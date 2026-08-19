// app.js - 应用主逻辑：路由、状态、UI 工具

const App = {
  currentModule: 'home',
  modules: {
    home: { title: '首页', render: () => Home.render() },
    plans: { title: '计划', render: () => Plans.render() },
    finance: { title: '记账', render: () => Finance.render() },
    dance: { title: '跳舞', render: () => Dance.render() },
    internship: { title: '工作', render: () => Internship.render() },
    market: { title: '沪深300', render: () => Market.render() },
    timeline: { title: '时间轴', render: () => Timeline.render() },
    weight: { title: '体重记录', render: () => Weight.render() },
    drinks: { title: '饮品', render: () => Drinks.render() },
    habits: { title: '习惯', render: () => Habits.render() },
    'ai-daily': { title: 'AI日报', render: () => AIDaily.render() },
    thoughts: { title: '随想', render: () => Thoughts.render() },
    learn: { title: '认知', render: () => Learn.render() },
    absorption: { title: '认知吸收卡', render: () => Absorption.render() },
    fund: { title: '基金投资', render: () => Fund.render() }
  },
  theme: localStorage.getItem('sb_theme') || 'light'
};

// ===== UI 工具函数 =====

// 简单 HTML 转义
function esc(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

// Toast
let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 1800);
}

// 模态框
function showModal({ title, body, footer }) {
  document.getElementById('modalTitle').textContent = title || '';
  document.getElementById('modalBody').innerHTML = body || '';
  document.getElementById('modalFooter').innerHTML = footer || '';
  document.getElementById('modalMask').classList.add('show');
}
function hideModal() {
  document.getElementById('modalMask').classList.remove('show');
}

// 同步状态 UI
function updateSyncUI(status) {
  const btn = document.getElementById('syncBtn');
  const dot = document.getElementById('syncDot');
  if (!btn || !dot) return;
  btn.classList.remove('state-idle', 'state-syncing', 'state-synced', 'state-offline', 'state-error');
  btn.classList.add('state-' + (status.state || 'idle'));
  const labels = {
    idle: '点击同步',
    syncing: '同步中…',
    synced: '已同步',
    offline: '离线',
    error: '同步失败'
  };
  const last = status.lastSyncAt ? relativeTime(status.lastSyncAt) : '未同步';
  btn.title = `${labels[status.state] || '同步'} · 上次：${last}${status.pendingCount ? ' · 待同步 ' + status.pendingCount + ' 条' : ''}`;
  dot.classList.toggle('show', status.pendingCount > 0);
}

async function manualSync() {
  const btn = document.getElementById('syncBtn');
  if (btn && btn.classList.contains('state-syncing')) return;
  toast('正在同步…');
  const res = await window.DB.syncNow();
  if (res.ok) {
    toast(`同步完成 · 推 ${res.pushed || 0} / 拉 ${res.pulled || 0}`);
  } else if (res.reason === 'offline') {
    toast('当前离线，已缓存变更');
  } else {
    toast('同步失败：' + (res.reason || '未知错误'));
  }
}

async function forceFullSync() {
  toast('正在重置并全量同步…');
  await window.DB.setSyncMeta('lastSyncAt', 0);
  window.DB._lastSyncAt = 0;
  const res = await window.DB.syncNow();
  if (res.ok) {
    toast(`全量同步完成 · 推 ${res.pushed || 0} / 拉 ${res.pulled || 0}`);
  } else if (res.reason === 'offline') {
    toast('当前离线，变更已缓存');
  } else {
    toast('全量同步失败：' + (res.reason || '未知错误'));
  }
}

// 确认对话框
function confirmDialog(msg) {
  return new Promise(resolve => {
    showModal({
      title: '确认',
      body: `<p style="text-align:center;padding:10px 0">${esc(msg)}</p>`,
      footer: `
        <button class="btn btn-ghost" onclick="hideModal();window._confirmRes(false)">取消</button>
        <button class="btn btn-primary" onclick="hideModal();window._confirmRes(true)">确定</button>
      `
    });
    window._confirmRes = (ok) => resolve(ok);
  });
}

