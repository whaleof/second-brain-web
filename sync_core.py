"""同步合并核心（纯逻辑，无 IO、无 HTTP）。

把 server.py 的 handle_sync 合并算法抽成可独立测试的纯函数：
所有"写 master.json / 收 HTTP 请求"的副作用都留在 server.py，
这里只做内存态的合并，方便用 pytest 覆盖「冲突 / 去重 / 软删除」等场景。

合并规则（与 server.py 原 handle_sync 行为逐字对齐）：
1. 变更按 gid 比较 updatedAt，最新覆盖；
   若该 gid 已被同名 store 的 tombstone 标记删除且删除时间更新，则拒绝复活。
2. tombstone 按最新 deletedAt 合并，并删除 data 中对应记录（删除传播）。
3. timeline_logs 中 date+hour+content 完全相同的记录只留最新一条，
   旧版写 tombstone 并从 data 移除（防多设备把重复内容拉回）。
4. 归一化：timeline_logs.hour 统一 int；updatedAt/deletedAt 统一 int 毫秒。
"""
from datetime import datetime


def _ts(v):
    """时间戳统一成 int(毫秒)。兼容 int/float、数字字符串、ISO 日期字符串
    (如 '2026-08-08T17:30:11.644039' 会转成对应毫秒戳)；空/非数字文本返回 0。
    用途：同步合并时比较 updatedAt/deletedAt，杜绝 Python `int > str` 抛
    TypeError 导致 /api/sync 返回 500（阻断级 bug #1 的根因）。"""
    if v is None:
        return 0
    if isinstance(v, bool):
        return 0
    if isinstance(v, (int, float)):
        try:
            return int(v)
        except (TypeError, ValueError):
            return 0
    if isinstance(v, str):
        s = v.strip()
        if not s:
            return 0
        # 数字字符串（含小数）
        try:
            return int(float(s))
        except (TypeError, ValueError):
            pass
        # ISO 日期字符串
        for fmt in ('%Y-%m-%dT%H:%M:%S.%f', '%Y-%m-%dT%H:%M:%S',
                    '%Y-%m-%d %H:%M:%S', '%Y-%m-%d'):
            try:
                return int(datetime.strptime(s, fmt).timestamp() * 1000)
            except ValueError:
                continue
    return 0


def new_master():
    """返回一个空的 master 结构（与 server.load_master 的默认值一致）。"""
    return {'version': 2, 'schemaVersion': 1, 'updatedAt': 0, 'data': {}, 'tombstones': {}}


def merge_into_master(master, incoming_changes, incoming_tombstones, now, incoming_meta=None):
    """把 incoming 合并进 master（原地修改并返回 master）。

    Args:
        master: 目标 master 字典（会被原地修改）。
        incoming_changes: {store_name: [record, ...]}，每条含 gid / updatedAt（可能脏）。
        incoming_tombstones: [{gid, storeName, deletedAt}, ...]。
        now: 当前毫秒时间戳，用于 timeline 去重 tombstone 的 deletedAt。

    Returns:
        合并后的 master（即为传入的同一个对象）。
    """
    if master is None:
        master = new_master()
    master.setdefault('data', {})
    master.setdefault('tombstones', {})
    incoming_changes = incoming_changes or {}
    incoming_tombstones = incoming_tombstones or []

    # 1. 合并变更：按 gid 比较 updatedAt，最新覆盖；tombstone 防复活
    for store_name, records in incoming_changes.items():
        if store_name not in master['data']:
            master['data'][store_name] = {}
        for r in records:
            gid = r.get('gid')
            if not gid:
                continue
            # hour 归一化（timeine_logs 专用）：杜绝 str/int 混写
            if store_name == 'timeline_logs' and 'hour' in r:
                try:
                    r['hour'] = int(r['hour'])
                except (TypeError, ValueError):
                    pass
            # 时间戳归一化（治本 bug #1）
            r['updatedAt'] = _ts(r.get('updatedAt'))
            # tombstone 防复活：若该 gid 已被同名 store 删除且删除时间更新，跳过
            existing_tomb = master['tombstones'].get(gid)
            if existing_tomb and existing_tomb.get('storeName') == store_name:
                tomb_time = _ts(existing_tomb.get('deletedAt'))
                if tomb_time > _ts(r.get('updatedAt')):
                    continue
            existing = master['data'][store_name].get(gid)
            if not existing or _ts(r.get('updatedAt')) > _ts(existing.get('updatedAt')):
                master['data'][store_name][gid] = r

    # 2. 合并墓碑：最新删除时间为准，并清除已被删除的数据
    for t in incoming_tombstones:
        gid = t.get('gid')
        if not gid:
            continue
        t['deletedAt'] = _ts(t.get('deletedAt'))
        existing_t = master['tombstones'].get(gid)
        if not existing_t or _ts(t.get('deletedAt')) > _ts(existing_t.get('deletedAt')):
            master['tombstones'][gid] = t
        store_name = t.get('storeName')
        if store_name and store_name in master['data']:
            rec = master['data'][store_name].get(gid)
            if rec and _ts(t.get('deletedAt')) > _ts(rec.get('updatedAt')):
                del master['data'][store_name][gid]

    # 3. timeline 重复条目去重：同 date+hour+content 完全相同的记录只留最新一条
    tl_store = master['data'].get('timeline_logs')
    if tl_store:
        tl_groups = {}
        for gid, r in list(tl_store.items()):
            if gid in master['tombstones']:
                continue
            date = r.get('date')
            hour = r.get('hour')
            if not date or hour is None:
                continue
            try:
                hour = int(hour)
            except (TypeError, ValueError):
                continue
            key = (date, hour, r.get('content'))
            tl_groups.setdefault(key, []).append((gid, r))
        for key, items in tl_groups.items():
            if len(items) <= 1:
                continue
            items.sort(key=lambda x: _ts(x[1].get('updatedAt')))
            for gid, r in items[:-1]:
                master['tombstones'][gid] = {
                    'gid': gid,
                    'storeName': 'timeline_logs',
                    'deletedAt': now
                }
                tl_store.pop(gid, None)

    # 3.5 透传 schemaVersion（前后端版本对齐护栏）：取 incoming 与本地较大者，
    # 保证多端版本号单调对齐，又不因高版本端临时回落而丢数据
    if incoming_meta and incoming_meta.get('schemaVersion'):
        try:
            sv = int(incoming_meta['schemaVersion'])
            master['schemaVersion'] = max(int(master.get('schemaVersion', 1)), sv)
        except (TypeError, ValueError):
            pass

    # 4. 更新 master 时间戳
    master['updatedAt'] = now
    return master
