"""sync_core 合并算法的单元测试。

覆盖四类核心场景（对应简历话术"tombstone + 时间戳解决多端冲突"）：
1. 时间戳归一化 _ts：脏输入（None/bool/字符串/ISO 日期）一律转 int 毫秒
2. 最新 updatedAt 覆盖：冲突时新胜旧，旧不覆盖新，新 gid 追加
3. tombstone 软删除：防复活、最新删除时间胜出、删除传播到 data
4. timeline_logs 去重：同 date+hour+content 完全相同的记录只留最新，旧版写 tombstone
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sync_core import _ts, merge_into_master, new_master


class TestTsNormalization:
    def test_none(self):
        assert _ts(None) == 0

    def test_bool(self):
        assert _ts(True) == 0
        assert _ts(False) == 0

    def test_int(self):
        assert _ts(1000) == 1000

    def test_float(self):
        assert _ts(1000.9) == 1000

    def test_numeric_str(self):
        assert _ts("12345") == 12345

    def test_float_str(self):
        assert _ts("12.5") == 12

    def test_empty_str(self):
        assert _ts("") == 0
        assert _ts("   ") == 0

    def test_iso_str(self):
        v = _ts("2026-08-08T17:30:11.644039")
        assert isinstance(v, int)
        assert v > 0

    def test_garbage_str(self):
        assert _ts("not-a-time") == 0


class TestMergeLatestWins:
    def test_newer_overwrites(self):
        m = new_master()
        m['data'] = {'notes': {'a': {'gid': 'a', 'updatedAt': 100, 'v': 'old'}}}
        incoming = {'notes': [{'gid': 'a', 'updatedAt': 300, 'v': 'new'}]}
        merge_into_master(m, incoming, [], now=5000)
        assert m['data']['notes']['a']['v'] == 'new'

    def test_older_ignored(self):
        m = new_master()
        m['data'] = {'notes': {'a': {'gid': 'a', 'updatedAt': 300, 'v': 'old'}}}
        incoming = {'notes': [{'gid': 'a', 'updatedAt': 100, 'v': 'new'}]}
        merge_into_master(m, incoming, [], now=5000)
        assert m['data']['notes']['a']['v'] == 'old'

    def test_new_gid_added(self):
        m = new_master()
        incoming = {'notes': [{'gid': 'b', 'updatedAt': 200, 'v': 'x'}]}
        merge_into_master(m, incoming, [], now=5000)
        assert m['data']['notes']['b']['v'] == 'x'

    def test_dirty_updatedAt_normalized(self):
        # 字符串形式的 updatedAt 也应参与比较
        m = new_master()
        m['data'] = {'notes': {'a': {'gid': 'a', 'updatedAt': "100", 'v': 'old'}}}
        incoming = {'notes': [{'gid': 'a', 'updatedAt': "300", 'v': 'new'}]}
        merge_into_master(m, incoming, [], now=5000)
        assert m['data']['notes']['a']['v'] == 'new'
        assert isinstance(m['data']['notes']['a']['updatedAt'], int)


class TestTombstone:
    def test_prevent_resurrect(self):
        m = new_master()
        m['tombstones'] = {'a': {'gid': 'a', 'storeName': 'notes', 'deletedAt': 400}}
        incoming = {'notes': [{'gid': 'a', 'updatedAt': 300, 'v': 'revived'}]}
        merge_into_master(m, incoming, [], now=5000)
        assert 'a' not in m['data'].get('notes', {})

    def test_resurrect_allowed_if_incoming_newer_than_tomb(self):
        m = new_master()
        m['tombstones'] = {'a': {'gid': 'a', 'storeName': 'notes', 'deletedAt': 200}}
        incoming = {'notes': [{'gid': 'a', 'updatedAt': 400, 'v': 'new'}]}
        merge_into_master(m, incoming, [], now=5000)
        assert m['data']['notes']['a']['v'] == 'new'

    def test_tombstone_latest_wins(self):
        m = new_master()
        m['tombstones'] = {'a': {'gid': 'a', 'storeName': 'notes', 'deletedAt': 100}}
        incoming_t = [{'gid': 'a', 'storeName': 'notes', 'deletedAt': 300}]
        merge_into_master(m, {}, incoming_t, now=5000)
        assert m['tombstones']['a']['deletedAt'] == 300

    def test_delete_propagation(self):
        m = new_master()
        m['data'] = {'notes': {'a': {'gid': 'a', 'updatedAt': 100, 'v': 'x'}}}
        incoming_t = [{'gid': 'a', 'storeName': 'notes', 'deletedAt': 200}]
        merge_into_master(m, {}, incoming_t, now=5000)
        assert 'a' not in m['data']['notes']


class TestTimelineDedup:
    def test_dup_removed_keep_latest(self):
        m = new_master()
        m['data'] = {'timeline_logs': {
            'g1': {'gid': 'g1', 'date': '2026-08-12', 'hour': 14, 'content': '写代码', 'updatedAt': 100},
            'g2': {'gid': 'g2', 'date': '2026-08-12', 'hour': 14, 'content': '写代码', 'updatedAt': 300},
        }}
        merge_into_master(m, {}, [], now=5000)
        assert 'g2' in m['data']['timeline_logs']
        assert 'g1' not in m['data']['timeline_logs']
        assert m['tombstones'].get('g1', {}).get('storeName') == 'timeline_logs'

    def test_hour_string_normalized(self):
        m = new_master()
        incoming = {'timeline_logs': [
            {'gid': 'x', 'date': '2026-08-12', 'hour': '14', 'content': 'a', 'updatedAt': 100}
        ]}
        merge_into_master(m, incoming, [], now=5000)
        assert m['data']['timeline_logs']['x']['hour'] == 14
        assert isinstance(m['data']['timeline_logs']['x']['hour'], int)

    def test_different_content_not_deduped(self):
        m = new_master()
        m['data'] = {'timeline_logs': {
            'g1': {'gid': 'g1', 'date': '2026-08-12', 'hour': 14, 'content': '写代码', 'updatedAt': 100},
            'g2': {'gid': 'g2', 'date': '2026-08-12', 'hour': 14, 'content': '喝水', 'updatedAt': 300},
        }}
        merge_into_master(m, {}, [], now=5000)
        assert 'g1' in m['data']['timeline_logs']
        assert 'g2' in m['data']['timeline_logs']


class TestMasterTimestamp:
    def test_updatedAt_set(self):
        m = new_master()
        merge_into_master(m, {}, [], now=9999)
        assert m['updatedAt'] == 9999
