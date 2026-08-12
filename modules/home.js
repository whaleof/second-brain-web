// modules/home.js - 首页：习惯完成情况四宫格 + 今日随想 + 模块快捷入口

const Home = {
  async render() {
    const content = document.getElementById('content');
    const today = todayStr();
    const [habits, habitLogs, thoughts, timelineLogs, drinks, weights, finances, plansAll] = await Promise.all([
      window.DB.getAll('habits'),
      window.DB.getAll('habit_logs'),
      window.DB.getAll('thoughts'),
      window.DB.getAll('timeline_logs'),
      window.DB.getAll('drink_records'),
      window.DB.getAll('weight_records'),
      window.DB.getAll('finance_records'),
      window.DB.getAll('plans'),
    ]);

    // ===== 习惯完成情况四宫格（今日）=====
    const getLog = (h) => habitLogs.find(l => l.habitGid === h.gid && l.date === today);
    const isDone = (h, log) => {
      if (!log) return false;
      if (h.type === 'check') return !!log.done;
      if (h.type === 'timerange') return !!log.done && !!log.start && !!log.end;
      return (log.value || 0) > 0; // count / duration
    };
    const total = habits.length;
    const done = habits.filter(h => isDone(h, getLog(h))).length;
    const undone = total - done;
    const rate = total ? Math.round(done / total * 100) : 0;

    const statGrid = `
      <div class="hstat-grid">
        <div class="hstat"><b>${total}</b><span>习惯数</span></div>
        <div class="hstat"><b>${done}</b><span>已完成</span></div>
        <div class="hstat"><b>${undone}</b><span>未完成</span></div>
        <div class="hstat"><b>${rate}%</b><span>完成率</span></div>
      </div>`;

    // 今日随想
    const todayThoughts = thoughts.filter(t => t.date === today);
    const thoughtCount = todayThoughts.length;

    // 模块快捷入口（4 个，显示今日实时进度，点整张卡跳转）
    const tlCount = timelineLogs.filter(t => t.date === today).length;
    const drinkCount = drinks.filter(d => d.date === today).length;
    const mods = [
      { key: 'thoughts', ico: '💡', name: '随想', status: `今日 ${thoughtCount} 条` },
      { key: 'timeline', ico: '🕐', name: '时间轴', status: `今日 ${tlCount} 段` },
      { key: 'drinks', ico: '🥤', name: '饮品', status: `今日 ${drinkCount} 杯` },
      { key: 'habits', ico: '✅', name: '习惯打卡', status: `今日 ${done}/${total}` },
    ];
    const modGrid = mods.map(m => `
      <div class="mod-tile" onclick="navigateTo('${m.key}')">
        <div class="mod-ico">${m.ico}</div>
        <div class="mod-name">${m.name}</div>
        <div class="mod-status">${m.status}</div>
      </div>`).join('');

    // ===== 轻量记录小组件（体重 / 记账 / 计划）=====
    const sortedW = [...weights].sort((a, b) => a.date.localeCompare(b.date));
    const latestW = sortedW[sortedW.length - 1];
    const heightRec = await window.DB.getKv('user_height');
    const height = heightRec != null ? String(heightRec) : '';
    const bmi = (height && latestW) ? (latestW.weight / Math.pow(height / 100, 2)).toFixed(1) : '--';

    const now0 = new Date();
    const thisMonthRecs = finances.filter(r => {
      const d = new Date(r.date);
      return d.getFullYear() === now0.getFullYear() && d.getMonth() === now0.getMonth();
    });
    const monthExpense = thisMonthRecs.filter(r => r.type === 'expense').reduce((s, r) => s + r.amount, 0);
    const todayExpense = finances.filter(r => r.date === today && r.type === 'expense').reduce((s, r) => s + r.amount, 0);
    const yest = fmtDate(Date.now() - 86400000);
    const yestExpense = finances.filter(r => r.date === yest && r.type === 'expense').reduce((s, r) => s + r.amount, 0);

    // 修复：今日计划需按日期过滤，避免把昨天的残留算进来
    const todayPlans = plansAll.filter(p => p.planType === 'today' && !p.archived && p.planDate === today);
    const todayPlanDone = todayPlans.filter(p => p.status === 'completed').length;
    // 体重较昨日
    const todayW = sortedW.find(r => r.date === today);
    const yestW = sortedW.find(r => r.date === yest);
    let wTrend = '';
    if (todayW && yestW) {
      const diff = (todayW.weight - yestW.weight).toFixed(1);
      const dir = diff > 0 ? '↑' : diff < 0 ? '↓' : '→';
      const col = diff > 0 ? 'var(--danger)' : diff < 0 ? 'var(--success)' : 'var(--text-sub)';
      wTrend = `<span class="mini-sub" style="color:${col}">较昨日 ${dir} ${Math.abs(diff)}</span>`;
    }

    const miniSection = `
      <div class="card home-mini">
        <div class="home-card-title">📋 轻量记录</div>
        <div class="mini-row" onclick="navigateTo('weight')">
          <div class="mini-ico">⚖️</div>
          <div class="mini-main">
            <div class="mini-top">${latestW ? `<b>${latestW.weight}</b> kg` : '未记录'}${bmi !== '--' ? ` <span class="mini-sub">BMI ${bmi}</span>` : ''} ${wTrend}</div>
            <div class="mini-bot">${latestW ? '最近 ' + latestW.date : '去记一笔吧'}</div>
          </div>
          <button class="btn btn-sm btn-soft" onclick="event.stopPropagation();Home.quickWeight()">记一笔</button>
        </div>
        <div class="mini-row" onclick="navigateTo('finance')">
          <div class="mini-ico">💰</div>
          <div class="mini-main">
            <div class="mini-top">本月支出 <b>¥${monthExpense.toFixed(0)}</b></div>
            <div class="mini-bot">今日 ¥${todayExpense.toFixed(0)} · 昨日 ¥${yestExpense.toFixed(0)}</div>
          </div>
          <button class="btn btn-sm btn-soft" onclick="event.stopPropagation();Home.quickFinance()">记一笔</button>
        </div>
      </div>`;

    const planRowsHtml = todayPlans.slice(0, 3).map((p) => `
      <div class="home-row ${p.status === 'completed' ? 'done' : ''}" onclick="event.stopPropagation();navigateTo('plans')">
        <div class="home-row-check ${p.status === 'completed' ? 'green' : ''}" onclick="event.stopPropagation();Home.togglePlan(${p.id})">${p.status === 'completed' ? '✓' : ''}</div>
        <span class="home-row-text">${esc(p.title)}</span>
        <button class="mini-plan-del" onclick="event.stopPropagation();Home.delPlan(${p.id})" title="删除">×</button>
      </div>
    `).join('');

    const planSection = `
      <div class="card home-card" onclick="navigateTo('plans')">
        <div class="home-card-header">
          <span class="home-card-title">📝 今日计划 · ${todayPlans.length} 项</span>
        </div>
        <div class="home-th-quick" onclick="event.stopPropagation()">
          <input class="input home-th-input" id="home_plan_input" type="text" placeholder="加一条今日计划，回车即可" />
          <button class="btn btn-primary home-th-save" onclick="Home.addHomePlan()">添加</button>
        </div>
        ${todayPlans.length === 0 ? '' : planRowsHtml + (todayPlans.length > 3 ? `<div class="text-xs text-sub" style="text-align:center;padding:4px 0">还有 ${todayPlans.length - 3} 条，点卡片查看全部</div>` : '')}
      </div>`;

    content.innerHTML = `
      ${statGrid}

      ${miniSection}

      ${planSection}

      <div class="mod-grid">${modGrid}</div>
    `;

    this.bindHomePlanInput();
  },

  // ===== 今日随想内联录入 =====
  bindHomeThoughtInput() {
    const el = document.getElementById('home_th_input');
    if (!el) return;
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        Home.saveThought();
      }
    });
    el.addEventListener('input', () => Home.autoGrowInput(el));
    Home.autoGrowInput(el);
  },

  autoGrowInput(el) {
    el.style.height = 'auto';
    const lh = parseInt(getComputedStyle(el).lineHeight, 10) || 22;
    const min = lh + 16;
    const max = lh * 4 + 16;
    el.style.height = Math.min(Math.max(el.scrollHeight, min), max) + 'px';
  },

  async saveThought() {
    const el = document.getElementById('home_th_input');
    if (!el) return;
    const text = el.value.trim();
    if (!text) { toast('先写点什么吧'); el.focus(); return; }

    const d = new Date();
    const time = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    await window.DB.add('thoughts', {
      date: todayStr(),
      time,
      ts: Date.now(),
      kind: 'idea',
      text
    });

    el.value = '';
    Home.autoGrowInput(el);
    toast('已记下 · ' + time);
    await Home.render();
    setTimeout(() => {
      const n = document.getElementById('home_th_input');
      if (n) n.focus();
    }, 60);
  },

  // 跳转随想模块并自动聚焦录入框
  openThoughts(focusAdd = false) {
    navigateTo('thoughts');
    if (focusAdd && window.Thoughts && window.Thoughts.openAdd) {
      setTimeout(() => window.Thoughts.openAdd(), 80);
    }
  },

  // ===== 首页今日计划内联录入 =====
  bindHomePlanInput() {
    const el = document.getElementById('home_plan_input');
    if (!el) return;
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        Home.addHomePlan();
      }
    });
  },

  async addHomePlan() {
    const el = document.getElementById('home_plan_input');
    if (!el) return;
    const title = el.value.trim();
    if (!title) { el.focus(); return; }
    await window.DB.add('plans', {
      title,
      planType: 'today',
      planDate: todayStr(),
      weekStart: '',
      category: '生活',
      status: 'active',
      priority: 'medium',
      progress: 0,
      subTasks: [],
      createdAt: Date.now()
    });
    el.value = '';
    toast('已添加');
    await Home.render();
    setTimeout(() => {
      const n = document.getElementById('home_plan_input');
      if (n) n.focus();
    }, 60);
  },

  // ===== 轻量记录快速录入 =====
  quickWeight() {
    showModal({
      title: '记录体重',
      body: `
        <div class="form-group">
          <label class="form-label">日期</label>
          <input class="input" id="qw_date" type="date" value="${todayStr()}" />
        </div>
        <div class="form-group">
          <label class="form-label">体重 (kg)</label>
          <input class="input" id="qw_weight" type="number" step="0.1" placeholder="如 65.5" onkeydown="if(event.key==='Enter')Home.saveQuickWeight()" />
        </div>`,
      footer: `<button class="btn btn-ghost" onclick="hideModal()">取消</button><button class="btn btn-primary" onclick="Home.saveQuickWeight()">保存</button>`
    });
    setTimeout(() => { const el = document.getElementById('qw_weight'); if (el) el.focus(); }, 60);
  },
  async saveQuickWeight() {
    const weight = parseFloat(document.getElementById('qw_weight').value);
    const date = document.getElementById('qw_date').value || todayStr();
    if (!weight || weight <= 0) return toast('请输入有效体重');
    const records = await window.DB.getAll('weight_records');
    const existing = records.find(r => r.date === date);
    if (existing) {
      await window.DB.put('weight_records', { ...existing, weight, updatedAt: Date.now() });
      toast('已更新当日体重');
    } else {
      await window.DB.add('weight_records', { date, weight });
      toast('已记录');
    }
    hideModal();
    await Home.render();
  },

  quickFinance() {
    Home._qfType = 'expense';
    const cats = ['餐饮', '交通', '购物', '娱乐', '居家', '医疗', '教育', '通讯', '其他'];
    showModal({
      title: '记一笔',
      body: `
        <div class="form-group">
          <label class="form-label">类型</label>
          <div style="display:flex;gap:8px">
            <button class="btn btn-sm qf-type active" id="qf_exp" onclick="Home._qfType='expense';this.classList.add('active');document.getElementById('qf_inc').classList.remove('active')">支出</button>
            <button class="btn btn-sm qf-type" id="qf_inc" onclick="Home._qfType='income';this.classList.add('active');document.getElementById('qf_exp').classList.remove('active')">收入</button>
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">金额</label>
          <input class="input" id="qf_amount" type="number" step="0.01" placeholder="0.00" onkeydown="if(event.key==='Enter')Home.saveQuickFinance()" />
        </div>
        <div class="form-group">
          <label class="form-label">分类</label>
          <select class="select" id="qf_cat">${cats.map(c => `<option value="${c}">${c}</option>`).join('')}</select>
        </div>
        <div class="form-group">
          <label class="form-label">备注（可选）</label>
          <input class="input" id="qf_note" placeholder="如：午饭" />
        </div>`,
      footer: `<button class="btn btn-ghost" onclick="hideModal()">取消</button><button class="btn btn-primary" onclick="Home.saveQuickFinance()">保存</button>`
    });
    setTimeout(() => { const el = document.getElementById('qf_amount'); if (el) el.focus(); }, 60);
  },
  async saveQuickFinance() {
    const amount = parseFloat(document.getElementById('qf_amount').value);
    if (!amount || amount <= 0) return toast('请输入有效金额');
    const type = Home._qfType || 'expense';
    const category = document.getElementById('qf_cat').value;
    const note = document.getElementById('qf_note').value.trim();
    await window.DB.add('finance_records', { date: todayStr(), type, amount, category, note });
    hideModal();
    toast('已记账');
    await Home.render();
  },

  quickPlan() {
    showModal({
      title: '加今日计划',
      body: `<div class="form-group"><label class="form-label">计划内容</label><input class="input" id="qp_text" placeholder="如：下午写周报" onkeydown="if(event.key==='Enter')Home.saveQuickPlan()" /></div>`,
      footer: `<button class="btn btn-ghost" onclick="hideModal()">取消</button><button class="btn btn-primary" onclick="Home.saveQuickPlan()">添加</button>`
    });
    setTimeout(() => { const el = document.getElementById('qp_text'); if (el) el.focus(); }, 60);
  },
  async saveQuickPlan() {
    const title = document.getElementById('qp_text').value.trim();
    if (!title) return toast('写点什么吧');
    await window.DB.add('plans', {
      title,
      planType: 'today',
      planDate: todayStr(),
      weekStart: '',
      category: '生活',
      status: 'active',
      priority: 'medium',
      progress: 0,
      subTasks: [],
      createdAt: Date.now()
    });
    hideModal();
    toast('已添加');
    await Home.render();
  },

  // 首页计划内联：勾选切换完成
  async togglePlan(id) {
    const p = await window.DB.get('plans', id);
    if (!p) return;
    await window.DB.put('plans', { ...p, status: p.status === 'completed' ? 'active' : 'completed' });
    await Home.render();
  },

  // 首页计划内联：删除
  async delPlan(id) {
    const ok = await confirmDialog('删除这条计划？');
    if (!ok) return;
    await window.DB.delete('plans', id);
    toast('已删除');
    await Home.render();
  }
};

window.Home = Home;
