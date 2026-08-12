#!/usr/bin/env python3
"""随想整合 → Notion 导出工具

把 digest_tool.py 生成好的「随想日终整合」按日期写进 Notion 的 Calendar 数据库。
与 digest_tool.py 一样是本地脚本，走 Notion 官方 REST API，不依赖连接器会话，
因此可以在每日定时自动化里稳定无人值守运行。

认证：
    需要一个 Notion 内部集成（Internal Integration）的 secret。
    把令牌写到配置文件（默认 C:/Users/Lenovo/.workbuddy/notion_config.json）：
        {"token": "ntn_xxx...", "database_id": "36b6fdc2-..."}
    也可用环境变量 NOTION_TOKEN 覆盖。

子命令：
    export --date YYYY-MM-DD   导出指定一天（若 Notion 中已有同名同日记录则跳过）
    auto   --days N            导出最近 N 天里「有整合但未导入」的日期

用法示例：
    python tools/notion_export.py auto --days 7
"""

import argparse
import json
import os
import re
import sys
import time
import socket
import urllib.request
import urllib.error
from datetime import datetime, timedelta
from urllib.request import ProxyHandler, build_opener, install_opener

# ---------- 网络兼容性 ----------
# 该环境：本地代理 127.0.0.1:7890 异常（HTTPS 握手失败），且 IPv6 直连被防火墙重置。
# 因此强制走 IPv4 并绕过代理，直连 api.notion.com，确保本地脚本与夜间自动化都能稳定出网。
_ORIG_GAI = socket.getaddrinfo
def _force_ipv4(host, port, family=0, type=0, proto=0, flags=0):
    return _ORIG_GAI(host, port, socket.AF_INET, type, proto, flags)
socket.getaddrinfo = _force_ipv4
install_opener(build_opener(ProxyHandler({})))

WORKSPACE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MASTER_FILE = os.path.join(WORKSPACE, '.sync', 'master.json')
CONFIG_PATH = os.path.join(
    os.path.dirname(os.path.dirname(os.path.dirname(WORKSPACE))),
    '.workbuddy', 'notion_config.json'
)
# 兜底：若上面解析不到，直接用绝对路径
if not os.path.exists(CONFIG_PATH):
    CONFIG_PATH = r'C:\Users\Lenovo\.workbuddy\notion_config.json'

DEFAULT_DB_ID = '36b6fdc2-9b2d-4439-a6dc-4117b4f2030f'  # Calendar 数据库
NOTION_VERSION = '2022-06-28'
API_BASE = 'https://api.notion.com/v1'

DIGEST_STORE = 'thought_digests'
THOUGHTS_STORE = 'thoughts'
KIND_LABEL = {'idea': '想法', 'feel': '感受', 'q': '思考', 'spark': '觉察', 'grateful': '感恩'}

# 匹配图片引用：markdown 图片 或 @image#...[] 形式
IMG_RE = re.compile(r'!\[.*?\]\(.*?\)|@image#[^\s\]]+\[\]')


def clean_thought_text(text):
    if not isinstance(text, str):
        return ''
    return IMG_RE.sub('', text).strip()


# ---------- 配置 ----------

def load_config():
    token = os.environ.get('NOTION_TOKEN')
    db_id = DEFAULT_DB_ID
    if os.path.exists(CONFIG_PATH):
        try:
            with open(CONFIG_PATH, 'r', encoding='utf-8') as f:
                cfg = json.load(f)
            token = token or cfg.get('token')
            db_id = cfg.get('database_id') or db_id
        except Exception:
            pass
    return token, db_id


# ---------- master.json 读取（与 digest_tool 同构） ----------

def load_master():
    if not os.path.exists(MASTER_FILE):
        return {'data': {}, 'tombstones': {}}
    with open(MASTER_FILE, 'r', encoding='utf-8') as f:
        return json.load(f)


def get_digest(master, date):
    records = master.get('data', {}).get(DIGEST_STORE, {})
    dead = set(master.get('tombstones', {}).keys())
    hits = [(gid, r) for gid, r in records.items()
            if r.get('date') == date and gid not in dead]
    if not hits:
        return None
    hits.sort(key=lambda x: x[1].get('generatedAt') or 0, reverse=True)
    return hits[0][1]


def get_thoughts(master, date):
    records = master.get('data', {}).get(THOUGHTS_STORE, {})
    dead = set(master.get('tombstones', {}).keys())
    items = []
    for gid, r in records.items():
        if r.get('date') != date or gid in dead:
            continue
        txt = clean_thought_text(r.get('text', ''))
        if not txt:
            continue
        r = dict(r)
        r['text'] = txt
        items.append(r)
    items.sort(key=lambda r: r.get('ts') or r.get('createdAt') or 0)
    return items


