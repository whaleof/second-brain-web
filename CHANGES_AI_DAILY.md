# AI日报模块 · 完整代码改动清单

> 日期：2026-08-01 · 版本：v1.0

---

## 改动概览

| 文件 | 操作 | 说明 |
|------|------|------|
| `server.py` | 修改 | 新增 `/api/aihot` 代理路由 |
| `db.js` | 修改 | 新增 `ai_daily` store，升级 DB_VERSION → v9 |
| `app.js` | 修改 | 注册 ai-daily 模块路由、FAB 排除、清空数据增强 |
| `index.html` | 修改 | 导航栏新增「日报」按钮、引入 ai-daily.js |
| `modules/ai-daily.js` | **新建** | AI日报核心模块（380 行） |
| `styles.css` | 修改 | 新增 AI日报全套样式 + 深色主题适配 |
| `README.md` | 修改 | 模块清单追加「AI日报」 |

---

## 1. server.py — AI HOT 日报代理接口

**新增 `handle_aihot` 方法**（位置：`send_json` 之前）

```python
def handle_aihot(self, parsed):
    """AI HOT 日报代理: /api/aihot 或 /api/aihot?date=YYYY-MM-DD"""
    params = urllib.parse.parse_qs(parsed.query)
    date = params.get('date', [None])[0]
    if date:
        api_url = f'https://aihot.virxact.com/api/v1/dailies/{date}'
    else:
        api_url = 'https://aihot.virxact.com/api/v1/dailies/latest'
    # ... 代理请求+SSL+错误处理（404 特殊处理）
```

**路由注册**（`do_GET` 方法内）：
```python
if parsed.path == '/api/aihot':
    self.handle_aihot(parsed)
    return
```

- 复用现有 `urllib.request` + SSL 上下文
- 自动处理 404 → 前端回落历史日报
- 返回 JSON 透传，不做二次解析

---

## 2. db.js — 存储层扩容

### 新增 store

```javascript
'ai_daily'  // AI 日报缓存
```

加入 `STORES` 数组（第 32 行），自动纳入 CRUD、导出、同步、备份、清空等所有流程。

### 新增索引

```javascript
if (name === 'ai_daily') {
    store.createIndex('date', 'date', { unique: true });
}
```

`date` 唯一索引，确保同一日报不重复存储。

### 版本升级

```javascript
const DB_VERSION = 9;  // v9: 新增 ai_daily store
```

IDb 自动迁移逻辑（`onupgradeneeded`）检测 store 不存在时自动创建。

---

## 3. app.js — 路由与导航

### 模块注册

```javascript
'ai-daily': { title: 'AI日报', render: () => AIDaily.render() }
```

加入 `App.modules` 对象。

### FAB 排除

```javascript
|| module === 'ai-daily'
```

AI 日报页面不需要悬浮添加按钮。

### clearAllData 增强

```javascript
'drink_records','ai_daily'
```

清空数据时一并清除 AI 日报缓存。

---

## 4. index.html — 导航入口

### 新增导航按钮

在「备忘」按钮之后：

```html
<button class="nav-btn" data-module="ai-daily" title="AI日报">
  <span class="nav-icon"><!-- 书本图标 SVG --></span>
  <span class="nav-label">日报</span>
</button>
```

### 脚本引入

```html
<script src="modules/ai-daily.js?v=20260801d"></script>
```

---

## 5. modules/ai-daily.js — 核心模块（新建）

### 模块结构

```javascript
const AIDaily = {
  report: null,         // 当前报表数据
  cacheTime: 0,         // 缓存时间戳
  loading: false,       // 防并发锁

  SECTIONS: [           // 五板块定义
    { key: '模型发布/更新', icon: '🧠', anchor: 'model' },
    { key: '产品发布/更新', icon: '🚀', anchor: 'product' },
    { key: '行业动态',      icon: '📡', anchor: 'industry' },
    { key: '论文研究',      icon: '📄', anchor: 'paper' },
    { key: '技巧与观点',    icon: '💡', anchor: 'tips' }
  ],

  render(),              // 入口：三级缓存策略 → 渲染
  getCached(),           // 内存缓存（10分钟）
  setCached(),
  loadFromDB(),          // IndexedDB 读取
  saveToDB(),            // IndexedDB 写入 → 自动触发 sync
  fetchReport(),         // 网络请求 → parseReport + saveToDB
  fetchLatestHistory(),  // 回退：最近 7 天历史日报
  parseReport(),         // 数据结构化 + 全局编号
  renderReport(),        // DOM 渲染（Hero/导航/卡片/底部）
  formatDateText()       // ISO → 北京时间通俗文本
};
```

