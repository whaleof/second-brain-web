#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
Notion 共享层：网络兼容 + 配置 + API + 块构造

供 daily_fusion.py / notion_export.py / timeline_notion_export.py 复用。
不依赖连接器会话，走 Notion 官方 REST API，可在定时自动化里稳定无人值守运行。
"""

import json
import os
import socket
import time
import urllib.request
import urllib.error
from urllib.request import build_opener, install_opener

# ---------- 网络兼容性 ----------
# 强制走 IPv4（避免 IPv6 直连被防火墙重置）。
# 代理处理：准备两个 opener（走系统代理 / 直连），每次请求重试时交替尝试。
# 用户电脑的 7890 代理软件时开时关，单次探测不可靠；交替重试保证总有一条路通。
import urllib.parse
from urllib.request import ProxyHandler

_ORIG_GAI = socket.getaddrinfo


def _force_ipv4(host, port, family=0, type=0, proto=0, flags=0):
    return _ORIG_GAI(host, port, socket.AF_INET, type, proto, flags)


def _proxy_reachable(proxies):
    """探测代理端口是否真的在监听；不通就当没有代理（避免死代理浪费重试）。"""
    import re
    for scheme in ('https', 'http'):
        url = proxies.get(scheme)
        if not url:
            continue
        m = re.match(r'https?://([^:/]+):?(\d+)?', url)
        if not m:
            continue
        host, port = m.group(1), int(m.group(2) or 80)
        try:
            with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
                s.settimeout(1.5)
                s.connect((host, port))
            return True
        except Exception:
            return False
    return False


def _make_openers():
    proxies = {}
    try:
        proxies = urllib.request.getproxies()
    except Exception:
        proxies = {}
    # 自适应：代理端口不通（如沙箱里残留的 127.0.0.1:7890 没开）→ 双路都直连
    if not _proxy_reachable(proxies):
        proxies = {}
    proxy_opener = build_opener(ProxyHandler(proxies))      # 走系统代理（7890 等）
    direct_opener = build_opener(ProxyHandler({}))          # 强制直连（绕过系统代理）
    return proxy_opener, direct_opener


_PROXY_OPENER, _DIRECT_OPENER = _make_openers()
socket.getaddrinfo = _force_ipv4
install_opener(_DIRECT_OPENER)  # 默认直连；重试里会交替

WORKSPACE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
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


# ---------- 配置 ----------

def load_config():
    """返回 (token, db_id)。优先环境变量 NOTION_TOKEN，其次配置文件。"""
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


# ---------- 块构造 ----------

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


def block_callout(segments, emoji=''):
    callout = {'object': 'block', 'type': 'callout',
               'callout': {'rich_text': rich(segments)}}
    if emoji:
        callout['callout']['icon'] = {'type': 'emoji', 'emoji': emoji}
    return callout


def block_quote_children(items, title=''):
    """quote 引用块：标题+内容**都在** quote 内（整块带左竖线）。
    items: list of strings（允许空 list：渲染成"只有标题块+灰竖线+无内容"的空白引用）。
    一般情况用 block_quote_title + block_paragraphs 分开放更易读。"""
    children = [
        {'object': 'block', 'type': 'paragraph',
         'paragraph': {'rich_text': [{'type': 'text', 'text': {'content': s}}]}}
        for s in items if s
    ]
    return {
        'object': 'block', 'type': 'quote',
        'quote': {
            'rich_text': [{'type': 'text', 'text': {'content': title or ' '}}],
            'children': children,  # 空 list 也合法：渲染空引用块（仅标题）
        },
    }


def block_quote_title(title):
    """quote 块只含标题（无 children）。视觉：左边一条竖线，仅段头文字。
    配合 block_paragraphs 用于「标题在 quote 内、内容在 quote 外」的形态。"""
    return {
        'object': 'block', 'type': 'quote',
        'quote': {'rich_text': [{'type': 'text', 'text': {'content': title or ' '}}]},
    }


def block_paragraphs(items):
    """多个 paragraph 块（每个 item 一行，普通样式不带竖线）。
    items: list of strings（允许空 list：返回空 list）。"""
    return [
        {'object': 'block', 'type': 'paragraph',
         'paragraph': {'rich_text': [{'type': 'text', 'text': {'content': s}}]}}
        for s in items if s
    ]


def block_quote(segments):
    """单段 quote，无子块。"""
    return {'object': 'block', 'type': 'quote',
            'quote': {'rich_text': rich(segments)}}


def block_empty():
    return {'object': 'block', 'type': 'paragraph', 'paragraph': {'rich_text': []}}


def block_divider():
    return {'object': 'block', 'type': 'divider', 'divider': {}}


# ---------- Notion API ----------

def api_call(method, path, token, body=None, retries=4):
    url = API_BASE + path
    data = json.dumps(body).encode('utf-8') if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header('Authorization', 'Bearer ' + token)
    req.add_header('Notion-Version', NOTION_VERSION)
    req.add_header('Content-Type', 'application/json')
    last_err = None
    for attempt in range(retries):
        # 交替尝试：偶数次走系统代理，奇数次强制直连（总有一条路通）
        opener = _PROXY_OPENER if attempt % 2 == 0 else _DIRECT_OPENER
        try:
            with opener.open(req, timeout=30) as resp:
                return json.loads(resp.read().decode('utf-8')), resp.status
        except urllib.error.HTTPError as e:
            detail = e.read().decode('utf-8', 'ignore')
            raise RuntimeError(f'Notion API {method} {path} 失败 [{e.code}]: {detail}')
        except urllib.error.URLError as e:
            # 网络瞬断 / 代理端口时开时关：切换另一条路重试
            last_err = e
            time.sleep(0.8 * (attempt + 1))
            continue
    raise RuntimeError(f'Notion API {method} {path} 在 {retries} 次尝试后失败: {last_err}')


def query_existing(db_id, token, date, name_match=None):
    """返回该日期下、标题匹配的未归档页面 id（没有则 None）。
    name_match: 若为 str，则标题需包含该串；若为 None，只按日期过滤。"""
    flt = [{'property': 'Date', 'date': {'equals': date}}]
    if name_match:
        flt.append({'property': 'Name', 'title': {'contains': name_match}})
    body = {'filter': {'and': flt}}
    res, _ = api_call('POST', f'/databases/{db_id}/query', token, body)
    for page in res.get('results', []):
        if page.get('archived'):
            continue
        title = page.get('properties', {}).get('Name', {})
        name = ''.join(t.get('plain_text', '') for t in title.get('title', []))
        if name_match is None or name_match in name:
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


def append_blocks(page_id, token, blocks):
    """往已有页面（page 本身就是一个 block）末尾追加一组块，原内容不动。
    用于「只补某一段、不重建整篇」的场景（如给老页面补「看见」段）。"""
    if not blocks:
        return None
    body = {'children': blocks}
    res, _ = api_call('PATCH', f'/blocks/{page_id}/children', token, body)
    return res

