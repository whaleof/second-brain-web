# 局域网双向同步机制改造清单

> 任务：为「第二大脑 · WorkBuddy」实现局域网多设备增量同步，电脑关机/断网期间手机本地功能照常使用，回家后同一 WiFi 自动同步。

## 一、已读 README.md 并理解的架构

- 移动端优先 SPA，纯前端 + Python 轻量后端 `server.py`，数据存浏览器 IndexedDB + localStorage 自动备份。
- `modules/` 目录为各业务模块，侧边导航基础布局已确认未做大幅改动（仅在顶部操作栏增加同步状态按钮）。
- 原有 `tasks` 旧模块已整合至 `plans`，未恢复旧代码。
- 视觉保持粉色柔和精致风格，新增同步图标/状态点沿用既有配色体系。

## 二、文件变更总览

| 类型 | 文件 | 说明 |
|------|------|------|
| 修改 | `server.py` | 重构 `/api/sync` 端点，新增 `master.json` 多设备合并数据集与墓碑机制 |
| 修改 | `db.js` | IndexedDB 升级至 v8，新增 `sync_meta` / `tombstones`，全表加 `gid` 索引，实现增量同步引擎 |
| 修改 | `app.js` | 增加同步状态 UI、手动同步、网络事件监听、定时同步、设置面板改造 |
| 修改 | `index.html` | 顶部栏增加同步按钮；更新缓存版本号 |
| 修改 | `styles.css` | 新增同步按钮状态样式（同步中旋转、已同步、离线、错误、待同步红点） |
| 新增 | `.sync/master.json`（运行时生成） | 服务端合并后的权威数据集，首次同步后自动生成 |

## 三、IndexedDB 迁移说明（v7 → v8）

### 3.1 新增 object store

- `sync_meta`：keyPath `key`，存储 `lastSyncAt` 等同步元数据。
- `tombstones`：keyPath `id`（自增），记录跨设备删除，索引 `gid` / `deletedAt` / `storeName`。

### 3.2 既有 store 变更

- 所有业务 store（`tasks`、`plans`、`finance_records` 等 16 个）新增 `gid` 索引（非唯一）。
- 在 `onupgradeneeded` 中通过 cursor 为每条历史记录生成全局唯一 `gid`，**历史数据不丢失**，且自动具备同步能力。

### 3.3 CRUD 变更

- `add()`：自动为无 `gid` 的记录生成 `gid`。
- `put()`：读取原记录以保留 `gid`；若全无则生成新的。
- `delete()`：删除前先读取 `gid`，删除后在 `tombstones` 写入墓碑，保证删除能传播到其他设备。

### 3.4 导入/导出兼容性

- `exportAll()` 输出格式升级为 version 2，包含 `tombstones`。
- `importAll()` 同时支持 version 1（旧备份）与 version 2，对无 `gid` 的记录自动生成 `gid`。

## 四、服务端 `/api/sync` 设计

### 4.1 存储结构

`.sync/master.json`：

```json
{
  "version": 2,
  "updatedAt": 1785526682731,
  "data": {
    "finance_records": {
      "<gid>": { /* 最新记录 */ }
    }
  },
  "tombstones": {
    "<gid>": { "gid", "storeName", "deletedAt", "deletedBy" }
  }
}
```

### 4.2 请求协议

- `GET /api/sync?device=xxx&since=<timestamp>`
  - 返回 `changes`（按 store 分组、自 `since` 以来变更的记录数组）和 `tombstones`。
- `POST /api/sync?device=xxx&since=<timestamp>`
  - 请求体：`{ changes: { storeName: [records] }, tombstones: [...], pushedAt }`
  - 服务端按「最新 `updatedAt` 覆盖」合并到 `master.json`，并同步合并墓碑、清除已被删除的数据。

### 4.3 冲突策略

- 以记录级 `updatedAt`（毫秒时间戳）为准。
- 服务端与客户端均采用同一策略：远端 `updatedAt` 大于本地则覆盖，否则忽略。
- 删除通过墓碑传播：墓碑 `deletedAt` 大于记录 `updatedAt` 时执行删除。

### 4.4 单设备快照兼容

- 仍保留 `.sync/<device>.json` 单设备快照，便于调试与向后兼容。

## 五、客户端同步引擎

### 5.1 增量策略

- 本地维护 `lastSyncAt`（`sync_meta`）。
- 推送时仅收集 `updatedAt > lastSyncAt` 的记录与 `deletedAt > lastSyncAt` 的墓碑。
- 拉取后应用远程变更并更新 `lastSyncAt` 为服务端返回的 `serverTime`。

### 5.2 自动同步时机

- 每次本地数据变更后 5 秒防抖触发 `syncNow()`（已有 `_scheduleCloudSync` 逻辑复用）。
- 应用启动 3 秒后尝试首次同步。
- 网络恢复（`online` 事件）立即尝试同步。
- 每 60 秒静默尝试一次。

### 5.3 离线行为

- `navigator.onLine === false` 时跳过同步，UI 显示「离线」，本地 CRUD 完全不受影响。
- 同步失败时仅更新状态与提示，不阻塞任何本地功能。
- 变更天然缓存在 IndexedDB 中，待网络恢复后按 `lastSyncAt` 自动增量推送。

## 六、UI 改动

### 6.1 顶部操作栏

- 在主题按钮左侧新增「同步状态按钮」。
- 状态：
  - 同步中：图标旋转。
  - 已同步：绿色。
  - 离线：灰色。
  - 错误：红色。
  - 有待同步记录：右上角红点提示。
- 点击可一键手动同步。

### 6.2 设置面板

- 「云端同步」改为「局域网同步」。
- 保留「立即同步」按钮，状态文本说明局域网同步与离线缓存机制。

### 6.3 视觉

- 同步图标、红点、旋转动画沿用粉色主题变量与圆角风格，保持与既有界面一致。

## 七、测试验证

- `python -m py_compile server.py` 通过。
- `node --check db.js`、`node --check app.js` 通过。
- 启动 `server.py` 后使用 `curl` 验证：
  - 空库 GET 返回空 `changes` / `tombstones`。
  - 设备 A POST 记账记录，设备 B GET 可拉取。
  - 设备 B 用更新的 `updatedAt` 覆盖同一 `gid`，设备 A 再次拉取得到最新版本。
  - 设备 B POST 墓碑，主库记录被删除，设备 A 拉取到墓碑。
- 测试后已清理 `.sync/` 目录中的测试数据。

## 八、风险点与注意事项

1. **时钟偏差**：若设备间系统时间差异较大，冲突策略可能偏向时钟快的设备。建议保持设备时间同步（NTP）。
2. **origin 隔离**：IndexedDB 按浏览器 origin 隔离，PWA 桌面图标可保证固定 origin；换域名/浏览器后仍需通过「导入数据」恢复。
3. **首次同步**：旧数据会在 DB v8 升级时自动生成 `gid`，升级后首次同步可能推送较多记录，属正常一次性行为。
4. **墓碑累积**：`tombstones` 只增不减，长期运行可能略微增大存储；对单用户个人台账影响可忽略，如需清理可在设置中增加「清理墓碑」功能（本次未做）。
5. **局域网可达性**：手机需通过电脑局域网 IP（如 `http://192.168.x.x:8080`）访问，不能仅依赖 `127.0.0.1`。

## 九、后续可优化方向

- 冲突可视化：当同一记录两端同时修改时，可提供冲突列表供用户选择（当前自动按时间覆盖）。
- 压缩传输：变更较多时可对 `changes` 做 gzip/精简字段。
- 墓碑清理：提供设置项清理已同步的早期墓碑。
