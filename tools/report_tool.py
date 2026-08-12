#!/usr/bin/env python3
"""周报 / 月报聚合工具

从局域网同步中心 .sync/master.json 聚合一个周期（周=上一完整周 周一~周日；
月=上一自然月）的 5 个模块数据（习惯 / 目标 / 时间轴 / 随想 / 饮品），
输出一份聚合 JSON 供 AI 分析；分析后再 save 回同步中心 + 归档 Markdown。

与 digest_tool.py 同构：本脚本只负责「读取 / 写回」，真正的整合分析由
每日自动化里的模型完成（先 fetch，再分析，最后 save）。

子命令：
    fetch   --period weekly|monthly [--end YYYY-MM-DD]   读取周期聚合数据（JSON 到 stdout）
    save    --period weekly|monthly [--end ...] --file report.json
                                                    把 AI 分析后的报告写回同步中心 + 归档

用法示例：
    python report_tool.py fetch --period weekly
    python report_tool.py save  --period weekly --file report.json
"""

import argparse
import json
import os
import sys
import time
import uuid
from collections import Counter
from datetime import datetime, timedelta

WORKSPACE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MASTER_FILE = os.path.join(WORKSPACE, '.sync', 'master.json')
ARCHIVE_DIR = os.path.join(WORKSPACE, 'data', 'reports')

HABITS_STORE = 'habits'
HABIT_LOGS = 'habit_logs'
OKR_STORE = 'okr'
TL_STORE = 'timeline_logs'
TL_DIGEST = 'timeline_digests'
THOUGHTS_STORE = 'thoughts'
THOUGHT_DIGEST = 'thought_digests'
MOOD_STORE = 'mood_logs'
DRINK_STORE = 'drink_records'

WEEKLY_STORE = 'weekly_reports'
MONTHLY_STORE = 'monthly_reports'


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


def store(master, name):
    dead = deleted_gids(master)
    return [r for gid, r in master.get('data', {}).get(name, {}).items() if gid not in dead]


# ---------- 周期计算 ----------

def period_range(period, end_str=None):
    ref = datetime.now().date()
    if end_str:
        ref = datetime.strptime(end_str, '%Y-%m-%d').date()
    if period == 'weekly':
        end = ref - timedelta(days=1)              # 上周日
        start = end - timedelta(days=end.weekday())  # 上周一
    else:  # monthly
        end = ref - timedelta(days=1)              # 上月最后一天
        start = end.replace(day=1)                 # 上月 1 号
    return start, end


def period_label(period, start):
    if period == 'weekly':
        return f'{start.year}-W{start.isocalendar().week:02d}'
    return f'{start.year}-{start.month:02d}'


# ---------- 聚合 ----------

def in_range(rec, start, end):
    d = rec.get('date')
    if not d:
        return False
    return start.isoformat() <= d <= end.isoformat()


def aggregate_habits(master, start, end):
    habits = store(master, HABITS_STORE)
    logs = [r for r in store(master, HABIT_LOGS) if in_range(r, start, end)]
    out = []
    for h in habits:
        hg = h.get('gid')
        hl = [r for r in logs if r.get('habitGid') == hg]
        done_days = sorted({r['date'] for r in hl if r.get('done')})
        checkins = sum(1 for r in hl if r.get('done') or (r.get('value') or 0) > 0)
        val_sum = sum((r.get('value') or 0) for r in hl)
        # 区间内最长连续完成
        streak = 0
        best = 0
        cur = start
        while cur <= end:
            if cur.isoformat() in done_days:
                streak += 1
                best = max(best, streak)
            else:
                streak = 0
            cur += timedelta(days=1)
        days = (end - start).days + 1
        out.append({
            'name': h.get('name'), 'icon': h.get('icon', ''),
            'type': h.get('type'), 'target': h.get('target') or 0,
            'doneDays': len(done_days), 'totalDays': days,
            'rate': round(len(done_days) / days * 100) if days else 0,
            'checkins': checkins, 'valueSum': val_sum, 'bestStreak': best,
        })
    out.sort(key=lambda x: x['doneDays'], reverse=True)
    return out


