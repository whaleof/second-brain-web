#!/usr/bin/env python3
"""Generate the visual-card HTML from the restructured markdown (grouped by 5 stages)."""
from pathlib import Path
import re

MD_PATH = Path(r"G:\_06_项目代码\工作台\workspace\docs\工作台问题汇总.md")
HTML_PATH = Path(r"G:\_06_项目代码\工作台\workspace\docs\工作台问题汇总.html")

# circled-number unicode -> int
CIRCLED = {}
for i in range(1, 21):
    CIRCLED[chr(0x2460 + i - 1)] = i
for i in range(21, 36):
    CIRCLED[chr(0x3251 + i - 21)] = i


def num_to_int(s):
    for ch in s:
        if ch in CIRCLED:
            return CIRCLED[ch]
    return s


def rich(text):
    """Convert `code` and **bold** to HTML."""
    # code first
    text = re.sub(r"`([^`]+)`", r"<code>\1</code>", text)
    # bold
    text = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", text)
    return text


def status_badge(status):
    if "未解决" in status:
        return '<span class="badge badge-unsolved">未解决 · 待决策</span>'
    if "持续警惕" in status:
        return '<span class="badge badge-watching">持续警惕</span>'
    return '<span class="badge badge-solved">已解决</span>'


def parse_field_value(lines):
    """Join a field's continuation lines with <br>."""
    return "<br>".join(l.strip() for l in lines if l.strip())


