# 随想模块 · 完整代码改动清单

> 日期：2026-08-01 · 版本：v1.0

---

## 改动概览

| 文件 | 操作 | 说明 |
|------|------|------|
| `db.js` | 修改 | 新增 `thoughts` / `thought_digests` store，升级 `DB_VERSION` → v10 |
| `app.js` | 修改 | 注册 thoughts 模块路由、FAB 排除、清空数据增强 |
| `index.html` | 修改 | 导航栏新增「随想」按钮（脑灯泡图标）、引入 thoughts.js |
| `modules/thoughts.js` | **新建** | 随想核心模块（前端录入 / 时间轴 / 日终整合卡片 / 归档） |
| `server.py` | 修改 | 新增 `/api/thoughts` 只读接口 |
| `tools/digest_tool.py` | **新建** | 随想日终整合工具（fetch / pending / save 子命令） |
| `styles.css` | 修改 | 新增随想全套 `.th-*` 样式 + 深色主题适配 |
| `build_single.py` | 修改 | `js_files` 列表新增 `modules/thoughts.js` |
| `README.md` | 修改 | 模块清单追加「随想」+ 自动化依赖说明 |
| `C:.workbuddy/automation` | 新增 | 每日 01:00 自动整合（recurring automation） |

---

## 1. db.js — 存储层扩容

### DB_VERSION

```javascript
const DB_VERSION = 10;   // v10: 新增 thoughts / thought_digests store
```

### 新增 store（STORES 数组）

```javascript
'thoughts',        // 随想：一天中随时记录的想法/感受，带时刻
'thought_digests'  // 随想日终整合：每日 AI 分析结果
```

自动纳入既有 CRUD / 导出 / 同步 / 备份 / 清空等所有流程。

### 新增索引（createStoreIndexes）

```javascript
if (name === 'thoughts') {
  store.createIndex('date', 'date', { unique: false });   // 按日期查询（可多设备）
  store.createIndex('ts',   'ts',   { unique: false });
}
if (name === 'thought_digests') {
  store.createIndex('date', 'date', { unique: false });   // 每日一篇，但保留非唯一避免同步冲突
}
```

> ⚠️ 所有 `date` 索引一律 `unique:false`。多设备同步时同一天会各自产生记录，唯一约束会触发 `ConstraintError`，故采用「最新 updatedAt 覆盖」的冲突策略（沿用同步层既有机理）。

---

## 2. app.js — 模块注册与流程接入

### 模块路由（App.modules）

```javascript
thoughts: { title: '随想', render: () => Thoughts.render() }
```

### FAB 悬浮按钮排除

```javascript
if (module === '...' || module === 'ai-daily' || module === 'thoughts') {
  fab.style.display = 'none';   // 随想自带底部录入区，不需要 FAB
}
```

### 清空全部数据（clearAllData）

```javascript
for (const name of ['...','ai_daily','thoughts','thought_digests']) {
  // 一并清空随想与整合数据
}
```

---

## 3. index.html — 导航与脚本

### 侧边导航（位于「AI日报」之前）

```html
<button class="nav-btn" data-module="thoughts" title="随想">
  <span class="nav-icon"><svg viewBox="0 0 24 24" ...>脑灯泡图标</svg></span>
  <span class="nav-label">随想</span>
</button>
```

### 脚本引入

```html
<script src="modules/thoughts.js?v=20260801e"></script>
```

所有静态资源版本号统一由 `v=20260801d` 升级到 `v=20260801e`（强制刷新缓存）。

---

## 4. modules/thoughts.js — 随想核心模块（新建，约 400 行）

### 设计要点

- **随时记录**：底部录入区（仅当天显示），支持四类型 `KINDS`：
  - `idea` 💭 想法 / `feel` 💗 感受 / `q` ❓ 疑问 / `spark` ✨ 灵感
- **自动时间戳**：`quickSave()` 写入 `{ date: todayStr(), time: nowHM(), ts: Date.now(), kind, text }`，时刻（如 10:20）随记录自动保存
- **每日整合卡片**：`renderDigest()` 展示 AI 日终整合 —— 标题 + 总结 + 主题聚类 + 洞察 + 可延伸方向 + 可落地行动（含 why）+ 当日情绪 + 评语，支持展开/折叠
- **时间轴**：`renderTimeline()` 按时刻排序，点击进入 `openEdit()` 弹窗编辑/删除
- **日期导航**：`renderDateNav()` 前一天/后一天切换 + 归档入口（带总天数 badge）
- **归档**：`openArchive()` 列出所有有记录的日期及条数/是否已整合，`jumpTo(date)` 跳转