def aggregate_okr(master, start, end):
    okrs = store(master, OKR_STORE)
    logs = [r for r in store(master, HABIT_LOGS) if in_range(r, start, end)]
    out = []
    for o in okrs:
        krs = []
        for k in o.get('keyResults', []):
            item = {'title': k.get('title'), 'target': k.get('target') or 0}
            hg = k.get('habitGid')
            if hg:
                done_days = sum(1 for r in logs if r.get('habitGid') == hg and r.get('done'))
                item['current'] = done_days
                item['linked'] = True
            else:
                item['current'] = k.get('current') or 0
                item['linked'] = False
            item['progress'] = round(item['current'] / item['target'] * 100) if item['target'] else 0
            krs.append(item)
        avg = round(sum(k['progress'] for k in krs) / len(krs)) if krs else 0
        out.append({'title': o.get('title'), 'desc': o.get('desc', ''),
                    'keyResults': krs, 'progress': avg})
    return out


def aggregate_timeline(master, start, end):
    logs = [r for r in store(master, TL_STORE) if in_range(r, start, end)]
    digs = [r for r in store(master, TL_DIGEST) if in_range(r, start, end)]
    days = sorted({r['date'] for r in logs})
    themes = []
    for d in digs:
        for t in d.get('themes', []):
            themes.append(t.get('name', ''))
    return {
        'activityDays': len(days),
        'logCount': len(logs),
        'digestCount': len(digs),
        'topThemes': [n for n, _ in Counter(themes).most_common(6) if n],
        'dailySummaries': [{'date': d.get('date'), 'summary': d.get('summary', '')}
                           for d in sorted(digs, key=lambda x: x.get('date', ''))],
    }


def aggregate_thoughts(master, start, end):
    logs = [r for r in store(master, THOUGHTS_STORE) if in_range(r, start, end)]
    digs = [r for r in store(master, THOUGHT_DIGEST) if in_range(r, start, end)]
    moods = [r for r in store(master, MOOD_STORE) if in_range(r, start, end)]
    avg_mood = round(sum(m.get('mood', 0) for m in moods) / len(moods), 1) if moods else 0
    return {
        'count': len(logs),
        'digestCount': len(digs),
        'avgMood': avg_mood,
        'topThemes': [t.get('name', '') for d in digs for t in d.get('themes', [])][:6],
        'insights': [i.get('summary', '') for d in digs for i in d.get('insights', [])][:6],
    }


def aggregate_drinks(master, start, end):
    logs = [r for r in store(master, DRINK_STORE) if in_range(r, start, end)]
    types = Counter(r.get('type', '其他') for r in logs)
    brands = Counter(r.get('brand', '未知') for r in logs)
    return {
        'count': len(logs),
        'typeDist': dict(types.most_common()),
        'topBrands': [b for b, _ in brands.most_common(5) if b],
    }


# ---------- 子命令 ----------

def cmd_fetch(args):
    master = load_master()
    start, end = period_range(args.period, args.end)
    label = period_label(args.period, start)
    payload = {
        'period': args.period,
        'periodStart': start.isoformat(),
        'periodEnd': end.isoformat(),
        'label': label,
        'habits': aggregate_habits(master, start, end),
        'okr': aggregate_okr(master, start, end),
        'timeline': aggregate_timeline(master, start, end),
        'thoughts': aggregate_thoughts(master, start, end),
        'drinks': aggregate_drinks(master, start, end),
    }
    print(json.dumps(payload, ensure_ascii=False, indent=2))
    return 0


