// modules/plans.js - 每日计划：今日任务 / 明日计划 / 本周计划 / 长期目标 / 历史
// 时间概念：今日任务绑定当天日期，过期自动归档；本周计划按自然周(周一-周日)过滤，跨周归档。

// 本周一日期（YYYY-MM-DD）
function weekStartStr() {
  const d = new Date(); d.setHours(0, 0, 0, 0);
  const day = (d.getDay() + 6) % 7; // 周一=0
  d.setDate(d.getDate() - day);
  return fmtDate(d.getTime());
}

// 统一的计划时间联动：把「明日计划」在到达其日期当天自动转为「今日任务」，过期的「今日任务」归档。
// 必须用 await 在每次首页/计划页渲染前调用；否则只停留在首页时迁移不会触发（之前搬进首页框后失效的根因）。
async function migratePlans(today, curWeek) {
  today = today || todayStr();
  curWeek = curWeek || weekStartStr();
  const plans = await window.DB.getAll('plans');
  // 1) 到点的「明日计划」→ 转为「今日任务」：planDate <= today 即当天/过期就转（修复原先慢一天）
  for (const p of plans.filter(p => p.planType === 'tomorrow' && p.status !== 'completed' && p.planDate && p.planDate <= today)) {
    await window.DB.put('plans', { ...p, planType: 'today', planDate: today, updatedAt: Date.now() });
  }
  // 2) 过期的「今日任务」自动归档为历史
  for (const p of plans.filter(p => p.planType === 'today' && p.planDate && p.planDate < today && !p.archived)) {
    await window.DB.put('plans', { ...p, archived: true, updatedAt: Date.now() });
  }
  // 3) 跨周的「本周计划」自动归档为历史；无 weekStart 的遗留周任务归到本周
  for (const p of plans.filter(p => p.planType === 'week')) {
    if (p.weekStart && p.weekStart < curWeek && !p.archived) {
      await window.DB.put('plans', { ...p, archived: true, updatedAt: Date.now() });
    } else if (!p.weekStart) {
      await window.DB.put('plans', { ...p, weekStart: curWeek, updatedAt: Date.now() });
    }
  }
}
window.migratePlans = migratePlans;

