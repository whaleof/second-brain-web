#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
AI / Agent 认知吸收卡 · 沉淀脚本
=================================
用途：把「AI-Agent 认知吸收卡」的合成结果落盘。
  1) 每周生成一页独立 HTML：cards/认知吸收归档/AI-Agent-YYYY-Www.html
     —— 不追加、不覆盖历史，跨周自动新文件，内容随当周素材生长。
  2) 同步维护 cards/认知吸收归档/index.html（历史周报索引，自动列出全部）。
  3) 按 source=absorption-ai + dedupKey 合并/更新一条 learn_note 进 .sync/master.json
     -> data.learn_notes（认知模块可读通道；下游吸收卡闸门①已排除合成源，防回声室）。

设计：LLM 负责“合成”，本脚本只负责“持久化”。调用方式：

  python tools/ai_agent_absorption.py --payload /tmp/absorption.json

payload JSON 结构：
{
  "week": "2026-W32",                 # 可选，缺省取当前 ISO 年周
  "summary": { "total": 22, "ai": 12, "done": 2, "pending": 10 },
  "insights": [ {"title": "...", "body": "..."}, ... ],
  "actions":  [ {"title": "...", "body": "..."}, ... ],
  "tags": ["AI", "Agent 架构", ... ]
}
"""
import argparse
import json
import os
import sys
import uuid
from datetime import datetime

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # workspace/
MASTER = os.path.join(ROOT, ".sync", "master.json")
CARDS = os.path.join(os.path.dirname(ROOT), "cards")  # 展示卡统一放仓库根 cards/（与索引卡/多主题卡同目录，相对链接才通）
ARCHIVE_DIR = os.path.join(CARDS, "吸收卡归档")

# 认知模块预设标签（learn_notes.tags 只能取这些，否则不同步进标签体系）
PRESET_TAGS = ['挣钱', '理财', '法律', '自媒体', '科技', 'AI',
               '地缘', '股市', '经济', '商业', '新闻', '油价汇价']


# ─── master.json 读写（原子写，复用 douyin_digest 的约定）──────────────────────
def load_master():
    if not os.path.exists(MASTER):
        return {"version": 2, "updatedAt": 0, "data": {}, "tombstones": {}}
    try:
        with open(MASTER, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {"version": 2, "updatedAt": 0, "data": {}, "tombstones": {}}


def save_master(master):
    os.makedirs(os.path.dirname(MASTER), exist_ok=True)
    tmp = MASTER + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(master, f, ensure_ascii=False)
    os.replace(tmp, MASTER)


# ─── HTML 渲染（沿用现有卡片的粉色主题与结构）──────────────────────────────────
CSS = """<style>
    :root {
      --bg: #FFF5F7; --card: #fff; --text: #4A3F45; --muted: #8B7A82;
      --accent: #F2A6B8; --accent-dark: #D9829A; --border: #FADBE3;
      --tag-bg: #FDEDF2; --insight-bg: #FFF9FB;
    }
    * { box-sizing: border-box; }
    body { margin: 0; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif;
      background: var(--bg); color: var(--text); line-height: 1.7; padding: 24px 16px; }
    .container { max-width: 720px; margin: 0 auto; }
    header { text-align: center; margin-bottom: 28px; }
    header h1 { margin: 0 0 6px; font-size: 26px; color: var(--accent-dark); letter-spacing: 1px; }
    header p { margin: 0; color: var(--muted); font-size: 14px; }
    .summary { display: flex; gap: 12px; justify-content: center; flex-wrap: wrap; margin-bottom: 24px; }
    .chip { background: var(--card); border: 1px solid var(--border); border-radius: 20px;
      padding: 8px 16px; font-size: 13px; color: var(--accent-dark); font-weight: 500; }
    .section { background: var(--card); border-radius: 16px; padding: 20px; margin-bottom: 18px;
      box-shadow: 0 4px 18px rgba(242, 166, 184, 0.12); }
    .section h2 { margin: 0 0 14px; font-size: 17px; color: var(--accent-dark);
      display: flex; align-items: center; gap: 8px; }
    .section h2::before { content: ""; display: inline-block; width: 6px; height: 18px;
      background: var(--accent); border-radius: 3px; }
    .insight { background: var(--insight-bg); border-left: 3px solid var(--accent);
      border-radius: 10px; padding: 14px 16px; margin-bottom: 12px; }
    .insight-title { font-weight: 600; color: var(--accent-dark); margin-bottom: 6px; font-size: 15px; }
    .insight p { margin: 0; font-size: 14px; color: var(--text); }
    .action { display: flex; gap: 12px; align-items: flex-start; margin-bottom: 12px; }
    .action-num { flex-shrink: 0; width: 26px; height: 26px; border-radius: 50%; background: var(--accent);
      color: #fff; display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 600; }
    .action-body { font-size: 14px; }
    .action-body strong { color: var(--accent-dark); }
    .tag-list { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 10px; }
    .tag { background: var(--tag-bg); color: var(--accent-dark); border: 1px solid var(--border);
      border-radius: 12px; padding: 4px 10px; font-size: 12px; }
    .footer { text-align: center; color: var(--muted); font-size: 12px; margin-top: 10px; }
  </style>"""


def esc(s):
    return (s or "").replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")


def render_html(week, summary, insights, actions, tags):
    chips = []
    if summary:
        chips.append(f"<div class=\"chip\">总素材 {summary.get('total','?')} 条</div>")
        chips.append(f"<div class=\"chip\">AI/Agent 相关 {summary.get('ai','?')} 条</div>")
        chips.append(f"<div class=\"chip\">已消化 {summary.get('done','?')} · 待消化 {summary.get('pending','?')}</div>")
    chips_html = "\n      ".join(chips)

    ins_blocks = []
    for i, it in enumerate(insights, 1):
        ins_blocks.append(
            f"      <div class=\"insight\">\n"
            f"        <div class=\"insight-title\">{i}. {esc(it.get('title',''))}</div>\n"
            f"        <p>{esc(it.get('body',''))}</p>\n"
            f"      </div>")
    ins_html = "\n".join(ins_blocks)

    act_blocks = []
    for i, it in enumerate(actions, 1):
        act_blocks.append(
            f"      <div class=\"action\">\n"
            f"        <div class=\"action-num\">{i}</div>\n"
            f"        <div class=\"action-body\"><strong>{esc(it.get('title',''))}</strong><br>{esc(it.get('body',''))}</div>\n"
            f"      </div>")
    act_html = "\n".join(act_blocks)

    tag_blocks = "".join(f"<div class=\"tag\">{esc(t)}</div>" for t in tags)
    gen_time = datetime.now().strftime("%Y-%m-%d %H:%M")

    return f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI/Agent 认知吸收卡 · {esc(week)}</title>
  {CSS}
</head>
<body>
  <div class="container">
    <header>
      <h1>AI / Agent 认知吸收卡</h1>
      <p>来源：工作台「认知」模块 · {esc(week)} 自动提炼（定时自动化）</p>
    </header>

    <div class="summary">
      {chips_html}
    </div>

    <div class="section">
      <h2>{len(insights)} 个核心洞察</h2>
{ins_html}
    </div>

    <div class="section">
      <h2>对工作台的 {len(actions)} 个落地启发</h2>
{act_html}
    </div>

    <div class="section">
      <h2>高频主题标签</h2>
      <div class="tag-list">
        {tag_blocks}
      </div>
    </div>

    <div class="footer">
      本卡由 WorkBuddy 定时读取用户认知模块后生成 · 每周一页、不追加 · 生成于 {gen_time}
    </div>
  </div>
</body>
</html>"""


# ─── 归档索引（列出全部历史周报）──────────────────────────────────────────────
INDEX_CSS = """<style>
  :root{--bg:#FFF5F7;--card:#fff;--text:#4A3F45;--muted:#8B7A82;--accent:#F2A6B8;--accent-dark:#D9829A;--border:#FADBE3;}
  *{box-sizing:border-box;}
  body{margin:0;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;background:var(--bg);color:var(--text);line-height:1.7;padding:24px 16px;}
  .container{max-width:720px;margin:0 auto;}
  header{text-align:center;margin-bottom:24px;}
  header h1{margin:0 0 6px;font-size:24px;color:var(--accent-dark);}
  header p{margin:0;color:var(--muted);font-size:14px;}
  .section{background:var(--card);border-radius:16px;padding:20px;box-shadow:0 4px 18px rgba(242,166,184,0.12);}
  .section h2{margin:0 0 14px;font-size:17px;color:var(--accent-dark);}
  .arch-list{list-style:none;padding:0;margin:0;}
  .arch-list li{padding:11px 0;border-bottom:1px solid var(--border);font-size:15px;}
  .arch-list li:last-child{border-bottom:none;}
  .arch-list a{color:var(--accent-dark);text-decoration:none;font-weight:500;}
  .arch-list a:hover{text-decoration:underline;}
  .footer{text-align:center;color:var(--muted);font-size:12px;margin-top:16px;}
  </style>"""


def update_archive_index(archive_dir):
    """扫描 ARCHIVE_DIR 下所有 AI-Agent-*.html，生成 index.html（最新在上）。"""
    files = sorted(
        [f for f in os.listdir(archive_dir)
         if f.startswith("AI-Agent-") and f.endswith(".html") and f != "index.html"],
        reverse=True,
    )
    items = []
    for fn in files:
        w = fn[len("AI-Agent-"):-len(".html")]
        items.append(f'      <li><a href="{esc(fn)}">AI/Agent 认知吸收 · {esc(w)}</a></li>')
    items_html = "\n".join(items) if items else '      <li style="color:var(--muted)">暂无周报</li>'
    gen_time = datetime.now().strftime("%Y-%m-%d %H:%M")
    idx = f"""<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>AI/Agent 认知吸收 · 周报归档</title>
  {INDEX_CSS}
</head>
<body>
  <div class="container">
    <header>
      <h1>AI/Agent 认知吸收 · 周报归档</h1>
      <p>每周自动生成一页 · 不追加 · 生成于 {gen_time}</p>
    </header>
    <div class="section">
      <h2>历史周报（共 {len(files)} 份）</h2>
      <ul class="arch-list">
{items_html}
      </ul>
    </div>
    <div class="footer">本索引由 ai_agent_absorption.py 自动维护</div>
  </div>
</body>
</html>"""
    with open(os.path.join(archive_dir, "index.html"), "w", encoding="utf-8") as f:
        f.write(idx)


# ─── learn_note 文本（认知模块内可读）──────────────────────────────────────────
def build_note_text(insights, actions, tags):
    lines = ["核心观点（本周 AI/Agent 内化）"]
    for i, it in enumerate(insights, 1):
        lines.append(f"· {it.get('title','')}：{it.get('body','')}")
    lines.append("")
    lines.append("行动建议（对工作台的落地启发）")
    for i, it in enumerate(actions, 1):
        lines.append(f"· {it.get('title','')}：{it.get('body','')}")
    lines.append("")
    lines.append("高频主题：" + " / ".join(tags))
    return "\n".join(lines).strip()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--payload", required=True, help="合成结果 JSON 路径")
    ap.add_argument("--no-db", action="store_true",
                   help="仅生成归档 HTML，跳过写 master.json（避免污染真实数据）")
    args = ap.parse_args()

    payload = json.load(open(args.payload, "r", encoding="utf-8"))
    if payload.get("week"):
        week = payload["week"]
    else:
        y, w, _ = datetime.now().isocalendar()
        week = f"{y}-W{w:02d}"
    summary = payload.get("summary") or {}
    insights = payload.get("insights") or []
    actions = payload.get("actions") or []
    tags = payload.get("tags") or ["AI", "科技"]

    if not insights or not actions:
        print("ERROR: payload 缺少 insights 或 actions", file=sys.stderr)
        sys.exit(2)

    # 1) 写当周 HTML 卡（每周一页，不追加；跨周自动新文件，当周文件周内进化）
    os.makedirs(ARCHIVE_DIR, exist_ok=True)
    card_path = os.path.join(ARCHIVE_DIR, f"AI-Agent-{week}.html")
    html = render_html(week, summary, insights, actions, tags)
    with open(card_path, "w", encoding="utf-8") as f:
        f.write(html)
    # 1b) 更新归档索引
    update_archive_index(ARCHIVE_DIR)

    # 2) 合并 learn_note（source=absorption-ai，按 dedupKey 防每周重复；下游闸门①排除合成源，防回声室）
    #    --no-db 时跳过，仅生成归档 HTML（用于手动验证 / 避免污染真实数据）
    dedup = f"absorption-ai-{week}"
    if not args.no_db:
        master = load_master()
        store = master.setdefault("data", {}).setdefault("learn_notes", {})
        now = int(datetime.now().timestamp() * 1000)
        existing_gid = None
        for g, n in store.items():
            if n.get("dedupKey") == dedup:
                existing_gid = g
                break

        note = {
            "gid": existing_gid or str(uuid.uuid4()),
            "dedupKey": dedup,
            "title": f"AI/Agent 认知吸收 · {week}",
            "url": "",
            "note": build_note_text(insights, actions, tags),
            "tags": [t for t in ["AI", "科技"] if t in PRESET_TAGS],  # 仅取预设标签，保证进标签体系
            "source": "absorption-ai",
            "status": "done",
            "author": "", "authorId": "", "publishDate": "",
            "contentId": "", "canonicalUrl": "",
            "createdAt": (store.get(existing_gid, {}) or {}).get("createdAt", now),
            "updatedAt": now,
        }
        store[note["gid"]] = note
        master["updatedAt"] = now
        save_master(master)
    else:
        print("（--no-db 模式：跳过写 master.json）")

    db_note = "(skip)" if args.no_db else note["gid"][:8]
    print(f"OK card={card_path} note_gid={db_note} dedup={dedup} "
          f"insights={len(insights)} actions={len(actions)}")


if __name__ == "__main__":
    main()