def cmd_save(args):
    period = args.period
    start, end = period_range(period, args.end)
    label = period_label(period, start)

    if args.file == '-':
        report = json.load(sys.stdin)
    else:
        with open(args.file, 'r', encoding='utf-8') as f:
            report = json.load(f)

    master = load_master()
    now = int(time.time() * 1000)
    store_name = WEEKLY_STORE if period == 'weekly' else MONTHLY_STORE

    # 同周期已有则覆盖
    existing_gid = None
    for gid, r in master.get('data', {}).get(store_name, {}).items():
        if r.get('periodStart') == start.isoformat():
            existing_gid = gid
            break
    gid = existing_gid or str(uuid.uuid4())

    record = {
        'gid': gid,
        'period': period,
        'periodStart': start.isoformat(),
        'periodEnd': end.isoformat(),
        'label': label,
        'keyword': report.get('keyword') or '',
        'summary': report.get('summary') or '',
        'modules': report.get('modules') or [],
        'themes': report.get('themes') or [],
        'insights': report.get('insights') or [],
        'extensions': report.get('extensions') or [],
        'actions': report.get('actions') or [],
        'mood': report.get('mood') or '',
        'note': report.get('note') or '',
        'source': report.get('source') or 'auto',
        'generatedAt': now,
        'createdAt': (master.get('data', {}).get(store_name, {}).get(gid, {}) or {}).get('createdAt') or now,
        'updatedAt': now,
    }
    master.setdefault('data', {}).setdefault(store_name, {})[gid] = record
    master['updatedAt'] = now
    save_master(master)

    md_path = write_archive(period, start, end, label, record)
    print(json.dumps({'ok': True, 'period': period, 'label': label,
                      'gid': gid, 'replaced': existing_gid is not None,
                      'archive': md_path}, ensure_ascii=False, indent=2))
    return 0


def write_archive(period, start, end, label, record):
    os.makedirs(ARCHIVE_DIR, exist_ok=True)
    fname = f'{period}-{label}.md'
    path = os.path.join(ARCHIVE_DIR, fname)
    cn = '周报' if period == 'weekly' else '月报'
    lines = [f'# {cn} {label}（{start}~{end}）', '']
    if record.get('summary'):
        lines += [record['summary'], '']
    for m in record.get('modules', []):
        lines += [f'## {m.get("name", "")}', '', m.get('text', ''), '']
    if record.get('themes'):
        lines += ['## 跨模块主题', '']
        for t in record['themes']:
            lines.append(f'- **{t.get("name", "")}** — {t.get("desc", "")}')
        lines.append('')
    if record.get('insights'):
        lines += ['## 核心洞察', '']
        for i in record['insights']:
            lines.append(f'- {i.get("summary", "")} — {i.get("detail", "")}')
        lines.append('')
    if record.get('actions'):
        lines += ['## 下一步行动', '']
        for a in record['actions']:
            lines.append(f'- **{a.get("text", "")}** — {a.get("why", "")}')
        lines.append('')
    if record.get('mood'):
        lines += ['## 情绪基调', '', f'{record["mood"].get("summary", "")} — {record["mood"].get("detail", "")}', '']
    if record.get('note'):
        lines += ['---', '', record['note'], '']
    with open(path, 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines))
    return path


def main():
    parser = argparse.ArgumentParser(description='周报/月报聚合工具')
    sub = parser.add_subparsers(dest='cmd', required=True)

    p_fetch = sub.add_parser('fetch', help='读取周期聚合数据')
    p_fetch.add_argument('--period', required=True, choices=['weekly', 'monthly'])
    p_fetch.add_argument('--end', help='参考日期 YYYY-MM-DD（默认今天；报告覆盖其之前的完整周/月）')
    p_fetch.set_defaults(func=cmd_fetch)

    p_save = sub.add_parser('save', help='保存 AI 分析报告')
    p_save.add_argument('--period', required=True, choices=['weekly', 'monthly'])
    p_save.add_argument('--end', help='参考日期 YYYY-MM-DD')
    p_save.add_argument('--file', required=True, help='分析报告 JSON 路径，- 表示 stdin')
    p_save.set_defaults(func=cmd_save)

    args = parser.parse_args()
    sys.exit(args.func(args))


if __name__ == '__main__':
    main()