const Plans = {
  currentTab: 'today', // today | tomorrow | week | long | history
  quickCategory: '工作',

  async render() {
    const content = document.getElementById('content');
    const today = todayStr();
    const curWeek = weekStartStr();
    await migratePlans(today, curWeek);
    let plans = await window.DB.getAll('plans');

    // 按 tab 过滤
    let filtered = plans;
    if (this.currentTab === 'today') {
      filtered = plans.filter(p => p.planType === 'today' && !p.archived);
    } else if (this.currentTab === 'tomorrow') {
      filtered = plans.filter(p => p.planType === 'tomorrow');
    } else if (this.currentTab === 'week') {
      filtered = plans.filter(p => p.planType === 'week' && !p.archived && (!p.weekStart || p.weekStart === curWeek));
    } else if (this.currentTab === 'long') {
      filtered = plans.filter(p => p.planType === 'long' || !p.planType);
    } else {
      filtered = plans.filter(p => p.archived);
    }

    const total = filtered.length;
    const done = filtered.filter(p => p.status === 'completed').length;
    const progress = total ? Math.round(done / total * 100) : 0;

    // 周范围标签
    const we = fmtDate(new Date(new Date(curWeek).getTime() + 6 * 86400000));
    const weekLabel = `${curWeek.slice(5).replace('-', '/')} – ${we.slice(5).replace('-', '/')}`;

    // 历史分组
    let historyHtml = '';
    if (this.currentTab === 'history') {
      const groups = {};
      filtered.forEach(p => {
        const key = p.weekStart && p.planType === 'week' ? `本周 ${p.weekStart.slice(5)}` : (p.planDate || '未注明日期');
        (groups[key] = groups[key] || []).push(p);
      });
      const keys = Object.keys(groups).sort().reverse();
      historyHtml = keys.length ? keys.map(k => `
        <div class="text-small text-sub" style="margin:10px 4px 4px;font-weight:600">📅 ${k}</div>
        ${groups[k].map(p => Plans.renderTaskItem(p, true)).join('')}
      `).join('') : `<div class="empty" style="padding:30px 0"><div class="empty-icon">📦</div><div class="empty-text">还没有历史任务</div></div>`;
    }

    content.innerHTML = `
      <div class="page-header" onclick="navigateTo('home')"><span class="back-arrow">←</span> 返回首页</div>

      <div class="card" style="padding:20px">
        <div class="row-between mb-8">
          <div>
            <div style="font-size:18px;font-weight:600">📋 每日计划</div>
            <div class="text-small text-sub mt-4">${this.currentTab === 'week' ? '本周 ' + weekLabel : '管理今日 / 明日 / 本周任务与长期目标'}</div>
          </div>
        </div>

        <div class="filter-bar" style="margin:16px 0 8px;flex-wrap:wrap">
          <button class="filter-chip ${this.currentTab === 'today' ? 'active' : ''}" onclick="Plans.setTab('today')">今日任务</button>
          <button class="filter-chip ${this.currentTab === 'tomorrow' ? 'active' : ''}" onclick="Plans.setTab('tomorrow')">明日计划</button>
          <button class="filter-chip ${this.currentTab === 'week' ? 'active' : ''}" onclick="Plans.setTab('week')">本周计划</button>
          <button class="filter-chip ${this.currentTab === 'long' ? 'active' : ''}" onclick="Plans.setTab('long')">长期目标</button>
          <button class="filter-chip ${this.currentTab === 'history' ? 'active' : ''}" onclick="Plans.setTab('history')">历史</button>
        </div>

        <div class="row" style="gap:6px;flex-wrap:wrap;margin-bottom:6px">
          ${['早起打卡', '健身30分', '阅读30分', '写随想', '练舞1支'].map(t => `<span class="tag" style="cursor:pointer" onclick="Plans.quickAddTpl('${t}')">+ ${t}</span>`).join('')}
        </div>
      </div>

      <div class="card" style="padding:16px">
        <div class="row" style="gap:8px">
          <input class="input" id="quickPlanInput" placeholder="添加任务..." style="flex:1" onkeydown="if(event.key==='Enter')Plans.quickAdd()" />
          <button class="btn btn-primary" onclick="Plans.quickAdd()">+ 添加</button>
        </div>
      </div>

      <div class="card" style="padding:16px">
        <div class="row-between mb-12">
          <div class="fw-600">${this.tabTitle()} 清单</div>
          <div class="text-small text-sub">${done}/${total} 已完成</div>
        </div>
        ${this.currentTab === 'history'
          ? historyHtml
          : (filtered.length === 0
            ? `<div class="empty" style="padding:30px 0"><div class="empty-icon">📝</div><div class="empty-text">还没有任务，上方快速添加</div></div>`
            : filtered.map(p => Plans.renderTaskItem(p)).join('')
          )
        }
        ${this.currentTab !== 'history' && total > 0 && done === total ? `
          <div style="background:var(--primary-light);border-radius:12px;padding:12px;text-align:center;margin-top:12px">
            <span style="font-size:13px">🎉 完成全部任务！奖励自己一下吧</span>
          </div>
        ` : ''}
      </div>
    `;
  },

  tabTitle() {
    return { today: '今日任务', tomorrow: '明日计划', week: '本周计划', long: '长期目标', history: '历史归档' }[this.currentTab];
  },

  setTab(t) {
    this.currentTab = t;
    Plans.render();
  },

  setCat(c) {
    this.quickCategory = c;
    Plans.render();
    setTimeout(() => document.getElementById('quickPlanInput')?.focus(), 50);
  },

  quickAddTpl(title) {
    this.quickAddWith(title);
  },

  quickAdd() {
    const input = document.getElementById('quickPlanInput');
    const title = input?.value?.trim();
    if (!title) return toast('请输入任务内容');
    this.quickAddWith(title);
  },

  async quickAddWith(title) {
    const planType = this.currentTab === 'history' ? 'today' : this.currentTab;
    const data = {
      title,
      planType,
      planDate: planType === 'tomorrow' ? fmtDate(new Date(Date.now() + 86400000)) : (planType === 'today' ? todayStr() : ''),
      weekStart: planType === 'week' ? weekStartStr() : '',
      category: this.quickCategory,
      status: 'active',
      priority: 'medium',
      progress: 0,
      subTasks: [],
      createdAt: Date.now()
    };
    await window.DB.add('plans', data);
    toast('已添加');
    Plans.render();
  },

  renderTaskItem(p, showDate) {
    const isDone = p.status === 'completed';
    const priorityLabel = { high: '高', medium: '中', low: '低' }[p.priority] || '中';
    const priorityClass = { high: 'prio-high', medium: 'prio-medium', low: 'prio-low' }[p.priority] || 'prio-medium';
    const dateTag = showDate ? (p.weekStart && p.planType === 'week' ? `本周 ${p.weekStart.slice(5)}` : (p.planDate || '')) : '';
    const tags = [p.category, p.planType === 'today' ? '常规' : ''].filter(Boolean);

    return `
      <div class="list-item" style="padding:10px 12px;gap:10px;opacity:${isDone ? .6 : 1}" onclick="Plans.openEdit(${p.id})">
        <div class="checkbox ${isDone ? 'checked' : ''}" style="width:22px;height:22px;flex-shrink:0" onclick="event.stopPropagation();Plans.toggleDone(${p.id})">
          ${isDone ? '✓' : ''}
        </div>
        <div class="list-item-content">
          <div class="list-item-title ${isDone ? 'done' : ''}" style="font-size:14px;display:flex;align-items:center;gap:8px">
            ${esc(p.title)}
            <span class="prio-tag ${priorityClass}">${priorityLabel}</span>
            ${dateTag ? `<span class="tag tag-gray">${dateTag}</span>` : ''}
          </div>
          <div style="display:flex;gap:4px;flex-wrap:wrap;margin-top:4px">
            ${tags.map(t => `<span class="tag ${t === '工作' ? 'tag-mint' : t === '学习' ? 'tag-blue' : t === '生活' ? 'tag-yellow' : 'tag-gray'}">${esc(t)}</span>`).join('')}
          </div>
        </div>
      </div>
    `;
  },

  async toggleDone(id) {
    const p = await window.DB.get('plans', id);
    await window.DB.put('plans', { ...p, status: p.status === 'completed' ? 'active' : 'completed' });
    Plans.render();
  },

  openAdd() {
    Plans.openEdit(null);
  },

  openEdit(id) {
    (async () => {
      let p = {
        title: '', planType: Plans.currentTab === 'history' ? 'today' : Plans.currentTab, category: Plans.quickCategory,
        priority: 'medium', status: 'active', progress: 0, deadline: '', subTasks: [], goal: ''
      };
      if (id) {
        p = await window.DB.get('plans', id) || p;
        if (!p.subTasks) p.subTasks = [];
      }

      showModal({
        title: id ? '编辑任务' : '新建任务',
        body: `
          <div class="form-group">
            <label class="form-label">任务内容 *</label>
            <input class="input" id="p_title" value="${esc(p.title)}" placeholder="例如：读10页书" />
          </div>
          <div class="row" style="gap:8px">
            <div class="form-group" style="flex:1">
              <label class="form-label">分类</label>
              <select class="select" id="p_category">
                ${['工作', '学习', '生活', '健康', '其他'].map(c => `<option ${p.category === c ? 'selected' : ''}>${c}</option>`).join('')}
              </select>
            </div>
            <div class="form-group" style="flex:1">
              <label class="form-label">计划类型</label>
              <select class="select" id="p_planType">
                <option value="today" ${p.planType === 'today' ? 'selected' : ''}>今日任务</option>
                <option value="tomorrow" ${p.planType === 'tomorrow' ? 'selected' : ''}>明日计划</option>
                <option value="week" ${p.planType === 'week' ? 'selected' : ''}>本周计划</option>
                <option value="long" ${p.planType === 'long' ? 'selected' : ''}>长期目标</option>
              </select>
            </div>
          </div>
          <div class="row" style="gap:8px">
            <div class="form-group" style="flex:1">
              <label class="form-label">优先级</label>
              <select class="select" id="p_priority">
                <option value="high" ${p.priority === 'high' ? 'selected' : ''}>高</option>
                <option value="medium" ${p.priority === 'medium' ? 'selected' : ''}>中</option>
                <option value="low" ${p.priority === 'low' ? 'selected' : ''}>低</option>
              </select>
            </div>
            <div class="form-group" style="flex:1">
              <label class="form-label">任务日期</label>
              <input class="input" id="p_deadline" type="date" value="${esc(p.deadline || p.planDate || '')}" />
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">备注 / 目标</label>
            <textarea class="textarea" id="p_goal" rows="2" placeholder="补充说明...">${esc(p.goal)}</textarea>
          </div>
        `,
        footer: `
          ${id ? '<button class="btn btn-danger" id="p_del">删除</button>' : ''}
          <button class="btn btn-ghost" onclick="hideModal()">取消</button>
          <button class="btn btn-primary" id="p_save">保存</button>
        `
      });

      setTimeout(() => {
        document.getElementById('p_save').onclick = async () => {
          const planTypeVal = document.getElementById('p_planType').value;
          const deadlineVal = document.getElementById('p_deadline').value;
          // 修复：编辑时尊重用户在"任务日期"输入框里改的值；只有用户没填才按 planType 默认填
          // 之前 bug：保存时 planDate 不读输入框、强制按 planType 重算，导致用户改的日期被悄悄覆盖回今天/明天
          let planDateVal;
          if (deadlineVal) {
            planDateVal = deadlineVal;
          } else if (planTypeVal === 'tomorrow') {
            planDateVal = fmtDate(new Date(Date.now() + 86400000));
          } else if (planTypeVal === 'today') {
            planDateVal = todayStr();
          } else {
            planDateVal = '';
          }
          const data = {
            title: document.getElementById('p_title').value.trim(),
            category: document.getElementById('p_category').value,
            planType: planTypeVal,
            planDate: planDateVal,
            weekStart: planTypeVal === 'week' ? weekStartStr() : '',
            priority: document.getElementById('p_priority').value,
            deadline: deadlineVal,
            goal: document.getElementById('p_goal').value.trim(),
            status: p.status || 'active',
            progress: p.progress || 0,
            subTasks: p.subTasks || []
          };
          if (!data.title) return toast('请输入任务内容');
          if (id) {
            const orig = await window.DB.get('plans', id);
            await window.DB.put('plans', { ...orig, ...data });
          } else {
            await window.DB.add('plans', data);
          }
          hideModal();
          toast('已保存');
          Plans.render();
        };
        if (id) {
          document.getElementById('p_del').onclick = async () => {
            const ok = await confirmDialog('确定删除？');
            if (!ok) return;
            await window.DB.delete('plans', id);
            hideModal();
            toast('已删除');
            Plans.render();
          };
        }
      }, 50);
    })();
  }
};

window.Plans = Plans;
