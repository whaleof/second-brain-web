#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
日终融合总结 → Notion（Daily Fusion）

把一天的多路原始记录（随想 / 时间轴 / 习惯打卡 / 计划 / 饮品）融合成一份总结，
经 DeepSeek 提炼后写进 Notion 的 Calendar 数据库（Name = 关键词串，Date = 当天）。

输入源（均读 master.json）：
    thoughts         随想
    timeline_logs    时间轴
    habits+habit_logs 习惯打卡
    plans            计划
    drink_records    饮品

用法：
    # 汇总昨天（默认），真实写 Notion
    #   默认优先读本地缓存（data/fusion_cache/日期.json），有缓存就复用、不重烧 LLM；
    #   无缓存才跑 LLM 并落缓存。写 Notion 失败也保留缓存，重跑自动复用。
    python daily_fusion.py

    # 汇总指定日期
    python daily_fusion.py --date 2026-08-08

    # 强制重新融合（忽略本地缓存，重烧 LLM 并覆盖缓存）
    python daily_fusion.py --date 2026-08-08 --fresh

    # 只跑 LLM + 解析，不写 Notion（用于验证格式）
    python daily_fusion.py --date 2026-08-08 --dry-run

备注：融合结果先落本地缓存，Notion 写入失败不丢内容、也不重烧 LLM。
"""

import argparse
import json
import os
import re
import sys
import time
from datetime import datetime, timedelta

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import notion_common as nc

WORKSPACE = nc.WORKSPACE
MASTER_FILE = os.path.join(WORKSPACE, '.sync', 'master.json')
PROMPT_FILE = os.path.join(WORKSPACE, 'prompts', 'daily_fusion_prompt.txt')

# 七段 callout 顺序 + 标题（不放图标，纯文字段头）；「看见」为第 7 段收尾
SECTION_ORDER = [
    ('一天',         '一天'),
    ('有效时间',    '有效时间'),
    ('感受',         '感受'),
    ('思考的问题',  '思考的问题'),
    ('进步·改变',  '进步/改变'),
    ('计划',         '计划'),
    ('看见',         '看见'),
]  # name 取自 LLM sections 的 key，header 为 callout 内部显示的纯文字段头（无图标）

IMG_RE = re.compile(r'!\[.*?\]\(.*?\)|@image#[^\s\]]+\[\]')


# ---------- 本地缓存（融合结果先落盘，Notion 写失败不丢、不重烧 LLM） ----------
# 2026-08-10 用户拍板：写 Notion 失败就先缓存，别一遍遍重跑 LLM。
CACHE_DIR = os.path.join(WORKSPACE, 'data', 'fusion_cache')


def cache_path(date):
    return os.path.join(CACHE_DIR, f'{date}.json')


def save_cache(date, title, sections, raw):
    """LLM 融合一完成就落盘，无论后面写 Notion 成不成功内容都不丢。"""
    os.makedirs(CACHE_DIR, exist_ok=True)
    payload = {
        'date': date,
        'title': title,
        'sections': sections,
        'raw': raw,
        'cached_at': datetime.now().isoformat(timespec='seconds'),
    }
    with open(cache_path(date), 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)


def load_cache(date):
    p = cache_path(date)
    if not os.path.exists(p):
        return None
    try:
        with open(p, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return None


def clear_cache(date):
    p = cache_path(date)
    if os.path.exists(p):
        try:
            os.remove(p)
        except Exception:
            pass



# ---------- 本地 .env 支持（密钥放文件，不进聊天/仓库）----------
def _load_dotenv_local():
    dotenv = os.path.join(WORKSPACE, '.env')
    if not os.path.exists(dotenv):
        return
    try:
        with open(dotenv, 'r', encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                k, v = line.split('=', 1)
                k, v = k.strip(), v.strip().strip('"').strip("'")
                if k and k not in os.environ:
                    os.environ[k] = v
    except Exception:
        pass


# ---------- master.json 读取 ----------

def load_master():
    if not os.path.exists(MASTER_FILE):
        return {'data': {}, 'tombstones': {}}
    with open(MASTER_FILE, 'r', encoding='utf-8') as f:
        return json.load(f)


def _store(master, name):
    return master.get('data', {}).get(name, {})


def _dead(master):
    return set(master.get('tombstones', {}).keys())


def _clean(text):
    if not isinstance(text, str):
        return ''
    return IMG_RE.sub('', text).strip()


# ---------- 各路采集器 ----------

def collect_thoughts(master, date):
    dead = _dead(master)
    items = []
    for gid, r in _store(master, 'thoughts').items():
        if r.get('date') != date or gid in dead:
            continue
        txt = _clean(r.get('text', ''))
        if not txt:
            continue
        t = r.get('time') or ''
        kind = r.get('kind') or ''
        items.append(f'{t} {txt}（{kind}）' if t else f'{txt}（{kind}）')
    return items


def collect_timeline(master, date):
    dead = _dead(master)
    items = []
    for gid, r in _store(master, 'timeline_logs').items():
        if r.get('date') != date or gid in dead:
            continue
        content = _clean(r.get('content', ''))
        if not content:
            continue
        h = r.get('hour')
        try:
            h = int(h) % 24
        except (TypeError, ValueError):
            h = 0
        items.append((h, content))
    items.sort(key=lambda x: x[0])
    return [f'{h:02d}:00 {c}' for h, c in items]


def _habit_display_name(master, hgid, hid=None):
    """把 habit_logs 里的 habitGid / habitId 解析成可读习惯名。
    优先用 habitGid 的 'hb-' 前缀（如 hb-记账 -> 记账）；回退查 habits 表（gid 或数字 id）。"""
    if hgid and str(hgid).startswith('hb-'):
        return str(hgid)[3:]
    habits = {g: r for g, r in _store(master, 'habits').items() if g not in _dead(master)}
    if hgid and hgid in habits:
        return habits[hgid].get('name', hgid)
    if hid is not None:
        for g, r in habits.items():
            if r.get('id') == hid:
                return r.get('name', hgid)
    return (hgid or '习惯')


def collect_habits(master, date):
    dead = _dead(master)
    items = []
    for gid, r in _store(master, 'habit_logs').items():
        if r.get('date') != date or gid in dead:
            continue
        name = _habit_display_name(master, r.get('habitGid'), r.get('habitId'))
        done = r.get('done')
        mark = '✓' if done else '✗'
        items.append(f'{name} {mark}')
    return items


def collect_plans(master, date):
    dead = _dead(master)
    items = []
    for gid, r in _store(master, 'plans').items():
        if gid in dead or r.get('archived'):
            continue
        ptype = r.get('planType')
        if ptype not in ('today', 'tomorrow'):
            continue
        pdate = r.get('planDate')
        if pdate and pdate != date and ptype == 'today':
            continue
        title = _clean(r.get('title', ''))
        if not title:
            continue
        status = '已完成' if r.get('status') == 'completed' else '进行中'
        items.append(f'[{status}] {title}（{ptype}）')
    return items


def collect_drinks(master, date):
    dead = _dead(master)
    type_label = {'milktea': '奶茶', 'coffee': '咖啡', 'fruit': '果茶', 'other': '其他'}
    items = []
    for gid, r in _store(master, 'drink_records').items():
        if r.get('date') != date or gid in dead:
            continue
        name = _clean(r.get('name', '未知'))
        t = r.get('type', 'other')
        rating = r.get('rating') or 0
        price = r.get('price') or 0
        stars = '★' * int(rating) if rating else ''
        price_s = f' ¥{price}' if price else ''
        items.append(f'{name}（{type_label.get(t, t)}{stars}{price_s}）')
    return items


# ---------- 跨天历史数据采集（供「看见」段做对比） ----------

# 历史窗口：近 DETAIL_DAYS 天给逐条明细，更早到 TOTAL_DAYS 天聚合成趋势摘要
HISTORY_DETAIL_DAYS = 7
HISTORY_TOTAL_DAYS = 30


def collect_habits_history(master, date, detail_days=HISTORY_DETAIL_DAYS, total_days=HISTORY_TOTAL_DAYS):
    """返回 (detail: {日期:[行]}, agg: 趋势摘要字符串)。
    近 detail_days 天逐条明细（不含当天）；更早到 total_days 天聚合成完成率/最常漏项等趋势。"""
    dead = _dead(master)
    try:
        target = datetime.strptime(date, '%Y-%m-%d')
    except (ValueError, TypeError):
        return {}, ''
    detail = {}
    total_records = 0
    total_done = 0
    missed_counter = {}
    for i in range(1, total_days + 1):
        d = (target - timedelta(days=i)).strftime('%Y-%m-%d')
        logs = [r for gid, r in _store(master, 'habit_logs').items()
                if r.get('date') == d and gid not in dead]
        if not logs:
            if i <= detail_days:
                detail[d] = ['（无打卡）']
            continue
        done_n = sum(1 for r in logs if r.get('done'))
        total_n = len(logs)
        total_records += total_n
        total_done += done_n
        missed = [_habit_display_name(master, r.get('habitGid'), r.get('habitId')) for r in logs if not r.get('done')]
        for m in missed:
            missed_counter[m] = missed_counter.get(m, 0) + 1
        if i <= detail_days:
            s = f'{done_n}/{total_n} 完成'
            if missed:
                s += f'，漏了{"、".join(missed)}'
            detail[d] = [s]
    if total_records:
        rate = round(100 * total_done / total_records)
        agg = f'近{total_days}天习惯完成率 {rate}%（{total_done}/{total_records}次打卡）'
        if missed_counter:
            top = sorted(missed_counter.items(), key=lambda x: -x[1])[:3]
            agg += '；最常漏：' + '、'.join(f'{n}×{c}' for n, c in top)
    else:
        agg = ''
    return detail, agg


def collect_drinks_history(master, date, detail_days=HISTORY_DETAIL_DAYS, total_days=HISTORY_TOTAL_DAYS):
    """返回 (detail: {日期:[行]}, agg: 趋势摘要字符串)。
    近 detail_days 天逐条明细（不含当天）；更早到 total_days 天聚合成杯数/均分/异常等趋势。"""
    dead = _dead(master)
    type_label = {'milktea': '奶茶', 'coffee': '咖啡', 'fruit': '果茶', 'other': '其他'}
    try:
        target = datetime.strptime(date, '%Y-%m-%d')
    except (ValueError, TypeError):
        return {}, ''
    detail = {}
    total_cups = 0
    ratings = []
    multi_day = 0
    zero_day = 0
    for i in range(1, total_days + 1):
        d = (target - timedelta(days=i)).strftime('%Y-%m-%d')
        recs = [r for gid, r in _store(master, 'drink_records').items()
                if r.get('date') == d and gid not in dead]
        if not recs:
            if i <= detail_days:
                detail[d] = ['（无）']
            zero_day += 1
            continue
        lines = []
        for r in recs:
            name = _clean(r.get('name', '未知'))
            t = r.get('type', 'other')
            rating = r.get('rating') or 0
            price = r.get('price') or 0
            stars = '★' * int(rating) if rating else ''
            price_s = f' ¥{price}' if price else ''
            lines.append(f'{name}（{type_label.get(t, t)}{stars}{price_s}）')
            total_cups += 1
            if rating:
                ratings.append(rating)
        if len(recs) >= 2:
            multi_day += 1
        if i <= detail_days:
            detail[d] = lines
    if total_cups:
        avg = round(sum(ratings) / len(ratings), 1) if ratings else 0
        agg = f'近{total_days}天饮品 {total_cups} 杯，均分 {avg}★'
        if multi_day:
            agg += f'；{multi_day} 天喝了≥2杯'
        if zero_day:
            agg += f'；{zero_day} 天没喝'
    else:
        agg = ''
    return detail, agg


def build_context(date):
    master = load_master()
    parts = [f'【日期】{date}', '']
    secs = [
        ('随想', collect_thoughts(master, date)),
        ('时间轴', collect_timeline(master, date)),
        ('习惯打卡', collect_habits(master, date)),
        ('计划', collect_plans(master, date)),
        ('饮品', collect_drinks(master, date)),
    ]
    for label, items in secs:
        parts.append(f'【{label}】')
        if items:
            parts.extend('  - ' + i for i in items)
        else:
            parts.append('  （无）')
        parts.append('')
    # 跨天历史数据（近7天明细 + 近30天聚合趋势，供「看见」段做对比）
    hist_habits_detail, hist_habits_agg = collect_habits_history(master, date)
    hist_drinks_detail, hist_drinks_agg = collect_drinks_history(master, date)
    has_hist = any([hist_habits_detail, hist_drinks_detail, hist_habits_agg, hist_drinks_agg])
    if has_hist:
        parts.append('【历史对比（近7天明细 + 近30天趋势，供「看见」段参考）】')
        parts.append('  近7天明细：')
        if hist_habits_detail:
            parts.append('    习惯：')
            for d in sorted(hist_habits_detail):
                parts.extend(f'      - {d}：{line}' for line in hist_habits_detail[d])
        if hist_drinks_detail:
            parts.append('    饮品：')
            for d in sorted(hist_drinks_detail):
                parts.extend(f'      - {d}：{line}' for line in hist_drinks_detail[d])
        parts.append('  近30天趋势：')
        parts.append(f'    习惯：{hist_habits_agg or "（无数据）"}')
        parts.append(f'    饮品：{hist_drinks_agg or "（无数据）"}')
        parts.append('')
    return '\n'.join(parts).strip()


# ---------- LLM ----------

def call_llm(system_prompt, user_prompt):
    _load_dotenv_local()
    api_key = os.environ.get('OPENAI_API_KEY')
    base = os.environ.get('OPENAI_BASE_URL', 'https://api.openai.com/v1')
    model = os.environ.get('OPENAI_MODEL', 'deepseek-chat')
    if not api_key:
        raise RuntimeError('未找到 OPENAI_API_KEY（请检查 workspace/.env 或环境变量）')
    from openai import OpenAI
    client = OpenAI(api_key=api_key, base_url=base)
    resp = client.chat.completions.create(
        model=model,
        messages=[
            {'role': 'system', 'content': system_prompt},
            {'role': 'user', 'content': user_prompt},
        ],
        temperature=0.2,
        max_tokens=1500,
    )
    return resp.choices[0].message.content


def _extract_json(text):
    """从 LLM 输出里抠出 JSON（兼容 ```json 围栏 / 前后多余文字）。"""
    t = text.strip()
    if t.startswith('```'):
        t = re.sub(r'^```[a-zA-Z]*\n?', '', t)
        t = re.sub(r'\n?```$', '', t)
        t = t.strip()
    try:
        return json.loads(t)
    except Exception:
        m = re.search(r'\{.*\}', t, re.DOTALL)
        if m:
            return json.loads(m.group(0))
        raise


