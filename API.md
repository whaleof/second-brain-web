# API 契约文档

`server.py` 暴露一组轻量 REST 端点，为前端纯静态 SPA 解决两件事：

1. **跨域代理**：把浏览器无法直接访问的第三方数据（股票、基金、AI 日报等）转发回本机。
2. **本地状态中心**：在多设备间同步 `IndexedDB` 数据，并做自动备份。

Base URL：`http://localhost:8080`

> 说明：这些接口主要服务于单人本地工具，因此没有 JWT/OAuth 鉴权层；密钥（GitHub Token、AI API Key 等）统一由后端读取环境变量或 `.env` 文件，**绝不落前端**。

---

## 统一约定

| 项 | 约定 |
|---|---|
| 数据格式 | 请求/响应均为 `application/json; charset=utf-8` |
| CORS | 允许任意源 `GET/POST/OPTIONS`，方便 GitHub Pages 版回连本机 |
| 成功码 | `200 OK`（GET/POST） |
| 错误码 | 见下表「错误码约定」 |
| 时间戳 | 服务端统一使用 **毫秒级 Unix 时间戳**（`int`） |

---

## 错误码约定

| HTTP 状态 | 含义 | 响应体示例 |
|---|---|---|
| `200` | 成功 | `{ "ok": true, ... }` 或原始数据 |
| `400` | 请求参数错误 | `{ "ok": false, "error": "无效的设备标识" }` |
| `404` | 资源不存在 | `{ "error": "not_found" }` |
| `405` | 方法不支持 | `{ "ok": false, "error": "方法不支持" }` |
| `500` | 服务端/代理异常 | `{ "error": "..." }` |
| `503` | 外部服务不可用 | `{ "ok": false, "error": "AI 提炼失败（可能密钥未配置）" }` |

---

## 1. 行情与金融代理

所有接口都是**无状态代理**，把前端请求转发到腾讯/东方财富 API。

| 方法 | 端点 | 参数 | 说明 |
|---|---|---|---|
| GET | `/api/quote` | `code` 股票代码，默认 `sh000300` | 实时行情（腾讯） |
| GET | `/api/kline` | `code` 股票代码；`count` 天数，默认 `7` | K 线数据（腾讯） |
| GET | `/api/fund` | `code` 基金代码，默认 `007044` | 基金净值、规模、经理等（东方财富） |
| GET | `/api/fund/history` | `code` 基金代码；`count` 条数，默认 `120` | 基金历史净值 |

### 示例

```bash
curl "http://localhost:8080/api/quote?code=sh000300"
```

响应：

```json
{
  "data": "v_sh000300=\"...\""
}
```

---

## 2. 资讯与认知

| 方法 | 端点 | 参数 / Body | 说明 |
|---|---|---|---|
| GET | `/api/news` | 无 | 新浪新闻热搜代理 |
| GET | `/api/aihot` | `date` 可选，格式 `YYYY-MM-DD` | AI HOT 日报代理 |
| GET | `/api/ai-impact` | `date` 可选，格式 `YYYY-MM-DD` | 市场影响分析（读取本地 `data/aihot-impact.json`） |
| GET | `/api/thoughts` | `date` 可选，格式 `YYYY-MM-DD` | 随想只读接口；不带 `date` 返回日期汇总 |
| POST | `/api/digest` | `{ "url": "https://v.douyin.com/xxx/" }` | 提交抖音/视频链接，后台异步消化为认知笔记 |
| GET | `/api/digest/status` | `job_id` | 查询消化任务状态 |
| GET | `/api/github-weekly` | `force=1` 可选，强制刷新 | 返回本周 GitHub 全品类周榜 |
| POST | `/api/digest-github` | `{ "name", "url", "description", "zh" }` | 调用 DeepSeek 提炼 GitHub 仓库为 markdown 笔记 |

### `/api/digest` 响应

```json
{
  "ok": true,
  "job_id": "a1b2c3..."
}
```

### `/api/digest/status` 响应

```json
{
  "ok": true,
  "status": "done",
  "step": "完成",
  "result": { "gid": "...", "title": "..." },
  "error": null
}
```

---

## 3. 同步与备份

### 3.1 `/api/sync`

| 方法 | 用途 | 参数 / Body |
|---|---|---|
| GET | 拉取服务器完整合并数据 | `device` 设备标识；`since` 时间戳 |
| POST | 推送本地变更并合并 | `device` 设备标识；Body 见下 |

#### POST Body

```json
{
  "changes": {
    "timeline_logs": [{ "gid": "...", "updatedAt": 1234567890, ... }]
  },
  "tombstones": [{ "gid": "...", "storeName": "timeline_logs", "deletedAt": 1234567890 }],
  "meta": { "schemaVersion": 18 }
}
```

#### 合并规则

1. **最新覆盖**：比较 `updatedAt`，新记录覆盖旧记录。
2. **Tombstone 防复活**：若某 `gid` 已被软删除，且删除时间晚于 incoming 更新时间，拒绝复活。
3. **删除传播**：tombstone 的 `deletedAt` 晚于数据 `updatedAt` 时，从 `data` 移除该记录。
4. **Timeline 去重**：同一 `date + hour + content` 只保留最新一条，其余写 tombstone。

> 核心合并逻辑已抽到 `sync_core.py`，并由 `tests/test_sync_core.py` 覆盖 25 个单元测试。

### 3.2 `/api/backup`

| 方法 | 用途 | 响应 |
|---|---|---|
| POST | 接收客户端完整数据，写入 `.sync/auto-backup.json` | `{ "ok": true }` |
| GET | 返回备份文件元信息 | `{ "ok": true, "exists": true, "size": ..., "total": ..., "counts": {...} }` |

---

## 4. 系统与部署

| 方法 | 端点 | 说明 |
|---|---|---|
| GET | `/api/deploy-status` | 部署状态自检：server / 隧道 / 各设备同步时间 / 备份 / cloudflared 体积 |

### `/api/deploy-status` 响应

```json
{
  "ok": true,
  "server": { "up": true, "port": 8080 },
  "time": 1234567890000,
  "tunnel": { "live": "", "published": "", "match": false, "reachable": null },
  "devices": [{ "device": "phone", "syncedAt": "2026-08-13T18:00:00" }],
  "backup": { "exists": true, "updatedAt": 1234567890000, "size": 12345 },
  "cloudflaredSize": 55369728
}
```

---

## 运行方式

```bash
# 本地开发
python server.py

# 带公网隧道（供远程设备访问）
python server.py --tunnel
```

---

## 维护提示

- 新增 `/api/*` 端点时，请在 `do_GET`/`do_POST` 路由表和本文档同时更新。
- 涉及外部 API 的端点，异常统一返回 `500` 并在响应体中给出可读的 `error` 信息。
- 数据相关接口的合并/校验逻辑应优先抽到独立模块（如 `sync_core.py`、`db_schema.js`）并补测试。
