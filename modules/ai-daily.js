// modules/ai-daily.js - AI日报模块：AI HOT 日报展示
// 复用 server.py /api/aihot 代理；数据持久化 IndexedDB + 局域网同步

const AIDaily = {
  report: null,
  cacheTime: 0,
  loading: false,

  // 五板块：key 用于 API 匹配，label 用于界面展示（统一4字）
  SECTIONS: [
    { key: '模型发布/更新', label: '模型动态', icon: '🧠', anchor: 'model' },
    { key: '产品发布/更新', label: '产品动态', icon: '🚀', anchor: 'product' },
    { key: '行业动态',      label: '行业动态', icon: '📡', anchor: 'industry' },
    { key: '论文研究',      label: '论文研究', icon: '📄', anchor: 'paper' },
    { key: '技巧与观点',    label: '技巧观点', icon: '💡', anchor: 'tips' }
  ],

  async render() {
    const content = document.getElementById('content');
    content.innerHTML = '<div class="ai-loading"><div class="ai-loading-spinner"></div><div class="ai-loading-text">加载 AI 日报中…</div></div>';

    // 先查本地缓存（10 分钟内直接复用）
    const cached = this.getCached();
    if (cached) {
      this.report = cached;
      this.renderReport();
      // 静默后台刷新
      this.fetchReport(false);
      return;
    }

    // 查 IndexedDB
    const stored = await this.loadFromDB();
    if (stored) {
      this.report = stored;
      this.setCached(stored);
      this.renderReport();
      // 检查是否今日数据，不是则后台刷新
      if (stored.date !== todayStr()) {
        this.fetchReport(false);
      } else {
        // 是同一天，静默刷新
        this.fetchReport(false);
      }
      return;
    }

    // 无缓存，全量拉取
    await this.fetchReport(true);
  },

  getCached() {
    if (this.report && (Date.now() - this.cacheTime < 600000)) {
      return this.report;
    }
    return null;
  },

  setCached(report) {
    this.report = report;
    this.cacheTime = Date.now();
  },

  async loadFromDB() {
    try {
      const all = await window.DB.getAll('ai_daily');
      if (!all.length) return null;
      // 取最新的
      all.sort((a, b) => b.savedAt - a.savedAt);
      return all[0].data;
    } catch (e) {
      console.warn('加载日报缓存失败:', e.message);
      return null;
    }
  },

  async saveToDB(data) {
    try {
      const date = data.date || todayStr();
      const all = await window.DB.getAll('ai_daily');
      const existing = all.find(r => r.date === date);
      const payload = { date, data, savedAt: Date.now() };
      if (existing) {
        await window.DB.put('ai_daily', { ...existing, ...payload });
      } else {
        await window.DB.add('ai_daily', payload);
      }
    } catch (e) {
      console.warn('保存日报缓存失败:', e.message);
    }
  },

  async fetchReport(showLoading) {
    if (this.loading) return;
    this.loading = true;

    try {
      let resp = await fetch(apiUrl('/api/aihot'));
      let json = await resp.json();

      // 今日无日报，回退历史
      if (json.error && json.code === 404) {
        json = await this.fetchLatestHistory();
      }

      if (json.error) {
        throw new Error(json.error);
      }

      const data = this.parseReport(json);
      this.report = data;
      this.cacheTime = Date.now();
      await this.saveToDB(data);
      if (showLoading) this.renderReport();
    } catch (e) {
      if (showLoading) {
        const content = document.getElementById('content');
        content.innerHTML = `
          <div class="empty">
            <div class="empty-icon">📡</div>
            <div class="empty-text">日报加载失败</div>
            <div class="text-xs text-sub" style="margin:4px 0">${esc(e.message)}</div>
            <button class="btn btn-primary btn-sm mt-12" onclick="AIDaily.fetchReport(true)">重试</button>
          </div>`;
      }
    } finally {
      this.loading = false;
    }
  },

  async fetchLatestHistory() {
    // 服务器代理支持 date 参数，先试 todayStr，再回溯 7 天
    const dates = [];
    const d = new Date();
    for (let i = 1; i <= 7; i++) {
      d.setDate(d.getDate() - 1);
      dates.push(fmtDate(d.getTime()));
    }
    for (const date of dates) {
      try {
        const resp = await fetch(apiUrl(`/api/aihot?date=${date}`));
        const json = await resp.json();
        if (!json.error) return json;
      } catch (e) { /* 继续 */ }
    }
    throw new Error('最近 7 天无日报数据');
  },

  parseReport(json) {
    const report = json.report || json;
    const sections = report.sections || [];
    const date = report.date || todayStr();

    // 全局连续编号 + 板块统计
    let globalIdx = 0;
    const sectionData = this.SECTIONS.map(spec => {
      const sec = sections.find(s => s.label === spec.key) || { label: spec.key, items: [] };
      const items = (sec.items || []).map(item => {
        globalIdx++;
        return {
          idx: globalIdx,
          title: item.title || '',
          summary: item.summary || '',
          source: (item.source && item.source.name) ? item.source.name : 'AI HOT',
          linkAihot: (item.links && item.links.aihot) ? item.links.aihot : '',
          linkOriginal: (item.links && item.links.original) ? item.links.original : ''
        };
      });
      return { ...spec, label: spec.label, items, count: items.length };
    });

    return {
      date,
      generatedAt: report.generatedAt || '',
      total: globalIdx,
      sections: sectionData,
      links: report.links || {},
      attribution: report.attribution || { name: 'AI HOT', url: 'https://aihot.virxact.com' }
    };
  },

  renderReport() {
    const content = document.getElementById('content');
    if (!this.report || !this.report.sections) {
      content.innerHTML = '<div class="empty"><div class="empty-icon">📭</div><div class="empty-text">暂无日报数据</div></div>';
      return;
    }

    const r = this.report;
    const dateText = this.formatDateText(r.date, r.generatedAt);

    // Hero 区域：白色卡片 = 大图标(左半) + 竖排分类(右半) + 底部信息行(带刷新)
    let html = `
      <div class="ai-hero">
        <div class="ai-hero-main">
          <div class="ai-hero-icon-col">
            <div class="ai-hero-icon">
              <svg width="120" height="120" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.1" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><line x1="7" y1="8" x2="17" y2="8"/><line x1="7" y1="12" x2="17" y2="12"/><line x1="7" y1="16" x2="13" y2="16"/></svg>
            </div>
          </div>
          <div class="ai-hero-cats-col">
            ${r.sections.map(s => `<a href="#${s.anchor}" class="ai-hero-cat">${s.icon} ${s.label} <span class="ai-hero-cat-count">${s.count}</span></a>`).join('')}
          </div>
        </div>
        <div class="ai-hero-meta">
          <span>${dateText} · 共 ${r.total} 条 · ${esc(r.attribution.name || 'AI HOT')}</span>
          <button class="ai-hero-refresh" onclick="AIDaily.fetchReport(true)">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
            刷新
          </button>
        </div>
      </div>`;

    // 主体区域
    html += `<div class="ai-body">`;
    r.sections.forEach(s => {
      if (s.items.length === 0) return;
      html += `
        <div class="ai-section" id="${s.anchor}">
          <h2 class="ai-section-title">${s.icon} ${s.label} <span class="ai-section-count">${s.count} 条</span></h2>
          <div class="ai-cards">`;
      s.items.forEach(item => {
        const link = item.linkAihot || item.linkOriginal || '#';
        const impact = item.summary;
        html += `
            <a class="ai-card" href="${esc(link)}" target="_blank" rel="noopener noreferrer">
              <div class="ai-card-header">
                <span class="ai-card-tag">${item.idx}</span>
                <div class="ai-card-title">${esc(item.title)}</div>
              </div>
              <div class="ai-card-source-line">来源：${esc(item.source)}</div>
              <div class="ai-card-impact">
                <div class="ai-card-impact-label">📈 资讯潜在市场影响</div>
                <div class="ai-card-impact-body">${esc(impact)}</div>
              </div>
            </a>`;
      });
      html += `</div></div>`;
    });
    html += `</div>`;

    // 底部
    html += `
      <div class="ai-footer">
        <div class="ai-footer-info">共 <b>${r.total}</b> 条资讯</div>
        <div class="ai-footer-source">数据来源：<a href="${esc(r.attribution.url || 'https://aihot.virxact.com')}" target="_blank" rel="noopener noreferrer">${esc(r.attribution.name || 'AI HOT')}</a></div>
      </div>`;

    content.innerHTML = html;

    // 滚动到顶部
    content.scrollTop = 0;
    window.scrollTo({ top: 0, behavior: 'smooth' });

    // 异步加载市场影响分析数据
    this.loadImpactData(r.date);
  },

  async loadImpactData(dateStr) {
    try {
      const resp = await fetch(apiUrl(`/api/ai-impact?date=${encodeURIComponent(dateStr)}`));
      if (!resp.ok) return; // 暂无分析数据，保持 summary 兜底
      const impactData = await resp.json();
      if (!impactData.items || !impactData.items.length) return;

      // 构建 idx → impact 映射
      const impactMap = {};
      impactData.items.forEach(item => { impactMap[item.idx] = item.impact; });

      // 更新 DOM：逐个替换 .ai-card-impact-body 内容
      document.querySelectorAll('.ai-card').forEach(card => {
        const tag = card.querySelector('.ai-card-tag');
        if (!tag) return;
        const idx = parseInt(tag.textContent, 10);
        const impact = impactMap[idx];
        if (impact) {
          const body = card.querySelector('.ai-card-impact-body');
          if (body) body.textContent = impact;
        }
      });
    } catch (e) {
      console.warn('加载市场影响分析失败:', e.message);
    }
  },

  formatDateText(dateStr, generatedAt) {
    try {
      const d = new Date(dateStr + 'T08:00:00+08:00');
      const y = d.getFullYear();
      const m = d.getMonth() + 1;
      const day = d.getDate();
      const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
      const wd = weekdays[d.getDay()];

      // 判断是否为"今天"或"昨天"
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const target = new Date(dateStr + 'T00:00:00+08:00');
      const diffDays = Math.round((today - target) / 86400000);

      let prefix = '';
      if (diffDays === 0) prefix = '今天 ';
      else if (diffDays === 1) prefix = '昨天 ';
      else if (diffDays === 2) prefix = '前天 ';

      // 生成时间（北京时间）
      let genTime = '';
      if (generatedAt) {
        const gen = new Date(generatedAt);
        genTime = ` · 生成于 ${String(gen.getHours()).padStart(2, '0')}:${String(gen.getMinutes()).padStart(2, '0')}`;
      }

      return `${prefix}${y}年${m}月${day}日 ${wd}${genTime}`;
    } catch (e) {
      return dateStr || '';
    }
  }
};

window.AIDaily = AIDaily;