### 三级缓存策略

```
内存缓存（10min）→ IndexedDB → 网络请求（/api/aihot）
                                    ↓ 404
                              回溯 7 天历史日报
```

- 页面切换时优先读缓存，零等待
- 后台静默拉取最新数据
- 非今日数据自动尝试刷新

### 全局连续编号

```javascript
let globalIdx = 0;
// 遍历五板块，逐条递增，不重置
items: [{ idx: 1, ... }, { idx: 2, ... }, ..., { idx: 20, ... }]
```

### 数据持久化

- 写入 `ai_daily` store（自动生成 gid，参与局域网同步）
- 通过 `DB.add()` / `DB.put()` 触发自动备份 + 5 秒后云端同步

### 时间格式化

```javascript
formatDateText('2026-08-01', '2026-08-01T00:00:44.798Z')
→ "今天 2026年8月1日 星期六 · 生成于 08:00"
```

- 支持「今天/昨天/前天」自然语言前缀
- 北京时间（Asia/Shanghai）转换
- 生成时间精确到分钟

---

## 6. styles.css — 全套样式

新增约 220 行 CSS，涵盖：

| 区域 | 类名 | 说明 |
|------|------|------|
| 加载态 | `.ai-loading` | spinner 动画 + 文字 |
| Hero | `.ai-hero` | 粉色渐变背景、日期/总数/板块统计 |
| 锚点导航 | `.ai-nav` / `.ai-nav-item` | 圆角胶囊按钮，hover 高亮 |
| 板块标题 | `.ai-section-title` | 图标 + 板块名 + 条数 |
| 卡片列表 | `.ai-cards` | flex 纵向布局 |
| 资讯卡片 | `.ai-card` | 序号圆、标题、摘要、来源标签、跳转箭头 |
| 底部 | `.ai-footer` | 统计、数据来源、刷新按钮 |
| 深色主题 | `body.theme-dark .ai-*` | 全组件深色适配 |

设计语言延续：
- `--primary: #F4A6B5` 粉色主色
- `--primary-light: #FFE4E9` 浅粉背景
- `--card: #FFFFFF` 白色卡片
- 圆角 `var(--radius)` / `var(--radius-lg)`
- 阴影 `var(--shadow)` / `var(--shadow-hover)`
- 移除所有外部 CDN 依赖，完全自包含

---

## 7. 需求对照验证

| # | 需求 | 实现 |
|---|------|------|
| 1 | 导航栏新增「AI日报」入口 + 独立路由 | ✅ `data-module="ai-daily"`, `App.modules` + `navigateTo` |
| 2 | 复用 server.py 代理 + 当日无数据回落历史 | ✅ `/api/aihot` 代理 + `fetchLatestHistory()` 回溯 7 天 |
| 3 | 五个固定板块 | ✅ SECTIONS 硬编码，API 返回按 label 匹配 |
| 4 | 全局连续编号 | ✅ `globalIdx` 跨板块递增 |
| 5 | Hero/锚点导航/卡片网格 | ✅ 自上而下三个区域 |
| 6 | 卡片结构：序号/标题/来源/摘要≤60字/链接 | ✅ `.ai-card` 完整实现，`target="_blank"` |
| 7 | 北京时间通俗文本 | ✅ `formatDateText()` 转换 |
| 8 | 底部标注总数 + 数据来源 | ✅ `.ai-footer` |
| 9 | IndexedDB + 局域网同步 + 本地缓存 | ✅ `ai_daily` store + `saveToDB` + 10min 内存缓存 |
| 10 | 复用全局样式，无外部 CDN | ✅ 全部使用 `--var()` 系统变量，零外部依赖 |

---

## 8. 未改动项（安全检查）

- ❌ `modules/` 目录结构不变，仅新增一个文件
- ❌ 侧边导航布局无任何重构
- ❌ 所有现有模块（home/plans/finance/dance/internship/market/news/memo/timeline/weight/drinks）代码一字未改
- ❌ `sw.js`（Service Worker）不变
- ❌ `build_single.py` 构建脚本仅需按原有方式执行（包含新文件）
- ❌ 所有历史数据保留，IDB v8→v9 自动迁移

