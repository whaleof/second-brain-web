// db.js - IndexedDB 封装层 + localStorage 自动备份 + 局域网增量同步
// 第二大脑数据持久化
//
// ⚠️ 重要：IndexedDB 按浏览器 origin（域名）隔离！
// Cloudflare Tunnel 每次重连可能换域名，导致之前数据"消失"。
// 对策：每次数据变更自动同步到 localStorage（同 origin 快速恢复）。
// 建议始终通过 PWA 桌面图标打开应用，避免 origin 变化。

const DB_NAME = 'second_brain_db';
const DB_VERSION = 18;                     // v18: 新增 fund_alert_rules（择时监控预警规则）
const LS_BACKUP_KEY = 'sb_indexeddb_backup';
const SYNC_META_STORE = 'sync_meta';
const TOMBSTONES_STORE = 'tombstones';

// 写入前校验层（UMD 挂在 window.SchemaValidator；node 测试用 require 取同名对象）
const { validateRecord, DBError } = (typeof window !== 'undefined' && window.SchemaValidator)
  ? window.SchemaValidator
  : { validateRecord: () => ({ ok: true }), DBError: Error };

// 后端 API 基址：
// 默认 ''（同源）——本地由 server.py 托管时无需配置。
// 部署到静态托管（GitHub Pages / CloudStudio / Cloudflare Pages）后，
// 在「设置 → 后端服务地址」填入本机同步/行情服务地址（如 cloudflared 隧道 https URL），
// 页面即可从任何地方加载并回连本机 server.py 做同步与行情代理。
function apiUrl(path) {
  let base = '';
  try { base = localStorage.getItem('sb_api_base') || ''; } catch (e) {}
  base = (base || '').replace(/\/+$/, '');
  if (!base) return path;
  return base + path;
}

// 全部数据 store 定义
const STORES = [
  'tasks',           // 任务
  'plans',           // 计划
  'finance_records', // 记账
  'dance_sessions',  // 跳舞（旧）
  'dance_songs',     // 扒舞清单
  'dance_logs',      // 跳舞练习日志
  'internship_logs', // 实习（旧，保留兼容）
  'market_reviews',  // 金融复盘
  'news',            // 新闻
  'news_archive',    // 新闻历史归档
  'memos',           // 备忘录
  'inbox',           // 收件箱
  'weight_records',  // 体重
  'timeline_logs',   // 时间轴
  'work_logs',       // 工作日志
  'drink_records',   // 饮品记录
  'ai_daily',        // AI 日报缓存
  'thoughts',        // 随想：一天中随时记录的想法/感受，带时刻
  'thought_digests', // 随想日终整合：每日 AI 分析结果
  'habits',          // 习惯定义（图标/颜色/尺寸/类型/目标）
  'habit_logs',      // 习惯打卡记录（每日每习惯一条）
  'mood_logs',       // 每日心情
  'okr',             // 目标 / OKR 看板（Objective + Key Results）
  'kv_store',        // 通用键值存储（身高 / 基金持仓等需跨端同步的设置）
  'work_projects',   // 工作模块：项目
  'work_skills',     // 工作模块：技能
  'learn_notes',     // 认知/学习素材：链接 + 标题 + 领域标签（抖音/网页书签，v2 再接 AI 分析）
  'fund_watchlist',  // 基金投资：自选监控列表（代码/底层指数/备注）
  'fund_holdings',   // 基金投资：实际持仓（代码/份额/成本）
  'fund_alert_rules' // 基金投资：择时监控预警规则（cheap/expensive/cooldownHrs）
];

