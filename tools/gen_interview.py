#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""把两条抖音图文 OCR 出的面试题，结构化注入 cards/面试题收集.html。"""
import os, io

CARD = r"G:\_06_项目代码\工作台\cards\面试题收集.html"
with io.open(CARD, "r", encoding="utf-8") as f:
    html = f.read()

TYPE_MAP = {"open": "t-open", "eight": "t-eight", "code": "t-code",
            "case": "t-case", "behav": "t-behav"}

def q_block(qno, text, ttype, diff, src):
    cls = TYPE_MAP[ttype]
    return (
        f'    <details class="q">\n'
        f'      <summary><span class="qno">{qno}</span>'
        f'<span class="qt">{text}</span>'
        f'<span class="tag {cls}">{LABEL[ttype]}</span>'
        f'<span class="tag s-undone">未整理</span></summary>\n'
        f'      <div class="qmeta"><span>来源：{src}</span><span>难度：{diff}</span></div>\n'
        f'      <div class="qans">\n'
        f'        <b>我的回答要点：</b>\n'
        f'        <ul><li><span class="hint">待整理（点开写要点）</span></li></ul>\n'
        f'      </div>\n'
        f'    </details>\n'
    )

LABEL = {"open": "开放题", "eight": "八股", "code": "手撕代码",
         "case": "Case/实战", "behav": "行为/HR"}

def build_section(rounds, src):
    out = []
    n = 0
    for round_title, groups in rounds:
        out.append(f'    <div class="grp">{round_title}</div>\n')
        for g_title, qs in groups:
            out.append(f'    <div class="subgrp">{g_title}</div>\n')
            for (text, ttype, diff) in qs:
                n += 1
                out.append(q_block(f"Q{n}", text, ttype, diff, src))
    return "".join(out), n