---

## 9. 后续微调（2026-08-01 第2轮）

### 问题与修复

| 问题 | 修复文件 | 具体改动 |
|------|----------|----------|
| 分类导航重复（Hero内 + 外部锚点各一套） | `modules/ai-daily.js` | 移除 `.ai-hero-stats` 统计pills，只保留 `.ai-nav` 锚点导航 |
| 「共 N 条资讯」字体过大 | `styles.css` | `.ai-hero-total` 28px→13px，`<b>` 34px→15px，改为柔和小字 |
| 分类导航占3行太松散 | `styles.css` | `.ai-nav` gap 6px→5px；`.ai-nav-item` padding 6px14px→4px10px、字号12px→11px、圆角20px→16px；`.ai-nav-count` padding 1px7px→1px5px |
| 深色主题残留样式 | `styles.css` | 移除 `body.theme-dark .ai-hero-stat` 无用规则

---

## 10. 后续微调（2026-08-01 第3轮）

### 问题与修复

| 问题 | 修复文件 | 具体改动 |
|------|----------|----------|
| Hero 区域与截图差距大 | `modules/ai-daily.js` + `styles.css` | 粉色渐变→白色卡片；左侧放 48px 文档 SVG 大图标；右侧放「刷新」pill 按钮；底部小字显示日期+总条数+来源 |
| 分类导航字数不统一 | `modules/ai-daily.js` | SECTIONS 增加 `label` 字段：模型动态/产品动态/行业动态/论文研究/技巧观点（全部4字），导航与板块标题均用 `label` 显示，API 匹配仍用 `key` |
| 卡片没有重点、来源过于强调 | `modules/ai-daily.js` + `styles.css` | 移除序号圆 `.ai-card-idx` 和箭头 `.ai-card-arrow`；标题缩小至 13px 深色；来源改为 10px 灰色极小字（去掉粉色 pill 背景）；摘要改为深粉色 `.ai-card-summary` 带浅粉背景 pill，突出「一句话总结」 |
| 底部刷新按钮冗余 | `modules/ai-daily.js` | 底部区域移除「刷新日报」按钮（Hero 已有刷新按钮）

---

## 11. 后续微调（2026-08-01 第4轮）

### 问题与修复

| 问题 | 修复文件 | 具体改动 |
|------|----------|----------|
| 图标过小 | `modules/ai-daily.js` + `styles.css` | SVG 图标从 48px 放大到 **72px**；opacity 从 0.5 降到 0.28，更柔和 |
| 分类导航位置奇怪 | `modules/ai-daily.js` + `styles.css` | 移除独立的 `.ai-nav` 横向导航；将 5 个分类 pill **竖排整合进 Hero 卡片内部**，位于大图标右侧；Hero 内部改为 flex 三列布局（图标 \| 竖排分类 \| 刷新按钮） |
| 卡片缺红色标签 | `modules/ai-daily.js` + `styles.css` | 每条新闻标题前新增红色序号标签 `.ai-card-tag`（背景 `#E53935`、白色字、圆角 5px、10px 粗体），仿照截图 P1 样式；标题与标签放在同一 flex 行 |
| 摘要不完整 | `modules/ai-daily.js` | 移除 60 字硬截断 `shortSummary`，改为直接输出完整 `item.summary`；CSS 控制 `-webkit-line-clamp: 3` 最多 3 行，既完整又不无限拉长 |
| 摘要文字颜色 | `styles.css` | `.ai-card-summary` 文字色从 `var(--primary-deep)` 深粉改回 `var(--text)` 深色，靠浅粉背景 pill 区分层次，更贴合截图 |
| 来源格式 | `modules/ai-daily.js` | 来源前缀加「来源：」→「来源：${source}」，与截图格式一致 |

---

## 12. 后续微调（2026-08-01 第5轮）

### 问题与修复