function generateGid() {
  if (typeof crypto !== 'undefined' && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  return 'g' + Math.random().toString(36).slice(2) + Date.now().toString(36) + Math.random().toString(36).slice(2);
}

function createStoreIndexes(store, name) {
  // 通用索引
  store.createIndex('createdAt', 'createdAt', { unique: false });
  store.createIndex('updatedAt', 'updatedAt', { unique: false });
  // 特定 store 索引。
  // ⚠️ 刻意不创建 date 索引：多设备同步常出现同日期多条记录，一旦 date 索引被
  // 设为 unique:true 会永久卡死同步写入；所有按日期查询都在前端 getAll 后 filter 完成。
  if (name === 'tasks') {
    store.createIndex('tag', 'tag', { unique: false });
    store.createIndex('status', 'status', { unique: false });
    store.createIndex('dueDate', 'dueDate', { unique: false });
  }
  if (name === 'finance_records') {
    store.createIndex('type', 'type', { unique: false });
  }
  if (name === 'dance_songs') {
    store.createIndex('stage', 'stage', { unique: false });
  }
  if (name === 'dance_logs') {
    store.createIndex('songId', 'songId', { unique: false });
  }
  if (name === 'news') {
    store.createIndex('savedAt', 'savedAt', { unique: false });
  }
  if (name === 'memos') {
    store.createIndex('pinned', 'pinned', { unique: false });
  }
  if (name === 'thoughts') {
    store.createIndex('ts', 'ts', { unique: false });
  }
  if (name === 'habit_logs') {
    store.createIndex('habitId', 'habitId', { unique: false });
  }
}

class SecondBrainDB {
  constructor() {
    this.db = null;
    this._backupTimer = null;
    this._diskBackupTimer = null;
    this._cloudTimer = null;
    this._suppressBackup = false;
    this._suppressCloudSync = false;
    this._syncing = false;
    this._syncPromise = null;
    this._syncState = typeof navigator !== 'undefined' && !navigator.onLine ? 'offline' : 'idle';
    this._lastSyncAt = 0;
    this._lastError = null;
    this._pendingCount = 0;
    this._lastDiskBackup = { ok: false, at: 0, error: null };
  }

  async open() {
    if (this.db) return this.db;
    return new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onerror = () => reject(req.error);
      req.onsuccess = async () => {
        this.db = req.result;
        await this.migrateCrossDeviceRefs();
        this._refreshSyncStatus();
        resolve(this.db);
      };
      req.onupgradeneeded = (e) => {
        const db = e.target.result;
        const tx = e.target.transaction;

        // 1. 确保用户数据 store 及索引
        STORES.forEach(name => {
          let store;
          if (!db.objectStoreNames.contains(name)) {
            store = db.createObjectStore(name, {
              keyPath: 'id',
              autoIncrement: true
            });
            createStoreIndexes(store, name);
          } else {
            store = tx.objectStore(name);
            // v13 修复：删除历史上被错误设为 unique:true 的 date 索引，不再重建
            // （所有按日期查询均在前端 getAll 后 filter 完成，无需索引，避免同步写入卡死）
            if (store.indexNames.contains('date')) {
              try { store.deleteIndex('date'); } catch (e) {}
            }
          }
          // v8 核心：所有 store 必须有 gid 索引
          if (!store.indexNames.contains('gid')) {
            store.createIndex('gid', 'gid', { unique: false });
          }
        });

        // 2. 同步元数据 store
        if (!db.objectStoreNames.contains(SYNC_META_STORE)) {
          db.createObjectStore(SYNC_META_STORE, { keyPath: 'key' });
        }

        // 3. 墓碑 store（记录跨设备删除）
        if (!db.objectStoreNames.contains(TOMBSTONES_STORE)) {
          const ts = db.createObjectStore(TOMBSTONES_STORE, {
            keyPath: 'id',
            autoIncrement: true
          });
          ts.createIndex('gid', 'gid', { unique: false });
          ts.createIndex('deletedAt', 'deletedAt', { unique: false });
          ts.createIndex('storeName', 'storeName', { unique: false });
        }

        // 4. 认知素材语义向量 store（本地 embedding 缓存；刻意不放入 STORES，
        //    因此不参与跨端同步 / 磁盘备份 / 导出导入；需要时可本地重算）
        if (!db.objectStoreNames.contains('learn_embeddings')) {
          db.createObjectStore('learn_embeddings', { keyPath: 'gid' });
        }

        // 5. 数据迁移：为所有历史记录生成 gid，保证历史数据可参与同步
        STORES.forEach(name => {
          const store = tx.objectStore(name);
          const cursorReq = store.openCursor();
          cursorReq.onsuccess = (ev) => {
            const cursor = ev.target.result;
            if (!cursor) return;
            const rec = cursor.value;
            if (!rec.gid) {
              rec.gid = generateGid();
              cursor.update(rec);
            }
            cursor.continue();
          };
        });
      };
    });
  }

  // ===== 通用 CRUD =====

  async add(storeName, data) {
    await this.open();
    const _v = validateRecord(storeName, data, 'add');
    if (!_v.ok) return Promise.reject(new DBError(_v.code, _v.message));
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const now = Date.now();
      const record = {
        ...data,
        createdAt: data.createdAt || now,
        updatedAt: data.updatedAt || now,
        gid: data.gid || generateGid()
      };
      const req = store.add(record);
      req.onsuccess = () => { resolve(req.result); this._scheduleBackup(); };
      req.onerror = () => reject(req.error);
    });
  }

  async put(storeName, data) {
    await this.open();
    const _v = validateRecord(storeName, data, 'put');
    if (!_v.ok) return Promise.reject(new DBError(_v.code, _v.message));
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const now = Date.now();
      const doPut = (record) => {
        if (!record.gid) record.gid = generateGid();
        const putReq = store.put(record);
        putReq.onsuccess = () => { resolve(putReq.result); this._scheduleBackup(); };
        putReq.onerror = () => reject(putReq.error);
      };
      if (data.id) {
        const getReq = store.get(data.id);
        getReq.onsuccess = () => {
          const old = getReq.result || {};
          const record = { ...old, ...data, updatedAt: data.updatedAt || now, gid: data.gid || old.gid || generateGid() };
          doPut(record);
        };
        getReq.onerror = () => reject(getReq.error);
      } else {
        const record = { ...data, updatedAt: data.updatedAt || now, gid: data.gid || generateGid() };
        doPut(record);
      }
    });
  }

  async get(storeName, id) {
    await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.get(id);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  async getAll(storeName) {
    await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      const req = store.getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
  }

  async delete(storeName, id) {
    await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction([storeName, TOMBSTONES_STORE], 'readwrite');
      const store = tx.objectStore(storeName);
      const tsStore = tx.objectStore(TOMBSTONES_STORE);
      const getReq = store.get(id);
      getReq.onsuccess = () => {
        const rec = getReq.result;
        const gid = rec && rec.gid ? rec.gid : null;
        const delReq = store.delete(id);
        delReq.onsuccess = () => {
          if (gid) {
            tsStore.add({
              gid,
              storeName,
              deletedAt: Date.now(),
              deletedBy: this.getDeviceId()
            });
          }
          resolve();
          this._scheduleBackup();
        };
        delReq.onerror = () => reject(delReq.error);
      };
      getReq.onerror = () => reject(getReq.error);
    });
  }

  async clear(storeName) {
    await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, 'readwrite');
      const store = tx.objectStore(storeName);
      const req = store.clear();
      req.onsuccess = () => { resolve(); this._scheduleBackup(); };
      req.onerror = () => reject(req.error);
    });
  }

  // ===== 按 gid 查询 =====

  async _getByGid(storeName, gid) {
    await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, 'readonly');
      const store = tx.objectStore(storeName);
      if (!store.indexNames.contains('gid')) return resolve(null);
      const idx = store.index('gid');
      const req = idx.get(gid);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  }

  // ===== 跨设备引用迁移（本地 id → gid） =====
  // 旧版 dance_logs.songId 与 drink_records.financeId 存的是本地自增 id，
  // 同步到其它设备后 id 会变化，导致引用断裂。迁移为 gid 后，引用随数据一起同步。
  async migrateCrossDeviceRefs() {
    const done = await this.getSyncMeta('migrated_refs_v1');
    if (done) return;
    this._suppressCloudSync = true;
    this._suppressBackup = true;
    try {
      // 1. dance_logs: songId 本地 id → gid
      const songs = await this.getAll('dance_songs');
      const songById = new Map(songs.map(s => [s.id, s]));
      const logs = await this.getAll('dance_logs');
      for (const log of logs) {
        if (!log.songId) continue;
        const song = songById.get(log.songId);
        if (song && song.gid) {
          await this._putRaw('dance_logs', { ...log, songId: song.gid });
        }
      }
      // 2. drink_records: financeId 本地 id → gid
      const drinks = await this.getAll('drink_records');
      const finances = await this.getAll('finance_records');
      const financeById = new Map(finances.map(f => [f.id, f]));
      for (const drink of drinks) {
        if (!drink.financeId) continue;
        const fin = financeById.get(drink.financeId);
        if (fin && fin.gid) {
          await this._putRaw('drink_records', { ...drink, financeId: fin.gid });
        }
      }
      await this.setSyncMeta('migrated_refs_v1', true);
    } finally {
      this._suppressCloudSync = false;
      this._suppressBackup = false;
      this._scheduleBackup();
    }
  }

  async _putRaw(storeName, record) {
    await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, 'readwrite');
      const req = tx.objectStore(storeName).put(record);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }

  // 公共 getByGid
  async getByGid(storeName, gid) {
    return this._getByGid(storeName, gid);
  }

  // ===== 通用键值存储（跨端同步的设置类数据）=====
  // 用固定 gid ('kv-' + key) 保证多设备合并为同一条记录
  async getKv(key) {
    const gid = 'kv-' + key;
    const rec = await this.getByGid('kv_store', gid);
    return rec ? rec.value : undefined;
  }

  async setKv(key, value) {
    const gid = 'kv-' + key;
    const existing = await this.getByGid('kv_store', gid);
    if (existing) {
      await this.put('kv_store', { ...existing, value, updatedAt: Date.now() });
    } else {
      await this.add('kv_store', { gid, key, value });
    }
  }

  // ===== localStorage 自动备份 =====

  _scheduleBackup() {
    if (this._suppressBackup) return;
    if (this._backupTimer) clearTimeout(this._backupTimer);
    this._backupTimer = setTimeout(() => this._doBackup(), 300);
  }

  async _doBackup() {
    try {
      const data = await this.exportAll();
      const json = JSON.stringify(data);
      localStorage.setItem(LS_BACKUP_KEY, json);
      localStorage.setItem('sb_last_backup', new Date().toISOString());
      // 本地备份完成后，调度一次局域网同步（防抖）和磁盘备份
      this._scheduleCloudSync();
      this._scheduleDiskBackup();
    } catch(e) {
      console.warn('localStorage 备份失败:', e.message);
    }
  }

  _scheduleDiskBackup() {
    if (this._diskBackupTimer) clearTimeout(this._diskBackupTimer);
    this._diskBackupTimer = setTimeout(() => this.backupToDisk().catch(() => {}), 2000);
  }

  async backupToDisk() {
    try {
      const data = await this.exportAll();
      const resp = await fetch(apiUrl('/api/backup'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data)
      });
      const json = await resp.json();
      if (!json.ok) throw new Error(json.error || '备份失败');
      this._lastDiskBackup = { ok: true, at: Date.now(), error: null };
      return { ok: true, size: json.size };
    } catch(e) {
      this._lastDiskBackup = { ok: false, at: Date.now(), error: e.message };
      return { ok: false, reason: e.message };
    }
  }

  async getDiskBackupInfo() {
    try {
      const resp = await fetch(apiUrl('/api/backup'));
      return await resp.json();
    } catch(e) {
      return { ok: false, reason: e.message };
    }
  }

  // ===== 跨设备局域网增量同步 =====

  getDeviceId() {
    let id = localStorage.getItem('sb_device_id');
    if (!id) {
      id = 'dev_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
      localStorage.setItem('sb_device_id', id);
    }
    return id;
  }

  _scheduleCloudSync() {
    if (this._suppressCloudSync) return;
    if (this._cloudTimer) clearTimeout(this._cloudTimer);
    this._cloudTimer = setTimeout(() => this.syncNow(), 5000); // 5秒防抖
  }

  getSyncStatus() {
    return {
      state: this._syncState,
      lastSyncAt: this._lastSyncAt,
      lastError: this._lastError,
      pendingCount: this._pendingCount,
      online: typeof navigator !== 'undefined' ? navigator.onLine : true
    };
  }

  async _refreshSyncStatus() {
    const lastSyncAt = await this.getSyncMeta('lastSyncAt') || 0;
    this._lastSyncAt = lastSyncAt;
    const pending = await this._collectChanges(lastSyncAt);
    this._pendingCount = pending.count + pending.tombstones.length;
    this._emitSyncStatus();
  }

  _emitSyncStatus() {
    if (typeof window !== 'undefined') {
      window.dispatchEvent(new CustomEvent('sb-sync-status', { detail: this.getSyncStatus() }));
    }
  }

  async getSyncMeta(key) {
    await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(SYNC_META_STORE, 'readonly');
      const store = tx.objectStore(SYNC_META_STORE);
      const req = store.get(key);
      req.onsuccess = () => resolve(req.result ? req.result.value : undefined);
      req.onerror = () => reject(req.error);
    });
  }

  async setSyncMeta(key, value) {
    await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(SYNC_META_STORE, 'readwrite');
      const store = tx.objectStore(SYNC_META_STORE);
      const req = store.put({ key, value });
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  // 收集自 since 以来的本地变更（含墓碑）
  async _collectChanges(since) {
    since = since || 0;
    const changes = {};
    let count = 0;
    for (const name of STORES) {
      const records = await this.getAll(name);
      const changed = records.filter(r => (r.updatedAt || 0) > since);
      if (changed.length) {
        changes[name] = changed;
        count += changed.length;
      }
    }
    const tombstones = (await this.getAll(TOMBSTONES_STORE)).filter(t => (t.deletedAt || 0) > since);
    return { changes, tombstones, count };
  }

  // 应用远程变更到本地，采用「最新 updatedAt 覆盖」策略
  async _applyRemoteChanges(changes, tombstones) {
    this._suppressCloudSync = true;
    this._suppressBackup = true;
    try {
      for (const [storeName, records] of Object.entries(changes || {})) {
        if (!STORES.includes(storeName)) continue;
        for (const r of records) {
          if (!r.gid) continue;
          const local = await this._getByGid(storeName, r.gid);
          const incomingUpdated = r.updatedAt || 0;
          if (!local) {
            // 新记录：去掉对端本地 id，让自增生成新本地 id
            const { id, ...rest } = r;
            await this.add(storeName, rest);
          } else if (incomingUpdated > (local.updatedAt || 0)) {
            // 冲突：以最新修改时间为准覆盖
            const updated = { ...r, id: local.id };
            await this.put(storeName, updated);
          }
        }
      }
      for (const t of (tombstones || [])) {
        if (!t.gid || !t.storeName) continue;
        const local = await this._getByGid(t.storeName, t.gid);
        if (local && (t.deletedAt || 0) > (local.updatedAt || 0)) {
          // 直接删除，避免再次生成墓碑导致循环
          await this._deleteRaw(t.storeName, local.id);
        }
        // 同时记录墓碑，方便本设备继续向其他设备传播删除
        await this._addTombstoneIfNewer(t);
      }
    } finally {
      this._suppressCloudSync = false;
      this._suppressBackup = false;
      this._scheduleBackup();
    }
  }

  async _deleteRaw(storeName, id) {
    await this.open();
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(storeName, 'readwrite');
      const req = tx.objectStore(storeName).delete(id);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  async _addTombstoneIfNewer(t) {
    await this.open();
    const existing = (await this.getAll(TOMBSTONES_STORE)).find(x => x.gid === t.gid);
    if (existing && (existing.deletedAt || 0) >= (t.deletedAt || 0)) return;
    if (existing) {
      // 更新为更早的删除时间？不需要，保留更早的即可；这里如传入更早已被上面过滤
      return;
    }
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(TOMBSTONES_STORE, 'readwrite');
      const req = tx.objectStore(TOMBSTONES_STORE).add({
        gid: t.gid,
        storeName: t.storeName,
        deletedAt: t.deletedAt || Date.now(),
        deletedBy: t.deletedBy || this.getDeviceId()
      });
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  }

  // 一键同步：先推后拉，应用冲突策略
  // force=true 时强制全量推送/拉取，用于修复旧数据漏同步
  async syncNow(force = false) {
    if (this._syncing) return this._syncPromise;
    this._syncing = true;
    this._syncState = 'syncing';
    this._emitSyncStatus();
    this._syncPromise = (async () => {
      try {
        if (typeof navigator !== 'undefined' && !navigator.onLine) {
          this._syncState = 'offline';
          return { ok: false, reason: 'offline' };
        }
        const device = encodeURIComponent(this.getDeviceId());
        let lastSyncAt = await this.getSyncMeta('lastSyncAt') || 0;
        if (force) {
          lastSyncAt = 0;
          await this.setSyncMeta('lastSyncAt', 0);
        }

        // 1. 推送本地变更（全量：since=0，避免旧记录因 lastSyncAt 已超前而漏推）
        const outgoing = await this._collectChanges(0);
        const pushBody = JSON.stringify({
          changes: outgoing.changes,
          tombstones: outgoing.tombstones,
          meta: { schemaVersion: DB_VERSION },
          pushedAt: Date.now()
        });
        const pushResp = await fetch(apiUrl(`/api/sync?device=${device}&since=${lastSyncAt}`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: pushBody
        });
        if (!pushResp.ok) throw new Error(`推送 HTTP ${pushResp.status}`);
        const pushJson = await pushResp.json();
        if (!pushJson.ok) throw new Error(pushJson.error || '推送失败');

        // 2. 拉取服务端合并后的变更
        const pullResp = await fetch(apiUrl(`/api/sync?device=${device}&since=${lastSyncAt}`));
        if (!pullResp.ok) throw new Error(`拉取 HTTP ${pullResp.status}`);
        const pullJson = await pullResp.json();
        if (!pullJson.ok) throw new Error(pullJson.error || '拉取失败');

        await this._applyRemoteChanges(pullJson.changes || {}, pullJson.tombstones || []);

        const newSyncAt = pullJson.serverTime || Date.now();
        await this.setSyncMeta('lastSyncAt', newSyncAt);
        this._lastSyncAt = newSyncAt;
        this._syncState = 'synced';
        this._lastError = null;
        this._refreshSyncStatus();
        const pulledCount = this._countChanges(pullJson.changes);
        if (pulledCount > 0) {
          // 同步拉取到远端新数据，通知 UI 重渲染当前模块
          // （治本：过去 syncNow 只 emit 同步状态 sb-sync-status，数据更新后界面不刷新）
          window.dispatchEvent(new CustomEvent('sb-sync-completed', { detail: { pulled: pulledCount } }));
        }
        return { ok: true, pushed: outgoing.count, pulled: pulledCount };
      } catch (e) {
        this._syncState = 'error';
        this._lastError = e.message;
        this._refreshSyncStatus();
        return { ok: false, reason: e.message };
      } finally {
        this._syncing = false;
        this._syncPromise = null;
        this._emitSyncStatus();
      }
    })();
    return this._syncPromise;
  }

  _countChanges(changes) {
    if (!changes) return 0;
    return Object.values(changes).reduce((sum, arr) => sum + arr.length, 0);
  }

  // 兼容旧设置面板调用：上传/下载统一走 syncNow
  async pushCloud() {
    const res = await this.syncNow();
    return res.ok;
  }

  async pullCloud() {
    const res = await this.syncNow();
    return { ok: res.ok, count: res.pulled || 0, reason: res.reason };
  }

  // ===== 备份信息 =====

  getBackupInfo() {
    try {
      const raw = localStorage.getItem(LS_BACKUP_KEY);
      if (!raw) return null;
      const data = JSON.parse(raw);
      let total = 0;
      for (const name of STORES) {
        total += (data.data?.[name] || []).length;
      }
      return {
        total,
        exportedAt: data.exportedAt,
        lastBackup: localStorage.getItem('sb_last_backup')
      };
    } catch { return null; }
  }

  async restoreFromBackup() {
    try {
      const raw = localStorage.getItem(LS_BACKUP_KEY);
      if (!raw) return 0;
      const data = JSON.parse(raw);
      return await this.importAll(data, 'overwrite');
    } catch(e) {
      throw new Error('恢复失败: ' + e.message);
    }
  }

  async totalCount() {
    await this.open();
    let total = 0;
    for (const name of STORES) {
      const records = await this.getAll(name);
      total += records.length;
    }
    return total;
  }

  generateGid() {
    return generateGid();
  }

  // 导出全部数据
  async exportAll() {
    await this.open();
    const data = {};
    for (const name of STORES) {
      data[name] = await this.getAll(name);
    }
    const tombstones = await this.getAll(TOMBSTONES_STORE);
    return {
      version: 2,
      exportedAt: new Date().toISOString(),
      deviceId: this.getDeviceId(),
      data,
      tombstones
    };
  }

  // 导入数据（合并/覆盖），支持 version 1/2
  async importAll(exported, mode = 'merge') {
    await this.open();
    this._suppressBackup = true;
    this._suppressCloudSync = true;
    try {
      if (mode === 'overwrite') {
        for (const name of STORES) await this.clear(name);
        await this.clear(TOMBSTONES_STORE);
      }
      let count = 0;
      for (const name of STORES) {
        const records = exported.data?.[name] || exported[name] || [];
        for (const r of records) {
          if (!r.gid) r.gid = generateGid();
          const local = await this._getByGid(name, r.gid);
          if (mode === 'merge' && local) {
            if ((r.updatedAt || 0) > (local.updatedAt || 0)) {
              await this.put(name, { ...r, id: local.id });
            }
            continue;
          }
          if (mode === 'merge' && !local) {
            const { id, ...rest } = r;
            await this.add(name, rest);
            count++;
            continue;
          }
          // overwrite
          const { id, ...rest } = r;
          await this.add(name, rest);
          count++;
        }
      }
      // 导入墓碑
      const tombstones = exported.tombstones || [];
      for (const t of tombstones) {
        await this._addTombstoneIfNewer(t);
      }
      return count;
    } finally {
      this._suppressBackup = false;
      this._suppressCloudSync = false;
      this._scheduleBackup();
    }
  }
}

window.DB = new SecondBrainDB();