def main():
    md = MD_PATH.read_text(encoding="utf-8")
    lines = md.splitlines()

    # Reuse existing style + head + panorama + footer from current (corrupt-body) html
    cur = HTML_PATH.read_text(encoding="utf-8")
    style_block = re.search(r"<style>.*?</style>", cur, re.DOTALL).group(0)
    # Keep the original first-version width (780px) which the user prefers.
    style_block = style_block.replace("max-width: 1120px;", "max-width: 780px;")
    panorama = '''  <div class="stage-grid">
    <div class="stage-card">
      <div class="num">01</div>
      <div class="title">想清楚</div>
      <div class="desc">MVP 边界 · 需求蔓延</div>
    </div>
    <div class="stage-card">
      <div class="num">02</div>
      <div class="title">做出来</div>
      <div class="desc">代码崩溃 · 功能缺位</div>
    </div>
    <div class="stage-card">
      <div class="num">03</div>
      <div class="title">接 AI</div>
      <div class="desc">自动化对齐 · 离线兜底</div>
    </div>
    <div class="stage-card">
      <div class="num">04</div>
      <div class="title">装上去</div>
      <div class="desc">本地服务 · 部署稳定</div>
    </div>
    <div class="stage-card wide">
      <div class="num">05</div>
      <div class="title">用得久</div>
      <div class="desc">跨端同步 · 数据口径 · 性能体验</div>
    </div>
  </div>'''
    intro = '''  <p class="intro-text">
    下面按「全景图五个阶段」对 33 个坑做分类，每个阶段内问题按踩坑先后顺序排列，全文已按顺序重新编号为 1–33。状态标签：已解决 / 未解决 / 持续警惕。
  </p>'''
    footer = re.search(r'<div class="footer">.*?</div>', cur, re.DOTALL).group(0)

    # Parse md into stages -> cards
    stages = []  # list of dict: num, title, sub, intro, cards
    cur_stage = None
    cur_card = None
    cur_field = None  # (name, [lines])

    def flush_field():
        nonlocal cur_card, cur_field
        if cur_card and cur_field:
            cur_card["fields"].append(cur_field)
        cur_field = None

    def flush_card():
        nonlocal cur_stage, cur_card
        flush_field()
        if cur_stage and cur_card:
            cur_stage["cards"].append(cur_card)
        cur_card = None

    i = 0
    while i < len(lines):
        line = lines[i]
        stripped = line.strip()
        stage_m = re.match(r"^## (.+?)（(.+?)）", line)
        if stage_m:
            flush_card()
            if cur_stage:
                stages.append(cur_stage)
            # parse "## 想清楚（MVP 边界 · 需求蔓延）"
            title = stage_m.group(1).strip()
            sub = stage_m.group(2).strip()
            cur_stage = {"title": title, "sub": sub, "intro": "", "cards": []}
        elif stripped.startswith("> 本阶段"):
            if cur_stage:
                cur_stage["intro"] = stripped.lstrip("> ").strip()
        elif re.match(r"^### ", line):
            flush_card()
            m = re.match(r"^### (\d+)\s+(.+)$", line)
            num = int(m.group(1))
            ctitle = m.group(2)
            cur_card = {"num": num, "title": ctitle, "fields": []}
            cur_field = None
        elif re.match(r"^- \*\*", line):
            flush_field()
            m = re.match(r"^- \*\*(.+?)\*\*[:：]?\s*(.*)$", line)
            fname = m.group(1)
            fval = m.group(2)
            cur_field = (fname, [fval] if fval else [])
        elif cur_field is not None and (line.startswith("  ") or line.startswith("\t")):
            # continuation line
            cur_field[1].append(line.strip())
        else:
            # blank or other -> flush field but keep card
            flush_field()
        i += 1
    flush_card()
    if cur_stage:
        stages.append(cur_stage)

    # Build body
    out = []
    out.append("<!DOCTYPE html>")
    out.append('<html lang="zh-CN">')
    out.append("<head>")
    out.append('<meta charset="UTF-8">')
    out.append('<meta name="viewport" content="width=device-width, initial-scale=1.0">')
    out.append("<title>工作台构建踩坑汇总 · 第二大脑</title>")
    out.append(style_block)
    # add stage-divider styling
    out.append("""
  <style>
  .stage-band {
    margin-top: 30px;
    margin-bottom: 18px;
    padding: 11px 18px;
    background: #F1ECF9;
    border-radius: 12px;
    border-left: 4px solid #8B6FBF;
  }
  .stage-band .stage-title {
    font-size: 15px;
    font-weight: 700;
    color: #4A3B6B;
    letter-spacing: 0.5px;
  }
  .stage-band .stage-sub {
    display: block;
    margin-top: 3px;
    font-size: 12px;
    font-weight: 400;
    color: #8473A8;
  }
  .stage-empty { font-size: 13px; color: var(--text-sub); background: #fff; border: 1.5px dashed var(--border); border-radius: 16px; padding: 16px 20px; margin-bottom: 22px; }
  </style>
""")
    out.append("</head>")
    out.append('<body>')
    out.append('<div class="container">')

    # Panorama section header
    out.append('''
  <div class="section-header">
    <div class="section-num">01</div>
    <div>
      <div class="section-title">全景图：问题集中在哪五个阶段</div>
      <div class="section-sub">The five stages of workbench pitfalls</div>
    </div>
  </div>
''')
    out.append(panorama)
    out.append(intro)
    out.append('''
  <div class="banner">
    我踩过的 33 个迭代版本的坑（按五个阶段分类）
  </div>
''')

    for st in stages:
        out.append(f'''
  <div class="stage-band">
    <span class="stage-title">{st['title']}</span>
    <span class="stage-sub">{st['sub']}</span>
  </div>
''')
        if not st["cards"]:
            out.append('  <p class="stage-empty">本阶段暂无对应踩坑。随想整合 / 时间轴整合 / Notion 导入等自动化已接入并正常运行，记录周期内未在此踩坑。</p>')
        for c in st["cards"]:
            fields = dict((f[0], parse_field_value(f[1])) for f in c["fields"])
            prob = fields.get("踩坑概率", "")
            status = fields.get("状态", "")
            # prob may contain stars + parenthetical; isolate stars
            stars = re.sub(r"（.*?）", "", prob).strip()
            card_html = f'''
  <div class="card">
    <div class="card-header">
      <div class="card-num">{c['num']}</div>
      <div class="card-title-wrap">
        <div class="card-title">{rich(c['title'])}</div>
        <div class="badge-row">
          <span class="badge badge-prob">踩坑概率 <span class="badge-stars">{stars}</span></span>
          {status_badge(status)}
        </div>
      </div>
    </div>
'''
            for label, cls in [("现象", ""), ("我的亲历", " green"), ("方案", "")]:
                if label in fields:
                    card_html += f'    <div class="section-label{cls}">{label}</div>\n    <p>{rich(fields[label])}</p>\n'
            if "怎么和 AI 说" in fields:
                card_html += f'''    <div class="hint-box">
      <div class="hint-box-title">怎么和 AI 说</div>
      <p>{rich(fields["怎么和 AI 说"])}</p>
    </div>
'''
            card_html += '  </div>\n'
            out.append(card_html)

    out.append(footer)
    out.append("</div>")
    out.append("</body>")
    out.append("</html>")

    HTML_PATH.write_text("\n".join(out), encoding="utf-8")
    total = sum(len(s["cards"]) for s in stages)
    print(f"Generated HTML: {len(stages)} stages, {total} cards")


if __name__ == "__main__":
    main()
