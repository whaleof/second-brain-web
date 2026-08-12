// modules/habits.js - 习惯打卡台（移动端优先 / 治愈波点风 / 主题派生）
// 数据落 IndexedDB（habits / habit_logs / mood_logs），随既有局域网同步链路多端互通。

// 默认习惯名称（用于「删除后不再自动补回」判断）
const HB_DEFAULT_NAMES = new Set([
  '早起', '早睡', '洗头', '洗澡', '练舞', '喝水', '外出',
  '锻炼', '护眼', '吃水果', '记账', '拉伸'
]);
const HB_REMOVED_KEY = 'hb_removed_defaults';
// 默认习惯使用「稳定 gid」= 'hb-' + 名称，保证各设备播种出的同一习惯 gid 一致，
// 同步后不会因随机 gid 产生重复，删除也能通过 tombstone 正确跨设备传播。
function hbStableGid(name) { return 'hb-' + (name || '').trim(); }
// 打卡日志 / 每日心情同样需要稳定 gid：否则各设备为「同一习惯+同一天」各建一条
// 不同 gid 的记录，同步后两条并存、互相覆盖显示，导致手机打卡电脑看不到。
function hbLogGid(habitGid, date) { return 'hlog-' + (habitGid || 'x') + '-' + date; }
function hbMoodGid(date) { return 'mood-' + date; }

