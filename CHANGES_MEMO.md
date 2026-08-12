# 备忘录模块优化改动清单

> 任务：优化备忘录模块，移除弹窗式新建交互，改为页面原生内联快速录入表单，参考记账模块设计。

## 一、已读 README.md 并理解的架构

- 移动端优先 SPA，纯前端 + Python 轻量后端 `server.py`，数据存浏览器 IndexedDB（`second_brain_db` v8）+ localStorage 自动备份。
- `modules/` 目录为各业务模块，侧边导航基础布局未做大幅改动。
- 记账模块 `finance.js` 的 `fin-quick` 内联快速录入表单为本次参考样板。
- 视觉保持粉色柔和精致风格，延续既有配色体系（`--primary: #F4A6B5`）与圆角阴影规范。
- IndexedDB 版本保持 v8 不变，无 schema 变更。

## 二、文件变更总览

| 类型 | 文件 | 说明 |
|------|------|------|
| 修改 | `app.js` | `navigateTo()` 中将 `memo` 与 `plans` 加入 FAB 隐藏列表（见第三次迭代） |
| 修改 | `modules/memo.js` | 重写备忘录模块：顶部内联快速录入表单（内容输入框 + 关键日期选择框 + 保存按钮），取消弹窗新建；保存后表单清空保留、新备忘沉底排列；编辑/查看/删除仍走弹窗；新增 `keyDate` 字段 |
| 修改 | `modules/home.js` | 今日待办完成态改造：打勾后不消失、仅沉底（见第三次迭代） |
| 修改 | `styles.css` | 新增 `.memo-quick` 系列样式；第二次迭代优化布局；第三次迭代移除冗余标题行、新增 `.home-row.done` 沉底样式 |
| 修改 | `index.html` | 缓存版本号 `v=20260801a` → `v=20260801b` → `v=20260801c` → `v=20260801d`，确保用户获取最新代码 |

## 三、需求逐项落实

### 3.1 移除右下角新建备忘录加号按钮及弹窗

- `app.js` 第 144 行：`navigateTo()` 的 FAB 隐藏条件增加 `|| module === 'memo'`。
- 备忘录页面不再显示 FAB 浮动按钮，`onFabClick` 中的 `memo` handler 保留但不会触发（向后兼容）。
- `Memo.openAdd()` 改为聚焦页面内联表单输入框，不再唤起弹窗。

### 3.2 新建备忘录改为页面原生内联快速录入表单

- 参考 `finance.js` 的 `fin-quick` 模式，在 `Memo.render()` 页面顶部渲染 `.card.memo-quick` 表单。
- 表单包含：
  - **备忘内容输入框**：`<textarea>` 2 行，placeholder 提示「Enter 保存, Shift+Enter 换行」。
  - **系统自动生成创建时间**：由 `db.js` 的 `add()` 方法自动设置 `createdAt` 和 `updatedAt`（`Date.now()`），用户无需手动输入。
  - **关键日期选择框**：`<input type="date">`，可选，手动设置重要日期。
  - **保存按钮**：点击或按 Enter 键触发 `Memo.quickSave()`。
- 保存后：表单清空但保留不消失，新备忘追加到列表底部（沉底），输入框自动重新聚焦支持连续录入。

### 3.3 排序逻辑调整（沉底）

- 原排序：置顶优先 → `updatedAt` 降序（最新在顶部）。
- 新排序：置顶优先 → `createdAt` 升序（最新沉底）。
- 代码：`(a.createdAt || a.updatedAt || 0) - (b.createdAt || b.updatedAt || 0)`。
- 兼容历史数据：无 `createdAt` 的旧记录回退到 `updatedAt`。

### 3.4 原有备忘录查看/编辑/删除完整保留

- `Memo.openEdit(id)` 保持弹窗形式不变，用于查看和编辑已有备忘录。
- 编辑弹窗新增「关键日期」字段（`<input type="date">`），与快速录入表统一。
- 删除功能（`memo_del` 按钮 + `confirmDialog` 确认）完整保留。
- Markdown 预览功能（`memo_preview` 按钮）完整保留。
- 搜索功能完整保留。

