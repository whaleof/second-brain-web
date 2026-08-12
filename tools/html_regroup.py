#!/usr/bin/env python3
"""Regroup the pitfall cards in the HTML visual version by the 5 stages."""
from pathlib import Path
import re

HTML_PATH = Path(r"G:\_06_项目代码\工作台\workspace\docs\工作台问题汇总.html")

# card number -> stage (1-based); mirrors the markdown classification
STAGE_MAP = {
    1: 1, 15: 1, 29: 1,                                   # 想清楚
    2: 2, 14: 2, 16: 2, 17: 2, 18: 2, 24: 2, 28: 2,      # 做出来
    # stage 3 接 AI: none
    19: 4, 20: 4, 22: 4, 31: 4,                          # 装上去
}
for n in [3,4,5,6,7,8,9,10,11,12,13,21,23,25,26,27,30,32,33]:
    STAGE_MAP[n] = 5                                     # 用得久

STAGES = {
    1: ("1", "阶段一 · 想清楚", "MVP 边界 · 需求蔓延 · 本阶段 3 条"),
    2: ("2", "阶段二 · 做出来", "代码崩溃 · 功能缺位 · 本阶段 7 条"),
    3: ("3", "阶段三 · 接 AI", "自动化对齐 · 离线兜底 · 本阶段暂无对应踩坑"),
    4: ("4", "阶段四 · 装上去", "本地服务 · 部署稳定 · 本阶段 4 条"),
    5: ("5", "阶段五 · 用得久", "跨端同步 · 数据口径 · 性能体验 · 本阶段 19 条"),
}

content = HTML_PATH.read_text(encoding="utf-8")

# Split: header part (before first card), footer part (after last card), and cards
m = re.search(r"<!-- 1 -->", content)
header = content[:m.start()]
footer_m = re.search(r'<div class="footer">', content)
footer = content[footer_m.start():]

# Extract each card block
pattern = re.compile(r"<!-- (\d+) -->\s*(<div class=\"card\">.*?</div>)\s*", re.DOTALL)
cards = {}
for num, block in pattern.findall(content):
    cards[int(num)] = block

# Build stage sections
stage_html = ""
for stage_idx in [1, 2, 3, 4, 5]:
    num, title, sub = STAGES[stage_idx]
    count = sum(1 for n, s in STAGE_MAP.items() if s == stage_idx)
    stage_html += f'''
  <div class="section-header stage-divider">
    <div class="section-num">{num}</div>
    <div>
      <div class="section-title">{title}</div>
      <div class="section-sub">{sub}</div>
    </div>
  </div>
'''
    if count == 0:
        stage_html += '''
  <p class="stage-empty">本阶段暂无对应踩坑。随想整合 / 时间轴整合 / Notion 导入等自动化已接入并正常运行，记录周期内未在此踩坑。</p>
'''
    else:
        for n, s in sorted(STAGE_MAP.items()):
            if s == stage_idx:
                stage_html += cards[n] + "\n"

# Update banner text
header = re.sub(r"我踩过的 \d+ 个迭代版本的坑", "我踩过的 33 个迭代版本的坑（按五个阶段分类）", header)

new_content = header + stage_html + "\n" + footer

# Add stage-divider styling if missing
if ".stage-divider" not in new_content:
    style_insert = """
  .stage-divider { margin-top: 8px; padding-top: 18px; border-top: 2px dashed var(--border); }
  .stage-empty { font-size: 13px; color: var(--text-sub); background: #fff; border: 1.5px dashed var(--border); border-radius: 16px; padding: 16px 20px; margin-bottom: 22px; }
"""
    # insert before closing </style>
    new_content = new_content.replace("</style>", style_insert + "</style>", 1)

HTML_PATH.write_text(new_content, encoding="utf-8")
print(f"Regrouped HTML: {len(cards)} cards across 5 stages")