# ---------- Notion 块构造 ----------

def rich(segments):
    """segments: list of (text, bold)"""
    out = []
    for text, bold in segments:
        if not text:
            continue
        out.append({
            'type': 'text',
            'text': {'content': text},
            'annotations': {'bold': bool(bold)},
        })
    return out


def block_para(segments):
    return {'object': 'block', 'type': 'paragraph',
            'paragraph': {'rich_text': rich(segments)}}


def block_heading(text):
    """把标题做成加粗引用块，统一 4 字且醒目"""
    return block_quote([(text, True)])


def block_bullet(segments):
    return {'object': 'block', 'type': 'bulleted_list_item',
            'bulleted_list_item': {'rich_text': rich(segments)}}


def block_numbered(segments):
    return {'object': 'block', 'type': 'numbered_list_item',
            'numbered_list_item': {'rich_text': rich(segments)}}


def block_quote(segments):
    return {'object': 'block', 'type': 'quote',
            'quote': {'rich_text': rich(segments)}}


def block_callout(segments, emoji=''):
    callout = {'object': 'block', 'type': 'callout',
               'callout': {'rich_text': rich(segments)}}
    if emoji:
        callout['callout']['icon'] = {'type': 'emoji', 'emoji': emoji}
    return callout


def block_empty():
    return {'object': 'block', 'type': 'paragraph', 'paragraph': {'rich_text': []}}


def block_divider():
    return {'object': 'block', 'type': 'divider', 'divider': {}}


def split_summary_detail(item):
    """把 'summary｜detail' 或 dict 拆成 (summary, detail)。"""
    if isinstance(item, dict):
        return item.get('summary', ''), item.get('detail', '')
    if isinstance(item, str):
        for sep in ('｜', '——', '：', ':'):
            if sep in item:
                parts = item.split(sep, 1)
                return parts[0].strip(), parts[1].strip()
    return '', item


def build_blocks(d, thoughts):
    b = []

    # 1. 核心主题（去掉 emoji，只用加粗段落）
    if d.get('title'):
        b.append(block_para([(d['title'], True)]))
    if d.get('summary'):
        b.append(block_para([(d['summary'], False)]))
    b.append(block_empty())

    # 2. 原始随想置顶（去掉 [感受]/[灵感] 类型标签）
    if thoughts:
        b.append(block_heading('原始随想'))
        for t in thoughts:
            b.append(block_bullet([
                (t.get('time', '') + ' ', False),
                (t.get('text', ''), False),
            ]))
        b.append(block_empty())

    # 3. 主题聚类（name 统一短总结，desc 展开）
    if d.get('themes'):
        b.append(block_heading('主题聚类'))
        for t in d['themes']:
            name = t.get('name', '')
            desc = t.get('desc', '')
            b.append(block_bullet([(name, True), (' — ' + desc, False)]))
        b.append(block_empty())

    # 4. 核心洞察（短总结 + 展开，编号列表）
    if d.get('insights'):
        b.append(block_heading('核心洞察'))
        for item in d['insights']:
            summary, detail = split_summary_detail(item)
            b.append(block_numbered([(summary, True), (' — ' + detail, False)]))
        b.append(block_empty())

    # 5. 延伸思考（短总结 + 展开）
    if d.get('extensions'):
        b.append(block_heading('延伸思考'))
        for item in d['extensions']:
            summary, detail = split_summary_detail(item)
            b.append(block_bullet([(summary, True), (' — ' + detail, False)]))
        b.append(block_empty())

    # 6. 行动落地（text 短总结，why 展开）
    if d.get('actions'):
        b.append(block_heading('行动落地'))
        for a in d['actions']:
            text = a.get('text', '')
            why = a.get('why', '')
            b.append(block_bullet([(text, True), (' — ' + why, False)]))
        b.append(block_empty())

    # 7. 情绪基调（短总结 + 展开）
    if d.get('mood'):
        b.append(block_heading('情绪基调'))
        summary, detail = split_summary_detail(d['mood'])
        b.append(block_para([(summary, True), (' — ' + detail, False)]))
        b.append(block_empty())

    # 8. 收尾备注
    b.append(block_divider())
    if d.get('note'):
        b.append(block_para([(d['note'], False)]))

    # Notion 单次建页最多 100 个 block
    if len(b) > 100:
        b = b[:100]
    return b


# ---------- Notion API ----------