// 格式化日期
function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${m}-${day}`;
}
function fmtDateTime(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  return `${fmtDate(d)} ${String(d.getHours()).padStart(2,'0')}:${String(d.getMinutes()).padStart(2,'0')}`;
}
function todayStr() {
  return fmtDate(Date.now());
}
function relativeTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - ts;
  const min = Math.floor(diff / 60000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `${hr} 小时前`;
  const day = Math.floor(hr / 24);
  if (day < 30) return `${day} 天前`;
  return fmtDate(ts);
}

// 导航切换
function navigateTo(module) {
  if (!App.modules[module]) return;
  App.currentModule = module;
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.module === module);
  });
  document.getElementById('pageTitle').textContent = App.modules[module].title;
  document.getElementById('content').innerHTML = '';
  document.getElementById('content').classList.remove('hb-content');
  App.modules[module].render();
  // 控制 FAB（时间轴、体重、饮品、首页、市场、备忘录不需要 FAB；计划模块顶部已有「添加」输入框，亦隐藏）
  const fab = document.getElementById('fab');
  if (module === 'timeline' || module === 'weight' || module === 'drinks' || module === 'home' || module === 'market' || module === 'memo' || module === 'plans' || module === 'ai-daily' || module === 'thoughts' || module === 'habits' || module === 'okr' || module === 'fund' || module === 'absorption') {
    fab.classList.remove('show');
  } else {
    fab.onclick = () => onFabClick(module);
    fab.classList.add('show');
  }
  // 滚动到顶
  document.getElementById('content').scrollTop = 0;
  // 持久化当前模块
  localStorage.setItem('sb_module', module);
}

function onFabClick(module) {
  const handlers = {
    home: () => Home.openAdd(),
    tasks: () => Tasks.openAdd(),
    plans: () => Plans.openAdd(),
    finance: () => Finance.openAdd(),
    dance: () => Dance.openAdd(),
    internship: () => Internship.openAdd(),
    market: () => Market.openAdd(),
    learn: () => Learn.openBatchDigest()
  };
  handlers[module]?.();
}

// 主题切换
function toggleTheme() {
  App.theme = App.theme === 'light' ? 'dark' : 'light';
  // 切换瞬间禁用过渡，确保主题切换无延迟
  document.body.classList.add('no-theme-transition');
  document.body.classList.toggle('theme-dark', App.theme === 'dark');
  document.getElementById('themeBtn').textContent = App.theme === 'dark' ? '☀️' : '🌙';
  localStorage.setItem('sb_theme', App.theme);
  // 两帧后恢复过渡（避免后续交互无动画）
  requestAnimationFrame(() => requestAnimationFrame(() => {
    document.body.classList.remove('no-theme-transition');
  }));
}

// 设置面板
function openSettings() {
  showModal({
    title: '设置',
    body: `
      <div class="form-group">
        <div class="row-between" style="padding:8px 0">
          <span>深色模式</span>
          <button class="btn btn-secondary btn-sm" id="setThemeBtn">${App.theme === 'dark' ? '已开启' : '已关闭'}</button>
        </div>
      </div>
      <div class="form-group">
        <div class="row-between" style="padding:8px 0">
          <span>检查更新</span>
          <button class="btn btn-secondary btn-sm" id="updateBtn">🔄 立即更新</button>
        </div>
        <p class="text-xs text-sub" style="margin-top:4px">清除缓存并刷新，同步最新版本</p>
      </div>
      <div class="form-group">
        <div class="row-between" style="padding:8px 0">
          <span>导出数据 (JSON)</span>
          <button class="btn btn-secondary btn-sm" id="exportBtn">导出</button>
        </div>
      </div>
      <div class="form-group">
        <div class="row-between" style="padding:8px 0">
          <span>导入数据 (JSON)</span>
          <button class="btn btn-secondary btn-sm" id="importBtn">选择文件</button>
        </div>
        <input type="file" id="importFile" accept="application/json" style="display:none" />
      </div>
      <div class="form-group">
        <div class="row-between" style="padding:8px 0">
          <span>磁盘自动备份</span>
          <div style="display:flex;gap:6px">
            <button class="btn btn-secondary btn-sm" id="diskBackupBtn">立即备份</button>
          </div>
        </div>
        <p class="text-xs text-sub" style="margin-top:4px" id="diskBackupStatus">数据每 2 秒自动备份到电脑磁盘：.sync/auto-backup.json</p>
      </div>
      <div class="form-group">
        <div style="padding:8px 0">
          <div class="row-between">
            <span>后端服务地址</span>
            <button class="btn btn-secondary btn-sm" id="apiBaseReset">用同源</button>
          </div>
          <input id="apiBaseInput" class="text-input" style="width:100%;margin-top:8px;font-size:12px" placeholder="留空=同源；部署到静态托管后填同步/行情服务地址，如 https://xxx.trycloudflare.com" />
          <p class="text-xs text-sub" style="margin-top:4px">页面部署到 GitHub Pages / CloudStudio 等静态托管后，在此填入本机 server.py 的可访问地址（建议 cloudflared 隧道 https URL），即可从任意设备回连做同步与行情。留空则使用当前网址同源。</p>
        </div>
      </div>
      <div class="form-group">
        <div class="row-between" style="padding:8px 0">
          <span>局域网同步</span>
          <div style="display:flex;gap:6px">
            <button class="btn btn-secondary btn-sm" id="cloudPush">立即同步</button>
            <button class="btn btn-secondary btn-sm" id="cloudForce">强制全量同步</button>
          </div>
        </div>
        <p class="text-xs text-sub" style="margin-top:4px" id="cloudStatus">电脑启动服务且手机在同一 WiFi 时，自动增量同步；离线时本地功能照常使用</p>
      </div>
      <div class="form-group">
        <div class="row-between" style="padding:8px 0">
          <span>清空所有数据</span>
          <button class="btn btn-danger btn-sm" id="clearBtn">清空</button>
        </div>
      </div>
      <div class="form-group" style="margin-top:20px;padding-top:16px;border-top:1px solid var(--border)">
        <p class="text-small text-sub" style="line-height:1.8">
          📱 <b>第二大脑 · WorkBuddy</b><br/>
          数据三保险：① 浏览器 IndexedDB ② localStorage 自动备份 ③ 电脑磁盘 .sync/auto-backup.json。<br/>
          磁盘备份不依赖浏览器缓存，即使浏览器数据被清空，也可从磁盘 JSON 恢复。<br/>
          手机数据需先同步到电脑，才会写入磁盘备份。
        </p>
      </div>
    `,
    footer: '<button class="btn btn-primary" onclick="hideModal()">完成</button>'
  });
  setTimeout(async () => {
    // 加载磁盘备份信息
    const diskStatusEl = document.getElementById('diskBackupStatus');
    const diskInfo = await window.DB.getDiskBackupInfo();
    if (diskInfo.ok && diskInfo.exists) {
      diskStatusEl.textContent = `✅ 磁盘备份 ${relativeTime(diskInfo.updatedAt)} · ${diskInfo.total} 条 · ${(diskInfo.size/1024).toFixed(1)} KB`;
    } else if (diskInfo.ok && !diskInfo.exists) {
      diskStatusEl.textContent = '⏳ 暂无磁盘备份，请点击「立即备份」或等待自动备份';
    } else {
      diskStatusEl.textContent = '⚠️ 磁盘备份信息获取失败：' + (diskInfo.reason || '服务未启动');
    }

    document.getElementById('diskBackupBtn').onclick = async () => {
      diskStatusEl.textContent = '正在备份到磁盘…';
      const res = await window.DB.backupToDisk();
      if (res.ok) {
        const info = await window.DB.getDiskBackupInfo();
        diskStatusEl.textContent = info.ok && info.exists
          ? `✅ 已备份 · ${info.total} 条 · ${(info.size/1024).toFixed(1)} KB`
          : '✅ 备份完成';
      } else {
        diskStatusEl.textContent = '⚠️ 备份失败：' + (res.reason || '未知错误');
      }
    };

    const apiBaseInput = document.getElementById('apiBaseInput');
    if (apiBaseInput) {
      apiBaseInput.value = localStorage.getItem('sb_api_base') || '';
      apiBaseInput.onchange = () => {
        const v = (apiBaseInput.value || '').trim();
        if (v) localStorage.setItem('sb_api_base', v.replace(/\/+$/, ''));
        else localStorage.removeItem('sb_api_base');
        toast('后端地址已保存，重启同步生效');
      };
      const resetBtn = document.getElementById('apiBaseReset');
      if (resetBtn) resetBtn.onclick = () => {
        localStorage.removeItem('sb_api_base');
        apiBaseInput.value = '';
        toast('已切回同源');
      };
    }

    document.getElementById('setThemeBtn').onclick = () => {
      toggleTheme();
      hideModal();
      setTimeout(openSettings, 100);
    };
    document.getElementById('updateBtn').onclick = () => {
      hideModal();
      forceUpdate();
    };
    document.getElementById('exportBtn').onclick = exportData;
    document.getElementById('importBtn').onclick = () => document.getElementById('importFile').click();
    document.getElementById('importFile').onchange = importData;
    document.getElementById('clearBtn').onclick = clearAllData;
    document.getElementById('cloudPush').onclick = async () => {
      const res = await window.DB.syncNow();
      const statusEl = document.getElementById('cloudStatus');
      if (res.ok) {
        statusEl.textContent = `✅ 同步完成 · 推 ${res.pushed || 0} / 拉 ${res.pulled || 0}`;
        setTimeout(() => { hideModal(); navigateTo(App.currentModule); }, 600);
      } else if (res.reason === 'offline') {
        statusEl.textContent = '⚠️ 当前离线，变更已缓存，联网后自动同步';
      } else {
        statusEl.textContent = '⚠️ 同步失败：' + (res.reason || '请检查局域网连接');
      }
    };
    document.getElementById('cloudForce').onclick = async () => {
      const statusEl = document.getElementById('cloudStatus');
      statusEl.textContent = '正在全量同步…';
      const res = await window.DB.syncNow(true);
      if (res.ok) {
        statusEl.textContent = `✅ 全量同步完成 · 推 ${res.pushed || 0} / 拉 ${res.pulled || 0}`;
        setTimeout(() => { hideModal(); navigateTo(App.currentModule); }, 600);
      } else if (res.reason === 'offline') {
        statusEl.textContent = '⚠️ 当前离线，变更已缓存';
      } else {
        statusEl.textContent = '⚠️ 全量同步失败：' + (res.reason || '请检查局域网连接');
      }
    };
  }, 50);
}

// 强制更新：清除所有缓存 + 注销 SW + 硬刷新
async function forceUpdate() {
  toast('正在清除缓存...');
  // 1. 注销所有 Service Worker
  if ('serviceWorker' in navigator) {
    const regs = await navigator.serviceWorker.getRegistrations();
    for (const r of regs) { await r.unregister(); }
  }
  // 2. 清除所有缓存
  const keys = await caches.keys();
  for (const k of keys) { await caches.delete(k); }
  // 3. 硬刷新（跳过缓存）
  toast('缓存已清除，正在刷新...');
  setTimeout(() => {
    location.href = location.href.split('?')[0] + '?v=' + Date.now();
  }, 500);
}

async function exportData() {
  const data = await window.DB.exportAll();
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `第二大脑备份_${todayStr()}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast('已导出备份');
}