| 问题 | 修复文件 | 具体改动 |
|------|----------|----------|
| 图标仍偏小 | `modules/ai-daily.js` + `styles.css` | SVG 图标从 72px 放大到 **96px**；Hero 改为左右分栏（各占 50%），图标列居中 |
| 刷新按钮位置不对 | `modules/ai-daily.js` + `styles.css` | 从 Hero 主体三列中移除，移到 `.ai-hero-meta` 信息行最右侧；meta 行改为 `flex + space-between` |
| 粉色区域不是市场影响 | `modules/ai-daily.js` + `styles.css` | 新增 `.ai-card-impact` 结构：标题「📈 资讯潜在市场影响」+ 内容 body；内容截断到 **80 字** 更精炼；CSS 标题用深粉粗体、内容用深色 |
| 深色主题残留 | `styles.css` | `.ai-card-summary` → `.ai-card-impact` 深色规则迁移 |

### 附录：如何实现真正的「资讯潜在市场影响」分析

当前 AI HOT API 只返回新闻标题、来源和一句话摘要（`summary`），**不包含对股票/市场的专业影响分析**。要在卡片中展示类似截图 P2 的「国产替代逻辑强化，关注设备材料板块」这类分析，需要额外调用 AI 对新闻做金融推理。

**推荐方案（按实现难度排序）：**

**方案 A：前端调用 AI 自动化（推荐，无额外后端）**
利用 WorkBuddy 内置自动化能力，在拉取日报后触发 AI 推理任务。遍历每条新闻，用 prompt 调用大模型（GPT-4o / Claude 3.5）：
> 「${title}」这条新闻对 A 股/港股/美股有哪些板块或个股可能产生影响？请用一句话总结，如「利好半导体国产替代，关注设备材料板块」。
将返回的 `impact` 字段存入 IndexedDB 的 `ai_daily` store，前端渲染时直接读取 `impact` 替代 `summary`。

**方案 B：后端 server.py 增加分析路由（需要 API Key）**
在 `server.py` 中新增 `/api/analyze-impact` 路由，接收 `title + summary`，调用 OpenAI / Claude / 智谱 API 返回市场影响。优点：前端零改动；缺点：需要 API Key 和费用。

**方案 C：接入金融数据 MCP / 技能（需配置 connector）**
当前可用但未启用的金融 connector：`westock-mcp`（腾讯自选股）、`wb-finance-skill`（金融场景总入口）、`gildata`（恒生聚源）、`gangtise-mcp`（Gangtise投研）。启用后可在 `server.py` 中调用其接口获取新闻事件关联分析。

**建议下一步：** 方案 A 最轻量，创建一条每日自动化任务，由 AI 读取当日日报并生成市场影响分析，结果保存到知识库或 IMA 笔记，前端再按需读取。可配置自动化实现。

---

## 13. 第六轮：配置「每日 AI 日报市场影响分析」自动化 (2026-08-01 17:40)

### 新增/改动文件

| 文件 | 操作 | 关键改动 |
|------|------|----------|
| `data/aihot-impact.json` | **新建** | 22 条新闻的市场影响分析样本数据（2026-08-01，含 idx/title/source/impact） |
| `server.py` | 修改 | 新增 `/api/ai-impact` 路由，读取 `data/aihot-impact.json` 并返回 JSON；支持 `?date=` 筛选 |
| `modules/ai-daily.js` | 修改 | 新增 `loadImpactData(dateStr)` 方法：渲染日报后异步请求影响分析，按 idx 匹配并替换 `.ai-card-impact-body` 内容 |
| `modules/ai-daily.js` | 修改 | SVG 图标 96px → **120px**；移除 80 字硬截断，summary 完整展示；分类间距 5px → 4px |

### 自动化任务配置

| 配置项 | 值 |
|--------|-----|
| 名称 | 每日 AI 日报市场影响分析 |
| ID | `automation-1785577237483` |
| 执行时间 | 每天 **08:30**（FREQ=DAILY;BYHOUR=8;BYMINUTE=30） |
| 状态 | ACTIVE |
| 工作目录 | `G:\_06_项目代码\工作台` |

### 工作流程

```
自动化 (08:30) → 拉取 AI HOT → 逐条 AI 分析市场影响 → 写入 data/aihot-impact.json
                                        ↓
前端访问 → server.py /api/ai-impact → 读取 JSON → 返回 impact 数据
                                        ↓
           ai-daily.js loadImpactData() → 按 idx 匹配 → 替换粉色区域内容
```

### 缓存版本号

所有资源追加缓存戳：`?v=20260801f`（第六轮）