def generate_summary(date):
    system_prompt = open(PROMPT_FILE, 'r', encoding='utf-8').read()
    user_prompt = build_context(date)
    raw = call_llm(system_prompt, user_prompt)
    data = _extract_json(raw)
    title = (data.get('title') or '').strip()
    sections = data.get('sections', {})
    if not title:
        title = date  # 兜底，避免空标题
    # 兜底：标题里的高频孤立名词自动补默认动词（用户反复强调）
    title = normalize_title(title)
    return title, sections, raw


# ---------- 标题标准化（无害结构整理 + 剔除 trivial） ----------
# 新哲学（2026-08-10 用户拍板）：标题是"这一天的一句话标识"，极简、高维、抓标志性事件，
# **绝不**是流水账。所以这里不再给食物/饮品硬加动词（那会产出"喝鸭屎香柠檬茶"式垃圾），
# 只做：①「加」→「+」 ②折叠 // ③合成 token 内主词去重 ④**主动删掉 trivial 日常 token**。
import re

# 抽取"主词"（去掉动词前缀），用于 token 内去重
_VERB_PREFIX = re.compile(r'^[吃喝买穿戴改通修刷看聊学跑走逛出入]')

# trivial 日常 token：人人都干、对"标识这天"毫无意义，标题里直接丢弃。
# 命中即删（token 完全等于其中之一，或主词等于其中之一）。
_TRIVIAL = {
    '睡觉', '睡', '吃饭', '吃', '吃飯', '看综艺', '刷手机', '玩手机', '休息',
    '咖啡', '奶茶', '果茶', '饮料', '喝水', '喝', '喝咖啡', '喝奶茶',
    '状态好', '有产出', '没事干', '很无聊',
}


