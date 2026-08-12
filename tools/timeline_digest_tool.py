#!/usr/bin/env python3
"""时间轴日终整合工具

与 thought 的 digest_tool.py 完全镜像，但作用于「一日时间轴」模块：
从 .sync/master.json 的 timeline_logs 读取某天「每小时做了什么」，
由每日 AI 整合生成一篇有价值的时间轴日终思考，写回同步中心 + 归档 Markdown。

数据存到独立的 timeline_digests store，与随想的 thought_digests 互不干扰。

子命令:
    fetch    读取指定日期的时间轴，输出 JSON（供 AI 分析）
    pending  列出最近 N 天中"有时间轴但还没整合"的日期
    save     把整合结果写入同步中心 + 归档 Markdown

用法示例:
    python timeline_digest_tool.py pending --days 3
    python timeline_digest_tool.py fetch --date 2026-08-01
    python timeline_digest_tool.py save --date 2026-08-01 --file digest.json
"""

import argparse
import json
import os
import sys
import time
import uuid
from datetime import datetime, timedelta

WORKSPACE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MASTER_FILE = os.path.join(WORKSPACE, '.sync', 'master.json')
ARCHIVE_DIR = os.path.join(WORKSPACE, 'data', 'timeline-digests')

TL_STORE = 'timeline_logs'
TL_DIGEST_STORE = 'timeline_digests'


# ---------- master.json 读写 ----------

def load_master():
    if not os.path.exists(MASTER_FILE):
        return {'version': 2, 'updatedAt': 0, 'data': {}, 'tombstones': {}}
    with open(MASTER_FILE, 'r', encoding='utf-8') as f:
        return json.load(f)


def save_master(master):
    os.makedirs(os.path.dirname(MASTER_FILE), exist_ok=True)
    tmp = MASTER_FILE + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(master, f, ensure_ascii=False)
    os.replace(tmp, MASTER_FILE)


def deleted_gids(master):
    return set(master.get('tombstones', {}).keys())


def get_logs(master, date):
    """某天的时间轴原始记录，按 hour 排序；hour 归一为 'HH:00' 文案。"""
    records = master.get('data', {}).get(TL_STORE, {})
    dead = deleted_gids(master)
    items = [r for gid, r in records.items()
             if r.get('date') == date and gid not in dead]
    def _hour_key(r):
        h = r.get('hour')
        try:
            return int(h)
        except (TypeError, ValueError):
            return 0

    items.sort(key=_hour_key)
    out = []
    for r in items:
        hour = r.get('hour')
        if hour is None:
            continue
        label = f'{int(hour):02d}:00'
        out.append({'hour': hour, 'label': label, 'content': r.get('content') or ''})
    return out


def get_digest(master, date):
    records = master.get('data', {}).get(TL_DIGEST_STORE, {})
    dead = deleted_gids(master)
    hits = [(gid, r) for gid, r in records.items()
            if r.get('date') == date and gid not in dead]
    if not hits:
        return None, None
    hits.sort(key=lambda x: x[1].get('generatedAt') or 0, reverse=True)
    return hits[0]


def all_timeline_dates(master):
    records = master.get('data', {}).get(TL_STORE, {})
    dead = deleted_gids(master)
    dates = {}
    for gid, r in records.items():
        if gid in dead:
            continue
        d = r.get('date')
        if d:
            dates[d] = dates.get(d, 0) + 1
    return dates


# ---------- 子命令 ----------