def api_call(method, path, token, body=None, retries=3):
    url = API_BASE + path
    data = json.dumps(body).encode('utf-8') if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header('Authorization', 'Bearer ' + token)
    req.add_header('Notion-Version', NOTION_VERSION)
    req.add_header('Content-Type', 'application/json')
    last_err = None
    for attempt in range(retries):
        try:
            with urllib.request.urlopen(req, timeout=30) as resp:
                return json.loads(resp.read().decode('utf-8')), resp.status
        except urllib.error.HTTPError as e:
            detail = e.read().decode('utf-8', 'ignore')
            raise RuntimeError(f'Notion API {method} {path} 失败 [{e.code}]: {detail}')
        except urllib.error.URLError as e:
            # 网络瞬断（IPv6 重置、EOF、连接被重置等）重试
            last_err = e
            time.sleep(1.0 * (attempt + 1))
            continue
    raise RuntimeError(f'Notion API {method} {path} 在 {retries} 次尝试后失败: {last_err}')


def query_existing(db_id, token, date):
    """返回该日期下、标题含『随想』且未归档的已有页面 id（没有则 None）"""
    body = {
        'filter': {
            'and': [
                {'property': 'Date', 'date': {'equals': date}},
                {'property': 'Name', 'title': {'contains': '随想'}},
            ]
        }
    }
    res, _ = api_call('POST', f'/databases/{db_id}/query', token, body)
    for page in res.get('results', []):
        if page.get('archived'):
            continue
        title = page.get('properties', {}).get('Name', {})
        texts = title.get('title', [])
        name = ''.join(t.get('plain_text', '') for t in texts)
        if '随想' in name:
            return page.get('id')
    return None


def create_page(db_id, token, date, name, blocks):
    props = {
        'Name': {'title': [{'text': {'content': name}}]},
        'Date': {'date': {'start': date}},
    }
    body = {
        'parent': {'database_id': db_id},
        'properties': props,
        'children': blocks,
    }
    res, _ = api_call('POST', '/pages', token, body)
    return res.get('id'), res.get('url')


# ---------- 命令 ----------

def export_date(date, token, db_id, dry_run=False):
    master = load_master()
    d = get_digest(master, date)
    if not d:
        print(json.dumps({'ok': False, 'date': date, 'reason': 'no digest'},
                         ensure_ascii=False))
        return False

    thoughts = get_thoughts(master, date)
    blocks = build_blocks(d, thoughts)
    keyword = (d.get('keyword') or '').strip()
    name = f'随想 - {keyword}' if keyword else '随想'

    if dry_run or not token:
        payload = {
            'parent': {'database_id': db_id},
            'properties': {
                'Name': {'title': [{'text': {'content': name}}]},
                'Date': {'date': {'start': date}},
            },
            'children': blocks,
        }
        print(json.dumps({'dry_run': True, 'date': date,
                          'block_count': len(blocks), 'payload': payload},
                         ensure_ascii=False, indent=2))
        return True

    existing = query_existing(db_id, token, date)
    if existing:
        print(json.dumps({'ok': True, 'date': date, 'skipped': True,
                          'reason': 'already in Notion', 'page_id': existing},
                         ensure_ascii=False))
        return True

    pid, url = create_page(db_id, token, date, name, blocks)
    print(json.dumps({'ok': True, 'date': date, 'page_id': pid, 'url': url,
                      'based_on': len(thoughts)}, ensure_ascii=False))
    return True


def cmd_auto(args):
    token, db_id = load_config()
    if not token:
        print(json.dumps({'ok': False, 'reason': 'no token',
                          'hint': f'请在 {CONFIG_PATH} 配置 token，或设置环境变量 NOTION_TOKEN'},
                         ensure_ascii=False, indent=2))
        return 1

    master = load_master()
    today = datetime.now().date()
    done = 0
    for i in range(0, args.days):
        date = (today - timedelta(days=i)).isoformat()
        if not get_digest(master, date):
            continue
        if export_date(date, token, db_id):
            done += 1
    print(json.dumps({'ok': True, 'checked_days': args.days, 'exported': done},
                     ensure_ascii=False))
    return 0


def cmd_export(args):
    token, db_id = load_config()
    export_date(args.date, token, db_id, dry_run=False)
    return 0


def main():
    parser = argparse.ArgumentParser(description='随想整合 → Notion 导出')
    sub = parser.add_subparsers(dest='cmd', required=True)

    p_export = sub.add_parser('export', help='导出指定日期')
    p_export.add_argument('--date', required=True)
    p_export.set_defaults(func=cmd_export)

    p_auto = sub.add_parser('auto', help='导出最近 N 天未导入的日期')
    p_auto.add_argument('--days', type=int, default=7)
    p_auto.set_defaults(func=cmd_auto)

    args = parser.parse_args()
    sys.exit(args.func(args))


if __name__ == '__main__':
    main()
