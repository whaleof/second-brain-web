// modules/market.js - 沪深300追踪 + 基金持仓管理

const Market = {
  chartLine: null,
  chartFund: null,
  editingDate: null,
  quoteData: null,
  klineData: null,
  fundData: null,

  // 我的持仓基金列表
  myFunds: [
    { code: '007044', name: '博道沪深300增强A', shares: '', cost: '' }
  ],

  async render() {
    const content = document.getElementById('content');

    content.innerHTML = `
      <div class="card market-hero" id="marketHero">
        <div class="market-loading">加载沪深300数据中...</div>
      </div>
      <div class="card" id="marketFundCard">
        <div class="market-loading">加载基金数据中...</div>
      </div>
      <div class="card">
        <div class="card-title">📈 近 7 天走势</div>
        <div class="chart-wrap" id="marketChartWrap"><div class="market-loading">加载中...</div></div>
      </div>
      <div class="card" id="marketFormCard">
        <div class="card-title">📝 今日记录</div>
        <div class="market-loading">加载中...</div>
      </div>
      <div class="card">
        <div class="card-title">📋 历史记录</div>
        <div id="marketHistory"><div class="market-loading">加载中...</div></div>
      </div>
    `;

    await Promise.all([
      Market.loadQuote(),
      Market.loadKline(),
      Market.loadFund()
    ]);

    try { Market.renderHero(); } catch(e) { console.error('hero', e); }
    try { await Market.renderFundCard(); } catch(e) { console.error('fund', e); }
    try { Market.renderChart(); } catch(e) { console.error('chart', e); }
    try { await Market.renderForm(); } catch(e) { console.error('form', e); }
    try { await Market.renderHistory(); } catch(e) { console.error('history', e); }
  },

  // 拉取基金数据
  async loadFund() {
    try {
      const resp = await fetch(apiUrl('/api/fund?code=007044'));
      Market.fundData = await resp.json();
    } catch (e) {
      console.error('基金数据加载失败:', e);
    }
  },

  // 渲染基金持仓卡片
  async renderFundCard() {
    const el = document.getElementById('marketFundCard');
    if (!el) return;
    const f = Market.fundData;
    if (!f || !f.nav) {
      el.innerHTML = `<div class="market-loading">基金数据加载失败</div>`;
      return;
    }

    const dayChange = parseFloat(f.dayChange);
    const isUp = dayChange >= 0;
    const colorClass = isUp ? 'market-up' : 'market-down';
    const arrow = isUp ? '▲' : '▼';

    // 读取用户输入的持仓信息
    const saved = await Market.getSavedHolding();
    const shares = saved.shares ? parseFloat(saved.shares) : 0;
    const cost = saved.cost ? parseFloat(saved.cost) : 0;
    const nav = parseFloat(f.nav);
    const marketValue = shares > 0 ? (shares * nav).toFixed(2) : '—';
    const totalCost = shares > 0 && cost > 0 ? (shares * cost).toFixed(2) : '—';
    const profit = shares > 0 && cost > 0 ? ((nav - cost) * shares).toFixed(2) : '—';
    const profitPct = shares > 0 && cost > 0 ? (((nav - cost) / cost) * 100).toFixed(2) : '—';
    const isProfit = parseFloat(profit) >= 0;
    const profitClass = isProfit ? 'market-up' : 'market-down';

    el.innerHTML = `
      <div class="card-title">💼 我的持仓</div>
      <div class="fund-holding-header">
        <div>
          <div class="fund-name">${esc(f.name)}</div>
          <div class="fund-code-row">
            <span class="fund-code">${f.code}</span>
            <span class="fund-star">${'★'.repeat(parseInt(f.star) || 0)}</span>
            <span class="fund-manager">${esc(f.manager || '')}</span>
          </div>
        </div>
        <div class="fund-nav-block ${colorClass}">
          <div class="fund-nav">${f.nav}</div>
          <div class="fund-change">${arrow} ${Math.abs(dayChange).toFixed(2)}%</div>
        </div>
      </div>
      <div class="fund-detail-row">
        <div class="market-detail-item"><span>净值日期</span><b>${f.navDate || '—'}</b></div>
        <div class="market-detail-item"><span>基金规模</span><b>${esc(f.scale || '—')}</b></div>
        <div class="market-detail-item"><span>成立日期</span><b>${f.startDate || '—'}</b></div>
      </div>
      <div class="fund-holding-inputs">
        <div class="fund-input-group">
          <label>持有份额</label>
          <input class="input" id="f_shares" type="number" step="0.01" placeholder="如：1000" value="${esc(saved.shares)}" onchange="Market.saveHolding()" />
        </div>
        <div class="fund-input-group">
          <label>买入成本价</label>
          <input class="input" id="f_cost" type="number" step="0.0001" placeholder="如：1.6500" value="${esc(saved.cost)}" onchange="Market.saveHolding()" />
        </div>
      </div>
      ${shares > 0 ? `
      <div class="fund-profit-row">
        <div class="market-detail-item"><span>持仓市值</span><b>¥${marketValue}</b></div>
        <div class="market-detail-item"><span>投入成本</span><b>¥${totalCost}</b></div>
        <div class="market-detail-item ${profitClass}"><span>浮动盈亏</span><b>${isProfit ? '+' : ''}¥${profit}</b></div>
        <div class="market-detail-item ${profitClass}"><span>收益率</span><b>${isProfit ? '+' : ''}${profitPct}%</b></div>
      </div>
      ` : '<div class="fund-hint">💡 输入持有份额和买入成本，自动计算盈亏</div>'}
    `;
  },

  // 持仓数据持久化（跨端同步）
  async getSavedHolding() {
    const v = await window.DB.getKv('market_holding_007044');
    if (v && (v.shares || v.cost)) return v;
    // 兼容旧 localStorage
    try {
      const old = JSON.parse(localStorage.getItem('sb_fund_007044') || '{}');
      if (old.shares || old.cost) {
        await window.DB.setKv('market_holding_007044', old);
        localStorage.removeItem('sb_fund_007044');
        return old;
      }
    } catch {}
    return {};
  },

  async saveHolding() {
    const shares = document.getElementById('f_shares')?.value || '';
    const cost = document.getElementById('f_cost')?.value || '';
    await window.DB.setKv('market_holding_007044', { shares, cost });
    localStorage.removeItem('sb_fund_007044');
    // 不重新渲染，直接更新计算行
    const f = Market.fundData;
    if (!f || !f.nav) return;
    const nav = parseFloat(f.nav);
    const s = parseFloat(shares) || 0;
    const c = parseFloat(cost) || 0;
    if (s > 0 && c > 0) {
      const mv = (s * nav).toFixed(2);
      const tc = (s * c).toFixed(2);
      const pf = ((nav - c) * s).toFixed(2);
      const pp = (((nav - c) / c) * 100).toFixed(2);
      const isP = parseFloat(pf) >= 0;
      // 就地更新盈亏行或插入
      const row = document.querySelector('.fund-profit-row');
      if (row) row.outerHTML = `
        <div class="fund-profit-row">
          <div class="market-detail-item"><span>持仓市值</span><b>¥${mv}</b></div>
          <div class="market-detail-item"><span>投入成本</span><b>¥${tc}</b></div>
          <div class="market-detail-item ${isP ? 'market-up' : 'market-down'}"><span>浮动盈亏</span><b>${isP ? '+' : ''}¥${pf}</b></div>
          <div class="market-detail-item ${isP ? 'market-up' : 'market-down'}"><span>收益率</span><b>${isP ? '+' : ''}${pp}%</b></div>
        </div>`;
      else {
        const hint = document.querySelector('.fund-hint');
        if (hint) hint.outerHTML = `
        <div class="fund-profit-row">
          <div class="market-detail-item"><span>持仓市值</span><b>¥${mv}</b></div>
          <div class="market-detail-item"><span>投入成本</span><b>¥${tc}</b></div>
          <div class="market-detail-item ${isP ? 'market-up' : 'market-down'}"><span>浮动盈亏</span><b>${isP ? '+' : ''}¥${pf}</b></div>
          <div class="market-detail-item ${isP ? 'market-up' : 'market-down'}"><span>收益率</span><b>${isP ? '+' : ''}${pp}%</b></div>
        </div>`;
      }
    }
  },

  // === 以下为原有沪深300功能 ===

  async loadQuote() {
    try {
      const resp = await fetch(apiUrl('/api/quote?code=sh000300'));
      const json = await resp.json();
      if (json.data) {
        const raw = json.data;
        const m = raw.match(/v_sh000300="([^"]+)"/);
        if (m) {
          const parts = m[1].split('~');
          Market.quoteData = {
            name: parts[1],
            code: parts[2],
            price: parseFloat(parts[3]),
            prevClose: parseFloat(parts[4]),
            open: parseFloat(parts[5]),
            datetime: parts[30],
            change: parseFloat(parts[31]),
            changePct: parseFloat(parts[32]),
            high: parseFloat(parts[33]),
            low: parseFloat(parts[34]),
            volume: parseInt(parts[36]?.split('/')[0]) || 0
          };
        }
      }
    } catch (e) { console.error('行情加载失败:', e); }
  },

  async loadKline() {
    try {
      const resp = await fetch(apiUrl('/api/kline?code=sh000300&count=7'));
      const json = await resp.json();
      if (json.data) {
        const parsed = JSON.parse(json.data);
        const days = parsed?.data?.sh000300?.day || [];
        Market.klineData = days.map(d => ({
          date: d[0],
          open: parseFloat(d[1]),
          close: parseFloat(d[2]),
          high: parseFloat(d[3]),
          low: parseFloat(d[4]),
          volume: parseFloat(d[5])
        }));
      }
    } catch (e) { console.error('K线加载失败:', e); }
  },

  renderHero() {
    const el = document.getElementById('marketHero');
    if (!el) return;
    const q = Market.quoteData;
    if (!q) { el.innerHTML = '<div class="market-loading">行情数据获取失败，稍后重试</div>'; return; }
    const isUp = q.change >= 0;
    const colorClass = isUp ? 'market-up' : 'market-down';
    const arrow = isUp ? '▲' : '▼';
    const wday = Market.parseWeekday(q.datetime);
    el.innerHTML = `
      <div class="market-hero-top">
        <div>
          <div class="market-name">沪深300</div>
          <div class="market-code">${q.code} · ${wday}</div>
        </div>
        <div class="market-price-block ${colorClass}">
          <div class="market-price">${q.price.toFixed(2)}</div>
          <div class="market-change">${arrow} ${Math.abs(q.change).toFixed(2)} (${Math.abs(q.changePct).toFixed(2)}%)</div>
        </div>
      </div>
      <div class="market-detail-row">
        <div class="market-detail-item"><span>昨收</span><b>${q.prevClose.toFixed(2)}</b></div>
        <div class="market-detail-item"><span>今开</span><b>${q.open.toFixed(2)}</b></div>
        <div class="market-detail-item"><span>最高</span><b>${q.high.toFixed(2)}</b></div>
        <div class="market-detail-item"><span>最低</span><b>${q.low.toFixed(2)}</b></div>
      </div>`;
  },

  renderChart() {
    const wrap = document.getElementById('marketChartWrap');
    if (!wrap) return;
    const data = Market.klineData;
    if (!data || data.length === 0) { wrap.innerHTML = '<div class="market-loading">走势数据加载失败</div>'; return; }
    wrap.innerHTML = '<canvas id="marketChart"></canvas>';
    const ctx = document.getElementById('marketChart');
    if (!ctx || typeof Chart === 'undefined') { wrap.innerHTML = '<div class="market-loading">图表库未加载</div>'; return; }
    if (Market.chartLine) Market.chartLine.destroy();

    const labels = data.map(d => d.date.slice(5));
    const closes = data.map(d => d.close);
    if (Market.quoteData?.price) { labels.push('实时'); closes.push(Market.quoteData.price); }

    Market.chartLine = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          data: closes,
          borderColor: '#F4A6B5',
          backgroundColor: 'rgba(244,166,181,0.15)',
          fill: true,
          tension: 0.3,
          pointBackgroundColor: closes.map((v, i) => i === 0 ? '#F4A6B5' : (v >= closes[i-1] ? '#E8857A' : '#9ED5C5')),
          pointRadius: 4,
          borderWidth: 2
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { ticks: { font: { size: 10 }, callback: v => v.toFixed(0) } },
          x: { ticks: { font: { size: 10 } } }
        }
      }
    });
  },

  _formHeadHtml() {
    const editing = Market.editingDate;
    return `<div class="card-title">📝 ${editing ? '编辑 ' + editing : '今日记录'}</div>` +
      (editing ? ' <button class="btn btn-ghost btn-sm" onclick="Market.resetEdit()">↺ 记今天</button>' : '');
  },

  async renderForm() {
    const el = document.getElementById('marketFormCard');
    if (!el) return;
    const today = todayStr();
    const reviews = await window.DB.getAll('market_reviews');
    const todayReview = reviews.find(r => r.date === today);
    el.innerHTML = `
      <div class="row-between mb-8" id="mfFormHead">${Market._formHeadHtml()}</div>
      <div class="form-group">
        <label class="form-label">持仓盈亏（元）</label>
        <input class="input" id="m_pnl" type="number" step="0.01" placeholder="如：+2500 或 -800" value="${esc(todayReview?.pnl || '')}" />
      </div>
      <div class="form-group">
        <label class="form-label">一句话复盘</label>
        <input class="input" id="m_note" placeholder="如：AI领涨，加仓了500" value="${esc(todayReview?.note || '')}" />
      </div>
      <button class="btn btn-primary btn-block" onclick="Market.save()">${Market.editingDate ? '更新记录' : '保存今日记录'}</button>`;
  },

  async renderHistory() {
    const el = document.getElementById('marketHistory');
    if (!el) return;
    const reviews = await window.DB.getAll('market_reviews');
    reviews.sort((a, b) => b.date.localeCompare(a.date));
    const recent = reviews.slice(0, 15);
    if (recent.length === 0) { el.innerHTML = '<div class="empty"><div class="empty-icon">📊</div><div class="empty-text">还没有历史记录</div></div>'; return; }
    el.innerHTML = recent.map(r => {
      const pnl = parseFloat(r.pnl);
      const hasPnl = !isNaN(pnl) && r.pnl !== '';
      const isProfit = hasPnl && pnl >= 0;
      const pnlClass = isProfit ? 'market-up' : 'market-down';
      const pnlText = hasPnl ? `${isProfit ? '+' : ''}${pnl.toFixed(0)}` : '—';
      return `<div class="list-item market-hist-item" onclick="Market.loadDate('${r.date}')">
        <div class="list-item-content"><div class="list-item-title">${r.date}</div><div class="list-item-sub">${esc(r.note || '无备注')}</div></div>
        <div class="market-pnl ${pnlClass}">${pnlText}</div>
        <button class="list-item-action" onclick="event.stopPropagation();Market.del(${r.id})">🗑️</button></div>`;
    }).join('');
  },

  async save() {
    const saveDate = Market.editingDate || todayStr();
    const pnl = document.getElementById('m_pnl').value.trim();
    const note = document.getElementById('m_note').value.trim();
    if (!pnl && !note) return toast('请至少填写一项');
    const reviews = await window.DB.getAll('market_reviews');
    const existing = reviews.find(r => r.date === saveDate);
    const data = { date: saveDate, pnl, note, savedAt: Date.now() };
    if (existing) { await window.DB.put('market_reviews', { ...existing, ...data }); }
    else { await window.DB.add('market_reviews', data); }
    const wasEdit = Market.editingDate;
    Market.editingDate = null;
    toast(wasEdit ? '已更新 ' + wasEdit : '已保存 ✓');
    const head = document.getElementById('mfFormHead');
    if (head) head.innerHTML = Market._formHeadHtml();
    Market.renderHistory();
  },

  async loadDate(date) {
    const reviews = await window.DB.getAll('market_reviews');
    const r = reviews.find(x => x.date === date);
    if (r) {
      const pnlEl = document.getElementById('m_pnl');
      const noteEl = document.getElementById('m_note');
      if (pnlEl) pnlEl.value = r.pnl || '';
      if (noteEl) noteEl.value = r.note || '';
      Market.editingDate = date;
      const head = document.getElementById('mfFormHead');
      if (head) head.innerHTML = Market._formHeadHtml();
      toast(`正在编辑 ${date}`);
    }
  },

  resetEdit() {
    Market.editingDate = null;
    const pnlEl = document.getElementById('m_pnl');
    const noteEl = document.getElementById('m_note');
    if (pnlEl) pnlEl.value = '';
    if (noteEl) noteEl.value = '';
    const head = document.getElementById('mfFormHead');
    if (head) head.innerHTML = Market._formHeadHtml();
    toast('已切回今日记录');
  },

  async del(id) {
    const ok = await confirmDialog('确定删除？');
    if (!ok) return;
    const item = await window.DB.get('market_reviews', id);
    await window.DB.delete('market_reviews', id);
    if (item && item.gid) {
      try { await window.DB._addTombstoneIfNewer({ gid: item.gid, storeName: 'market_reviews', deletedAt: Date.now() }); }
      catch (e) { console.warn('tombstone 失败', e); }
    }
    toast('已删除');
    Market.render();
  },

  parseWeekday(datetimeStr) {
    if (!datetimeStr) return '';
    const y = datetimeStr.slice(0, 4);
    const m = datetimeStr.slice(4, 6);
    const d = datetimeStr.slice(6, 8);
    const date = new Date(y, parseInt(m) - 1, d);
    const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const w = days[date.getDay()];
    const h = datetimeStr.slice(8, 10);
    const min = datetimeStr.slice(10, 12);
    return `${m}/${d} ${w} ${h}:${min}`;
  }
};

window.Market = Market;