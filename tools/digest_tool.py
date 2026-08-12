#!/usr/bin/env python3
"""随想日终整合工具

直接读写局域网同步中心 .sync/master.json，让每日 AI 整合结果沿既有同步链路
下发到手机 / 平板等所有设备，不依赖 HTTP 服务是否在运行。

子命令:
    fetch    读取指定日期的随想，输出 JSON（供 AI 分析）
    pending  列出最近 N 天中"有随想但还没整合"的日期
    save     把整合结果写入同步中心 + 归档 Markdown

用法示例:
    python digest_tool.py pending --days 3
    python digest_tool.py fetch --date 2026-08-01
    python digest_tool.py save --date 2026-08-01 --file digest.json
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
ARCHIVE_DIR = os.path.join(WORKSPACE, 'data', 'thought-digests')

THOUGHTS_STORE = 'thoughts'
DIGEST_STORE = 'thought_digests'

KIND_LABEL = {
    'idea': '想法',
    'feel': '感受',
    'q': '思考',
    'spark': '觉察',
    'grateful': '感恩',
}


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
    """已被墓碑标记删除的 gid 集合"""
    return set(master.get('tombstones', {}).keys())


def get_thoughts(master, date):
    records = master.get('data', {}).get(THOUGHTS_STORE, {})
    dead = deleted_gids(master)
    items = [r for gid, r in records.items()
             if r.get('date') == date and gid not in dead]
    items.sort(key=lambda r: r.get('ts') or r.get('createdAt') or 0)
    return items


def get_digest(master, date):
    records = master.get('data', {}).get(DIGEST_STORE, {})
    dead = deleted_gids(master)
    hits = [(gid, r) for gid, r in records.items()
            if r.get('date') == date and gid not in dead]
    if not hits:
        return None, None
    hits.sort(key=lambda x: x[1].get('generatedAt') or 0, reverse=True)
    return hits[0]


def all_thought_dates(master):
    records = master.get('data', {}).get(THOUGHTS_STORE, {})
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
    items = get_thoughts(master, date)
    existing_gid, existing = get_digest(master, date)

    payload = {
        'date': date,
        'count': len(items),
        'hasDigest': existing is not None,
        'thoughts': [
            {
                'time': t.get('time') or '',
                'kind': KIND_LABEL.get(t.get('kind'), '想法'),
                'text': t.get('text') or '',
            }
            for t in items
        ],
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


def cmd_pending(args):
    master = load_master()
    dates = all_thought_dates(master)
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


def cmd_save(args):
    date = args.date

    if args.file == '-':
        digest = json.load(sys.stdin)
    else:
        with open(args.file, 'r', encoding='utf-8') as f:
            digest = json.load(f)

    master = load_master()
    items = get_thoughts(master, date)
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
        # 版本D：阶段式结构
        'stages': digest.get('stages') or [],
    }

    master.setdefault('data', {}).setdefault(DIGEST_STORE, {})[gid] = record
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


def fmt_summary_detail(item):
    if isinstance(item, dict):
        return f'{item.get("summary", "")}｜{item.get("detail", "")}'
    return str(item)


def write_archive(date, record, items):
    """同时写一份人类可读的 Markdown 归档（支持版本D阶段式和老格式）"""
    os.makedirs(ARCHIVE_DIR, exist_ok=True)
    path = os.path.join(ARCHIVE_DIR, f'{date}.md')

    kw = record.get('keyword') or ''
    lines = [f'# {date} 随想' + (f' - {kw}' if kw else '') + ' 日终整合', '']
    if record.get('title'):
        lines += [f'> {record["title"]}', '']
    if record.get('summary'):
        lines += [record['summary'], '']

    # 版本D：阶段式输出（优先）
    stages = record.get('stages') or []
    if stages:
        for si, stage in enumerate(stages):
            t = stage.get('time', '')
            n = stage.get('name', '')
            lines.append(f'### {t} · {n}' if t else f'### {n}')
            lines.append('')
            for ins in stage.get('insights') or []:
                lines.append(f'- **洞察** {ins.get("summary","")} — {ins.get("detail","")}')
            for ext in stage.get('extensions') or []:
                lines.append(f'- **延伸** {ext.get("summary","")} — {ext.get("detail","")}')
            for act in stage.get('actions') or []:
                why = f'（{act.get("why")}）' if act.get('why') else ''
                lines.append(f'- **落地** {act.get("text","")}{why}')
            lines.append('')
    else:
        # 老格式：4 平行列表
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
                why = f'（{a.get("why")}）' if a.get('why') else ''
                lines.append(f'- **{a.get("text", "")}**{why}')
            lines.append('')

    if record.get('mood'):
        lines += [f'情绪基调：{fmt_summary_detail(record["mood"])}', '']
    if record.get('note'):
        lines += ['---', '', record['note'], '']

    lines += ['## 原始随想', '']
    for t in items:
        lines.append(f'- `{t.get("time", "")}` {t.get("text", "")}')
    lines.append('')

    with open(path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines))
    return path


def main():
    parser = argparse.ArgumentParser(description='随想日终整合工具')
    sub = parser.add_subparsers(dest='cmd', required=True)

    p_fetch = sub.add_parser('fetch', help='读取指定日期的随想')
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