# ── 爱奇艺 AI 产品经理面试全过程（AI 产品/PM）──
aiqiyi = [
  ("一面 · 基础能力与项目深挖", [
    ("项目经历类（必问·深度追问）", [
      ("请详细介绍你主导或深度参与的一个 AI 产品项目。", "open", "★★☆"),
      ("这个项目的需求是如何发现的？来源是用户反馈、数据分析还是战略规划？", "open", "★★☆"),
      ("项目的核心目标是什么？为什么设定这个指标（如点击率、转化率、停留时长）？", "open", "★★☆"),
      ("你如何定义“好”的数据和特征？在数据标注和质量把控上你做了什么？", "open", "★★★"),
      ("在模型训练和迭代中，你是如何与算法团队协作的？遇到过什么分歧，如何解决？", "open", "★★☆"),
      ("项目最终达成目标了吗？如果没达成，根本原因是什么？", "open", "★★☆"),
      ("如果再给你一次机会，你会从哪些方面改进这个项目？", "open", "★★☆"),
    ]),
    ("AI 技术理解类", [
      ("请解释 RAG 和 Fine-tuning 的区别，分别适合什么场景？", "eight", "★★☆"),
      ("你如何判断一个 AI 需求是“产品问题”还是“技术问题”？", "open", "★★☆"),
      ("目前大语言模型（LLM）的主要局限性有哪些？产品设计上如何规避？", "open", "★★☆"),
    ]),
    ("场景应用类", [
      ("你觉得 AIGC 在爱奇艺的剧本创作、选角或后期制作环节，有哪些潜在应用场景？", "open", "★★☆"),
      ("你平时用爱奇艺吗？有没有体验不好的地方？如果让你用 AI 来优化，你会怎么做？", "case", "★★☆"),
      ("如何利用 AI 提升长视频的搜索体验？（考虑模糊语义、剧情搜索等）", "case", "★★★"),
      ("AI 生成摘要/预告片时，如何保证内容不剧透且吸引人？", "case", "★★★"),
    ]),
  ]),
  ("二面 · 业务洞察与高压测试", [
    ("竞品与行业分析类", [
      ("在个性化推荐上，爱奇艺与 B站、抖音的核心差异是什么？", "open", "★★☆"),
      ("对比 Netflix，爱奇艺在 AI 应用上有哪些可以借鉴的地方？", "open", "★★☆"),
      ("长视频平台做 AI 相较于短视频平台，劣势和优势分别是什么？", "open", "★★☆"),
    ]),
    ("商业化与增长类", [
      ("如何利用 AI 提升非会员用户的付费转化率？设计一个具体策略。", "case", "★★★"),
      ("如何利用 AI 设计一种更原生、体验更好的广告形式？", "case", "★★★"),
      ("如何通过 AI 减少会员流失（预测流失并干预）？", "case", "★★★"),
      ("AI 功能本身如何变现？你设想过哪些商业模式？", "open", "★★★"),
    ]),
    ("高压追问类（可能连环追问）", [
      ("你刚才说这个项目提升了 X% 的指标，这个数字真实吗？如何验证的？", "behav", "★★☆"),
      ("如果现在让你重新做这个项目，你有信心做得更好吗？为什么？", "behav", "★★☆"),
      ("你提到的方案，算法成本大概是多少？ROI 算过吗？", "open", "★★★"),
      ("用户真的需要这个功能吗？还是你们自己 YY 出来的？", "behav", "★★☆"),
    ]),
  ]),
  ("三面/四面 · 综合决策与跨部门协作", [
    ("跨部门协作类", [
      ("如果你策划了一个需要内容版权部门和技术部门紧密合作的 AI 创新项目，但双方优先级都不高，你会如何推进？", "behav", "★★★"),
      ("当算法团队说“这个需求做不了”时，你通常会怎么做？", "behav", "★★☆"),
      ("你如何向非技术背景的老板汇报一个 AI 项目的进展和价值？", "behav", "★★☆"),
    ]),
    ("数据合规与安全类", [
      ("你的 AI 功能需要大量用户观看行为数据，但法务部门对数据隐私非常谨慎，你会如何应对？", "case", "★★★"),
      ("生成式 AI 可能产生不当内容（如侵权、违规），你如何在产品层面做风险控制？", "case", "★★★"),
    ]),
    ("战略与认知类", [
      ("请分享一个你平衡“技术理想”与“业务现实”最终推动项目落地的经历。", "behav", "★★★"),
      ("你认为爱奇艺在 AI 战略上的核心优势是什么？（数据、内容 IP、场景？）", "open", "★★☆"),
      ("在未来 1-2 年，你认为 AI 会给长视频行业带来最颠覆性的变化可能是什么？", "open", "★★★"),
    ]),
    ("文化契合类", [
      ("你为什么想来爱奇艺做 AI 产品经理？（考察动机和热情）", "open", "★☆☆"),
      ("你平时喜欢看什么类型的影视内容？最近在追什么剧？", "behav", "★☆☆"),
      ("你觉得“技术为内容服务”这句话，你怎么理解？", "open", "★★☆"),
    ]),
    ("反问环节（高价值提问·候选人问面试官）", [
      ("这个岗位目前最迫切希望用 AI 解决的，是内容生命周期中哪个环节的难题？", "open", "★☆☆"),
      ("您认为在未来 1-2 年，这个岗位的成功画像应该是什么样的？", "open", "★☆☆"),
      ("目前团队在 AI 方向的资源和算法支持情况如何？", "open", "★☆☆"),
      ("对于这个岗位，您最看重候选人哪方面的能力或特质？", "open", "★☆☆"),
    ]),
    ("附加 · 可能出现的笔试题/案例分析", [
      ("给一段爱奇艺首页截图，分析推荐策略并给出优化建议。", "case", "★★★"),
      ("给一个用户场景（如“用户看了 5 分钟某剧后关闭”），设计 AI 干预策略。", "case", "★★★"),
      ("估算爱奇艺每天产生多少用户行为数据，这些数据如何用于 AI 模型训练？", "case", "★★★"),
    ]),
  ]),
]