// ===== 颜色工具（全局，供内部使用）=====
function hbHexToRgb(h) {
  h = (h || '#000000').replace('#', '');
  if (h.length === 3) h = h.split('').map(c => c + c).join('');
  const n = parseInt(h, 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}
function hbRgbToHex(r, g, b) {
  return '#' + [r, g, b].map(x => Math.max(0, Math.min(255, Math.round(x))).toString(16).padStart(2, '0')).join('');
}
function hbMix(h1, h2, t) {
  const a = hbHexToRgb(h1), b = hbHexToRgb(h2);
  return hbRgbToHex(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t);
}
function hbLum(h) {
  const [r, g, b] = hbHexToRgb(h).map(x => x / 255);
  const f = x => x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

const HB_SETTINGS_KEY = 'hb_settings';
const HB_SEEDED_KEY = 'hb_seeded';
const HB_DEFAULT_SETTINGS = { nickname: '我', avatar: '🌿', themeKey: 'blush', accent: '#E79BB0' };

const HB_THEMES = {
  blush:    { name: '蜜桃', bg: '#FFF6F3', dot: '#FBE0D8' },
  mint:     { name: '薄荷', bg: '#F1FAF5', dot: '#D8EEE2' },
  lavender: { name: '薰衣草', bg: '#F6F4FC', dot: '#E6DFF6' },
  sky:      { name: '晴空', bg: '#F1F7FC', dot: '#DAEAF6' },
  cream:    { name: '奶油', bg: '#FBF7EF', dot: '#F0E7D6' },
  night:    { name: '夜幕', bg: '#2B2730', dot: '#3C3744' }
};
const HB_ACCENTS = ['#E79BB0', '#9CC4B8', '#A9A0D4', '#7FB1D9', '#E6B17A', '#C98AA6', '#8FB98E', '#D98C8C'];
const HB_ICONS = ['🌿','☕','💧','🏃','🚶','🌅','🌙','🚿','💪','🧘','📚','📖','✍️','🎯','🥗','🍎','🦷','💊','🚭','🧴','🌸','🔥','⭐','💡','🎵','🎨','💻','📝','🏊','🚴','⛰️','🐱','🍵','🌞','☀️','💤','🤸','🧠','🥱','🍳','🧹','🛒','💰','🌱','🎮','📷','🌈','🐶','🍇','🌛','🛏️','🧖'];
const HB_TYPES = [
  { key: 'check', label: '打勾', desc: '完成即勾选' },
  { key: 'count', label: '计数', desc: '每天 N 次' },
  { key: 'duration', label: '时长', desc: '累计分钟' },
  { key: 'timerange', label: '时间段', desc: '记录起止' }
];
const HB_SIZES = [
  { key: 's', label: '紧凑' },
  { key: 'm', label: '标准' },
  { key: 'l', label: '宽松' }
];
const HB_MOODS = [
  { v: 1, e: '😞', l: '糟糕' },
  { v: 2, e: '😐', l: '一般' },
  { v: 3, e: '🙂', l: '还行' },
  { v: 4, e: '😊', l: '不错' },
  { v: 5, e: '🤩', l: '超棒' }
];

const Habits = {
  tab: 'today',
  viewDate: null,      // 「今日」tab 当前查看的日期（默认今天，可切历史）
  settings: null,
  _timer: null,        // { habitGid, start, iv }
  _sel: null,          // 表单选择态
  _busy: new Set(),    // 防重复触发（触摸+click 双发 / 快速连点）
  _ctx: null,          // 当前「今日」视图的 { habits, logs, moods, ds }，供局部重绘用

  // ===== 初始化 =====
  initStyles() {
    if (document.getElementById('hb-style')) return;
    const s = document.createElement('style');
    s.id = 'hb-style';
    s.textContent = `
.hb-wrap{color:var(--hb-textbg);flex:1 1 auto;min-height:0}
.hb-tabs{position:sticky;top:0;z-index:5;display:flex;gap:6px;padding:10px 2px 12px;background:linear-gradient(var(--hb-bg),color-mix(in srgb,var(--hb-bg) 88%,transparent));backdrop-filter:blur(4px)}
.hb-tab{flex:1;border:1.5px solid color-mix(in srgb,var(--hb-accent) 30%,transparent);background:var(--hb-card);color:var(--hb-text);border-radius:14px;padding:9px 4px;font-size:13px;font-weight:600;text-align:center;cursor:pointer;transition:.18s}
.hb-tab.active{background:var(--hb-accent);color:#fff;border-color:var(--hb-accent)}
.hb-card{background:var(--hb-card);color:var(--hb-text);border-radius:18px;padding:14px;margin-bottom:12px;box-shadow:0 4px 16px rgba(120,90,110,.08)}
.hb-card.tint{background:var(--hb-inner)}
.hb-sec{font-size:14px;font-weight:700;margin:2px 0 10px;display:flex;align-items:center;justify-content:space-between}
.hb-sub{opacity:.62;font-size:12px;font-weight:500}
.hb-mood-row{display:flex;gap:8px;justify-content:space-between}
.hb-mood{flex:1;background:var(--hb-inner);border-radius:14px;padding:10px 0;text-align:center;font-size:22px;cursor:pointer;border:2px solid transparent;transition:.15s}
.hb-mood.on{border-color:var(--hb-accent);background:color-mix(in srgb,var(--hb-accent) 18%,var(--hb-card))}
.hb-mood small{display:block;font-size:10px;opacity:.6;margin-top:2px}
.hb-top{display:flex;align-items:center;gap:10px;padding:10px 12px}
.hb-top-prog{display:flex;flex-direction:column;align-items:center;flex-shrink:0}
.hb-top-count{font-size:18px;font-weight:800;line-height:1.1;margin-top:2px;text-align:center}
.hb-top-den{font-size:13px;font-weight:600;opacity:.55}
.hb-top-div{width:1px;align-self:stretch;background:color-mix(in srgb,var(--hb-text) 12%,transparent)}
.hb-top-mood{flex:1;min-width:0}
.hb-mood-row2{display:flex;gap:4px;justify-content:space-between}
.hb-mood2{flex:1;text-align:center;font-size:18px;padding:6px 0;border-radius:10px;cursor:pointer;border:2px solid transparent;background:var(--hb-inner);transition:.15s}
.hb-mood2.on{border-color:var(--hb-accent);background:color-mix(in srgb,var(--hb-accent) 18%,var(--hb-card))}
@media(max-width:420px){
  .hb-top{gap:8px;padding:8px 10px}
  .hb-top-count{font-size:16px}
  .hb-top-den{font-size:12px}
  .hb-mood2{font-size:16px;padding:5px 0;border-radius:9px}
  .hb-mood-row2{gap:3px}
}
.hb-ring-wrap{display:flex;justify-content:center;padding:6px 0 2px}
.hb-top-prog svg{max-width:84px;max-height:84px}
@media(max-width:420px){.hb-top-prog svg{max-width:72px;max-height:72px}}
.hb-habit{border-radius:16px;padding:10px 12px;margin-bottom:8px;background:var(--hb-card);color:var(--hb-text);border-left:5px solid var(--hb-hc,var(--hb-accent));box-shadow:0 4px 16px rgba(120,90,110,.08)}
.hb-habit.s{padding:8px 10px}
.hb-habit.l{padding:12px}
.hb-habit-head{display:flex;align-items:flex-start;gap:10px}
.hb-habit-ico{width:34px;height:34px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:19px;background:var(--hb-inner);flex-shrink:0;margin-top:1px}
.hb-habit-main{flex:1;min-width:0;display:flex;flex-direction:column;gap:2px}
.hb-habit-title-row{display:flex;align-items:center;justify-content:space-between;gap:8px}
.hb-habit-name{font-weight:700;font-size:15px;flex:1;min-width:0;line-height:1.25}
.hb-habit-meta-row{display:flex;align-items:center;gap:6px;min-height:18px}
.hb-streak{font-size:10px;font-weight:700;color:var(--hb-accent);background:color-mix(in srgb,var(--hb-accent) 14%,var(--hb-card));padding:2px 7px;border-radius:20px;white-space:nowrap}
.hb-target{font-size:10px;opacity:.55}
.hb-check{width:34px;height:34px;border-radius:50%;border:2px solid var(--hb-accent);background:transparent;color:var(--hb-accent);font-size:18px;cursor:pointer;display:flex;align-items:center;justify-content:center;transition:.15s;flex-shrink:0}
.hb-habit-ctrl{margin-top:8px}
.hb-count{display:flex;align-items:center;gap:12px}
.hb-count-val{font-size:22px;font-weight:800}
.hb-check.done{background:var(--hb-accent);color:#fff}
.hb-done-badge{width:34px;height:34px;border-radius:50%;background:var(--hb-success,#4CAF50);color:#fff;font-size:18px;display:flex;align-items:center;justify-content:center;flex-shrink:0;box-shadow:0 2px 6px rgba(76,175,80,.3)}
.hb-count{display:flex;align-items:center;gap:12px}
.hb-count-val{font-size:22px;font-weight:800}
.hb-step{width:38px;height:38px;border-radius:12px;border:none;background:var(--hb-inner);color:var(--hb-text);font-size:22px;font-weight:700;cursor:pointer}
.hb-prog{height:8px;border-radius:8px;background:var(--hb-inner);overflow:hidden;margin-top:10px;flex:1}
.hb-prog>i{display:block;height:100%;background:var(--hb-accent);border-radius:8px}
.hb-dur-row{display:flex;align-items:center;gap:8px;flex-wrap:wrap}
.hb-chip{border:none;background:var(--hb-inner);color:var(--hb-text);border-radius:12px;padding:8px 12px;font-size:13px;font-weight:600;cursor:pointer}
.hb-chip.run{background:var(--hb-accent);color:#fff}
.hb-timer{font-size:20px;font-weight:800;font-variant-numeric:tabular-nums}
.hb-grid{display:grid;grid-template-columns:repeat(2,1fr);gap:10px}
.hb-grid-manage{gap:8px}
.hb-tile{background:var(--hb-card);color:var(--hb-text);border-radius:16px;padding:12px;position:relative}
.hb-tile-manage{padding:10px;border-radius:14px;cursor:pointer;transition:.15s}
.hb-tile-manage:active{transform:scale(.98)}
.hb-tile-manage .x{top:6px;right:8px;font-size:14px;padding:4px}
.hb-tile .x{position:absolute;top:8px;right:10px;color:var(--hb-text);opacity:.4;cursor:pointer;font-size:16px}
.hb-stat-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px}
.hb-stat{background:var(--hb-card);color:var(--hb-text);border-radius:14px;padding:12px 8px;text-align:center}
.hb-stat b{font-size:22px;display:block}
.hb-heat{display:grid;grid-template-columns:repeat(10,1fr);gap:5px}
.hb-heat-cell{aspect-ratio:1;border-radius:5px;background:var(--hb-inner)}
.hb-bars{display:flex;align-items:flex-end;gap:6px;height:120px;padding:6px 0}
.hb-bar{flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;height:100%;justify-content:flex-end}
.hb-bar>i{width:100%;border-radius:6px 6px 0 0;background:var(--hb-accent);min-height:3px}
.hb-bar small{font-size:10px;opacity:.6}
.hb-badges{display:grid;grid-template-columns:repeat(3,1fr);gap:10px}
.hb-badge{text-align:center}
.hb-badge .ring{width:62px;height:62px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:24px;margin:0 auto 6px;background:var(--hb-inner);color:var(--hb-accent)}
.hb-badge.lock .ring{color:#bbb;background:var(--hb-inner);opacity:.7}
.hb-badge small{font-size:11px;opacity:.7}
.hb-set-row{display:flex;align-items:center;justify-content:space-between;padding:12px 0;border-bottom:1px solid color-mix(in srgb,var(--hb-text) 10%,transparent)}
.hb-set-row:last-child{border-bottom:none}
.hb-avatar{width:46px;height:46px;border-radius:50%;background:var(--hb-inner);display:flex;align-items:center;justify-content:center;font-size:24px;cursor:pointer;border:2px solid transparent}
.hb-avatar.on{border-color:var(--hb-accent)}
.hb-swatches{display:flex;gap:8px;flex-wrap:wrap}
.hb-sw{width:30px;height:30px;border-radius:50%;cursor:pointer;border:2.5px solid transparent}
.hb-sw.on{border-color:var(--hb-textbg)}
.hb-form-grid{display:grid;grid-template-columns:repeat(6,1fr);gap:8px;margin-bottom:6px}
.hb-ico-opt{font-size:22px;text-align:center;padding:8px 0;border-radius:12px;background:var(--hb-inner);cursor:pointer;border:2px solid transparent}
.hb-ico-opt.on{border-color:var(--hb-accent)}
.hb-pick{display:flex;gap:8px;flex-wrap:wrap}
.hb-pick>div{padding:8px 14px;border-radius:12px;background:var(--hb-inner);cursor:pointer;border:2px solid transparent;font-size:13px;font-weight:600}
.hb-pick>div.on{border-color:var(--hb-accent);background:color-mix(in srgb,var(--hb-accent) 16%,var(--hb-card))}
.hb-empty{text-align:center;padding:30px 10px;opacity:.6}
.hb-empty .big{font-size:34px;margin-bottom:8px}
.hb-add-fab{position:fixed;right:18px;bottom:84px;width:52px;height:52px;border-radius:50%;background:var(--hb-accent);color:#fff;border:none;font-size:26px;box-shadow:0 6px 18px rgba(0,0,0,.18);cursor:pointer;z-index:20}
.hb-datenav{display:flex;align-items:center;gap:8px;background:var(--hb-inner);border-radius:14px;padding:6px}
.hb-nav-arrow{width:32px;height:32px;border-radius:10px;border:none;background:var(--hb-card);color:var(--hb-text);font-size:18px;font-weight:700;cursor:pointer;display:flex;align-items:center;justify-content:center}
.hb-nav-arrow.disabled{opacity:.35;cursor:not-allowed}
.hb-datenav-center{flex:1;text-align:center}
.hb-stat-row{display:flex;align-items:center;gap:10px;padding:10px 0;border-bottom:1px solid color-mix(in srgb,var(--hb-text) 8%,transparent);cursor:pointer}
.hb-stat-row:last-child{border-bottom:none;padding-bottom:0}
.hb-stat-row:first-child{padding-top:0}
.hb-stat-row-ico{width:36px;height:36px;border-radius:10px;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0}
.hb-stat-row-main{flex:1;min-width:0}
.hb-stat-row-name{font-weight:700;font-size:14px;margin-bottom:1px}
.hb-stat-row-val{font-size:12px;opacity:.6}
.hb-stat-row-val.done{color:var(--hb-accent);opacity:1;font-weight:700}
.hb-stat-row-check{width:26px;height:26px;border-radius:50%;border:2px solid var(--hb-accent);color:var(--hb-accent);display:flex;align-items:center;justify-content:center;font-size:14px;font-weight:700;flex-shrink:0}
.hb-stat-row-check.on{background:var(--hb-accent);color:#fff}
.hb-archive{display:flex;flex-direction:column;gap:6px;max-height:60vh;overflow-y:auto;padding-right:4px}
.hb-arc-item{background:var(--hb-card);border-radius:14px;padding:12px;cursor:pointer;display:flex;align-items:center;justify-content:space-between;transition:.15s}
.hb-arc-item:active{transform:scale(.98)}
.hb-arc-item.current{border:2px solid var(--hb-accent)}
.hb-arc-date{font-weight:700;font-size:14px}
.hb-arc-meta{display:flex;align-items:center;gap:8px;font-size:12px;opacity:.7}
.hb-arc-count{background:var(--hb-inner);padding:2px 8px;border-radius:10px}
.hb-arc-flag{background:color-mix(in srgb,var(--hb-accent) 20%,transparent);color:var(--hb-accent);padding:2px 8px;border-radius:10px;font-weight:600}
.hb-history-hint{font-size:12px;color:var(--hb-accent);font-weight:600;text-align:center;padding:8px 4px 2px;line-height:1.4}
`;
    document.head.appendChild(s);
  },

  loadSettings() {
    try {
      this.settings = Object.assign({}, HB_DEFAULT_SETTINGS, JSON.parse(localStorage.getItem(HB_SETTINGS_KEY) || '{}'));
    } catch (e) { this.settings = Object.assign({}, HB_DEFAULT_SETTINGS); }
    if (!HB_THEMES[this.settings.themeKey]) this.settings.themeKey = 'blush';
    return this.settings;
  },
  saveSettings() {
    localStorage.setItem(HB_SETTINGS_KEY, JSON.stringify(this.settings));
  },

  themeVars() {
    const st = this.settings;
    const theme = HB_THEMES[st.themeKey] || HB_THEMES.blush;
    const accent = st.accent;
    const cardBg = hbMix(theme.bg, accent, 0.10);
    const innerBg = hbMix(theme.bg, accent, 0.20);
    const ringTrack = hbMix(theme.bg, accent, 0.18);
    const textOnCard = hbLum(cardBg) > 0.55 ? '#413D40' : '#F3EEF1';
    const textOnBg = hbLum(theme.bg) > 0.55 ? '#4A4548' : '#EDE7EA';
    return {
      '--hb-bg': theme.bg, '--hb-dot': theme.dot, '--hb-accent': accent,
      '--hb-card': cardBg, '--hb-inner': innerBg, '--hb-ring': ringTrack,
      '--hb-text': textOnCard, '--hb-textbg': textOnBg
    };
  },

  // ===== 主渲染 =====
  async render(preserveScroll = false) {
    this.initStyles();
    this.loadSettings();
    const content = document.getElementById('content');
    content.classList.add('hb-content');
    const savedScroll = (preserveScroll && content) ? content.scrollTop : 0;
    if (!this.settings) this.loadSettings();
    const vars = this.themeVars();
    const styleStr = Object.entries(vars).map(([k, v]) => `${k}:${v}`).join(';');
    const theme = HB_THEMES[this.settings.themeKey] || HB_THEMES.blush;

    // 一次性数据迁移：只在首次打开时执行，避免每次 render 遍历全库造成卡顿
    await this.ensureMigrated();
    localStorage.setItem(HB_SEEDED_KEY, '1');
    // 每次渲染检查缺失的默认习惯并补加（按名称去重，不会重复）
    await this.ensureHabits();
    // 实时合并可能新产生的重复习惯（同步/旧迁移残留），幂等且数据量小
    await this.dedupeHabits();

    content.innerHTML = `<div class="hb-wrap" style="${styleStr};background-color:${theme.bg};background-image:radial-gradient(${theme.dot} 1.6px, transparent 1.6px);background-size:20px 20px">
      <div class="hb-tabs">
        ${this.tabBtn('today', '今日')}
        ${this.tabBtn('manage', '管理')}
        ${this.tabBtn('stats', '统计')}
      </div>
      <div id="hb-body"></div>
      ${this.tab === 'manage' ? '<button class="hb-add-fab" onclick="Habits.openForm()">+</button>' : ''}
    </div>`;

    const body = document.getElementById('hb-body');
    if (this.tab === 'today') body.innerHTML = await this.renderToday();
    else if (this.tab === 'manage') body.innerHTML = await this.renderManage();
    else if (this.tab === 'stats') body.innerHTML = await this.renderStats();
    if (content && preserveScroll) content.scrollTop = savedScroll;
  },

  tabBtn(key, label) {
    return `<div class="hb-tab ${this.tab === key ? 'active' : ''}" onclick="Habits.switchTab('${key}')">${label}</div>`;
  },
  switchTab(key) {
    this.tab = key;
    this.render();
  },

  // ===== 数据加载 =====
  async loadHabits() {
    const list = await window.DB.getAll('habits');
    // 防御性去重：同名习惯只保留一条（稳定 gid 优先），避免多端同步/旧迁移残留导致重复渲染
    const seen = new Map();
    for (const h of list) {
      const name = (h.name || '').trim();
      if (!name) continue;
      if (seen.has(name)) {
        const cur = seen.get(name);
        const curStable = cur.gid && cur.gid.startsWith('hb-');
        const hStable = h.gid && h.gid.startsWith('hb-');
        if (!curStable && hStable) seen.set(name, h);
      } else {
        seen.set(name, h);
      }
    }
    return [...seen.values()].filter(h => !h.archived).sort((a, b) => (a.order || 0) - (b.order || 0));
  },
  async loadLogs() {
    return await window.DB.getAll('habit_logs');
  },
  async loadMoods() {
    return await window.DB.getAll('mood_logs');
  },
  getLog(logs, habitOrId, date) {
    // 兼容旧调用（habitId 数字）；优先推荐传入 habit 对象，可同时按 habitGid 匹配，
    // 解决跨设备同步后 habitId 不一致导致打卡状态显示错误的问题。
    if (habitOrId && typeof habitOrId === 'object') {
      return logs.find(l => l.date === date && (l.habitGid === habitOrId.gid || l.habitId === habitOrId.id));
    }
    return logs.find(l => l.habitId === habitOrId && l.date === date);
  },
  isDone(habit, log) {
    if (!log) return false;
    if (habit.type === 'check' || habit.type === 'timerange') return !!log.done;
    const target = habit.target || 1;
    return (log.value || 0) >= target;
  },
  computeStreak(habit, logs) {
    let streak = 0;
    const d = new Date();
    for (let i = 0; i < 400; i++) {
      const ds = fmtDate(d.getTime() - i * 86400000);
      if (this.isDone(habit, this.getLog(logs, habit, ds))) streak++;
      else if (i === 0) continue; // 今天还没打卡不中断历史
      else break;
    }
    return streak;
  },

  // ===== 今日打卡（也用于查看/编辑历史某天）=====
  async renderToday() {
    if (!this.viewDate || this.viewDate > todayStr()) this.viewDate = todayStr();
    const ds = this.viewDate;
    const isToday = ds === todayStr();
    const habits = await this.loadHabits();
    const logs = await this.loadLogs();
    const moods = await this.loadMoods();

    let html = this.renderDateNav(habits, logs);

    html += this.topCard(habits, logs, moods, ds, isToday);

    if (habits.length === 0) {
      html += `<div class="hb-empty"><div class="big">🌱</div>还没有习惯，去「管理」添加一个吧</div>`;
      this._ctx = { habits, logs, moods, ds };
      return html;
    }

    html += habits.map(h => this.habitCard(h, logs, ds)).join('');
    this._ctx = { habits, logs, moods, ds };
    return html;
  },

  // 顶部完成度 + 心情卡（抽成方法，便于打卡后局部重绘，避免整页重建）
  topCard(habits, logs, moods, ds, isToday) {
    const mood = (moods || []).find(m => m.date === ds);
    const doneCount = habits.filter(h => this.isDone(h, this.getLog(logs, h, ds))).length;
    const ratio = habits.length ? doneCount / habits.length : 0;
    return `
      <div class="hb-card hb-top">
        <div class="hb-top-prog">
          ${this.ringSvg(ratio)}
          <div class="hb-top-count">${doneCount}<span class="hb-top-den">/${habits.length}</span></div>
          <div class="hb-sub">已完成</div>
        </div>
        <div class="hb-top-div"></div>
        <div class="hb-top-mood">
          <div class="hb-sub" style="margin-bottom:6px">${isToday ? '今天的心情' : '这天心情'}</div>
          <div class="hb-mood-row2">
            ${HB_MOODS.map(m => `<div class="hb-mood2 ${mood && mood.mood === m.v ? 'on' : ''}" title="${m.l}" onclick="Habits.setMood(${m.v})">${m.e}</div>`).join('')}
          </div>
        </div>
      </div>`;
  },

  ringSvg(ratio) {
    const R = 38, S = 96, c = 2 * Math.PI * R, off = c * (1 - ratio);
    return `<svg width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">
      <circle cx="${S / 2}" cy="${S / 2}" r="${R}" fill="none" stroke="var(--hb-ring)" stroke-width="9"/>
      <circle cx="${S / 2}" cy="${S / 2}" r="${R}" fill="none" stroke="var(--hb-accent)" stroke-width="9" stroke-linecap="round"
        stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" transform="rotate(-90 ${S / 2} ${S / 2})"/>
      <text x="${S / 2}" y="${S / 2 - 1}" text-anchor="middle" font-size="20" font-weight="800" fill="var(--hb-text)">${Math.round(ratio * 100)}%</text>
      <text x="${S / 2}" y="${S / 2 + 15}" text-anchor="middle" font-size="9" fill="var(--hb-text)" opacity=".5">完成</text>
    </svg>`;
  },

  habitCard(h, logs, today) {
    // 用 habit 对象（按 habitGid 匹配），与 doneCount 口径一致，避免跨设备同步后 habitId 不一致导致勾显示丢失
    const log = this.getLog(logs, h, today);
    const done = this.isDone(h, log);
    const streak = this.computeStreak(h, logs);
    const sizeCls = h.size || 'm';
    const ctrl = this.controlFor(h, log, today);
    const targetTxt = h.type === 'count' ? `目标 ${h.target || 1} 次`
      : h.type === 'duration' ? `目标 ${h.target || 1} 分` : '';
    const isCheckLike = h.type === 'check' || h.type === 'timerange';
    return `<div class="hb-habit ${sizeCls}" data-gid="${h.gid || ''}" style="--hb-hc:${h.color || 'var(--hb-accent)'}">
      <div class="hb-habit-head">
        <div class="hb-habit-ico">${h.icon || '⭐'}</div>
        <div class="hb-habit-main">
          <div class="hb-habit-title-row">
            <span class="hb-habit-name">${esc(h.name)}</span>
            ${isCheckLike
              ? `<button type="button" class="hb-check ${done ? 'done' : ''}" data-gid="${h.gid || ''}" onclick="event.stopPropagation();Habits.toggleDone('${h.gid || ''}')">${done ? '✓' : ''}</button>`
              : (done ? `<span class="hb-done-badge" title="今日已完成">✓</span>` : '')}
          </div>
          <div class="hb-habit-meta-row">
            ${streak > 0 ? `<span class="hb-streak">🔥 ${streak}天</span>` : ''}
            ${targetTxt ? `<span class="hb-target">${targetTxt}</span>` : ''}
          </div>
        </div>
      </div>
      ${ctrl ? `<div class="hb-habit-ctrl">${ctrl}</div>` : ''}
    </div>`;
  },

  controlFor(h, log, today) {
    const val = log ? (log.value || 0) : 0;
    if (h.type === 'count') {
      const target = h.target || 1;
      const pct = Math.min(100, Math.round(val / target * 100));
      return `<div class="hb-count">
        <button class="hb-step" onclick="Habits.changeCount('${h.gid || ''}',-1)">−</button>
        <div style="flex:1">
          <div class="hb-count-val">${val}<span style="font-size:13px;font-weight:500;opacity:.6"> / ${target}</span></div>
          <div class="hb-prog"><i style="width:${pct}%"></i></div>
        </div>
        <button class="hb-step" onclick="Habits.changeCount('${h.gid || ''}',1)">+</button>
      </div>`;
    }
    if (h.type === 'duration') {
      const running = this._timer && this._timer.habitGid === h.gid;
      return `<div class="hb-dur-row">
        <span class="hb-timer" id="hb_timer_${h.gid || 'x'}">${this.fmtDur(val)}</span>
        <button class="hb-chip" onclick="Habits.changeDur('${h.gid || ''}',15)">+15</button>
        <button class="hb-chip" onclick="Habits.changeDur('${h.gid || ''}',30)">+30</button>
        <button class="hb-chip ${running ? 'run' : ''}" onclick="Habits.toggleTimer('${h.gid || ''}')">${running ? '结束' : '计时'}</button>
      </div>`;
    }
    if (h.type === 'timerange') {
      const start = log && log.start ? log.start : '';
      const end = log && log.end ? log.end : '';
      return `<div class="hb-dur-row">
        <input class="input" type="time" value="${start}" onchange="Habits.setRange('${h.gid || ''}','start',this.value)" style="flex:1;min-width:0" />
        <span style="opacity:.5">→</span>
        <input class="input" type="time" value="${end}" onchange="Habits.setRange('${h.gid || ''}','end',this.value)" style="flex:1;min-width:0" />
      </div>`;
    }
    return '';
  },

  fmtDur(min) {
    min = Math.floor(min || 0);
    const h = Math.floor(min / 60), m = min % 60;
    return h > 0 ? `${h}h${m}m` : `${m}m`;
  },

  async ensureLog(habitId, date) {
    const habits = await this.loadHabits();
    const habit = habits.find(h => h.id === habitId);
    const habitGid = habit ? habit.gid : '';
    const gid = hbLogGid(habitGid || habitId, date);
    // 优先按稳定 gid 查找（同步后各设备同一记录）
    let log = await window.DB.getByGid('habit_logs', gid);
    if (log) return log;
    // 兼容旧随机 gid 日志：同习惯同日期若已存在，重写为稳定 gid
    const logs = await this.loadLogs();
    const legacy = logs.find(l => l.habitId === habitId && l.date === date);
    const base = { habitId, habitGid, date, type: habit ? habit.type : 'check', done: false, value: 0, start: '', end: '', note: '' };
    if (legacy) {
      await window.DB.put('habit_logs', { ...legacy, ...base, gid, updatedAt: Date.now() });
      return await window.DB.getByGid('habit_logs', gid);
    }
    const id = await window.DB.add('habit_logs', { ...base, gid });
    return { ...base, id, gid };
  },

  _currentDate() { return this.viewDate || todayStr(); },

  // 一次性迁移调度：加总标记，避免每次 render 重复执行全量迁移导致页面卡顿
  async ensureMigrated() {
    if (localStorage.getItem('hb_migrated_all_v1')) return;
    await this.migrateV2();
    await this.migrateSplitWash();
    await this.dedupeHabits();
    // 把默认习惯统一到稳定 gid，合并各设备随机 gid 造成的重复（根因：同步后习惯列表不一致）
    await this.migrateHabitGids();
    // 把打卡日志 / 每日心情统一到稳定 gid，合并各设备随机 gid 造成的重复（根因：同一天打卡手机电脑不同步）
    await this.migrateHabitLogs();
    localStorage.setItem('hb_migrated_all_v1', '1');
  },

  // 打卡/改历史后，立即调度一次双向同步（不依赖 localStorage 备份链路，更稳更及时）
  _syncTimer: null,
  scheduleSync() {
    if (this._syncTimer) clearTimeout(this._syncTimer);
    this._syncTimer = setTimeout(() => {
      try { if (window.DB && window.DB.syncNow) window.DB.syncNow().catch(() => {}); } catch (e) {}
    }, 1500);
  },

  // ===== 打卡交互（稳定 gid 定位 + 局部重绘，避免整页重建导致的闪/误触）=====
  async _resolveHabit(gid) {
    const inCtx = this._habitByGid(gid);
    if (inCtx) return inCtx;
    return (await this.loadHabits()).find(h => h.gid === gid);
  },
  _habitByGid(gid) {
    if (this._ctx && this._ctx.habits) {
      const f = this._ctx.habits.find(h => h.gid === gid);
      if (f) return f;
    }
    return null;
  },
  _ctxLog(gid, ds) {
    if (!this._ctx) return null;
    const habit = this._habitByGid(gid);
    const hid = habit ? habit.id : null;
    return this._ctx.logs.find(l => l.date === ds && (l.habitGid === gid || (hid != null && l.habitId === hid)));
  },
  _setCtxLog(updated) {
    if (!this._ctx) return;
    const i = this._ctx.logs.findIndex(l => l.date === updated.date &&
      (l.habitGid === updated.habitGid || (updated.habitId != null && l.habitId === updated.habitId)));
    if (i >= 0) this._ctx.logs[i] = updated;
    else this._ctx.logs.push(updated);
  },
  // 只重绘某一张习惯卡（替换该卡 DOM，不动其他卡，杜绝误触串卡）
  repaintCard(gid) {
    const wrap = document.querySelector(`.hb-habit[data-gid="${gid}"]`);
    if (!wrap || !this._ctx) return;
    const habit = this._habitByGid(gid);
    if (!habit) return;
    wrap.outerHTML = this.habitCard(habit, this._ctx.logs, this._ctx.ds);
  },
  // 只重绘顶部完成度 + 心情卡
  repaintTop() {
    if (!this._ctx) return;
    const el = document.querySelector('.hb-top');
    if (!el) return;
    el.outerHTML = this.topCard(this._ctx.habits, this._ctx.logs, this._ctx.moods, this._ctx.ds, this._ctx.ds === todayStr());
  },

  async toggleDone(gid) {
    if (!gid) return;
    if (this._busy && this._busy.has(gid)) return;   // 防触摸+click 双发
    this._busy.add(gid);
    try {
      const ds = this._currentDate();
      const habit = await this._resolveHabit(gid);
      if (!habit) return;
      const log = await this.ensureLog(habit.id, ds);
      const updated = { ...log, done: !log.done };
      this._setCtxLog(updated);
      this.repaintCard(gid);
      this.repaintTop();
      await window.DB.put('habit_logs', updated);
      this.scheduleSync();
    } catch (e) { console.warn('[habits] toggleDone 失败', e); }
    finally { this._busy.delete(gid); }
  },
  async changeCount(gid, delta) {
    if (!gid) return;
    const k = 'c' + gid;
    if (this._busy && this._busy.has(k)) return;
    this._busy.add(k);
    try {
      const ds = this._currentDate();
      const habit = await this._resolveHabit(gid);
      if (!habit) return;
      const log = await this.ensureLog(habit.id, ds);
      const updated = { ...log, value: Math.max(0, (log.value || 0) + delta) };
      this._setCtxLog(updated);
      this.repaintCard(gid);
      this.repaintTop();
      await window.DB.put('habit_logs', updated);
      this.scheduleSync();
    } catch (e) { console.warn('[habits] changeCount 失败', e); }
    finally { this._busy.delete(k); }
  },
  async changeDur(gid, mins) {
    if (!gid) return;
    const k = 'd' + gid;
    if (this._busy && this._busy.has(k)) return;
    this._busy.add(k);
    try {
      const ds = this._currentDate();
      const habit = await this._resolveHabit(gid);
      if (!habit) return;
      const log = await this.ensureLog(habit.id, ds);
      const updated = { ...log, value: Math.max(0, (log.value || 0) + mins) };
      this._setCtxLog(updated);
      this.repaintCard(gid);
      this.repaintTop();
      await window.DB.put('habit_logs', updated);
      this.scheduleSync();
    } catch (e) { console.warn('[habits] changeDur 失败', e); }
    finally { this._busy.delete(k); }
  },
  async setRange(gid, field, value) {
    if (!gid) return;
    const k = 'r' + gid;
    if (this._busy && this._busy.has(k)) return;
    this._busy.add(k);
    try {
      const ds = this._currentDate();
      const habit = await this._resolveHabit(gid);
      if (!habit) return;
      const log = await this.ensureLog(habit.id, ds);
      const upd = { ...log, [field]: value };
      if (upd.start && upd.end) upd.done = true;
      this._setCtxLog(upd);
      this.repaintCard(gid);
      this.repaintTop();
      await window.DB.put('habit_logs', upd);
      this.scheduleSync();
    } catch (e) { console.warn('[habits] setRange 失败', e); }
    finally { this._busy.delete(k); }
  },
  toggleTimer(gid) {
    if (!gid) return;
    if (this._timer && this._timer.habitGid === gid) {
      this.stopTimer(gid);
      return;
    }
    this._timer = { habitGid: gid, start: Date.now(), iv: null };
    // 每帧重新取 DOM 节点（局部重绘后旧节点已 detached，需指向新节点）
    this._timer.iv = setInterval(() => {
      const el = document.getElementById('hb_timer_' + (this._timer.habitGid || 'x'));
      if (!el) return;
      const sec = Math.floor((Date.now() - this._timer.start) / 1000);
      el.textContent = this.fmtDur(sec / 60);
    }, 1000);
    this.repaintCard(gid);
  },
  async stopTimer(gid) {
    if (!this._timer || this._timer.habitGid !== gid) return;
    clearInterval(this._timer.iv);
    const sec = Math.floor((Date.now() - this._timer.start) / 1000);
    const mins = Math.max(1, Math.round(sec / 60));
    const ds = this._currentDate();
    const habit = await this._resolveHabit(gid);
    if (!habit) { this._timer = null; return; }
    const log = await this.ensureLog(habit.id, ds);
    const updated = { ...log, value: (log.value || 0) + mins };
    this._setCtxLog(updated);
    this._timer = null;
    this.repaintCard(gid);
    this.repaintTop();
    await window.DB.put('habit_logs', updated);
    this.scheduleSync();
  },

  async setMood(v) {
    const ds = this._currentDate();
    const gid = hbMoodGid(ds);
    let m = await window.DB.getByGid('mood_logs', gid);
    if (m) await window.DB.put('mood_logs', { ...m, mood: v });
    else await window.DB.add('mood_logs', { date: ds, mood: v, gid });
    if (this._ctx) {
      const i = this._ctx.moods.findIndex(x => x.date === ds);
      if (i >= 0) this._ctx.moods[i].mood = v;
      else this._ctx.moods.push({ date: ds, mood: v, gid });
    }
    this.repaintTop();
    this.scheduleSync();
  },

  // ===== 习惯管理 =====
  async renderManage() {
    const habits = await this.loadHabits();
    if (habits.length === 0) {
      return `<div class="hb-empty"><div class="big">🌱</div>还没有习惯<br/>点击下方 + 添加你的第一个习惯</div>`;
    }
    return `<div class="hb-grid hb-grid-manage">${habits.map(h => `
      <div class="hb-tile hb-tile-manage" style="border-left:5px solid ${h.color || 'var(--hb-accent)'}" onclick="Habits.openForm('${h.gid || ''}')">
        <span class="x" onclick="event.stopPropagation();Habits.delHabit('${h.gid || ''}')">✕</span>
        <div style="font-size:24px">${h.icon || '⭐'}</div>
        <div style="font-weight:700;margin:4px 0 1px;font-size:14px">${esc(h.name)}</div>
        <div class="hb-sub" style="font-size:11px">${((HB_TYPES.find(t => t.key === h.type) || {}).label || '')}${h.target ? ' · ' + h.target : ''}</div>
        ${h.desc ? `<div style="font-size:10px;opacity:.6;margin-top:3px;line-height:1.3;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden">${esc(h.desc)}</div>` : ''}
      </div>`).join('')}</div>
      <div style="text-align:center;margin-top:6px">
        <button class="hb-chip" onclick="Habits.clearSample()">清空示例数据</button>
      </div>`;
  },

  async openForm(gid) {
    let h = null;
    if (gid) h = (await this.loadHabits()).find(x => x.gid === gid);
    const st = this.settings;
    this._sel = {
      icon: h ? h.icon : HB_ICONS[0],
      color: h ? h.color : st.accent,
      size: h ? h.size : 'm',
      type: h ? h.type : 'check',
      target: h ? h.target : 8
    };
    const typeNeedsTarget = this._sel.type === 'count' || this._sel.type === 'duration';
    showModal({
      title: h ? '编辑习惯' : '新建习惯',
      body: `
        <div class="form-group">
          <label class="form-label">名称</label>
          <input class="input" id="hb_name" value="${h ? esc(h.name) : ''}" placeholder="比如：喝水、阅读、冥想..." autocomplete="off" />
        </div>
        <div class="form-group">
          <label class="form-label">图标</label>
          <div class="hb-form-grid">
            ${HB_ICONS.map(ic => `<div class="hb-ico-opt ${ic === this._sel.icon ? 'on' : ''}" data-ic="${ic}" onclick="Habits.pick('icon','${ic}',this)">${ic}</div>`).join('')}
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">颜色</label>
          <div class="hb-swatches">
            ${HB_ACCENTS.map(c => `<span class="hb-sw ${c === this._sel.color ? 'on' : ''}" data-co="${c}" style="background:${c}" onclick="Habits.pick('color','${c}',this)"></span>`).join('')}
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">卡片尺寸</label>
          <div class="hb-pick" data-grp="size">
            ${HB_SIZES.map(s => `<div class="${s.key === this._sel.size ? 'on' : ''}" data-v="${s.key}" onclick="Habits.pick('size','${s.key}',this)">${s.label}</div>`).join('')}
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">打卡方式</label>
          <div class="hb-pick" data-grp="type">
            ${HB_TYPES.map(t => `<div class="${t.key === this._sel.type ? 'on' : ''}" data-v="${t.key}" onclick="Habits.pick('type','${t.key}',this)">${t.label}</div>`).join('')}
          </div>
          <p class="text-xs text-sub" style="margin-top:4px">${(HB_TYPES.find(t => t.key === this._sel.type) || {}).desc || ''}</p>
        </div>
        <div class="form-group" id="hb_target_box" style="${typeNeedsTarget ? '' : 'display:none'}">
          <label class="form-label" id="hb_target_label">${this._sel.type === 'duration' ? '每日目标分钟' : '每日目标次数'}</label>
          <input class="input" id="hb_target" type="number" min="1" value="${this._sel.target}" />
        </div>
      `,
      footer: `
        <button class="btn btn-ghost" onclick="hideModal()">取消</button>
        <button class="btn btn-primary" id="hb_save">保存</button>
      `
    });
    setTimeout(() => {
      document.getElementById('hb_save').onclick = () => this.saveForm(h);
    }, 80);
  },

  pick(field, value, el) {
    this._sel[field] = value;
    if (field === 'type') {
      const need = value === 'count' || value === 'duration';
      const box = document.getElementById('hb_target_box');
      if (box) box.style.display = need ? '' : 'none';
      const lbl = document.getElementById('hb_target_label');
      if (lbl) lbl.textContent = value === 'duration' ? '每日目标分钟' : '每日目标次数';
    }
    const grp = el.parentElement;
    if (grp && grp.classList.contains('hb-pick')) {
      grp.querySelectorAll('div').forEach(d => d.classList.remove('on'));
      el.classList.add('on');
    } else {
      // 图标/颜色：兄弟节点高亮
      el.parentElement.querySelectorAll('.on').forEach(d => d.classList.remove('on'));
      el.classList.add('on');
    }
  },

  async saveForm(h) {
    const name = document.getElementById('hb_name').value.trim();
    if (!name) { toast('请输入习惯名称'); return; }
    const targetEl = document.getElementById('hb_target');
    const target = (this._sel.type === 'count' || this._sel.type === 'duration')
      ? Math.max(1, parseInt(targetEl.value) || 1) : 0;
    const data = {
      name, icon: this._sel.icon, color: this._sel.color,
      size: this._sel.size, type: this._sel.type, target,
      order: h ? h.order : 999
    };
    if (h) { await window.DB.put('habits', { ...h, ...data }); }
    else { await window.DB.add('habits', data); }
    hideModal();
    toast('已保存');
    this.render();
  },

  async delHabit(gid) {
    const ok = await confirmDialog('删除这个习惯？相关打卡记录也会删除');
    if (!ok) return;
    const h = (await this.loadHabits()).find(x => x.gid === gid);
    if (!h) return;
    const logs = await this.loadLogs();
    for (const l of logs.filter(x => x.habitId === h.id)) await window.DB.delete('habit_logs', l.id);
    await window.DB.delete('habits', h.id);
    // 若是默认习惯，记入「已删除」集合，避免下次渲染又被自动补回
    if (h && HB_DEFAULT_NAMES.has((h.name || '').trim())) {
      let removed = [];
      try { removed = JSON.parse(localStorage.getItem(HB_REMOVED_KEY) || '[]'); } catch (e) { removed = []; }
      if (!removed.includes(h.name)) {
        removed.push(h.name);
        localStorage.setItem(HB_REMOVED_KEY, JSON.stringify(removed));
      }
    }
    // 修复（08-07 截图 bug）：无论是否默认，都写本地 tombstone store，
    // 让 sync 把删除操作传到 server 并广播到其它设备，避免下次渲染被 ensureHabits 复活
    const tombGid = (h && h.gid) || (h && hbStableGid(h.name)) || null;
    if (tombGid) {
      try {
        await window.DB._addTombstoneIfNewer({
          gid: tombGid,
          storeName: 'habits',
          deletedAt: Date.now(),
          deletedBy: (window.DB.getDeviceId && window.DB.getDeviceId()) || 'unknown'
        });
      } catch (e) { console.warn('[habits] tombstone 写入失败，不影响本次删除:', e); }
    }
    toast('已删除');
    this.render();
  },

  // ===== 数据统计（纯看板，不含当天编辑）=====
  async renderStats() {
    const habits = await this.loadHabits();
    const logs = await this.loadLogs();
    const moods = await this.loadMoods();

    // 概览统计
    const totalCount = logs.length;
    const maxStreak = habits.reduce((m, h) => Math.max(m, this.computeStreak(h, logs)), 0);
    const avgMood = moods.length ? (moods.reduce((s, m) => s + m.mood, 0) / moods.length) : 0;

    // 近 30 天数据（用于热力图）
    const today = new Date();
    const days = [];
    for (let i = 29; i >= 0; i--) {
      const ds = fmtDate(today.getTime() - i * 86400000);
      const done = habits.filter(h => this.isDone(h, this.getLog(logs, h, ds))).length;
      days.push({ date: ds, ratio: habits.length ? done / habits.length : 0, done, total: habits.length });
    }

    return `
      <div class="hb-card">
        <div class="hb-sec"><span>30 天热力图</span><span class="hb-sub">颜色越深完成越多</span></div>
        <div class="hb-heat">
          ${days.map(d => {
            const col = d.ratio > 0 ? hbMix('#EDE7E4', this.settings.accent, d.ratio) : '#ECE6E3';
            return `<div class="hb-heat-cell" title="${d.date} ${Math.round(d.ratio * 100)}%" style="background:${col}" onclick="Habits.jumpStatsDate('${d.date}')"></div>`;
          }).join('')}
        </div>
      </div>

      <div class="hb-stat-grid">
        <div class="hb-stat"><b>${habits.length}</b><span class="hb-sub">习惯数</span></div>
        <div class="hb-stat"><b>${maxStreak}</b><span class="hb-sub">最长连续</span></div>
        <div class="hb-stat"><b>${totalCount}</b><span class="hb-sub">打卡次数</span></div>
      </div>

      <div class="hb-card">
        <div class="hb-sec"><span>近 7 天趋势</span><span class="hb-sub">完成个数</span></div>
        <div class="hb-bars">
          ${days.slice(-7).map(d => {
            const max = Math.max(1, d.total);
            const hpx = Math.round(d.done / max * 100);
            return `<div class="hb-bar"><i style="height:${hpx}%"></i><small>${d.date.slice(5)}</small></div>`;
          }).join('')}
        </div>
      </div>

      <div class="hb-card">
        <div class="hb-sec"><span>心情曲线</span><span class="hb-sub">近 30 天 · 均 ${avgMood ? avgMood.toFixed(1) : '—'}</span></div>
        ${this.moodCurve(moods)}
      </div>

      <div class="hb-card">
        <div class="hb-sec"><span>成就徽章</span><span class="hb-sub">${this.badgeCount(habits, logs, totalCount)}/${this.badges(habits, logs, totalCount, maxStreak).length}</span></div>
        <div class="hb-badges">${this.badges(habits, logs, totalCount, maxStreak).map(b => `
          <div class="hb-badge ${b.ok ? '' : 'lock'}"><div class="ring">${b.ok ? b.ico : '🔒'}</div><small>${b.name}</small></div>
        `).join('')}</div>
      </div>`;
  },

  renderDateNav(habits, logs) {
    const ds = this.viewDate || todayStr();
    const isToday = ds === todayStr();
    const d = new Date(ds + 'T12:00:00');
    const dateText = `${d.getMonth() + 1}月${d.getDate()}日`;
    const hasLog = habits.some(h => this.getLog(logs, h, ds));
    const emptyTip = habits.length ? (hasLog ? '' : '这天还没有记录') : '还没有习惯';

    return `
      <div class="hb-card">
        <div class="hb-datenav">
          <button class="hb-nav-arrow" onclick="Habits.shiftViewDate(-1)" title="前一天">‹</button>
          <div class="hb-datenav-center">
            <div style="font-weight:700;font-size:15px;white-space:nowrap">${isToday ? '今天 · ' : ''}${dateText}</div>
            ${emptyTip ? `<div class="hb-sub" style="margin-top:2px">${emptyTip}</div>` : ''}
          </div>
          <button class="hb-nav-arrow ${isToday ? 'disabled' : ''}" onclick="Habits.shiftViewDate(1)" title="后一天">›</button>
          <button class="hb-nav-arrow" onclick="Habits.openArchive()" title="全部记录" style="display:flex;align-items:center;justify-content:center">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v4H4z"/><path d="M5 8v12h14V8"/><line x1="10" y1="13" x2="14" y2="13"/></svg>
          </button>
        </div>
        ${!isToday ? `<div class="hb-history-hint">📅 历史日期 · 点击圆圈可直接修改当天打卡</div>` : ''}
      </div>`;
  },

  shiftViewDate(delta) {
    const ds = this.viewDate || todayStr();
    const d = new Date(ds + 'T12:00:00');
    d.setDate(d.getDate() + delta);
    const next = fmtDate(d.getTime());
    if (next > todayStr()) return toast('已经是今天了');
    this.viewDate = next;
    this.render();
  },

  gotoViewToday() {
    this.viewDate = todayStr();
    this.render();
  },

  jumpStatsDate(date) {
    this.viewDate = date;
    this.switchTab('today');
  },

  async openArchive() {
    const habits = await this.loadHabits();
    const logs = await this.loadLogs();
    const byDate = {};
    const seen = new Set();
    logs.forEach(l => {
      const key = l.date + '|' + (l.habitGid || l.habitId);
      if (seen.has(key)) return;            // 同日同习惯只计一次，避免重复日志重复计数
      seen.add(key);
      if (!byDate[l.date]) byDate[l.date] = { done: 0 };
      const h = habits.find(x => x.gid === l.habitGid) || habits.find(x => x.id === l.habitId);
      if (h && this.isDone(h, l)) byDate[l.date].done++;
    });
    const dates = Object.keys(byDate).sort().reverse();

    showModal({
      title: '全部记录',
      body: dates.length === 0
        ? '<p class="text-sub" style="text-align:center;padding:20px 0">还没有任何打卡记录</p>'
        : `<div class="hb-archive">
            ${dates.map(d => `
              <div class="hb-arc-item ${d === (this.viewDate || todayStr()) ? 'current' : ''}" onclick="Habits.jumpStatsDate('${d}');hideModal()">
                <div class="hb-arc-date">${d}${d === todayStr() ? ' · 今天' : ''}</div>
                <div class="hb-arc-meta">
                  <span class="hb-arc-count">${byDate[d].done} / ${habits.length} 完成</span>
                </div>
              </div>`).join('')}
          </div>`,
      footer: '<button class="btn btn-primary" onclick="hideModal()">关闭</button>'
    });
  },

  async openLogEdit(habitId, date) {
    const h = (await this.loadHabits()).find(x => x.id === habitId);
    if (!h) return;
    const logs = await this.loadLogs();
    let log = this.getLog(logs, habitId, date);
    const isNew = !log;
    if (!log) {
      // 用稳定 gid 预建记录，避免「补录」路径生成随机 gid 导致跨设备不同步
      log = await this.ensureLog(habitId, date);
    }

    let body = '';
    if (h.type === 'check') {
      body = `
        <div class="form-group">
          <label class="form-label">${esc(h.name)} · ${date}</label>
          <div class="hb-pick" id="hb_log_done_pick">
            <div class="${log.done ? 'on' : ''}" data-v="1" onclick="Habits.pickLogDone(1,this)">已完成</div>
            <div class="${!log.done ? 'on' : ''}" data-v="0" onclick="Habits.pickLogDone(0,this)">未完成</div>
          </div>
        </div>`;
    } else if (h.type === 'count') {
      body = `
        <div class="form-group">
          <label class="form-label">${esc(h.name)} · ${date}</label>
          <input class="input" id="hb_log_value" type="number" min="0" value="${log.value || 0}" />
          <p class="text-xs text-sub">目标：${h.target || 1} 次</p>
        </div>`;
    } else if (h.type === 'duration') {
      body = `
        <div class="form-group">
          <label class="form-label">${esc(h.name)} · ${date}</label>
          <input class="input" id="hb_log_value" type="number" min="0" value="${log.value || 0}" placeholder="分钟" />
          <p class="text-xs text-sub">目标：${h.target || 1} 分钟</p>
        </div>`;
    } else if (h.type === 'timerange') {
      body = `
        <div class="form-group">
          <label class="form-label">${esc(h.name)} · ${date}</label>
          <div style="display:flex;align-items:center;gap:8px">
            <input class="input" id="hb_log_start" type="time" value="${log.start || ''}" style="flex:1" />
            <span style="opacity:.5">→</span>
            <input class="input" id="hb_log_end" type="time" value="${log.end || ''}" style="flex:1" />
          </div>
        </div>`;
    }

    showModal({
      title: `${esc(h.name)} · ${date}`,
      body,
      footer: `
        ${isNew ? '' : '<button class="btn btn-danger" id="hb_log_del">删除</button>'}
        <button class="btn btn-ghost" onclick="hideModal()">取消</button>
        <button class="btn btn-primary" id="hb_log_save">保存</button>
      `
    });
    this._logEdit = { log, h, isNew };
    setTimeout(() => {
      document.getElementById('hb_log_save').onclick = () => this.saveLogEdit();
      const delBtn = document.getElementById('hb_log_del');
      if (delBtn) delBtn.onclick = () => this.delLogEdit();
    }, 50);
  },

  pickLogDone(v, el) {
    this._logEdit.log.done = !!v;
    const grp = el.parentElement;
    grp.querySelectorAll('div').forEach(d => d.classList.remove('on'));
    el.classList.add('on');
  },

  async saveLogEdit() {
    const { log, h, isNew } = this._logEdit || {};
    if (!log) return;
    let upd = { ...log };
    if (h.type === 'check') {
      upd.done = !!upd.done;
    } else if (h.type === 'count' || h.type === 'duration') {
      const valEl = document.getElementById('hb_log_value');
      upd.value = Math.max(0, parseInt(valEl ? valEl.value : 0) || 0);
      upd.done = upd.value >= (h.target || 1);
    } else if (h.type === 'timerange') {
      upd.start = document.getElementById('hb_log_start')?.value || '';
      upd.end = document.getElementById('hb_log_end')?.value || '';
      upd.done = !!(upd.start && upd.end);
    }
    if (isNew) {
      await window.DB.add('habit_logs', upd);
    } else {
      await window.DB.put('habit_logs', upd);
    }
    this.scheduleSync();
    hideModal();
    toast('已保存');
    this.render();
  },

  async delLogEdit() {
    const { log, isNew } = this._logEdit || {};
    if (!log || isNew) return;
    const ok = await confirmDialog('删除这条打卡记录？');
    if (!ok) return;
    await window.DB.delete('habit_logs', log.id);
    hideModal();
    toast('已删除');
    this.render();
  },

  moodCurve(moods) {
    const map = {};
    moods.forEach(m => map[m.date] = m.mood);
    const today = new Date();
    const pts = [];
    for (let i = 29; i >= 0; i--) {
      const ds = fmtDate(today.getTime() - i * 86400000);
      pts.push(map[ds] != null ? map[ds] : null);
    }
    const W = 300, H = 90, pad = 8;
    const n = pts.length;
    const x = i => pad + i * (W - 2 * pad) / (n - 1);
    const y = v => H - pad - (v - 1) / 4 * (H - 2 * pad);
    let d = '', has = false;
    pts.forEach((v, i) => {
      if (v == null) return;
      d += (has ? ' L' : 'M') + x(i).toFixed(1) + ' ' + y(v).toFixed(1);
      has = true;
    });
    let dots = '';
    pts.forEach((v, i) => { if (v != null) dots += `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2.6" fill="var(--hb-accent)"/>`; });
    return `<svg width="100%" viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" style="display:block">
      <line x1="${pad}" y1="${y(1)}" x2="${W - pad}" y2="${y(1)}" stroke="var(--hb-inner)" stroke-width="1"/>
      <line x1="${pad}" y1="${y(5)}" x2="${W - pad}" y2="${y(5)}" stroke="var(--hb-inner)" stroke-width="1"/>
      <path d="${d}" fill="none" stroke="var(--hb-accent)" stroke-width="2.2" stroke-linejoin="round" stroke-linecap="round"/>
      ${dots}
    </svg>`;
  },

  badges(habits, logs, totalCount, maxStreak) {
    const streak7 = habits.some(h => this.computeStreak(h, logs) >= 7);
    const streak30 = habits.some(h => this.computeStreak(h, logs) >= 30);
    const weekPerfect = (() => {
    const today = new Date();
    for (let i = 0; i < 7; i++) {
      const ds = fmtDate(today.getTime() - i * 86400000);
      const done = habits.filter(h => this.isDone(h, this.getLog(logs, h, ds))).length;
      if (habits.length && done < habits.length) return false;
    }
      return habits.length > 0;
    })();
    return [
      { name: '初见习惯', ico: '🌱', ok: habits.length >= 1 },
      { name: '百次达成', ico: '💯', ok: totalCount >= 100 },
      { name: '记录满满', ico: '📒', ok: totalCount >= 50 },
      { name: '坚持一周', ico: '🔥', ok: streak7 },
      { name: '月度达人', ico: '🏆', ok: streak30 },
      { name: '全勤一周', ico: '⭐', ok: weekPerfect }
    ];
  },
  badgeCount(habits, logs, totalCount) {
    return this.badges(habits, logs, totalCount, 0).filter(b => b.ok).length;
  },

  // ===== 数据 =====
  async clearSample() {
    const ok = await confirmDialog('仅清空示例习惯及相关记录？');
    if (!ok) return;
    const habits = (await window.DB.getAll('habits')).filter(h => h.sample);
    for (const h of habits) {
      const logs = (await this.loadLogs()).filter(l => l.habitId === h.id);
      for (const l of logs) {
        await window.DB.delete('habit_logs', l.id);
        if (l.gid) {
          try { await window.DB._addTombstoneIfNewer({ gid: l.gid, storeName: 'habit_logs', deletedAt: Date.now() }); }
          catch (e) { console.warn('log tombstone 失败', e); }
        }
      }
      await window.DB.delete('habits', h.id);
      if (h.gid) {
        try { await window.DB._addTombstoneIfNewer({ gid: h.gid, storeName: 'habits', deletedAt: Date.now() }); }
        catch (e) { console.warn('habit tombstone 失败', e); }
      }
    }
    const moods = (await this.loadMoods()).filter(m => m.sample);
    for (const m of moods) {
      await window.DB.delete('mood_logs', m.id);
      if (m.gid) {
        try { await window.DB._addTombstoneIfNewer({ gid: m.gid, storeName: 'mood_logs', deletedAt: Date.now() }); }
        catch (e) { console.warn('mood tombstone 失败', e); }
      }
    }
    localStorage.removeItem(HB_SEEDED_KEY);
    toast('已清空示例');
    this.render();
  },

  // ===== 示例数据 =====
  // 必备打卡事项：早起 / 早睡 / 洗头洗澡 / 锻炼 / 喝水 / 外出
  async seedSample() {
    const existing = await window.DB.getAll('habits');
    const mk = (o) => window.DB.add('habits', o);
    const habits = [
      { name: '早起',   icon: '🌅', color: '#FFB74D', size: 's', type: 'check',    target: 0,  order: 1,  desc: '用晨光打开一天' },
      { name: '早睡',   icon: '🌙', color: '#9575CD', size: 's', type: 'check',    target: 0,  order: 2,  desc: '给身体和大脑充电' },
      { name: '洗头',   icon: '🚿', color: '#4FC3F7', size: 's', type: 'check',    target: 0,  order: 3,  desc: '清爽从头开始' },
      { name: '洗澡',   icon: '🛁', color: '#4FC3F7', size: 's', type: 'check',    target: 0,  order: 3.5,desc: '洗掉疲惫，焕然一新' },
      { name: '练舞',   icon: '💃', color: '#F06292', size: 's', type: 'duration', target: 30, order: 4,  desc: '重复里长出质感' },
      { name: '喝水',   icon: '💧', color: '#4DD0E1', size: 's', type: 'count',    target: 8,  order: 5,  desc: '细胞在喊渴' },
      { name: '外出',   icon: '🚶', color: '#81C784', size: 's', type: 'check',    target: 0,  order: 6,  desc: '走出去，世界才进来' },
      { name: '锻炼',   icon: '💪', color: '#E57373', size: 's', type: 'duration', target: 30, order: 7,  desc: '身体是你最大的底气' },
      { name: '护眼',   icon: '👀', color: '#AED581', size: 's', type: 'check',    target: 0,  order: 8,  desc: '屏幕之外，眼睛也需要休息' },
      { name: '吃水果', icon: '🍎', color: '#FF8A65', size: 's', type: 'check',    target: 0,  order: 9,  desc: '给身体加点颜色' },
      { name: '记账',   icon: '🧾', color: '#BCAAA4', size: 's', type: 'check',    target: 0,  order: 10, desc: '看见钱去哪儿了' },
      { name: '拉伸',   icon: '🧘', color: '#7986CB', size: 's', type: 'duration', target: 15, order: 11, desc: '把紧绷还回去' }
    ];
    const ids = [];
    for (const h of habits) {
      const ex = existing.find(x => (x.name || '').trim() === h.name && x.sample);
      ids.push(ex ? ex.id : await mk({ ...h, sample: true }));
    }
    // 给示例习惯填一点历史打卡，让热力图/趋势不至于空白（已存在的日期跳过，避免重复造数据）
    const today = new Date();
    for (let i = 12; i >= 0; i--) {
      const ds = fmtDate(today.getTime() - i * 86400000);
      const r = () => Math.random();
      for (let k = 0; k < ids.length; k++) {
        const h = habits[k];
        const habitId = ids[k];
        const hasLog = (await this.loadLogs()).some(l => l.habitId === habitId && l.date === ds);
        if (hasLog) continue;
        if (h.type === 'check') {
          if (r() > 0.35) await window.DB.add('habit_logs', { habitId, habitGid: '', date: ds, type: 'check', done: true, value: 0, start: '', end: '' });
        } else if (h.type === 'count') {
          await window.DB.add('habit_logs', { habitId, habitGid: '', date: ds, type: 'count', done: r() > 0.3, value: Math.floor(r() * (h.target + 1)), start: '', end: '' });
        } else if (h.type === 'duration') {
          await window.DB.add('habit_logs', { habitId, habitGid: '', date: ds, type: 'duration', done: r() > 0.5, value: Math.floor(r() * (h.target + 10)), start: '', end: '' });
        }
      }
      if (r() > 0.4) {
        const m = (await this.loadMoods()).find(x => x.date === ds && x.sample);
        if (!m) await window.DB.add('mood_logs', { date: ds, mood: 2 + Math.floor(r() * 4), sample: true });
      }
    }
  },

  // 迁移：把旧版示例习惯（喝够水/阅读/冥想）替换为新的必备 6 项
  async migrateV2() {
    if (localStorage.getItem('hb_migrated_v2')) return;
    const habits = await window.DB.getAll('habits');
    const samples = habits.filter(h => h.sample);
    const logs = await this.loadLogs();
    for (const h of samples) {
      for (const l of logs.filter(x => x.habitId === h.id)) await window.DB.delete('habit_logs', l.id);
      await window.DB.delete('habits', h.id);
    }
    const sampleMoods = (await this.loadMoods()).filter(m => m.sample);
    for (const m of sampleMoods) await window.DB.delete('mood_logs', m.id);
    await this.seedSample();
    localStorage.setItem('hb_migrated_v2', '1');
  },

  // 一次性迁移：把旧版单个「洗头洗澡」拆成「洗头」「洗澡」两个独立习惯，并继承其打卡记录。
  async migrateSplitWash() {
    if (localStorage.getItem('hb_split_wash')) return;
    const habits = await window.DB.getAll('habits');
    const wash = habits.find(h => (h.name || '').trim() === '洗头洗澡');
    if (wash) {
      const washLogs = (await this.loadLogs()).filter(l => l.habitId === wash.id);
      const mk = (o) => window.DB.add('habits', o);
      const id1 = await mk({ name: '洗头', icon: wash.icon || '🚿', color: wash.color || '#4FC3F7', size: wash.size || 's', type: 'check', target: 0, order: wash.order || 3, sample: true });
      const id2 = await mk({ name: '洗澡', icon: wash.icon || '🚿', color: wash.color || '#4FC3F7', size: wash.size || 's', type: 'check', target: 0, order: (wash.order || 3) + 0.5, sample: true });
      for (const l of washLogs) {
        for (const nid of [id1, id2]) {
          const exists = (await this.loadLogs()).some(x => x.habitId === nid && x.date === l.date);
          if (!exists) await window.DB.add('habit_logs', { habitId: nid, habitGid: '', date: l.date, type: 'check', done: l.done, value: 0, start: '', end: '' });
        }
        await window.DB.delete('habit_logs', l.id);
      }
      await window.DB.delete('habits', wash.id);
    }
    localStorage.setItem('hb_split_wash', '1');
  },

  // 去重：同一名称出现多条（旧版双播种 / 多端同步各播一次）时，保留打卡记录多的那条，
  // 其余记录的日志并入保留条后删除，避免出现「双份习惯」。
  async dedupeHabits() {
    const habits = await window.DB.getAll('habits');
    const byName = {};
    for (const h of habits) {
      const k = (h.name || '').trim();
      if (!k) continue;
      (byName[k] = byName[k] || []).push(h);
    }
    const logs = await this.loadLogs();
    let changed = false;
    for (const k in byName) {
      const group = byName[k];
      if (group.length <= 1) continue;
      group.sort((a, b) => {
        const la = logs.filter(l => l.habitId === a.id).length;
        const lb = logs.filter(l => l.habitId === b.id).length;
        if (lb !== la) return lb - la;
        return a.id - b.id;
      });
      const keep = group[0];
      const keepDates = new Set(logs.filter(l => l.habitId === keep.id).map(l => l.date));
      for (let i = 1; i < group.length; i++) {
        const dup = group[i];
        for (const l of logs.filter(x => x.habitId === dup.id)) {
          if (!keepDates.has(l.date)) {
            await window.DB.put('habit_logs', { ...l, habitId: keep.id, habitGid: keep.gid || '' });
            keepDates.add(l.date);
          } else {
            await window.DB.delete('habit_logs', l.id);
          }
        }
        await window.DB.delete('habits', dup.id);
        changed = true;
      }
    }
    if (changed) console.log('[habits] 已去除重复习惯');
  },

  // 仅在「缺失且用户未删过」时补加默认习惯；不复活被删习惯
  async ensureHabits() {
    let removed = [];
    try { removed = JSON.parse(localStorage.getItem(HB_REMOVED_KEY) || '[]'); } catch (e) { removed = []; }
    const removedSet = new Set(removed);
    // 已被 tombstone 删除的默认习惯（跨设备同步的删除记录），不再补回
    const tombstoned = new Set((await window.DB.getAll('tombstones'))
      .filter(t => t.storeName === 'habits')
      .map(t => t.gid));
    const existingNames = new Set((await window.DB.getAll('habits')).map(h => (h.name || '').trim()));
    const defaults = [
      { name: '早起',   icon: '🌅', color: '#FFB74D', size: 's', type: 'check',    target: 0,  order: 1,  desc: '用晨光打开一天' },
      { name: '早睡',   icon: '🌙', color: '#9575CD', size: 's', type: 'check',    target: 0,  order: 2,  desc: '给身体和大脑充电' },
      { name: '洗头',   icon: '🚿', color: '#4FC3F7', size: 's', type: 'check',    target: 0,  order: 3,  desc: '清爽从头开始' },
      { name: '洗澡',   icon: '🛁', color: '#4FC3F7', size: 's', type: 'check',    target: 0,  order: 3.5,desc: '洗掉疲惫，焕然一新' },
      { name: '练舞',   icon: '💃', color: '#F06292', size: 's', type: 'duration', target: 30, order: 4,  desc: '重复里长出质感' },
      { name: '喝水',   icon: '💧', color: '#4DD0E1', size: 's', type: 'count',    target: 8,  order: 5,  desc: '细胞在喊渴' },
      { name: '外出',   icon: '🚶', color: '#81C784', size: 's', type: 'check',    target: 0,  order: 6,  desc: '走出去，世界才进来' },
      { name: '锻炼',   icon: '💪', color: '#E57373', size: 's', type: 'duration', target: 30, order: 7,  desc: '身体是你最大的底气' },
      { name: '护眼',   icon: '👀', color: '#AED581', size: 's', type: 'check',    target: 0,  order: 8,  desc: '屏幕之外，眼睛也需要休息' },
      { name: '吃水果', icon: '🍎', color: '#FF8A65', size: 's', type: 'check',    target: 0,  order: 9,  desc: '给身体加点颜色' },
      { name: '记账',   icon: '🧾', color: '#BCAAA4', size: 's', type: 'check',    target: 0,  order: 10, desc: '看见钱去哪儿了' },
      { name: '拉伸',   icon: '🧘', color: '#7986CB', size: 's', type: 'duration', target: 15, order: 11, desc: '把紧绷还回去' }
    ];
    let added = 0;
    for (const d of defaults) {
      if (removedSet.has(d.name)) continue;                 // 本机删过的不再自动加回
      if (tombstoned.has(hbStableGid(d.name))) continue;     // 跨设备已删除的默认习惯不再补回
      if (existingNames.has(d.name)) continue;              // 已存在
      // 使用稳定 gid，保证各设备同一习惯 gid 一致、同步不重复
      await window.DB.add('habits', { ...d, sample: true, gid: hbStableGid(d.name) });
      added++;
    }
    if (added) console.log(`[habits] 补加了 ${added} 个缺失习惯`);
  },

  // 把默认习惯统一到稳定 gid，并合并历史重复（各设备曾用随机 gid 独立播种导致同步后重复）。
  // 幂等：稳定 gid 已存在时不再处理。同时把 OKR 里对该习惯的旧 gid 引用改到稳定 gid。
  async migrateHabitGids() {
    const habits = await window.DB.getAll('habits');
    const logs = await window.DB.getAll('habit_logs');
    const gidMap = {};  // oldGid -> stableGid（仅默认习惯）
    let changed = false;

    for (const name of HB_DEFAULT_NAMES) {
      const stable = hbStableGid(name);
      const group = habits.filter(h => (h.name || '').trim() === name);
      if (group.length === 0) continue;
      // 目标：已是稳定 gid 的优先；否则日志最多的；否则第一个
      let target = group.find(h => h.gid === stable);
      if (!target) {
        target = group.slice().sort((a, b) => {
          const la = logs.filter(l => l.habitId === a.id).length;
          const lb = logs.filter(l => l.habitId === b.id).length;
          if (lb !== la) return lb - la;
          return a.id - b.id;
        })[0];
        await window.DB.put('habits', { ...target, gid: stable, updatedAt: Date.now() });
        gidMap[target.gid] = stable;
        changed = true;
      }
      // 合并其余同名（随机 gid）重复项
      for (const dup of group) {
        if (dup === target || dup.gid === stable) continue;
        const dupLogs = logs.filter(l => l.habitId === dup.id);
        for (const l of dupLogs) {
          await window.DB.put('habit_logs', { ...l, habitId: target.id, habitGid: stable, updatedAt: Date.now() });
        }
        await window.DB.delete('habits', dup.id);
        if (dup.gid) gidMap[dup.gid] = stable;
        changed = true;
      }
    }

    // 更新 OKR 中对旧 gid 的引用
    if (Object.keys(gidMap).length) {
      const okrs = await window.DB.getAll('okr');
      for (const o of okrs) {
        let oChanged = false;
        const krs = (o.keyResults || []).map(k => {
          if (k.habitGid && gidMap[k.habitGid]) { oChanged = true; return { ...k, habitGid: gidMap[k.habitGid] }; }
          return k;
        });
        if (oChanged) await window.DB.put('okr', { ...o, keyResults: krs, updatedAt: Date.now() });
      }
    }
    if (changed) console.log('[habits] 默认习惯已统一稳定 gid');
  },

  // 把打卡日志 / 每日心情统一到稳定 gid，并合并各设备随机 gid 造成的重复。
  // 打卡日志稳定 gid = hlog-<习惯gid>-<日期>；心情稳定 gid = mood-<日期>。
  async migrateHabitLogs() {
    const habits = await window.DB.getAll('habits');
    const habitById = new Map(habits.map(h => [h.id, h]));
    const logs = await window.DB.getAll('habit_logs');
    const byKey = {};
    for (const l of logs) {
      const habit = habitById.get(l.habitId);
      const habitGid = habit ? habit.gid : (l.habitGid || '');
      const key = habitGid + '|' + l.date;
      (byKey[key] = byKey[key] || []).push({ ...l, habitGid });
    }
    for (const group of Object.values(byKey)) {
      let target = group.find(g => g.gid === hbLogGid(g.habitGid, g.date));
      if (!target) {
        target = group.slice().sort((a, b) =>
          (b.done ? 1 : 0) - (a.done ? 1 : 0) ||
          ((b.value || 0) - (a.value || 0)) ||
          ((b.updatedAt || 0) - (a.updatedAt || 0)))[0];
      }
      const stable = hbLogGid(target.habitGid, target.date);
      if (target.gid !== stable) {
        await window.DB.put('habit_logs', { ...target, gid: stable, habitGid: target.habitGid, updatedAt: Date.now() });
      }
      for (const dup of group) {
        if (dup === target || dup.gid === stable) continue;
        await window.DB.delete('habit_logs', dup.id);
      }
    }

    // 每日心情：按日期稳定 gid 合并
    const moods = await window.DB.getAll('mood_logs');
    const mByDate = {};
    for (const m of moods) (mByDate[m.date] = mByDate[m.date] || []).push(m);
    for (const group of Object.values(mByDate)) {
      let target = group.find(g => g.gid === hbMoodGid(g.date));
      if (!target) target = group.slice().sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))[0];
      const stable = hbMoodGid(target.date);
      if (target.gid !== stable) await window.DB.put('mood_logs', { ...target, gid: stable, updatedAt: Date.now() });
      for (const dup of group) {
        if (dup === target || dup.gid === stable) continue;
        await window.DB.delete('mood_logs', dup.id);
      }
    }
  }
};

window.Habits = Habits;
