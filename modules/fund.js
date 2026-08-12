// modules/fund.js - 基金投资模块 v2：自选监控(实时行情+分位) + 持仓管理 + 7日走势图 + 详情面板
// 设计：活系统（watchlist / holdings / alertRules 均为可增删改查集合，monitor 遍历）
// 数据源：/api/fund(东方财富净值) + /api/quote(新浪实时) + /api/kline(腾讯K线) + /api/fund/history(分位)
// 复用 market.js 已验证的 Chart.js 画法

const Fund = {
  watch: [],
  holdings: [],
  fundCache: {},        // code -> 最新净值对象
  quoteCache: {},       // indexCode -> 实时行情对象
  klineCache: {},       // indexCode -> K线数组
  histCache: {},        // code -> 历史净值数组（分位用，缓存避免重复拉）
  pctCache: {},         // code -> { pct, level } 已算出的分位
  alertRules: null,     // 择时预警规则 {cheap, expensive, cooldownHrs}
  chartInstance: null,  // 当前详情面板的 Chart 实例

  // 底层指数映射：基金代码/名称关键词 → A股实时代理 code
  // 纳指100 用 sh513100(纳指ETF)；标普500 用 sh513500(标普ETF)
  INDEX_MAP: {
    'sh000300': { name: '沪深300', code: 'sh000300' },
    'sh513100': { name: '纳斯达克100 ETF', code: 'sh513100' },
    'sh513500': { name: '标普500 ETF', code: 'sh513500' },
    // 关键词 → 代理 code
    '沪深300':   { name: '沪深300', code: 'sh000300' },
    '纳指':      { name: '纳斯达克100', code: 'sh513100' },
    '纳斯达克':  { name: '纳斯达克100', code: 'sh513100' },
    '纳指100':   { name: '纳斯达克100', code: 'sh513100' },
    '标普500':   { name: '标普500', code: 'sh513500' },
    '标普':      { name: '标普500', code: 'sh513500' },
    '黄金':      { name: '黄金ETF', code: 'sh518880' },
    '中证500':   { name: '中证500', code: 'sh000905' },
    '创业板':    { name: '创业板指', code: 'sh399006' },
  },

  // 常见基金代码 → 底层代理（兜底：当 API 返回空名字、关键词匹配失效时用）
  FUND_CODE_INDEX: {
    '017641': { name: '标普500', code: 'sh513500' },   // 摩根标普500指数A
    '019172': { name: '纳斯达克100', code: 'sh513100' }, // 摩根纳斯达克100指数A
    '000216': { name: '黄金ETF', code: 'sh518880' },     // 华安黄金ETF联接A → 黄金ETF代理
    // 持仓短名（卡片表面用，弹窗有全名）
    '007044': { name: '沪深300', code: '' },              // 博道沪深300增强A
    '011962': { name: '易方达稳鑫', code: '' },           // 易方达稳鑫30天滚动持有
    '003547': { name: '鹏华丰禄', code: '' },             // 鹏华丰禄债券
    '011489': { name: '创金双季享', code: '' },           // 创金合信双季享6个月持有A
    '013536': { name: '鹏华稳华', code: '' },             // 鹏华稳华90天滚动持有债
    '000198': { name: '余额宝', code: '' },               // 天弘余额宝货币A
    '002937': { name: '帮你投', code: '' },               // 华夏沃利货币B
  },

  // 根据基金信息推断底层实时代理
  resolveIndexCode(fundInfo) {
    const code = fundInfo.code || '';
    const name = fundInfo.name || fundInfo.index || '';
    // 1. 先精确匹配代码或名称中的关键词
    for (const [key, val] of Object.entries(Fund.INDEX_MAP)) {
      if (code.includes(key) || name.includes(key)) return val;
    }
    // 2. 兜底：按基金代码直接查表（API 返回空名字时用）
    const direct = Fund.FUND_CODE_INDEX[code];
    if (direct) return direct;
    // 3. 默认无代理
    return null;
  },

  async render() {
    const content = document.getElementById('content');
    content.innerHTML = `
      <div class="card card-tip">
        <b>活系统</b> · 自选和持仓随时增删 · 分位=当前净值在约半年中的位置（越低越便宜）<br>
        <span class="muted">实时行情来自 A 股代理（9:30–15:00）；QDII 基金净值 T+1 更新</span>
      </div>
      <div class="card" id="fundWatchCard">
        <div class="card-title">👁 自选监控 <span class="card-extra" onclick="Fund.openRules()">⚙ 规则</span></div>
        <div class="market-loading">加载中...</div>
      </div>
      <div class="card" id="fundHoldCard">
        <div class="card-title">💼 我的持仓</div>
        <div class="market-loading">加载中...</div>
      </div>
    `;
    await Fund.loadAll();
    await Fund.renderWatch();  // 自选监控（含择时信号，合并模块）
    await Fund.renderHoldings();
    Fund.showWatchReminder(); // 14:50 看盘弹窗（交易日窗口内触发）
  },

  async loadAll() {
    Fund.watch = await window.DB.getAll('fund_watchlist');
    Fund.holdings = await window.DB.getAll('fund_holdings');
    await Fund.dedupeWatch();
    await Fund.dedupeHoldings();
    await Fund.loadRules();
  },

  // 自动清理同 code 重复（历史脏数据），只保留首条，避免列表数量乱跳
  async dedupeWatch() {
    const seen = {}, dup = [];
    for (const w of Fund.watch) { if (seen[w.code]) dup.push(w); else seen[w.code] = true; }
    for (const w of dup) {
      try {
        await window.DB.delete('fund_watchlist', w.id);
        if (w.gid) await window.DB._addTombstoneIfNewer({ gid: w.gid, storeName: 'fund_watchlist', deletedAt: Date.now() });
      } catch (e) { console.warn('dedupe watch 失败', e); }
    }
    if (dup.length) { Fund.watch = Fund.watch.filter(w => !dup.includes(w)); toast('已清理 ' + dup.length + ' 条重复自选'); }
  },

  async dedupeHoldings() {
    const seen = {}, dup = [];
    for (const h of Fund.holdings) { if (seen[h.code]) dup.push(h); else seen[h.code] = true; }
    for (const h of dup) {
      try {
        await window.DB.delete('fund_holdings', h.id);
        if (h.gid) await window.DB._addTombstoneIfNewer({ gid: h.gid, storeName: 'fund_holdings', deletedAt: Date.now() });
      } catch (e) { console.warn('dedupe holding 失败', e); }
    }
    if (dup.length) { Fund.holdings = Fund.holdings.filter(h => !dup.includes(h)); toast('已清理 ' + dup.length + ' 条重复持仓'); }
  },

  // ===== 自选监控（v3：智能渲染——已有卡片不消失，只更新数字） =====
  // ===== 自选监控（合并：列表+择时信号） =====
  async renderWatch() {
    const el = document.getElementById('fundWatchCard');
    if (!el) return;

    // 空状态
    if (Fund.watch.length === 0) {
      if (!el.querySelector('.empty')) {
        el.innerHTML = `<div class="card-title">👁 自选监控 <span class="card-extra" onclick="Fund.openRules()">⚙ 规则</span></div>
          <div class="empty"><div class="empty-icon">👁</div><div class="empty-text">还没有自选基金</div>
          <button class="btn btn-primary" onclick="Fund.openAdd()">+ 添加基金</button></div>`;
      }
      return;
    }

    // 骨架只建一次
    let list = document.getElementById('fundTimingList');
    if (!list) {
      el.innerHTML = `<div class="card-title">👁 自选监控 <span class="card-extra" onclick="Fund.openRules()">⚙ 规则</span></div>
        <div class="muted" id="fundTimingHint" style="font-size:11px;margin:4px 0 8px"></div>
        <style>
          .timing-item{padding:14px 16px;margin-bottom:10px;cursor:pointer;position:relative}
          .timing-item:last-child{margin-bottom:0}
          .timing-item:hover{background:rgba(0,0,0,0.02)}
          .timing-del{position:absolute;top:50px;right:6px;font-size:14px;cursor:pointer;z-index:2;background:none;border:none;padding:2px;line-height:1}
          .timing-del:hover{transform:scale(1.2)}
        </style>
        <div id="fundTimingList"></div>
        <button class="btn btn-ghost btn-block mt-8" onclick="Fund.openAdd()">+ 添加基金</button>`;
      list = document.getElementById('fundTimingList');
    } else {
      const titleEl = el.querySelector('.card-title');
      if (titleEl) titleEl.innerHTML = `👁 自选监控 <span class="card-extra" onclick="Fund.openRules()">⚙ 规则</span>`;
    }

    const hint = document.getElementById('fundTimingHint');
    if (hint) hint.textContent = Fund.cutoffHint();

    for (const w of Fund.watch) {
      let item = document.getElementById('ft_' + w.id);
      if (!item) {
        item = document.createElement('div');
        item.className = 'card timing-item';
        item.id = 'ft_' + w.id;
        item.onclick = () => Fund.openDetail(w.code);
        list.appendChild(item);
      }
      try { await Fund.refreshTimingItem(w, item); } catch (e) {
        console.error('refreshTimingItem 出错', w.code, e);
        item.innerHTML = `<button class="timing-del" onclick="event.stopPropagation();Fund.delWatch(${w.id})" title="移除自选">🗑️</button>
          <div style="font-weight:500;font-size:14px">${esc(w.name || w.code)}</div>
          <div class="muted" style="font-size:12px">数据加载失败</div>`;
      }
    }
    // 清理残留 DOM
    const cur = new Set(Fund.watch.map(w => 'ft_' + w.id));
    Array.from(list.children).forEach(c => { if (!cur.has(c.id)) c.remove(); });
    await Fund.checkAlerts();
  },

  // 同步完成时调用：只原地刷新已有卡片的数字，绝不重建 DOM（防自选/持仓闪动）
  async refreshData() {
    // 自选监控（合并模块）：逐条原地刷新
    for (const w of Fund.watch) {
      const item = document.getElementById('ft_' + w.id);
      if (item) await Fund.refreshTimingItem(w, item);
    }
    // 持仓：逐条原地刷新
    for (const h of Fund.holdings) {
      if (document.getElementById('fh_' + h.id)) Fund.refreshHoldingItem(h);
    }
  },


  // ===== 详情面板// ===== 详情面板（v2：7日走势图 + 完整分位 + 入场参考） =====
  async openDetail(code) {
    const w = Fund.watch.find(x => x.code === code);
    const f = Fund.fundCache[code];
    const idx = Fund.resolveIndexCode(f || w || { code, name: '' });

    showModal({
      title: (f?.name || code),
      body: `<div id="fundDetailLoading" class="market-loading">加载走势数据...</div>
       <div id="fundDetailBody" style="display:none">
         <div id="fundDetailChartWrap" style="height:220px;position:relative"></div>
         <div id="fundDetailStats" class="mt-12"></div>
         <div id="fundDetailAdvice" class="mt-8"></div>
       </div>`,
      footer: ''
    });

    // 并行拉 K线 + 历史 + 实时
    const [klineData, histData, quote] = await Promise.all([
      Fund._loadKline(idx),
      Fund.fetchHistory(code),
      idx ? (Fund.quoteCache[idx.code] || Fund._loadQuote(idx.code)) : null
    ]);

    document.getElementById('fundDetailLoading').style.display = 'none';
    const body = document.getElementById('fundDetailBody');
    body.style.display = '';

    // 走势图
    Fund._renderChart(klineData, quote, idx);

    // 统计 & 分位
    Fund._renderStats(f, histData, quote, idx);

    // 入场参考
    Fund._renderAdvice(histData, f, idx);
  },

  async _loadKline(idx) {
    if (!idx) return [];
    try {
      const r = await fetch(apiUrl('/api/kline?code=' + idx.code + '&count=15'));
      const j = await r.json();
      if (j?.data) {
        const parsed = JSON.parse(j.data);
        const stockData = parsed?.data?.[idx.code] || {};
        // 指数用 'day' 键，ETF 用 'qfqday' 键
        const days = stockData.day || stockData.qfqday || [];
        Fund.klineCache[idx.code] = days.map(d => ({
          date: d[0], open: parseFloat(d[1]), close: parseFloat(d[2]),
          high: parseFloat(d[3]), low: parseFloat(d[4]), volume: parseFloat(d[5])
        }));
        return Fund.klineCache[idx.code];
      }
    } catch (e) {}
    return [];
  },

  async _loadQuote(code) {
    try {
      const r = await fetch(apiUrl('/api/quote?code=' + code));
      const j = await r.json();
      if (j?.data) {
        const m = j.data.match(new RegExp(`v_${code}="([^"]+)"`));
        if (m) {
          const p = m[1].split('~');
          const q = { name: p[1], price: parseFloat(p[3]), prevClose: parseFloat(p[4]),
                change: parseFloat(p[31]), changePct: parseFloat(p[32]) };
          Fund.quoteCache[code] = q;
          return q;
        }
      }
    } catch (e) {}
    return null;
  },

  _renderChart(klineData, quote, idx) {
    const wrap = document.getElementById('fundDetailChartWrap');
    if (!wrap) return;
    if (!klineData || klineData.length === 0) {
      wrap.innerHTML = '<div class="market-loading">暂无走势数据（需重启 bat 后 /api/kline 生效，或该指数无 A 股代理）</div>';
      return;
    }
    wrap.innerHTML = '<canvas id="fundDetailChart"></canvas>';
    const ctx = document.getElementById('fundDetailChart');
    if (!ctx || typeof Chart === 'undefined') { wrap.innerHTML = '<div class="market-loading">图表库未加载</div>'; return; }
    if (Fund.chartInstance) Fund.chartInstance.destroy();

    const labels = klineData.map(d => d.date.slice(5));  // MM-DD
    const closes = klineData.map(d => d.close);
    if (quote?.price) { labels.push('实时'); closes.push(quote.price); }

    Fund.chartInstance = new Chart(ctx, {
      type: 'line',
      data: {
        labels,
        datasets: [{
          data: closes,
          borderColor: '#F4A6B5',
          backgroundColor: 'rgba(244,166,181,0.15)',
          fill: true,
          tension: 0.3,
          pointBackgroundColor: closes.map((v, i) =>
            i === 0 ? '#F4A6B5' : (v >= closes[i-1] ? '#E8857A' : '#9ED5C5')),
          pointRadius: 4,
          borderWidth: 2
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: { ticks: { font: { size: 10 }, callback: v => v.toFixed(2) } },
          x: { ticks: { font: { size: 10 } } }
        }
      }
    });
  },

  _renderStats(f, histData, quote, idx) {
    const el = document.getElementById('fundDetailStats');
    if (!el) return;

    // 取最新 K线缓存（_renderStats 在 _renderChart 之后调用，此时已有）
    const klineDataCache = Fund.klineCache[idx?.code] || [];

    // 分位计算
    let pct = null;
    if (histData && histData.length > 5 && f?.nav) {
      const nav = parseFloat(f.nav);
      const arr = histData.map(h => parseFloat(h.nav)).filter(v => !isNaN(v));
      const lower = arr.filter(v => v <= nav).length;
      pct = Math.round(lower / arr.length * 100);
    }

    // 波动率（基于K线）
    let volatility = null;
    if (klineDataCache?.length > 2) {
      const returns = [];
      for (let i = 1; i < klineDataCache.length; i++) {
        returns.push((klineDataCache[i].close - klineDataCache[i-1].close) / klineDataCache[i-1].close);
      }
      const avg = returns.reduce((a,b)=>a+b,0)/returns.length;
      const variance = returns.reduce((a,r)=>a+(r-avg)**2,0)/returns.length;
      volatility = (Math.sqrt(variance) * Math.sqrt(252) * 100).toFixed(1);  // 年化%
    }

    // 持仓盈亏（弹窗里显示完整¥金额，卡片表面只显示%）
    const hold = Fund.holdings.find(x => x.code === (f?.code || ''));
    let holdPfHtml = '';
    if (hold && f?.nav) {
      const hShares = parseFloat(hold.shares) || 0;
      const hNav = parseFloat(f.nav);
      const hMv = hShares > 0 && hNav > 0 ? hShares * hNav : 0;
      const hInv = parseFloat(hold.invested) || 0;
      if (hMv > 0 && hInv > 0) {
        const hPf = hMv - hInv;
        const hPp = (hPf / hInv * 100).toFixed(2);
        const hIsP = hPf >= 0;
        holdPfHtml = `<div class="market-detail-item"><span>持仓盈亏</span><b class="${hIsP?'market-up':'market-down'}">${hIsP?'+':''}¥${hPf.toFixed(2)} (${hPp}%)</b></div>
          <div class="market-detail-item"><span>持仓市值</span><b>¥${hMv.toFixed(2)}</b></div>
          <div class="market-detail-item"><span>累计投入</span><b>¥${hInv.toFixed(2)}</b></div>`;
      }
    }

    el.innerHTML = `
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(120px,1fr));gap:8px;font-size:12px">
        <div class="market-detail-item"><span>最新净值</span><b>${f?.nav || '—'}</b></div>
        <div class="market-detail-item"><span>日涨跌</span><b class="${parseFloat(f?.dayChange)>=0?'market-up':'market-down'}">${(f?.dayChange||'—').replace(/%$/,'')}%</b></div>
        ${pct !== null ? `<div class="market-detail-item"><span>历史分位</span><b class="${pct<=20?'tag-red':pct>=80?'tag-green':''}">${pct}%</b></div>` : ''}
        ${quote ? `<div class="market-detail-item"><span>${idx?.name||''} 实时</span><b class="${quote.change>=0?'market-up':'market-down'}">${quote.price.toFixed(2)}</b></div>` : ''}
        ${volatility ? `<div class="market-detail-item"><span>年化波动</span><b>${volatility}%</b></div>` : ''}
        <div class="market-detail-item"><span>净值日期</span><b>${f?.navDate || '—'}</b></div>
        <div class="market-detail-item"><span>规模</span><b>${esc(f?.scale || '—')}</b></div>
        <div class="market-detail-item"><span>成立日期</span><b>${f?.startDate || '—'}</b></div>
        ${holdPfHtml}
      </div>`;
  },

  _renderAdvice(histData, f, idx) {
    const el = document.getElementById('fundDetailAdvice');
    if (!el) return;
    let advice = '';
    let level = '';

    if (histData && histData.length > 5 && f?.nav) {
      const nav = parseFloat(f.nav);
      const arr = histData.map(h => parseFloat(h.nav)).filter(v => !isNaN(v));
      const lower = arr.filter(v => v <= nav).length;
      const p = Math.round(lower / arr.length * 100);

      if (p <= 20) {
        advice = '🟢 当前处于历史低位区间（≤20% 分位），从估值角度看入场性价比较高。建议可开始定投建仓，或分批买入。';
        level = 'tag-green';
      } else if (p >= 80) {
        advice = '🔴 当前处于历史高位区间（≥80% 分位），一次性买入风险偏高。建议小额定投或等待回调。';
        level = 'tag-red';
      } else {
        advice = '🟡 当前处于历史中间区间（' + p + '% 分位），不算贵也不算便宜。适合定投平摊成本，不建议一把梭哈。';
        level = '';
      }
    } else {
      advice = '⚪ 数据不足，无法给出分位参考。重启 bat 后可获取更多历史数据。';
      level = '';
    }

    el.innerHTML = `<div class="card card-tip" style="margin:0"><b>入场参考</b> <span class="${level}">${level?'['+level.split('-')[1]+']':''}</span><br><span style="font-size:13px">${advice}</span>
      <br><span class="muted" style="font-size:11px">仅供参考，不构成投资建议。定投是应对择时不确定性的最佳策略。</span></div>`;
  },

  // ===== 持仓管理 =====
  async renderHoldings() {
    const el = document.getElementById('fundHoldCard');
    if (!el) return;
    if (Fund.holdings.length === 0) {
      el.innerHTML = `<div class="card-title">💼 我的持仓</div>
        <div class="empty"><div class="empty-icon">💼</div><div class="empty-text">还没有记录持仓</div>
        <button class="btn btn-primary" onclick="Fund.openAddHolding()">+ 添加持仓</button>
        <button class="btn btn-ghost mt-8" onclick="Fund.openBulkHolding()">批量粘贴</button></div>`;
      return;
    }
    el.innerHTML = `<div class="card-title">💼 我的持仓 <span class="muted">(${Fund.holdings.length})</span></div>
      <div id="fundHoldList"></div>
      <div class="mt-8" style="display:flex;gap:8px">
        <button class="btn btn-ghost btn-block" onclick="Fund.openAddHolding()">+ 添加持仓</button>
        <button class="btn btn-ghost" onclick="Fund.openBulkHolding()">批量粘贴</button>
      </div>`;
    const list = document.getElementById('fundHoldList');
    for (const h of Fund.holdings) {
      const item = document.createElement('div');
      item.className = 'list-item';
      item.id = 'fh_' + h.id;
      list.appendChild(item);
      Fund.refreshHoldingItem(h);
    }
  },

  async refreshHoldingItem(h) {
    const item = document.getElementById('fh_' + h.id);
    if (!item) return;
    Fund._htok = Fund._htok || {};
    const tok = (Fund._htok[h.id] = (Fund._htok[h.id] || 0) + 1);

    // 骨架只建一次：持仓卡片容器永不重建 → 不会消失/闪
    if (!item.querySelector('.fh-title')) {
      item.innerHTML = `
        <div class="list-item-content fh-content" onclick="Fund.openDetail('${h.code}')" style="cursor:pointer;flex:1;min-width:0">
          <div class="list-item-title fh-title">${esc(h.code)}</div>
          <div class="list-item-sub fh-sub"></div>
        </div>
        <div class="fh-pf" style="text-align:right;flex:0 0 auto;min-width:0;white-space:nowrap;padding-right:4px"></div>
        <div class="list-item-actions" style="flex-shrink:0;margin-left:auto">
          <button class="list-item-action" onclick="event.stopPropagation();Fund.openEditHolding(${h.id})" title="编辑持仓">✏️</button>
          <button class="list-item-action" onclick="event.stopPropagation();Fund.delHolding(${h.id})" title="删除持仓">🗑️</button>
        </div>`;
    }
    const titleEl = item.querySelector('.fh-title');
    const subEl   = item.querySelector('.fh-sub');
    const pfEl    = item.querySelector('.fh-pf');

    let f = Fund.fundCache[h.code];
    if (!f) {
      try { const r = await fetch(apiUrl('/api/fund?code=' + h.code)); f = await r.json(); Fund.fundCache[h.code] = f; }
      catch (e) { f = null; }
    }
    if (tok !== Fund._htok[h.id]) return;

    // 名字缩短：FUND_CODE_INDEX 短名优先（弹窗有全名）
    const displayName = (Fund.FUND_CODE_INDEX[h.code] && Fund.FUND_CODE_INDEX[h.code].name)
      || (f && f.name) || h.name || h.code;
    titleEl.textContent = displayName;
    const shares = parseFloat(h.shares) || 0;
    const nav = f ? parseFloat(f.nav) : 0;
    const mv = shares > 0 && nav > 0 ? (shares * nav).toFixed(2) : '—';
    subEl.textContent = `${esc(h.code)} · ${shares.toFixed(2)} 份`;

    const invested = parseFloat(h.invested) || 0;
    let pf = '—', pp = '—';
    if (shares > 0 && invested > 0 && mv !== '—') {
      const p = parseFloat(mv);
      pf = (p - invested).toFixed(2);
      pp = ((p - invested) / invested * 100).toFixed(2);
    }
    const isP = parseFloat(pf) >= 0;
    const pc = isP ? 'market-up' : 'market-down';
    // 卡片表面只显示百分比（隐私：不暴露具体金额）；¥金额在弹窗里看
    const pfText = pf === '—' ? '待填本金' : `${isP ? '+' : ''}${pp}%`;
    pfEl.innerHTML = `<div style="text-align:right;line-height:1.35"><span style="font-size:11px;color:var(--text-sub);display:block">盈亏</span><b class="${pc}" style="font-size:14px">${pfText}</b></div>`;
  },

  // ===== CRUD 操作 =====
  openAdd() {
    showModal({ title: '添加自选基金', body: `
      <div class="form-group"><label class="form-label">基金代码 *</label>
        <input class="input" id="fa_code" placeholder="如 017641 (摩根标普500A)" /></div>
      <div class="form-group"><label class="form-label">底层指数 (自动识别)</label>
        <input class="input" id="fa_index" placeholder="如 标普500 / 纳指100（可不填，自动推断）" /></div>
      <div class="form-group"><label class="form-label">备注 (选填)</label>
        <input class="input" id="fa_note" placeholder="为什么关注" /></div>
      <div class="muted" style="font-size:11px">推荐：<b>017641</b> 摩根标普500A · <b>019172</b> 摩根纳指100A</div>
    `, footer: `<button class="btn btn-primary" onclick="Fund.saveWatch()">添加</button>` });
  },

  async saveWatch() {
    const code = document.getElementById('fa_code').value.trim();
    if (!code) return toast('请输入基金代码');
    const index = document.getElementById('fa_index').value.trim();
    const note = document.getElementById('fa_note').value.trim();
    // 去重检查：直接查 IndexedDB（不依赖可能过期的内存数组）
    const all = await window.DB.getAll('fund_watchlist');
    if (all.some(w => w.code === code)) return toast('该基金已在自选中');
    await window.DB.add('fund_watchlist', { code, name: '', index, note });
    hideModal();
    toast('已添加 ✓（正在拉取数据...）');
    await Fund.loadAll();
    Fund.renderWatch();  // 仅局部重建自选卡片，不整页刷新（避免逐条闪）
  },

  async delWatch(id) {
    const ok = await confirmDialog('从自选移除？');
    if (!ok) return;
    const item = await window.DB.get('fund_watchlist', id);
    await window.DB.delete('fund_watchlist', id);
    if (item?.gid) {
      try { await window.DB._addTombstoneIfNewer({ gid: item.gid, storeName: 'fund_watchlist', deletedAt: Date.now() }); }
      catch (e) { console.warn('tombstone 失败', e); }
    }
    // 只删该条 DOM + 更新计数，不重建整页（避免闪屏）
    const el = document.getElementById('fw_' + id);
    if (el) el.remove();
    Fund.watch = Fund.watch.filter(w => w.id !== id);
    const countEl = document.querySelector('#fundWatchCard .muted');
    if (countEl) countEl.textContent = `(${Fund.watch.length} 只)`;
    if (Fund.watch.length === 0) Fund.renderWatch();  // 最后一条删完才重建空状态
  },

  openAddHolding() {
    showModal({ title: '添加持仓', body: `
      <div class="muted" style="font-size:11px;margin-bottom:8px">只需填「代码 + 当前市值」，份额系统按净值自动算。成本价不用管，盈亏会显示「待填本金」。</div>
      <div class="form-group"><label class="form-label">基金代码 *</label>
        <input class="input" id="fh_code" placeholder="如 007044（支付宝/天天基金持仓页顶部那串6位数字）" /></div>
      <div class="form-group"><label class="form-label">当前市值（你在 App 里看到的金额）*</label>
        <input class="input" id="fh_mv" type="number" step="0.01" placeholder="如 1585.29" /></div>
      <div class="form-group"><label class="form-label">累计投入（选填，App 里「累计投入/持仓成本」那栏）</label>
        <input class="input" id="fh_invested" type="number" step="0.01" placeholder="填了才能算盈亏，不填盈亏显示—" /></div>
    `, footer: `<button class="btn btn-primary" onclick="Fund.saveHolding()">保存</button>` });
  },

  async saveHolding() {
    const code = document.getElementById('fh_code').value.trim();
    if (!code) return toast('请输入基金代码');
    const mv = parseFloat(document.getElementById('fh_mv').value);
    if (!mv || mv <= 0) return toast('请输入当前市值');
    const invested = parseFloat(document.getElementById('fh_invested').value) || null;
    // 拉净值 → 反推份额 = 市值 / 单位净值
    let nav = 0;
    try {
      const r = await fetch(apiUrl('/api/fund?code=' + code));
      const f = await r.json();
      nav = parseFloat(f?.nav) || 0;
      if (f?.name) Fund.fundCache[code] = f;
    } catch (e) { nav = 0; }
    if (!nav) return toast('拉不到该基金净值，请检查代码是否正确');
    const shares = mv / nav;
    const cost = invested ? invested / shares : null;  // 每股成本（用于兼容旧逻辑）
    await window.DB.add('fund_holdings', { code, name: '', shares, cost, invested });
    hideModal();
    toast('已保存 ✓ 份额已按净值自动计算');
    await Fund.loadAll();
    Fund.renderHoldings();  // 仅局部重建持仓卡片，不整页刷新
  },

  openBulkHolding() {
    showModal({ title: '批量粘贴持仓', body: `
      <div class="muted" style="font-size:11px;margin-bottom:8px">每行一只，格式：<b>代码,市值,本金(可选)</b>，逗号或空格分隔均可。例：<br>007044,1585.29,1500<br>003547,780.49</div>
      <textarea id="fh_bulk" class="input" rows="6" style="width:100%;font-family:monospace" placeholder="007044,1585.29&#10;003547,780.49"></textarea>
    `, footer: `<button class="btn btn-primary" onclick="Fund.saveBulkHolding()">导入</button>` });
  },

  async saveBulkHolding() {
    const raw = document.getElementById('fh_bulk').value.trim();
    if (!raw) return toast('请粘贴持仓数据');
    const lines = raw.split('\n').map(s => s.trim()).filter(Boolean);
    let okCount = 0, failLines = [];
    hideModal();
    for (const line of lines) {
      const parts = line.split(/[,\s]+/).filter(Boolean);
      const code = parts[0];
      const mv = parseFloat(parts[1]);
      const invested = parseFloat(parts[2]) || null;
      if (!code || !mv || mv <= 0) { failLines.push(line); continue; }
      let nav = 0;
      try {
        const r = await fetch(apiUrl('/api/fund?code=' + code));
        const f = await r.json();
        nav = parseFloat(f?.nav) || 0;
        if (f?.name) Fund.fundCache[code] = f;
      } catch (e) { nav = 0; }
      if (!nav) { failLines.push(line + ' (净值拉不到)'); continue; }
      const shares = mv / nav;
      const cost = invested ? invested / shares : null;
      await window.DB.add('fund_holdings', { code, name: '', shares, cost, invested });
      okCount++;
    }
    await Fund.loadAll();
    Fund.renderHoldings();
    if (failLines.length) toast(`成功 ${okCount} 只，失败 ${failLines.length} 只（见控制台）`);
    else toast(`已导入 ${okCount} 只持仓 ✓`);
    failLines.forEach(l => console.warn('批量导入失败:', l));
  },

  async delHolding(id) {
    const ok = await confirmDialog('删除持仓记录？');
    if (!ok) return;
    const item = await window.DB.get('fund_holdings', id);
    await window.DB.delete('fund_holdings', id);
    if (item?.gid) {
      try { await window.DB._addTombstoneIfNewer({ gid: item.gid, storeName: 'fund_holdings', deletedAt: Date.now() }); }
      catch (e) { console.warn('tombstone 失败', e); }
    }
    // 只删该条 DOM + 更新计数，不重建整页（仿 delWatch）
    const el = document.getElementById('fh_' + id);
    if (el) el.remove();
    Fund.holdings = Fund.holdings.filter(h => h.id !== id);
    const countEl = document.querySelector('#fundHoldCard .muted');
    if (countEl) countEl.textContent = `(${Fund.holdings.length})`;
    if (Fund.holdings.length === 0) Fund.renderHoldings();
  },

  // 编辑持仓：改市值（重算份额）或本金（盈亏基准）
  openEditHolding(id) {
    const h = Fund.holdings.find(x => x.id === id);
    if (!h) return;
    // 预填当前估算市值（份额 × 缓存净值）
    let curMv = '';
    const cached = Fund.fundCache[h.code];
    if (cached && cached.nav && h.shares) curMv = (h.shares * parseFloat(cached.nav)).toFixed(2);
    showModal({ title: '编辑持仓 · ' + esc(h.name || h.code), body: `
      <div class="form-group"><label class="form-label">基金代码</label>
        <input class="input" id="fe_code" value="${esc(h.code)}" readonly /></div>
      <div class="muted" style="font-size:11px;margin-bottom:8px">改「当前市值」会按最新净值重算份额；只改「本金」则份额与市值不变，只重算盈亏。</div>
      <div class="form-group"><label class="form-label">当前市值（你在 App 里看到的金额，选填）</label>
        <input class="input" id="fe_mv" type="number" step="0.01" placeholder="如 31.02" value="${curMv}" /></div>
      <div class="form-group"><label class="form-label">累计投入 / 本金（盈亏基准，选填）</label>
        <input class="input" id="fe_invested" type="number" step="0.01" placeholder="如 29.95" value="${h.invested != null ? h.invested : ''}" /></div>
    `, footer: `<button class="btn btn-primary" onclick="Fund.saveEditHolding(${id})">保存</button>` });
  },

  async saveEditHolding(id) {
    const h = Fund.holdings.find(x => x.id === id);
    if (!h) return;
    const mvRaw = (document.getElementById('fe_mv').value || '').trim();
    const invRaw = (document.getElementById('fe_invested').value || '').trim();
    const invested = invRaw === '' ? null : parseFloat(invRaw);
    let shares = h.shares;
    if (mvRaw !== '') {
      const mv = parseFloat(mvRaw);
      if (!mv || mv <= 0) return toast('当前市值需为正数');
      let nav = 0;
      try { const r = await fetch(apiUrl('/api/fund?code=' + h.code)); const f = await r.json(); nav = parseFloat(f?.nav) || 0; }
      catch (e) { nav = 0; }
      if (nav) shares = mv / nav;
    }
    const update = {
      id: h.id,
      code: h.code,
      name: h.name || '',
      shares: shares != null ? shares : 0,
      cost: (invested && shares) ? invested / shares : null,
      invested: invested
    };
    await window.DB.put('fund_holdings', update);
    hideModal();
    toast('已更新 ✓');
    await Fund.loadAll();
    const nh = Fund.holdings.find(x => x.id === id) || h;
    Fund.refreshHoldingItem(nh);
  },

  // ===== 择时监控面板（v1：分位信号 + 可改规则 + 红点/toast + 15:00 提示） =====

  defaultRules() {
    return { cheap: 20, expensive: 80, cooldownHrs: 24 };
  },

  async loadRules() {
    try {
      const all = await window.DB.getAll('fund_alert_rules');
      const r = all.find(x => x.id === 'rules');
      Fund.alertRules = r ? { cheap: r.cheap, expensive: r.expensive, cooldownHrs: r.cooldownHrs } : Fund.defaultRules();
    } catch (e) { Fund.alertRules = Fund.defaultRules(); }
  },

  // 分位 → 信号（便宜=可加码 / 贵=观望 / 中间=按原计划）
  computeSignal(pct, rules) {
    rules = rules || Fund.alertRules || Fund.defaultRules();
    if (pct == null) return { level: 'none', text: '数据不足', style: '' };
    if (pct <= rules.cheap) return { level: 'cheap', text: '这期定投可加码', style: 'background:#EAF3DE;color:#27500A' };
    if (pct >= rules.expensive) return { level: 'expensive', text: '观望少投', style: 'background:#FCEBEB;color:#A32D2D' };
    return { level: 'normal', text: '按原计划', style: 'background:#F1EFE8;color:#5F5E5A' };
  },

  // 分位条（绿=便宜区 红=贵区 黑线=当前落点）
  pctBarHtml(pct) {
    const c = Math.max(0, Math.min(100, pct));
    return `<div class="muted" style="font-size:11px;margin-bottom:2px">历史分位 <b style="color:var(--text-primary,#2C2C2A)">${pct}%</b></div>
      <div style="position:relative;height:6px;border-radius:3px;display:flex;overflow:hidden;margin:2px 0">
        <div style="width:20%;background:#C0DD97"></div>
        <div style="width:60%;background:var(--bg-secondary,#F1EFE8)"></div>
        <div style="width:20%;background:#F7C1C1"></div>
        <div style="position:absolute;left:${c}%;top:-3px;width:2px;height:12px;background:var(--text-primary,#2C2C2A)"></div>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-light,#888780)">
        <span>便宜 0%</span><span>贵 100%</span>
      </div>`;
  },

  // 分位条（纯视觉：绿/灰/红三段 + 黑线落点，不含文字标签）
  _pctBarVisual(pct) {
    const c = Math.max(0, Math.min(100, pct));
    return `<div style="position:relative;height:6px;border-radius:3px;display:flex;overflow:hidden;margin:2px 0">
        <div style="width:20%;background:#C0DD97"></div>
        <div style="width:60%;background:var(--bg-secondary,#F1EFE8)"></div>
        <div style="width:20%;background:#F7C1C1"></div>
        <div style="position:absolute;left:${c}%;top:-3px;width:2px;height:12px;background:var(--text-primary,#2C2C2A)"></div>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:10px;color:var(--text-light,#888780)">
        <span>便宜 0%</span><span>贵 100%</span>
      </div>`;
  },

  // 15:00 净值截止提示
  cutoffHint() {
    const now = new Date();
    const day = now.getDay();
    const h = now.getHours(), m = now.getMinutes();
    const isWeekend = (day === 0 || day === 6);
    const passed = (h > 15 || (h === 15 && m > 0));
    if (isWeekend) return '今日周末休市 · 下个交易日 15:00 前多投可锁当日净值';
    if (passed) return '已过今日 15:00 · 现在提交顺延至下一交易日净值';
    return '今日 15:00 前多投可锁今日净值';
  },

  // 14:50 看盘弹窗（交易日 14:40–15:10 打开模块时触发，每天最多一次）
  showWatchReminder() {
    const now = new Date();
    const day = now.getDay();
    if (day === 0 || day === 6) return;
    const h = now.getHours(), m = now.getMinutes();
    const totalMin = h * 60 + m;
    if (totalMin < 14 * 60 + 40 || totalMin > 15 * 60 + 10) return;
    const today = now.toISOString().slice(0, 10);
    try { if (localStorage.getItem('fundWatchRemind_' + today)) return; } catch(e){}
    showModal({
      title: '📊 盘前看盘',
      body: `<div style="font-size:13px;line-height:1.8">
        <p>现在 <b>${h}:${String(m).padStart(2,'0')}</b>，距离 <b>15:00 收盘</b> 还有 ${15*60 - totalMin} 分钟。</p>
        <p>看看三张自选卡的信号 pill：</p>
        <ul style="margin:4px 0;padding-left:18px;color:var(--text-primary,#2C2C2A)">
          <li><b>跌（▼）</b> → 可以考虑投一点</li>
          <li><b>涨（▲）</b> → 再等等</li>
          <li>QDII 美股基金按<strong>昨晚美股收盘</strong>算</li>
        </ul>
        <p class="muted" style="font-size:11px">此提示每天只出现一次</p>
      </div>`
    });
    try { localStorage.setItem('fundWatchRemind_' + today, '1'); } catch(e){}
  },

  // 侧边栏基金 nav 红点（动态注入，不碰 HTML）
  ensureDot() {
    const btn = document.querySelector('.nav-btn[data-module="fund"]');
    if (!btn) return;
    if (!document.getElementById('fundAlertDot')) {
      btn.style.position = 'relative';
      const d = document.createElement('span');
      d.id = 'fundAlertDot';
      d.style.cssText = 'display:none;position:absolute;top:6px;right:6px;width:8px;height:8px;border-radius:50%;background:#E24B4A;z-index:2';
      btn.appendChild(d);
    }
  },

  // 渲染单只自选卡片（合并：净值+实时+分位条+信号pill+右上角删除）
  async refreshTimingItem(w, item) {
    const { f, q, pct } = await Fund.ensureTimingData(w);
    Fund.pctCache[w.code] = { pct };
    const idx = Fund.resolveIndexCode(f || w);
    // 显示名优先级：FUND_CODE_INDEX 短名 > API 返回全名 > 用户自填 > 代码
    const name = (Fund.FUND_CODE_INDEX[w.code] && Fund.FUND_CODE_INDEX[w.code].name)
      || (f && f.name) || w.name || w.code;

    // 价格行：统一格式 = 净值/实时价 + 涨跌%（所有基金同一种排版）
    let priceNum = f?.nav || (q?.price ? q.price.toFixed(2) : '—');
    let dcPct;
    if (q && q.changePct != null) {
      dcPct = q.changePct;  // 有代理 → 用实时涨跌%
    } else {
      dcPct = f ? parseFloat(f.dayChange) : NaN;  // 无代理 → 用净值日涨跌%
    }
    const isUp = !isNaN(dcPct) && dcPct >= 0;
    // 第一行：名字 + 净值（不含涨跌幅）
    // 第二行：历史分位 + 涨跌幅%（合一行，字小但够看）
    const dcHtml = isNaN(dcPct) ? '—'
      : `<span class="${isUp ? 'market-up' : 'market-down'}">${isUp ? '▲' : '▼'} ${Math.abs(dcPct).toFixed(2)}%</span>`;

    // 信号 pill
    const sig = Fund.computeSignal(pct, Fund.alertRules);
    const badge = (pct == null)
      ? '<span class="muted" style="font-size:12px">数据不足</span>'
      : `<span style="display:inline-block;padding:4px 10px;border-radius:8px;font-size:12px;${sig.style}">${sig.text}</span>`;

    item.innerHTML = `
      <button class="timing-del" onclick="event.stopPropagation();Fund.delWatch(${w.id})" title="移除自选">🗑️</button>
      <div style="display:flex;justify-content:space-between;align-items:baseline;padding-right:24px">
        <span style="font-weight:500;font-size:14px">${esc(name)}</span>
        <span style="font-size:12px;text-align:right"><b>${priceNum}</b></span>
      </div>
      <div style="display:flex;justify-content:space-between;align-items:center;font-size:11px;margin-bottom:2px;padding-right:24px">
        <span class="muted">历史分位 <b style="color:var(--text-primary,#2C2C2A)">${pct == null ? '—' : pct + '%'}</b></span>
        <span>${dcHtml}</span>
      </div>
      ${pct != null ? '<div style="padding-right:24px">' + Fund._pctBarVisual(pct) + '</div>' : ''}
      <div style="margin-top:6px">${badge}</div>`;
  },

  // 拉取某基金历史净值（用于计算分位）
  async fetchHistory(code) {
    if (Fund.histCache[code]) return Fund.histCache[code];
    try {
      const r = await fetch(apiUrl('/api/fund/history?code=' + code));
      const j = await r.json();
      const arr = Array.isArray(j) ? j : (j?.data || j?.list || []);
      if (arr.length > 0) Fund.histCache[code] = arr;
      return arr;
    } catch (e) {
      console.warn('fetchHistory 失败', code, e);
      return [];
    }
  },

  // 确保某自选基金的 净值/实时/历史 都就位（复用缓存）
  async ensureTimingData(w) {
    let f = Fund.fundCache[w.code];
    if (!f) {
      try { const r = await fetch(apiUrl('/api/fund?code=' + w.code)); f = await r.json(); Fund.fundCache[w.code] = f; } catch (e) {}
    }
    const idx = Fund.resolveIndexCode(f || w);
    let q = idx ? Fund.quoteCache[idx.code] : null;
    if (idx && !q) { try { q = await Fund._loadQuote(idx.code); } catch (e) {} }
    let hist = Fund.histCache[w.code];
    if (!hist) hist = await Fund.fetchHistory(w.code);
    let pct = null;
    if (f && f.nav && hist && hist.length > 5) {
      const nav = parseFloat(f.nav);
      const arr = hist.map(h => parseFloat(h.nav)).filter(v => !isNaN(v));
      const lower = arr.filter(v => v <= nav).length;
      pct = Math.round(lower / arr.length * 100);
    }
    return { f, q, pct };
  },


  // 信号触发// 信号触发 → 红点常亮 + 冷却期内弹一次 toast
  async checkAlerts() {
    Fund.ensureDot();
    let active = false;
    const now = Date.now();
    const rules = Fund.alertRules || Fund.defaultRules();
    const coolMs = (rules.cooldownHrs || 24) * 3600 * 1000;
    for (const w of Fund.watch) {
      const pct = Fund.pctCache[w.code] ? Fund.pctCache[w.code].pct : null;
      if (pct == null) continue;
      const sig = Fund.computeSignal(pct, rules);
      if (sig.level === 'cheap' || sig.level === 'expensive') {
        active = true;
        let last = 0;
        try { last = parseInt(localStorage.getItem('fundAlert_' + w.code) || '0', 10); } catch (e) {}
        if (now - last > coolMs) {
          toast((sig.level === 'cheap' ? '🟢 ' : '🔴 ') + ((Fund.fundCache[w.code] && Fund.fundCache[w.code].name) || w.code) + '：' + sig.text);
          try { localStorage.setItem('fundAlert_' + w.code, String(now)); } catch (e) {}
        }
      }
    }
    const dot = document.getElementById('fundAlertDot');
    if (dot) dot.style.display = active ? 'block' : 'none';
  },

  openRules() {
    const r = Fund.alertRules || Fund.defaultRules();
    showModal({
      title: '择时预警规则',
      body: `<div class="muted" style="font-size:11px;margin-bottom:8px">分位 ≤ 便宜阈值 → 绿色「这期定投可加码」；分位 ≥ 贵阈值 → 红色「观望少投」；中间 → 灰色「按原计划」。</div>
        <div class="form-group"><label class="form-label">便宜阈值（分位 %）</label><input class="input" id="ar_cheap" type="number" value="${r.cheap}"></div>
        <div class="form-group"><label class="form-label">贵阈值（分位 %）</label><input class="input" id="ar_exp" type="number" value="${r.expensive}"></div>
        <div class="form-group"><label class="form-label">冷静期（小时，同类不重复提醒）</label><input class="input" id="ar_cd" type="number" value="${r.cooldownHrs}"></div>`,
      footer: `<button class="btn btn-primary" onclick="Fund.saveRules()">保存</button>`
    });
  },

  async saveRules() {
    const cheap = parseFloat(document.getElementById('ar_cheap').value);
    const expensive = parseFloat(document.getElementById('ar_exp').value);
    const cooldownHrs = parseFloat(document.getElementById('ar_cd').value) || 24;
    if (isNaN(cheap) || isNaN(expensive)) return toast('阈值需为数字');
    if (cheap >= expensive) return toast('便宜阈值应小于贵阈值');
    const rules = { id: 'rules', cheap, expensive, cooldownHrs };
    await window.DB.put('fund_alert_rules', rules);
    Fund.alertRules = { cheap, expensive, cooldownHrs };
    hideModal();
    toast('规则已保存 ✓');
    Fund.renderWatch();
  }
};

window.Fund = Fund;