async function importData(e) {
  const file = e.target.files[0];
  if (!file) return;
  try {
    const text = await file.text();
    const data = JSON.parse(text);
    const ok = await confirmDialog('导入将合并到当前数据，是否继续？\n(选择「确定」会合并，重复数据将共存)');
    if (!ok) return;
    const count = await window.DB.importAll(data, 'merge');
    toast(`已导入 ${count} 条记录`);
    hideModal();
    navigateTo(App.currentModule);
  } catch (err) {
    toast('导入失败：' + err.message);
  }
}

async function clearAllData() {
  const ok = await confirmDialog('确定清空所有数据？此操作不可恢复！');
  if (!ok) return;
  for (const name of ['tasks','plans','finance_records','dance_sessions','dance_songs','dance_logs','internship_logs','market_reviews','memos','inbox','weight_records','timeline_logs','work_logs','drink_records','ai_daily','thoughts','thought_digests','habits','habit_logs','mood_logs','okr','fund_watchlist','fund_holdings']) {
    await window.DB.clear(name);
  }
  await window.DB.clear('tombstones');
  await window.DB.setSyncMeta('lastSyncAt', 0);
  window.DB._lastSyncAt = 0;
  window.DB._refreshSyncStatus();
  toast('已清空所有数据');
  hideModal();
  navigateTo(App.currentModule);
}