### 3.5 页面视觉与触屏适配

- 快速录入卡片使用简洁白色卡片（`var(--card)`），顶部无厚重渐变，减少视觉压迫感。
- 增加卡片标题栏：左侧「📝 快速备忘」、右侧轻提示「Enter 保存 · Shift+Enter 换行」，让表单目的更清晰。
- **备忘内容输入框**：`textarea` 最小 3 行，输入时自动增高，最多 6 行，避免内容多时显得狭窄；聚焦时边框变粉并带柔和光晕。
- **关键日期选择器**：紧凑按钮式容器（📅 + 「关键日期」文字 + 日期输入），与保存按钮左右分布，不再独占整行造成大片留白。
- **保存按钮**：固定宽度 72px、高度 40px，与日期选择器同高对齐，视觉更紧凑。
- 输入框、日期选择器、保存按钮的触屏命中区均 ≥ 40px，适配手机操作。
- 列表项 `.memo-item` 支持 `pre-wrap` 换行显示，内容预览最多 120 字符。
- 深色主题完整适配（`.theme-dark .memo-quick` 等规则）。

### 3.6 布局二次迭代说明

针对初次实现后「输入区窄、留白大、元素挤」的反馈，第二次迭代：
1. 去掉卡片渐变背景，改用纯白卡片 + 柔和阴影；
2. 增加标题栏，明确区分表单区域；
3. textarea 从固定 2 行改为最小 3 行 + 自动增高；
4. 日期选择器与保存按钮改为底部横向紧凑排布；
5. 统一元素高度与间距，消除 uneven 空白。

## 四、IndexedDB 数据兼容说明

### 4.1 无 Schema 变更

- IndexedDB 版本保持 **v8 不变**，无 `onupgradeneeded` 触发，无迁移逻辑需要。
- `memos` store 的 object store 定义、索引（`pinned`、`createdAt`、`updatedAt`、`gid`）均未改变。

### 4.2 新增字段 `keyDate`

- `keyDate` 为备忘录记录的新增可选字段（`string` 类型，格式 `YYYY-MM-DD`），存储于记录对象上。
- IndexedDB 为 schema-less 记录存储，新增字段无需修改 schema。
- 历史备忘录无 `keyDate` 字段时，UI 显示时自动跳过关键日期显示，不影响已有数据。
- 快速录入新建的备忘录 `title` 默认为空字符串、`tags` 默认为空、`pinned` 默认为 `false`，与既有数据结构完全兼容。

### 4.3 同步兼容

- `keyDate` 字段随记录通过 `/api/sync` 正常同步（同步引擎传输完整记录对象，不依赖字段白名单）。
- 跨设备同步不受影响。

## 五、风险点与注意事项

1. **排序变化**：备忘录列表从「最新在顶部」改为「最新沉底」，用户初次使用可能需要适应。置顶备忘录仍在最顶部。
2. **FAB 隐藏**：备忘录模块不再有 FAB 按钮，新建入口完全依赖页面顶部内联表单。如用户习惯点 FAB，需知晓新入口位置。
3. **keyDate 无索引**：`keyDate` 未建立 IndexedDB 索引（避免不必要的 schema 升级），如未来需按关键日期排序/筛选，可考虑升级 DB 版本添加索引。
4. **Enter 键行为**：快速录入框中 Enter 直接保存（Shift+Enter 换行），与记账模块的交互习惯一致，但与纯文本编辑器不同，需在 placeholder 中提示。

## 六、测试验证

- `node --check modules/memo.js` 通过。
- `node --check app.js` 通过。
- `python -m py_compile server.py` 通过。
- 启动 `server.py` 后 `curl` 验证：
  - `GET /` → 200
  - `GET /modules/memo.js` → 200，包含 `quickSave`、`memo-quick` 等新代码。
  - `GET /styles.css` → 200。
  - `GET /app.js` → 200，包含 `module === 'memo'` FAB 隐藏逻辑。