def _bare_word(s):
    return _VERB_PREFIX.sub('', s)


def _dedup_token(t):
    """合成 token 'X+Y+Z' 内有重复主词时，删掉重复部分（用「+」连接）。"""
    if '+' not in t:
        return t
    parts = t.split('+')
    seen = set()
    out = []
    for p in parts:
        bare = _bare_word(p.strip())
        if bare in seen or not bare:
            continue
        seen.add(bare)
        out.append(p)
    return '+'.join(out) if out else t


def normalize_title(title):
    """只做无害整理 + 剔除 trivial 日常 token；**不**给食物饮品硬加动词。
    兼容性：// 在用户新规则下被禁用，做一次折叠兜底；「加」与「+」统一为「+」。"""
    if not title:
        return title
    # 先把「加」标准化为「+」，便于后续统一处理（LLM 常输出汉字「加」）
    title = title.replace('加', '+')
    # 兜底：先折叠 // 为 /
    title = title.replace('///', '/').replace('//', '/')
    while '//' in title:
        title = title.replace('//', '/')
    tokens = [t.strip() for t in title.split('/') if t.strip()]
    out_tokens = []
    for t in tokens:
        # 整 token 或主词命中 trivial → 丢弃（如"睡觉""看综艺""鸭屎香柠檬茶"含"奶茶"主词→删）
        if t in _TRIVIAL or _bare_word(t) in _TRIVIAL:
            continue
        # 合成 token 内主词去重
        if '+' in t:
            t = _dedup_token(t)
        if t:
            out_tokens.append(t)
    # 若剔除后空了，兜底回退到原 token（不让标题变空）
    if not out_tokens:
        out_tokens = [tok for tok in tokens if tok]
    return '/'.join(out_tokens)