// 启动应用
async function boot() {
  await window.DB.open();

  // ═══ 数据完整性检测 ═══
  const total = await window.DB.totalCount();
  const backupInfo = window.DB.getBackupInfo();

  // 场景1：IndexedDB 为空但有 localStorage 备份 → 自动恢复
  if (total === 0 && backupInfo && backupInfo.total > 0) {
    console.log('检测到 localStorage 备份，自动恢复中...');
    try {
      const restored = await window.DB.restoreFromBackup();
      toast(`🔄 已恢复 ${restored} 条数据（来自本地备份）`);
    } catch(e) {
      console.error('自动恢复失败:', e);
    }
  }

  // 场景2：IndexedDB 为空且无备份 → 可能是换了访问地址
  if (total === 0 && (!backupInfo || backupInfo.total === 0)) {
    // 在首页渲染后显示提示（由 Home.render 处理）
    window._dataEmpty = true;
  } else {
    window._dataEmpty = false;
  }

  // 应用主题
  if (App.theme === 'dark') {
    document.body.classList.add('theme-dark');
    document.getElementById('themeBtn').textContent = '☀️';
  }
  // 绑定事件
  document.querySelectorAll('.nav-btn').forEach(btn => {
    btn.addEventListener('click', () => navigateTo(btn.dataset.module));
  });
  document.getElementById('themeBtn').onclick = toggleTheme;
  document.getElementById('settingsBtn').onclick = openSettings;
  document.getElementById('syncBtn').onclick = manualSync;
  document.getElementById('modalClose').onclick = hideModal;
  document.getElementById('modalMask').onclick = (e) => {
    if (e.target.id === 'modalMask') hideModal();
  };

  // 同步状态监听
  updateSyncUI(window.DB.getSyncStatus());
  window.addEventListener('sb-sync-status', (e) => updateSyncUI(e.detail));
  // 同步拉取到远端新数据后，安全重渲染当前模块（治本：过去 syncNow 只发同步状态，
  // 数据已更新但各模块界面不刷新，必须手动刷新页面才看得到）
  // 若用户正在编辑输入框则跳过，避免打断输入（数据已落库，下次切换/刷新自然更新）
  window.addEventListener('sb-sync-completed', () => {
    const ae = document.activeElement;
    const editing = ae && (ae.tagName === 'INPUT' || ae.tagName === 'TEXTAREA');
    if (editing) return;
    const mod = App.modules[App.currentModule];
    if (!mod || typeof mod.render !== 'function') return;
    // 吸收卡：内容为每周生成的独立静态 HTML（iframe 加载），同步不影响它；
    // 重渲染会重建 iframe 并刷新缓存戳，导致每 20 秒白屏闪跳，故跳过（治本）。
    if (App.currentModule === 'absorption') return;
    // 习惯模块：同步只原地重绘卡片，不整页重建，杜绝打卡后整页闪跳（治本）
    if (App.currentModule === 'habits' && typeof Habits.refresh === 'function') {
      Habits.refresh();
    }
    // 基金模块：同步只原地刷新数字，不重建 DOM（防止自选/持仓卡片反复闪动/消失）
    else if (App.currentModule === 'fund' && typeof Fund.refreshData === 'function') {
      Fund.refreshData();
    } else {
      mod.render();
    }
  });

  // 网络恢复时自动同步
  window.addEventListener('online', () => {
    window.DB._syncState = 'idle';
    window.DB._emitSyncStatus();
    checkTunnelHint();
    window.DB.syncNow().catch(() => {});
  });
  window.addEventListener('offline', () => {
    window.DB._syncState = 'offline';
    window.DB._emitSyncStatus();
  });

  // 定时同步（每 20 秒尝试一次，失败静默）——保证一端打卡后另一端很快收到
  setInterval(() => {
    checkTunnelHint();
    if (navigator.onLine) window.DB.syncNow().catch(() => {});
  }, 20000);

  // 启动后延迟首次同步
  setTimeout(() => {
    checkTunnelHint();
    if (navigator.onLine) window.DB.syncNow().catch(() => {});
  }, 3000);

  // 恢复上次模块
  const last = localStorage.getItem('sb_module') || 'home';
  navigateTo(last);
}

