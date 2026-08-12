"""一次性脚本：把 3 条 github-weekly 笔记按新两行 prompt 重消化。
- 备份 master.json -> master.json.bak2
- 对每条 github-weekly 调 DeepSeek（复制 server.py 的新两行 sys_prompt）
- 新 note 覆盖回 master.json，原 note 存到 legacy_note 字段（可回滚）
- 同步清 github_digests.json 缓存（删 3 条 name + 写新结果）
"""
import json, os, shutil, urllib.request, urllib.error

WEBROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # workspace/
SYNC = os.path.join(WEBROOT, '.sync')
MASTER = os.path.join(SYNC, 'master.json')
BAK = os.path.join(SYNC, 'master.json.bak2')
CACHE = os.path.join(SYNC, 'github_digests.json')

SYS_PROMPT = (
    "你是技术洞察分析师。对给定的GitHub仓库写中文极简分析（**模仿 GitHub 周榜 Digest HTML 的两行格式**）。\n\n"
    "格式要求（**严格**）：\n"
    "1. **只输出两行**，用换行分隔，每行（含前缀）不超过 40 字：\n"
    "   第一行以「作者在干嘛：」开头，说清这个仓库在做什么、解决什么问题（动宾、抓本质，不要「他介绍了…」套话）\n"
    "   第二行以「关联工作台：」开头，写对「第二大脑工作台」的具体落地启发（落到本地优先/IndexedDB/语义回忆/自动化/标签治理 等具体机制上）\n"
    "2. 不用任何章节标题（不要 ### 核心观点/### 结论/### 适用场景/### 行动建议），不要其他前缀。\n"
    "3. 直接输出两行正文，不要任何客套话/导语/总结。\n\n"
    "如果仓库信息太少说不清，就只输出一行「信息不足、跳过」即可。"
)

def ds_config():
    key = base = model = None
    p = os.path.join(WEBROOT, '.env')
    if os.path.exists(p):
        with open(p, encoding='utf-8') as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith('#') or '=' not in line:
                    continue
                k, v = line.split('=', 1)
                k = k.strip()
                if k == 'OPENAI_API_KEY': key = v.strip()
                elif k == 'OPENAI_BASE_URL': base = v.strip()
                elif k == 'OPENAI_MODEL': model = v.strip()
    key = key or os.environ.get('OPENAI_API_KEY')
    base = base or os.environ.get('OPENAI_BASE_URL') or 'https://api.openai.com/v1'
    model = model or os.environ.get('OPENAI_MODEL') or 'deepseek-chat'
    return key, base, model

def digest(name, url, description, zh):
    key, base, model = ds_config()
    if not key:
        raise RuntimeError('OPENAI_API_KEY 未配置')
    user_content = json.dumps({'name': name, 'url': url, 'description': description or '', 'summary': zh or ''}, ensure_ascii=False)
    url_api = base.rstrip('/') + '/chat/completions'
    payload = {
        'model': model,
        'messages': [
            {'role': 'system', 'content': SYS_PROMPT},
            {'role': 'user', 'content': f"请分析这个 GitHub 项目：\n\n{user_content}"}
        ],
        'temperature': 0.5,
        'max_tokens': 800,
    }
    headers = {'Content-Type': 'application/json', 'Authorization': f'Bearer {key}'}
    req = urllib.request.Request(url_api, data=json.dumps(payload).encode('utf-8'), headers=headers, method='POST')
    with urllib.request.urlopen(req, timeout=60) as resp:
        data = json.loads(resp.read().decode('utf-8'))
    return data['choices'][0]['message']['content'].strip()

def main():
    # 1. 备份
    shutil.copy2(MASTER, BAK)
    print(f'[backup] {MASTER} -> {BAK}')

    d = json.load(open(MASTER, encoding='utf-8'))
    notes = d['data']['learn_notes']
    gw = {k: v for k, v in notes.items() if v.get('source') == 'github-weekly'}
    print(f'[scan] github-weekly 笔记数 = {len(gw)}')

    # 读旧缓存
    cache = {}
    if os.path.exists(CACHE):
        try: cache = json.load(open(CACHE, encoding='utf-8'))
        except Exception: cache = {}

    # 2. 逐条重消化
    new_notes = {}
    for gid, v in gw.items():
        name = (v.get('title') or '').strip()  # title 即 owner/repo
        if not name:
            print(f'[skip] {gid} 无 title，跳过')
            continue
        try:
            # 旧 4 章节 note 本身信息充足，把它当 summary 喂回 DeepSeek 提炼两行
            old_note = v.get('legacy_note') or v.get('note', '')
            new = digest(name, v.get('url', ''), v.get('description', ''), old_note[:1500])
            # 校验
            if '作者' not in new and '关联' not in new:
                print(f'[warn] {gid} ({name}) 返回格式异常：{new[:60]}')
            v['legacy_note'] = v.get('note', '')  # 保留原 note
            v['note'] = new
            new_notes[name] = new
            # 同步缓存：删旧 + 写新
            cache.pop(name, None)
            cache[name] = new
            print(f'[ok] {gid} ({name}) 新 note：\n{new}\n')
        except Exception as e:
            print(f'[fail] {gid} ({name}) 失败：{e}（保留原 note）')

    # 3. 写回 master.json
    json.dump(d, open(MASTER, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
    print(f'[write] master.json 已更新（保留 legacy_note 字段回滚）')

    # 4. 写回缓存
    json.dump(cache, open(CACHE, 'w', encoding='utf-8'), ensure_ascii=False, indent=2)
    print(f'[write] github_digests.json 缓存已同步（旧条目已删+新结果写入）')

    # 5. 验证
    print('\n=== 验证：新 note 长度 ===')
    for gid, v in gw.items():
        n = v.get('note', '')
        print(f'  {gid} len={len(n)} 含两行={"作者在干嘛" in n and "关联工作台" in n}')

if __name__ == '__main__':
    main()