### 关键方法

| 方法 | 说明 |
|------|------|
| `render()` | 主渲染：日期导航 + 整合卡片 + 时间轴 + 底部录入 |
| `quickSave()` | 写入一条随想，自动记录 `time` |
| `openEdit(id)` | 弹窗修改类型/文本/时刻，或删除 |
| `getDigest(date)` | 读取当日最新整合 |
| `openArchive()` | 归档浏览与跳转 |
| `openAdd()` | FAB 兼容入口：跳今天并聚焦输入框 |

### 录入交互

- `Enter` 保存 / `Shift+Enter` 换行
- textarea 自动增高（`autoGrow`）
- 实时显示「🕐 时刻 自动记录」提示当前时刻

---

## 5. server.py — 只读接口

### 路由注册（do_GET）

```python
if parsed.path == '/api/thoughts':
    self.handle_thoughts(parsed)
    return
```

### handle_thoughts 行为

- **不带 date**：返回 `dates` 汇总（每日期数 + `digested` 标记）
- **带 date**：返回 `{ date, count, thoughts:[{time,kind,text}], digest: 最新整合或 null }`
- 过滤 `tombstones` 已删除 gid，仅暴露未删除内容

---

## 6. tools/digest_tool.py — 日终整合工具（新建）

直接读写 `.sync/master.json`（沿既有局域网同步链路下发），避免自动化无法访问手机本地 IndexedDB 的矛盾。

### 子命令

| 子命令 | 说明 |
|--------|------|
| `fetch --date YYYY-MM-DD` | 输出当天随想 JSON，供 AI 分析 |
| `pending --days N [--force]` | 列出最近 N 天「有随想未整合」的日期 |
| `save --date YYYY-MM-DD --file result.json` | 把整合结果写入 master.json 的 `thought_digests` store，并写 `data/thought-digests/YYYY-MM-DD.md` 归档 |

### 数据流

```
手机随想 → 局域网同步 → 电脑 .sync/master.json
        → 每日 01:00 自动化跑 digest_tool.py
        → 整合结果写回 master.json
        → 手机下次同步自动收到，第二天卡片里出现整合
```

---

## 7. styles.css — 样式（约 +400 行）

新增 `.th-*` 全套样式，含浅色 / 深色双主题：

- `.th-datenav` / `.th-nav-arrow`（带归档 badge）
- `.th-digest` / `.th-dg-*`（日终整合卡片，折叠动画）
- `.th-digest-pending`（未整合占位）
- `.th-timeline` / `.th-item-*`（时间轴竖线 + 时刻 + 类型图标）
- `.th-composer` / `.th-kinds` / `.th-kind` / `.th-input` / `.th-save`（底部录入）
- `.th-archive` / `.th-arc-*`（归档弹窗）

---

## 8. README.md — 文档

- 模块清单追加「随想」
- 新增「随想模块的自动化依赖」段落，说明 `tools/digest_tool.py` 与每日 01:00 自动整合

---

## 9. 自动化（Automation）

- **名称**：随想日终整合
- **调度**：`FREQ=DAILY;BYHOUR=1;BYMINUTE=0;BYSECOND=0`（每日 01:00）
- **动作**：在电脑端运行 `tools/digest_tool.py`，对当天（或最近未整合的）随想做 AI 分析整合，写回同步中心
- **效果**：手机端次日打开「随想」，当天整合卡片自动出现

---

## 验证记录

- ✅ JS 语法检查：`thoughts.js` / `app.js` / `db.js` 均通过 `node --check`
- ✅ 渲染冒烟测试：`Thoughts.render()` 在 mock 环境完整产出（时间轴 / 整合卡片 / 录入区 / 日期导航齐全）
- ✅ 全链路同步验证：注入测试随想 → `pending` / `fetch` / `save` 子命令正常 → `/api/thoughts` 接口正常 → `since=0` 同步可下发 `thoughts` / `thought_digests` → 已还原真实数据并清理测试痕迹
