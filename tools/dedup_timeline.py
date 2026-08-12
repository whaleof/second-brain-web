#!/usr/bin/env python3
"""清理 master.json 中 timeline_logs 的同 (date, hour) 重复记录。

策略：
- 同一个 (date, hour) 只保留一条 canonical 记录。
- 如果该小时有多条记录，把它们的 content 按逗号拆分、trim、去重、保持出现顺序，
  合并成一条新的 content，保存到 updatedAt 最新的那条上。
- 其余记录写 tombstone，并从 data 中移除。
- 备份原文件，改完后 bump master['updatedAt'] 并回读验证。

用法：
    python dedup_timeline.py
"""

import json
import os
import shutil
from collections import defaultdict
from datetime import datetime

WORKSPACE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MASTER_FILE = os.path.join(WORKSPACE, '.sync', 'master.json')
BACKUP_DIR = os.path.join(WORKSPACE, '.sync', 'backups')


def load_master(path):
    with open(path, 'r', encoding='utf-8') as f:
        return json.load(f)


def save_master(path, master):
    tmp = path + '.tmp'
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(master, f, ensure_ascii=False)
    os.replace(tmp, path)


def merge_contents(contents):
    """把多条 content 字符串合并，拆分逗号、trim、去重、保持第一次出现的顺序。"""
    seen = set()
    parts = []
    for c in contents:
        if not isinstance(c, str):
            continue
        for seg in c.split('，'):
            seg = seg.strip()
            if not seg:
                continue
            if seg in seen:
                continue
            seen.add(seg)
            parts.append(seg)
    return '，'.join(parts) if parts else ''


def main():
    if not os.path.exists(MASTER_FILE):
        print(f'master.json 不存在: {MASTER_FILE}')
        return

    # 1. 备份
    os.makedirs(BACKUP_DIR, exist_ok=True)
    ts = datetime.now().strftime('%Y%m%d-%H%M%S')
    backup_path = os.path.join(BACKUP_DIR, f'master-{ts}-before-timeline-dedup.json')
    shutil.copy2(MASTER_FILE, backup_path)
    print(f'已备份: {backup_path}')

    # 2. 读取
    master = load_master(MASTER_FILE)
    tl_store = master.setdefault('data', {}).get('timeline_logs', {})
    tombstones = master.setdefault('tombstones', {})
    now = int(datetime.now().timestamp() * 1000)

    # 3. 按 (date, hour) 分组
    groups = defaultdict(list)
    for gid, r in tl_store.items():
        if gid in tombstones:
            continue
        date = r.get('date')
        hour = r.get('hour')
        if not date or hour is None:
            continue
        try:
            hour = int(hour)
        except (TypeError, ValueError):
            continue
        groups[(date, hour)].append((gid, r))

    removed = 0
    merged = 0
    for (date, hour), items in groups.items():
        if len(items) <= 1:
            continue
        # 按 updatedAt 排序，保留最新一条
        items.sort(key=lambda x: x[1].get('updatedAt') or 0)
        keeper_gid, keeper_rec = items[-1]
        contents = [r.get('content', '') for _, r in items]
        new_content = merge_contents(contents)
        # 更新 keeper
        keeper_rec['content'] = new_content
        keeper_rec['updatedAt'] = now
        keeper_rec['hour'] = hour  # 确保是 int
        # 其余写 tombstone 并移除
        for gid, r in items[:-1]:
            tombstones[gid] = {
                'gid': gid,
                'storeName': 'timeline_logs',
                'deletedAt': now
            }
            tl_store.pop(gid, None)
            removed += 1
        merged += 1
        print(f'合并 {date} {hour:02d}:00 ({len(items)}条 -> 1条): {new_content[:60]}')

    if removed == 0:
        print('未发现重复记录，无需清理。')
        return

    # 4. bump updatedAt
    master['updatedAt'] = now

    # 5. 保存
    save_master(MASTER_FILE, master)
    print(f'已删除 {removed} 条重复记录，合并 {merged} 个时段。')

    # 6. 回读验证
    master2 = load_master(MASTER_FILE)
    assert master2['updatedAt'] == now
    print('回读验证通过。')


if __name__ == '__main__':
    main()