## 七、第三次迭代：三项微调

> 任务：根据使用反馈做三处小调整——备忘录布局重排（搜索置顶 / 列表居中 / 录入置底且无标题行）、首页今日待办打勾后沉底不消失、计划模块取消右下角 FAB。

### 7.1 备忘录模块布局重排（搜索置顶 / 录入置底 / 去标题行）

- `modules/memo.js` 的 `Memo.render()` 重排 `content.innerHTML` 顺序为：
  1. **搜索框**（`.form-group` + `#memoSearch`）置顶；
  2. **备忘录列表**（空态提示「在下方快速记录吧」+ 各项 `Memo.renderItem`）居中；
  3. **快速备忘录入表单**（`.card.memo-quick`）置底。
- **去掉「📝 快速备忘」标题行**：原 `memo-quick-header` 区块（含标题与「Enter 保存」提示）已从 HTML 与 `styles.css` 中移除；录入提示合并进 textarea 的 placeholder（「写下此刻的想法... (Enter 保存 · Shift+Enter 换行)」）。
- 录入表单功能不变：内容输入框 + 关键日期选择框 + 保存按钮，保存后清空保留、新备忘沉底。
- 视觉一致：表单仍用白色卡片 + 柔和阴影，延续粉色精致风；深色主题已适配。

### 7.2 首页今日待办：打勾后沉底不消失

- `modules/home.js` 的今日待办列表（原 `todayTasks` / `todayPlans` 过滤 `status !== 'done'/'completed'`）改为**保留已完成项**：筛选出今日全部任务与计划，并为每条标注 `done` 标志。
- **排序规则**：未完成项在前、已完成项沉底（同类仍按 `createdAt` 升序）。
- **视觉**：已完成行加 `.home-row.done` 样式（文字划线 + 整体淡化 0.62，深色主题 0.5），复选框仅在完成时显示绿色 ✓。
- **统计卡「待办」**：保持只统计今日未完成任务数（`todayTasksAll.filter(t => t.status !== 'done').length`），不受沉底改动影响。
- 复选框点击仍走 `Home.toggleTodo()` 切换完成态并重渲染，仅列表呈现从「消失」改为「沉底」。

### 7.3 计划模块取消右下角 FAB

- `app.js` 第 144 行 `navigateTo()` 的 FAB 隐藏条件增加 `|| module === 'plans'`。
- 计划模块顶部已有「添加任务」输入框 + 「+ 添加」按钮，FAB 冗余，故隐藏右下角加号浮动按钮。
- `Plans.openAdd()` 逻辑保留（不再被 FAB 触发，向后兼容）。

### 7.4 风险点与注意事项

1. **备忘录重排**：录入表单移至底部后，长列表场景需滚动到底部才能新建；若用户习惯顶部录入，需适应。空态提示已改为「在下方快速记录吧」引导。
2. **今日待办沉底**：列表项上限仍为 `.slice(0, 8)`，若今日任务 + 已完成超过 8 条，底部已完成项可能被截断。
3. **计划 FAB 隐藏**：仅隐藏浮动按钮，顶部「添加任务」入口不变，新建能力无损失。
4. **无数据变更**：三项调整均为 UI / 交互层，IndexedDB 结构与数据零改动，历史数据绝对安全。

### 7.5 第三次迭代验证

- `node --check modules/memo.js` / `modules/home.js` / `app.js` 均通过。
- 启动 `server.py` 后 `curl` 验证：
  - 备忘录 `render()` 中 `memoSearch` 在 `快速备忘录入` 之前（搜索置顶、录入置底）✓
  - 备忘录含「快速备忘」标题文本已不存在 ✓
  - `home.js` 含 `t.done` 沉底排序逻辑 ✓
  - `app.js` 含 `module === 'plans'` FAB 隐藏逻辑 ✓
