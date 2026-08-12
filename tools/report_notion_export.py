#!/usr/bin/env python3
"""周报 / 月报 → Notion 导出工具

把 report_tool.py 生成好的「周报 / 月报」写进 Notion 的 Calendar 数据库
（与随想 / 时间轴整合同一库）。走 Notion 官方 REST API，不依赖连接器会话，
可在每日定时自动化里稳定无人值守运行。

认证：同 notion_export.py，读 C:/Users/Lenovo/.workbuddy/notion_config.json
      （{"token": "...", "database_id": "..."}），或环境变量 NOTION_TOKEN。

子命令：
    export --period weekly|monthly [--end YYYY-MM-DD]   导出指定周期（已存在则跳过）
    auto   --period weekly|monthly [--end ...]           导出指定周期（包装 export）

用法示例：
    python report_notion_export.py auto --period weekly
"""

import argparse
import json
import os
import sys
import time
import socket
import urllib.request
import urllib.error
from datetime import datetime, timedelta
from urllib.request import ProxyHandler, build_opener, install_opener

# 与 notion_export.py 一致：强制 IPv4 + 绕过代理，确保本地脚本与夜间自动化稳定出网
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
if not os.path.exists(CONFIG_PATH):
    CONFIG_PATH = r'C:\Users\Lenovo\.workbuddy\notion_config.json'

DEFAULT_DB_ID = '36b6fdc2-9b2d-4439-a6dc-4117b4f2030f'  # Calendar 数据库
NOTION_VERSION = '2022-06-28'
API_BASE = 'https://api.notion.com/v1'

WEEKLY_STORE = 'weekly_reports'
MONTHLY_STORE = 'monthly_reports'


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


def load_master():
    if not os.path.exists(MASTER_FILE):
        return {'data': {}, 'tombstones': {}}
    with open(MASTER_FILE, 'r', encoding='utf-8') as f:
        return json.load(f)


def get_report(master, period, start_iso):
    store_name = WEEKLY_STORE if period == 'weekly' else MONTHLY_STORE
    dead = set(master.get('tombstones', {}).keys())
    for gid, r in master.get('data', {}).get(store_name, {}).items():
        if gid in dead:
            continue
        if r.get('periodStart') == start_iso:
            return r
    return None


# ---------- Notion 块构造 ----------

def rich(segments):
    out = []
    for text, bold in segments:
        if not text:
            continue
        out.append({'type': 'text', 'text': {'content': text},
                    'annotations': {'bold': bool(bold)}})
    return out


def block_para(segments):
    return {'object': 'block', 'type': 'paragraph',
            'paragraph': {'rich_text': rich(segments)}}


def block_heading(text):
    return {'object': 'block', 'type': 'quote',
            'quote': {'rich_text': rich([(text, True)])}}


def block_bullet(segments):
    return {'object': 'block', 'type': 'bulleted_list_item',
            'bulleted_list_item': {'rich_text': rich(segments)}}


def block_numbered(segments):
    return {'object': 'block', 'type': 'numbered_list_item',
            'numbered_list_item': {'rich_text': rich(segments)}}


def block_empty():
    return {'object': 'block', 'type': 'paragraph', 'paragraph': {'rich_text': []}}


def block_divider():
    return {'object': 'block', 'type': 'divider', 'divider': {}}


def split_summary_detail(item):
    if isinstance(item, dict):
        return item.get('summary', ''), item.get('detail', '')
    if isinstance(item, str):
        for sep in ('｜', '——', '：', ':'):
            if sep in item:
                a, b = item.split(sep, 1)
                return a.strip(), b.strip()
    return '', item


def build_blocks(d):
    b = []
    if d.get('summary'):
        b.append(block_para([(d['summary'], False)]))
        b.append(block_empty())

    # 分模块小结（周报/月报特有）
    if d.get('modules'):
        b.append(block_heading('分模块小结'))
        for m in d['modules']:
            name = m.get('name', '')
            text = m.get('text', '')
            b.append(block_bullet([(name, True), (' — ' + text, False)]))
        b.append(block_empty())

    if d.get('themes'):
        b.append(block_heading('跨模块主题'))
        for t in d['themes']:
            b.append(block_bullet([(t.get('name', ''), True), (' — ' + t.get('desc', ''), False)]))
        b.append(block_empty())

    if d.get('insights'):
        b.append(block_heading('核心洞察'))
        for item in d['insights']:
            s, det = split_summary_detail(item)
            b.append(block_numbered([(s, True), (' — ' + det, False)]))
        b.append(block_empty())

    if d.get('extensions'):
        b.append(block_heading('可以延伸'))
        for item in d['extensions']:
            s, det = split_summary_detail(item)
            b.append(block_bullet([(s, True), (' — ' + det, False)]))
        b.append(block_empty())

    if d.get('actions'):
        b.append(block_heading('下一步行动'))
        for a in d['actions']:
            b.append(block_bullet([(a.get('text', ''), True), (' — ' + a.get('why', ''), False)]))
        b.append(block_empty())

    if d.get('mood'):
        b.append(block_heading('情绪基调'))
        s, det = split_summary_detail(d['mood'])
        b.append(block_para([(s, True), (' — ' + det, False)]))
        b.append(block_empty())

    b.append(block_divider())
    if d.get('note'):
        b.append(block_para([(d['note'], False)]))

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
            last_err = e
            time.sleep(1.0 * (attempt + 1))
            continue
    raise RuntimeError(f'Notion API {method} {path} 在 {retries} 次尝试后失败: {last_err}')