document.addEventListener('DOMContentLoaded', boot);

// 自动从 GitHub Pages 上的 tunnel.txt 读取最新隧道地址并填入后端地址，免去手动填写。
// tunnel.txt 由本机 server.py --tunnel 在隧道地址变化时自动推送。地址天天变也无感知。
async function checkTunnelHint() {
  try {
    // 加时间戳 query 破除 GitHub Pages / CDN 对边缘缓存 tunnel.txt 的滞后（否则手机拿到旧隧道地址）
    const res = await fetch('tunnel.txt?t=' + Date.now(), { cache: 'no-store' });
    if (!res.ok) return;
    const txt = (await res.text()).trim();
    if (!/^https:\/\//.test(txt)) return;
    const next = txt.replace(/\/+$/, '');
    const cur = (localStorage.getItem('sb_api_base') || '').replace(/\/+$/, '');
    // 若用户已手动设置一个地址，且当前地址能正常同步，则不强制覆盖（避免死地址劫持）
    if (cur && cur !== next) {
      const healthy = await pingApi(cur);
      if (healthy) {
        console.log('[隧道] 当前后端地址正常，保留手动设置', cur);
        return;
      }
    }
    if (cur !== next) {
      // 先验证隧道地址是否真的存活，存活才采用，避免把死地址塞给用户
      const alive = await pingApi(next);
      if (!alive) {
        console.log('[隧道] 候选地址不可达，跳过自动更新', next);
        return;
      }
      localStorage.setItem('sb_api_base', next);
      console.log('[隧道] 自动更新后端地址为', next);
      if (window.DB && window.DB.syncNow) window.DB.syncNow().catch(() => {});
    }
  } catch (e) {
    // 本地运行或无网络时 tunnel.txt 不存在，忽略即可
  }
}

// 轻量健康检查：探测后端 /api/backup（GET，返回 200 即存活），带短超时
async function pingApi(base) {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3500);
    const r = await fetch(base.replace(/\/+$/, '') + '/api/backup?device=ping', { signal: ctrl.signal, cache: 'no-store' });
    clearTimeout(t);
    return r.ok;
  } catch (e) {
    return false;
  }
}

// 暴露给模块使用
window.App = App;
window.navigateTo = navigateTo;
window.showModal = showModal;
window.hideModal = hideModal;
window.toast = toast;
window.confirmDialog = confirmDialog;
window.esc = esc;
window.fmtDate = fmtDate;
window.fmtDateTime = fmtDateTime;
window.todayStr = todayStr;
window.relativeTime = relativeTime;
