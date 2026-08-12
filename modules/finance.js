// modules/finance.js - 记账模块

const Finance = {
  chartPie: null,
  chartLine: null,

  async render() {
    const content = document.getElementById('content');
    const records = await window.DB.getAll('finance_records');
    const expenseCats = ['餐饮','交通','购物','娱乐','居家','医疗','教育','通讯','其他'];
    const incomeCats = ['工资','奖金','理财','兼职','红包','其他'];
    const now = new Date();
    const thisMonth = records.filter(r => {
      const d = new Date(r.date);
      return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
    });
    const monthIncome = thisMonth.filter(r => r.type === 'income').reduce((s, r) => s + r.amount, 0);
    const monthExpense = thisMonth.filter(r => r.type === 'expense').reduce((s, r) => s + r.amount, 0);
    const balance = monthIncome - monthExpense;

    // 按分类统计支出
    const expenseByCat = {};
    thisMonth.filter(r => r.type === 'expense').forEach(r => {
      expenseByCat[r.category] = (expenseByCat[r.category] || 0) + r.amount;
    });

    // 近 7 天每日支出
    const last7 = [];
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const ds = fmtDate(d);
      const total = records.filter(r => r.date === ds && r.type === 'expense').reduce((s, r) => s + r.amount, 0);
      last7.push({ date: ds.slice(5), total });
    }

    records.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);
    Finance._allRecords = records;
    if (!Finance._monthFilter) Finance._monthFilter = 'all';

    content.innerHTML = `
      <div class="page-header" onclick="navigateTo('home')"><span class="back-arrow">←</span> 返回首页</div>

      <div class="stat-grid">
        <div class="stat-card">
          <div class="stat-icon">💰</div>
          <div class="stat-value text-success">+${monthIncome.toFixed(0)}</div>
          <div class="stat-label">本月收入</div>
        </div>
        <div class="stat-card">
          <div class="stat-icon">💸</div>
          <div class="stat-value text-danger">-${monthExpense.toFixed(0)}</div>
          <div class="stat-label">本月支出</div>
        </div>
      </div>

      <div class="card" style="background:linear-gradient(135deg, var(--primary), var(--primary-deep));color:white">
        <div class="text-small" style="opacity:0.9">本月结余</div>
        <div style="font-size:32px;font-weight:600;margin-top:4px">¥ ${balance.toFixed(2)}</div>
      </div>

      <!-- 快速记账 -->
      <div class="card fin-quick">
        <div class="fin-quick-type">
          <button class="fin-type-btn active" data-type="expense" onclick="Finance.switchType('expense')">支出</button>
          <button class="fin-type-btn" data-type="income" onclick="Finance.switchType('income')">收入</button>
        </div>
        <div class="fin-quick-row">
          <span class="fin-quick-currency">¥</span>
          <input class="input fin-quick-amount" id="fin_amount" type="number" step="0.01" placeholder="0.00" />
          <select class="select fin-quick-cat" id="fin_category">
            ${expenseCats.map(c => `<option value="${c}">${c}</option>`).join('')}
          </select>
        </div>
        <div class="fin-quick-row" style="gap:8px">
          <input class="input fin-quick-note" id="fin_note" placeholder="备注（可选）" />
          <button class="btn btn-primary fin-quick-save" onclick="Finance.quickSave()">记一笔</button>
        </div>
      </div>

      <div class="card">
        <div class="card-title">📊 支出分类</div>
        <div class="chart-wrap"><canvas id="finPie"></canvas></div>
      </div>

      <div class="card">
        <div class="card-title">📈 近 7 天支出</div>
        <div class="chart-wrap"><canvas id="finLine"></canvas></div>
      </div>

      <div class="card">
        <div class="card-title" style="display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap">
          <span>📋 历史记录</span>
          <span style="display:flex;align-items:center;gap:8px">
            <select class="select" id="fin_month" onchange="Finance.filterMonth()" style="padding:4px 8px;font-size:13px">
              <option value="all" ${Finance._monthFilter === 'all' ? 'selected' : ''}>全部</option>
              ${Finance._months().map(m => `<option value="${m}" ${Finance._monthFilter === m ? 'selected' : ''}>${m}</option>`).join('')}
            </select>
            <button class="btn btn-primary btn-sm" onclick="Finance.openAdd()">+ 记一笔</button>
          </span>
        </div>
        <div id="fin_list_stat" class="text-small text-sub" style="margin:2px 0 8px"></div>
        <div id="fin_records_list"></div>
      </div>
    `;

    // 渲染图表
    Finance.renderCharts(expenseByCat, last7);
    Finance.renderRecordsList();
  },

  // 所有出现过的月份（倒序）
  _months() {
    const set = new Set();
    (Finance._allRecords || []).forEach(r => { if (r.date) set.add(r.date.slice(0, 7)); });
    return Array.from(set).sort().reverse();
  },

  // 月份筛选切换
  filterMonth() {
    const sel = document.getElementById('fin_month');
    Finance._monthFilter = sel ? sel.value : 'all';
    Finance.renderRecordsList();
  },

  // 渲染筛选后的历史记录列表
  renderRecordsList() {
    const box = document.getElementById('fin_records_list');
    if (!box) return;
    const all = Finance._allRecords || [];
    const list = Finance._monthFilter === 'all'
      ? all
      : all.filter(r => r.date && r.date.slice(0, 7) === Finance._monthFilter);
    const inc = list.filter(r => r.type === 'income').reduce((s, r) => s + r.amount, 0);
    const exp = list.filter(r => r.type === 'expense').reduce((s, r) => s + r.amount, 0);
    const stat = document.getElementById('fin_list_stat');
    if (stat) stat.textContent = `共 ${list.length} 笔 · 收入 ¥${inc.toFixed(0)} · 支出 ¥${exp.toFixed(0)}`;
    box.innerHTML = list.length === 0
      ? `<div class="empty"><div class="empty-icon">💰</div><div class="empty-text">该范围暂无记录</div></div>`
      : list.map(r => Finance.renderItem(r)).join('');
  },

  renderItem(r) {
    const color = r.type === 'income' ? 'text-success' : 'text-danger';
    const sign = r.type === 'income' ? '+' : '-';
    return `
      <div class="list-item" onclick="Finance.openEdit(${r.id})" style="cursor:pointer">
        <div style="font-size:24px">${r.type === 'income' ? '💰' : '🛒'}</div>
        <div class="list-item-content">
          <div class="list-item-title">${esc(r.category)}</div>
          <div class="list-item-sub">${r.date}${r.note ? ' · ' + esc(r.note) : ''}</div>
        </div>
        <div class="fw-600 ${color}" style="text-align:right">
          ${sign}¥${r.amount.toFixed(2)}
          <div class="text-xs text-sub" style="font-weight:400;margin-top:2px">✎ 点击编辑</div>
        </div>
      </div>
    `;
  },

  renderCharts(expenseByCat, last7) {
    // 销毁旧图表
    if (this.chartPie) this.chartPie.destroy();
    if (this.chartLine) this.chartLine.destroy();

    const pieCtx = document.getElementById('finPie');
    const lineCtx = document.getElementById('finLine');
    if (!pieCtx || !lineCtx) return;

    const catLabels = Object.keys(expenseByCat);
    const catValues = catLabels.map(k => expenseByCat[k]);
    const palette = ['#F4A6B5','#9ED5C5','#FFD68A','#8FB8E0','#C8A8E9','#F5A8A0','#A8D8B9'];

    if (catLabels.length === 0) {
      pieCtx.parentElement.innerHTML = '<div class="text-small text-sub text-center" style="padding:40px 0">本月暂无支出</div>';
    } else {
      this.chartPie = new Chart(pieCtx, {
        type: 'doughnut',
        data: {
          labels: catLabels,
          datasets: [{
            data: catValues,
            backgroundColor: palette.slice(0, catLabels.length),
            borderWidth: 0
          }]
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          plugins: {
            legend: { position: 'right', labels: { font: { size: 11 }, boxWidth: 12 } }
          }
        }
      });
    }

    this.chartLine = new Chart(lineCtx, {
      type: 'line',
      data: {
        labels: last7.map(d => d.date),
        datasets: [{
          label: '支出',
          data: last7.map(d => d.total),
          borderColor: '#F4A6B5',
          backgroundColor: 'rgba(244,166,181,0.2)',
          fill: true,
          tension: 0.35,
          pointBackgroundColor: '#F4A6B5',
          pointRadius: 4
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { beginAtZero: true, ticks: { font: { size: 10 } } },
          x: { ticks: { font: { size: 10 } } }
        }
      }
    });
  },

  // 快速记账的支出/收入切换
  switchType(type) {
    document.querySelectorAll('.fin-type-btn').forEach(b => b.classList.toggle('active', b.dataset.type === type));
    const cats = type === 'income' ? ['工资','奖金','理财','兼职','红包','其他'] : ['餐饮','交通','购物','娱乐','居家','医疗','教育','通讯','其他'];
    document.getElementById('fin_category').innerHTML = cats.map(c => `<option value="${c}">${c}</option>`).join('');
    document.getElementById('fin_amount').focus();
  },

  // 快速保存
  async quickSave() {
    const raw = document.getElementById('fin_amount').value.trim();
    const amount = parseFloat(raw);
    if (!isFinite(amount) || amount <= 0) return toast('请输入有效金额');
    const activeBtn = document.querySelector('.fin-type-btn.active');
    const type = activeBtn ? activeBtn.dataset.type : 'expense';
    await window.DB.add('finance_records', {
      type,
      amount,
      category: document.getElementById('fin_category').value,
      date: todayStr(),
      note: document.getElementById('fin_note').value.trim(),
      createdAt: Date.now()
    });
    document.getElementById('fin_amount').value = '';
    document.getElementById('fin_note').value = '';
    toast('已记账 ✓');
    Finance.render();
  },

  openAdd() {
    Finance.openEdit(null);
  },

  openEdit(id) {
    (async () => {
      const expenseCats = ['餐饮','交通','购物','娱乐','居家','医疗','教育','通讯','其他'];
      const incomeCats = ['工资','奖金','理财','兼职','红包','其他'];
      let r = { type: 'expense', amount: 0, category: '餐饮', date: todayStr(), note: '' };
      if (id) r = await window.DB.get('finance_records', id) || r;

      showModal({
        title: id ? '编辑记录' : '新增记账',
        body: `
          <div class="form-group">
            <div class="row" style="gap:8px">
              <button class="btn ${r.type === 'expense' ? 'btn-primary' : 'btn-secondary'}" id="r_exp" style="flex:1">支出</button>
              <button class="btn ${r.type === 'income' ? 'btn-primary' : 'btn-secondary'}" id="r_inc" style="flex:1">收入</button>
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">金额</label>
            <input class="input" id="r_amount" type="number" step="0.01" value="${r.amount || ''}" placeholder="0.00" />
          </div>
          <div class="form-group">
            <label class="form-label">分类</label>
            <select class="select" id="r_category">
              ${(r.type === 'income' ? incomeCats : expenseCats).map(c => `<option ${r.category === c ? 'selected' : ''}>${c}</option>`).join('')}
            </select>
          </div>
          <div class="form-group">
            <label class="form-label">日期</label>
            <input class="input" id="r_date" type="date" value="${esc(r.date)}" />
          </div>
          <div class="form-group">
            <label class="form-label">备注</label>
            <input class="input" id="r_note" value="${esc(r.note)}" placeholder="可选" />
          </div>
        `,
        footer: `
          ${id ? '<button class="btn btn-danger" id="r_del">删除</button>' : ''}
          <button class="btn btn-ghost" onclick="hideModal()">取消</button>
          <button class="btn btn-primary" id="r_save">保存</button>
        `
      });
      setTimeout(() => {
        const updateCats = (type) => {
          const sel = document.getElementById('r_category');
          const cats = type === 'income' ? incomeCats : expenseCats;
          sel.innerHTML = cats.map(c => `<option ${r.category === c ? 'selected' : ''}>${c}</option>`).join('');
        };
        document.getElementById('r_exp').onclick = () => {
          r.type = 'expense';
          document.getElementById('r_exp').className = 'btn btn-primary';
          document.getElementById('r_inc').className = 'btn btn-secondary';
          updateCats('expense');
        };
        document.getElementById('r_inc').onclick = () => {
          r.type = 'income';
          document.getElementById('r_inc').className = 'btn btn-primary';
          document.getElementById('r_exp').className = 'btn btn-secondary';
          updateCats('income');
        };
        document.getElementById('r_save').onclick = async () => {
          const raw = document.getElementById('r_amount').value.trim();
          const amt = parseFloat(raw);
          if (!isFinite(amt) || amt <= 0) return toast('请输入有效金额');
          const data = {
            type: r.type,
            amount: amt,
            category: document.getElementById('r_category').value,
            date: document.getElementById('r_date').value,
            note: document.getElementById('r_note').value.trim()
          };
          if (id) {
            const orig = await window.DB.get('finance_records', id);
            await window.DB.put('finance_records', { ...orig, ...data });
          } else {
            await window.DB.add('finance_records', data);
          }
          hideModal();
          toast('已保存');
          Finance.render();
        };
        if (id) {
          document.getElementById('r_del').onclick = async () => {
            const ok = await confirmDialog('确定删除？');
            if (!ok) return;
            await window.DB.delete('finance_records', id);
            hideModal();
            toast('已删除');
            Finance.render();
          };
        }
      }, 50);
    })();
  }
};

window.Finance = Finance;