def cmd_fetch(args):
    master = load_master()
    date = args.date
    items = get_logs(master, date)
    existing_gid, existing = get_digest(master, date)

    payload = {
        'date': date,
        'count': len(items),
        'hasDigest': existing is not None,
        'logs': items,
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


def cmd_pending(args):
    master = load_master()
    dates = all_timeline_dates(master)
    today = datetime.now().date()
    result = []
    for i in range(1, args.days + 1):
        d = (today - timedelta(days=i)).isoformat()
        if dates.get(d, 0) == 0:
            continue
        _, existing = get_digest(master, d)
        if existing and not args.force:
            continue
        result.append({'date': d, 'count': dates[d]})
    print(json.dumps({'pending': result}, ensure_ascii=False, indent=2))
    return 0


def fmt_summary_detail(item):
    if isinstance(item, dict):
        return f'{item.get("summary", "")}｜{item.get("detail", "")}'
    return str(item)


def cmd_save(args):
    date = args.date

    if args.file == '-':
        digest = json.load(sys.stdin)
    else:
        with open(args.file, 'r', encoding='utf-8') as f:
            digest = json.load(f)

    master = load_master()
    items = get_logs(master, date)
    now = int(time.time() * 1000)

    existing_gid, existing = get_digest(master, date)
    gid = existing_gid or str(uuid.uuid4())

    record = {
        'gid': gid,
        'date': date,
        'count': digest.get('count') or len(items),
        'title': digest.get('title') or '',
        'keyword': digest.get('keyword') or '',
        'summary': digest.get('summary') or '',
        'themes': digest.get('themes') or [],
        'insights': digest.get('insights') or [],
        'extensions': digest.get('extensions') or [],
        'actions': digest.get('actions') or [],
        'mood': digest.get('mood') or '',
        'note': digest.get('note') or '',
        'source': digest.get('source') or 'auto',
        'generatedAt': now,
        'createdAt': (existing or {}).get('createdAt') or now,
        'updatedAt': now,
    }

    master.setdefault('data', {}).setdefault(TL_DIGEST_STORE, {})[gid] = record
    master['updatedAt'] = now
    save_master(master)

    md_path = write_archive(date, record, items)

    print(json.dumps({
        'ok': True,
        'date': date,
        'gid': gid,
        'basedOn': len(items),
        'replaced': existing is not None,
        'archive': md_path,
    }, ensure_ascii=False, indent=2))
    return 0


def write_archive(date, record, items):
    """同时写一份人类可读的 Markdown 归档"""
    os.makedirs(ARCHIVE_DIR, exist_ok=True)
    path = os.path.join(ARCHIVE_DIR, f'{date}.md')

    kw = record.get('keyword') or ''
    lines = [f'# {date} 时间轴' + (f' - {kw}' if kw else '') + ' 日终整合', '']
    if record.get('title'):
        lines += [f'> {record["title"]}', '']
    if record.get('summary'):
        lines += [record['summary'], '']

    if items:
        lines += ['## 原始时间轴', '']
        for t in items:
            lines.append(f'- `{t.get("label", "")}` {t.get("content", "")}')
        lines.append('')

    if record.get('themes'):
        lines += ['## 主题聚类', '']
        for t in record['themes']:
            desc = f' — {t.get("desc")}' if t.get('desc') else ''
            lines.append(f'- **{t.get("name", "")}**{desc}')
        lines.append('')

    for key, title in (('insights', '洞察'), ('extensions', '可以延伸')):
        if record.get(key):
            lines += [f'## {title}', '']
            for s in record[key]:
                lines.append(f'- {fmt_summary_detail(s)}')
            lines.append('')

    if record.get('actions'):
        lines += ['## 可以落地', '']
        for a in record['actions']:
            why = f' — {a.get("why")}' if a.get('why') else ''
            lines.append(f'- **{a.get("text", "")}**{why}')
        lines.append('')

    if record.get('mood'):
        lines += ['## 情绪基调', '', fmt_summary_detail(record['mood']), '']
    if record.get('note'):
        lines += ['---', '', record['note'], '']

    with open(path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines))
    return path


def main():
    parser = argparse.ArgumentParser(description='时间轴日终整合工具')
    sub = parser.add_subparsers(dest='cmd', required=True)

    p_fetch = sub.add_parser('fetch', help='读取指定日期的时间轴')
    p_fetch.add_argument('--date', required=True, help='YYYY-MM-DD')
    p_fetch.set_defaults(func=cmd_fetch)

    p_pending = sub.add_parser('pending', help='列出待整合的日期')
    p_pending.add_argument('--days', type=int, default=3, help='回溯天数，默认 3')
    p_pending.add_argument('--force', action='store_true', help='包含已整合的日期')
    p_pending.set_defaults(func=cmd_pending)

    p_save = sub.add_parser('save', help='保存整合结果')
    p_save.add_argument('--date', required=True, help='YYYY-MM-DD')
    p_save.add_argument('--file', required=True, help='整合结果 JSON 文件路径，- 表示 stdin')
    p_save.set_defaults(func=cmd_save)

    args = parser.parse_args()
    sys.exit(args.func(args))


if __name__ == '__main__':
    main()