def period_range(period, end_str=None):
    ref = datetime.now().date()
    if end_str:
        ref = datetime.strptime(end_str, '%Y-%m-%d').date()
    if period == 'weekly':
        end = ref - timedelta(days=1)
        start = end - timedelta(days=end.weekday())
    else:
        end = ref - timedelta(days=1)
        start = end.replace(day=1)
    return start, end


def query_existing(db_id, token, period, date):
    kw = '周报' if period == 'weekly' else '月报'
    body = {
        'filter': {
            'and': [
                {'property': 'Date', 'date': {'equals': date}},
                {'property': 'Name', 'title': {'contains': kw}},
            ]
        }
    }
    res, _ = api_call('POST', f'/databases/{db_id}/query', token, body)
    for page in res.get('results', []):
        if page.get('archived'):
            continue
        texts = page.get('properties', {}).get('Name', {}).get('title', [])
        name = ''.join(t.get('plain_text', '') for t in texts)
        if kw in name:
            return page.get('id')
    return None


def create_page(db_id, token, date, name, blocks):
    props = {
        'Name': {'title': [{'text': {'content': name}}]},
        'Date': {'date': {'start': date}},
    }
    body = {'parent': {'database_id': db_id}, 'properties': props, 'children': blocks}
    res, _ = api_call('POST', '/pages', token, body)
    return res.get('id'), res.get('url')


def export_period(period, token, db_id, end_str=None, dry_run=False):
    start, end = period_range(period, end_str)
    master = load_master()
    d = get_report(master, period, start.isoformat())
    if not d:
        print(json.dumps({'ok': False, 'period': period, 'reason': 'no report',
                          'periodStart': start.isoformat()}, ensure_ascii=False))
        return False

    blocks = build_blocks(d)
    keyword = (d.get('keyword') or '').strip()
    cn = '周报' if period == 'weekly' else '月报'
    name = f'{cn} - {keyword}' if keyword else cn

    if dry_run or not token:
        print(json.dumps({'dry_run': True, 'period': period, 'name': name,
                          'block_count': len(blocks)}, ensure_ascii=False, indent=2))
        return True

    existing = query_existing(db_id, token, period, start.isoformat())
    if existing:
        print(json.dumps({'ok': True, 'period': period, 'skipped': True,
                          'reason': 'already in Notion', 'page_id': existing}, ensure_ascii=False))
        return True

    pid, url = create_page(db_id, token, start.isoformat(), name, blocks)
    print(json.dumps({'ok': True, 'period': period, 'page_id': pid, 'url': url},
                     ensure_ascii=False))
    return True


def cmd_auto(args):
    token, db_id = load_config()
    if not token:
        print(json.dumps({'ok': False, 'reason': 'no token',
                          'hint': f'请在 {CONFIG_PATH} 配置 token，或设置环境变量 NOTION_TOKEN'},
                         ensure_ascii=False, indent=2))
        return 1
    export_period(args.period, token, db_id, args.end)
    return 0


def cmd_export(args):
    token, db_id = load_config()
    export_period(args.period, token, db_id, args.end, dry_run=False)
    return 0


def main():
    parser = argparse.ArgumentParser(description='周报/月报 → Notion 导出')
    sub = parser.add_subparsers(dest='cmd', required=True)

    p_auto = sub.add_parser('auto', help='导出指定周期')
    p_auto.add_argument('--period', required=True, choices=['weekly', 'monthly'])
    p_auto.add_argument('--end', help='参考日期 YYYY-MM-DD')
    p_auto.set_defaults(func=cmd_auto)

    p_export = sub.add_parser('export', help='导出指定周期（同 auto）')
    p_export.add_argument('--period', required=True, choices=['weekly', 'monthly'])
    p_export.add_argument('--end', help='参考日期 YYYY-MM-DD')
    p_export.set_defaults(func=cmd_export)

    args = parser.parse_args()
    sys.exit(args.func(args))


if __name__ == '__main__':
    main()