# ── 快手 AI 应用开发 一面（技术向·参考）──
kuaishou = [
  ("快手 AI 应用开发 一面（技术向·可作 PM 面试技术储备参考）", [
    ("（通用）", [
      ("自我介绍。", "behav", "★☆☆"),
    ]),
    ("项目深挖 ① · MinerU 工业文档解析", [
      ("拷打第一个项目：MinerU 在解析工业文档时如何处理图文混排？为什么选择 MinerU？多模态检索中文本和图片如何映射到同一向量空间？为何引入 Ragas 评测、用了哪些指标？Faithfulness 与 AnswerRelevance 的具体计算逻辑是什么？", "eight", "★★★"),
    ]),
    ("项目深挖 ② · 记忆/LangGraph Agent", [
      ("拷打第二个项目：LangGraph 相比于 LangChain 有什么优势？记忆库如何更新用户画像？如何区分短期记忆和长期记忆？安全护栏是如何实现敏感词拦截的？", "eight", "★★★"),
    ]),
    ("RAG / 向量库 / 推理基础（八股）", [
      ("在 RAG 中，文档切片的粒度如何选择？", "eight", "★★☆"),
      ("向量数据库索引中，VFFLAT 和 HNSW 有什么区别？各自的适用场景？", "eight", "★★☆"),
      ("什么是 CoT（思维链）？为什么它能提高模型处理复杂任务的能力？", "eight", "★★☆"),
      ("大模型应用中常见的幻觉有哪些类型？在工程上如何缓解？", "eight", "★★☆"),
      ("介绍一下 FunctionCall 的流程，模型是如何知道该调用哪个工具的？", "eight", "★★☆"),
      ("介绍一下 vLLM 中 PagedAttention 的原理。", "eight", "★★★"),
    ]),
    ("Python / 网络基础（八股）", [
      ("Python 中列表和元组的区别？", "eight", "★☆☆"),
      ("介绍一下 Python 中的装饰器及其应用场景。", "eight", "★☆☆"),
      ("HTTP 协议中 GET 和 POST 请求的区别？", "eight", "★☆☆"),
    ]),
    ("手撕代码", [
      ("手撕：无重复字符的最长子串。", "code", "★★★"),
    ]),
  ]),
]

ai_html, ai_n = build_section(aiqiyi, "抖音·爱奇艺AI产品经理面试全过程（图文）")
ks_html, ks_n = build_section(kuaishou, "抖音·快手AI应用开发一面面经（图文）")

# 注入：AI/PM 段
marker_pm = "    <!-- 在这下面接着加 AI/PM 的题 -->\n"
assert marker_pm in html, "AI/PM marker missing"
html = html.replace(marker_pm, ai_html + marker_pm, 1)

# 注入：其他/待分类 段
marker_other = "    <!-- 在这下面加「待分类」的题 -->\n"
assert marker_other in html, "other marker missing"
html = html.replace(marker_other, ks_html + marker_other, 1)

# 加 .grp / .subgrp 样式（若尚未存在）
if ".grp{" not in html:
    css = ("  .grp{font-size:14px;font-weight:800;color:var(--pri);margin:20px 0 6px;"
           "padding-bottom:4px;border-bottom:1px solid var(--pri-line);}\n"
           "  .subgrp{font-size:12.5px;font-weight:700;color:#6b728f;margin:12px 0 2px;}\n")
    html = html.replace("  .foot{", css + "  .foot{", 1)

# 更新计数与日期
import re
html = re.sub(r"AI产品/PM <b>\d+</b>", f"AI产品/PM <b>{ai_n}</b>", html)
html = re.sub(r"前端 <b>\d+</b>", "前端 <b>0</b>", html)
html = re.sub(r"其他 <b>\d+</b>", f"其他 <b>{ks_n}</b>", html)
html = re.sub(r"最近更新：\d{4}-\d{2}-\d{2}", "最近更新：2026-08-11", html)

with io.open(CARD, "w", encoding="utf-8") as f:
    f.write(html)

print(f"OK 爱奇艺注入 {ai_n} 题；快手注入 {ks_n} 题；卡片已更新。")