# ---------- Notion 块构造 ----------

def build_blocks(title, sections):
    b = []
    # 不在 body 重复标题（Notion 数据库 Name 已显示，重复一次是冗余）
    for name, header in SECTION_ORDER:
        raw = sections.get(name)
        # 兼容两种返回：list[str]（新格式）或 str（旧格式兼容）
        if isinstance(raw, list):
            items = [str(x).strip() for x in raw if str(x).strip()]
        else:
            text = (raw or '').strip()
            items = [text] if text else []
        # quote 块只放标题（带左竖线），内容作为普通 paragraph 在 quote 外（不带竖线）
        # 空 items 时只渲染一个空 quote 标题块，符合手写笔记「这一段今天没东西」的留白
        b.append(nc.block_quote_title(header))
        b.extend(nc.block_paragraphs(items))
        b.append(nc.block_empty())
    if len(b) > 100:
        b = b[:100]
    return b


# ---------- 主流程 ----------

def run(date, dry_run=False, fresh=False):
    print(f'[daily_fusion] 汇总日期={date}  dry_run={dry_run}  fresh={fresh}')

    # 1) 决定内容来源：默认优先读缓存（不重烧 LLM），--fresh 才强制重算
    cache = None if fresh else load_cache(date)
    if cache:
        title = cache['title']
        sections = cache['sections']
        raw = cache.get('raw', '')
        print(f'[cache] 命中本地缓存 {cache_path(date)}，跳过 LLM 融合（如需重算加 --fresh）')
    else:
        title, sections, raw = generate_summary(date)
        # 融合一完成就落缓存——后面写 Notion 成不成功内容都不丢
        save_cache(date, title, sections, raw)
        print(f'[cache] 融合结果已落本地缓存 {cache_path(date)}')

    print('--- LLM 产出标题 ---')
    print(title)
    print('--- LLM 七段 ---')
    for name, _ in SECTION_ORDER:
        v = sections.get(name, [])
        if isinstance(v, list):
            empty = '(空)' if not v else f'{len(v)} 条'
        else:
            v = (v or '').strip()
            empty = '(空)' if not v else '1 段'
        print(f'  [{name}] {empty}')
    print('-------------------')

    blocks = build_blocks(title, sections)

    if dry_run or not blocks:
        print(f'[dry_run] 不写 Notion。block 数={len(blocks)}')
        return True

    token, db_id = nc.load_config()
    if not token:
        print(json.dumps({'ok': False, 'reason': 'no token',
                          'hint': '请在 C:/Users/Lenovo/.workbuddy/notion_config.json 配置 token',
                          'cache': cache_path(date)},
                         ensure_ascii=False, indent=2))
        return False

    # 去重：同一天 + 同名标题已存在则跳过
    existing = nc.query_existing(db_id, token, date, name_match=title)
    if existing:
        print(json.dumps({'ok': True, 'date': date, 'skipped': True,
                          'reason': '同名页面已存在', 'page_id': existing},
                         ensure_ascii=False))
        return True

    # 2) 写 Notion：失败保留缓存 + 友好提示，绝不重烧 LLM
    try:
        pid, url = nc.create_page(db_id, token, date, title, blocks)
    except Exception as e:
        err = str(e)
        base_hint = (f'融合内容已缓存在 {cache_path(date)}，'
                     f'直接重跑 `daily_fusion.py --date {date}` 会自动复用缓存写 Notion，无需重烧 LLM')
        # 连接被重置（10054）= 运行环境到 api.notion.com 的出口被 RST，通常开代理/直连可解
        if ('10054' in err or 'WinError' in err or '远程主机强迫关闭' in err
                or 'Connection reset' in err or 'getaddrinfo' in err):
            base_hint += ('\n⚠️ 这是到 api.notion.com 的 TLS 连接被远端重置（典型 WinError 10054）：'
                          '本运行环境的出口被挡，与代码无关。先在本机开代理 / 确认能直连 Notion，'
                          '再重跑同一命令即可落库（缓存命中、不重烧 LLM）。')
        print(json.dumps({'ok': False, 'error': err, 'hint': base_hint},
                         ensure_ascii=False, indent=2))
        return False

    print(json.dumps({'ok': True, 'date': date, 'page_id': pid, 'url': url,
                      'title': title, 'block_count': len(blocks),
                      'cache': cache_path(date) + '（已保留作本地双备份）'},
                     ensure_ascii=False))
    return True


def main():
    parser = argparse.ArgumentParser(description='日终融合总结 → Notion')
    parser.add_argument('--date', default=(datetime.now() - timedelta(days=1)).strftime('%Y-%m-%d'),
                        help='汇总哪一天（默认昨天）')
    parser.add_argument('--dry-run', action='store_true', help='只跑 LLM+解析，不写 Notion')
    parser.add_argument('--fresh', action='store_true',
                        help='强制重新融合（忽略本地缓存，重烧 LLM 并覆盖缓存）')
    args = parser.parse_args()
    try:
        ok = run(args.date, args.dry_run, args.fresh)
    except Exception as e:
        print(json.dumps({'ok': False, 'error': str(e),
                          'hint': f'若融合已完成，可重跑 `daily_fusion.py --date {args.date}` 复用本地缓存'},
                         ensure_ascii=False))
        sys.exit(1)
    sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
