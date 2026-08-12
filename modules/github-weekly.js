// modules/github-weekly.js - GitHub 周榜：全品类 + AI 高亮，中文一句话摘要，一键消化进认知模块
// 数据来自本机 server.py /api/github-weekly（后端代理 GitHub Search API + DeepSeek 批量中文摘要）

const GitHubWeekly = {
  filter: 'all',          // 'all' | 'ai'
  data: null,
  digested: null,         // 已消化过的 repo name 集合（跨周去重）

  async render() {
    const content = document.getElementById('content');
    content.innerHTML = `
      <div class="gh-head">
        <div class="gh-sub">每周一自动更新 · 全品类 · AI 相关已高亮</div>
        <div class="gh-toolbar">
          <div class="seg">
            <button class="seg-btn ${this.filter === 'all' ? 'on' : ''}" onclick="GitHubWeekly.setFilter('all')" data-f="all">全品类</button>
            <button class="seg-btn ${this.filter === 'ai' ? 'on' : ''}" onclick="GitHubWeekly.setFilter('ai')" data-f="ai">仅 AI</button>
          </div>
          <button class="gh-refresh" onclick="GitHubWeekly.refresh()" title="强制刷新本周数据">↻</button>
        </div>
      </div>
      <div id="gh_body">
        <div class="gh-loading">⏳ 正在拉取本周 GitHub 热门…（首次约需几秒，需本机 server.py 运行中）</div>
      </div>`;
    this.load();
  },

  setFilter(f) {
    this.filter = f;
    // 切换按钮激活态
    document.querySelectorAll('.seg-btn[data-f]').forEach(b => {
      b.classList.toggle('on', b.getAttribute('data-f') === f);
    });
    if (this.data) this.paint(this.data);
    else this.render();
  },

  async refresh() {
    const body = document.getElementById('gh_body');
    body.innerHTML = `<div class="gh-loading">🔄 正在强制刷新本周数据…</div>`;
    this.load(true);
  },

  async load(force) {
    const body = document.getElementById('gh_body');
    try {
      const resp = await fetch(apiUrl('/api/github-weekly' + (force ? '?force=1' : '')));
      const j = await resp.json();
      if (!resp.ok) throw new Error(j.error || '请求失败');
      if (j.error && !j.items) throw new Error(j.error);
      this.data = j;
      // ④ 跨周去重：读认知模块已消化的 github-weekly 来源
      try {
        const notes = await window.DB.getAll('learn_notes');
        this.digested = new Set(
          (notes || []).filter(n => n.source === 'github-weekly').map(n => n.title)
        );
      } catch (e) { this.digested = new Set(); }
      this.paint(j);
    } catch (e) {
      body.innerHTML = `
        <div class="gh-error">
          ⚠️ 无法获取周榜：${esc(e.message)}
          <div class="gh-hint">周榜需要本机 server.py 运行中，并在「设置」里配置后端地址。双击「启动工作台.bat」即可。</div>
        </div>`;
    }
  },

  paint(j) {
    const all = j.items || [];
    if (!all.length) {
      document.getElementById('gh_body').innerHTML =
        `<div class="gh-error">${esc(j.error || '本周暂无可展示的仓库')}</div>`;
      return;
    }
    // ③ 统计随筛选变化
    const list = this.filter === 'ai' ? all.filter(i => i.domain === 'AI') : all;
    const total = list.length;
    const aiCnt = list.filter(i => i.domain === 'AI').length;
    const aiPct = all.length ? Math.round(aiCnt / all.length * 100) : 0;
    const starsTotal = list.reduce((a, b) => a + (b.stars || 0), 0);

    const stat = `
      <div class="gh-stats">
        <div class="gh-stat"><div class="n">${total}</div><div class="l">本周收录</div></div>
        <div class="gh-stat"><div class="n">${aiPct}%</div><div class="l">AI 占比</div></div>
        <div class="gh-stat"><div class="n">${fmtStars(starsTotal)}</div><div class="l">总 Star</div></div>
        <div class="gh-stat"><div class="n">${esc(j.week || '')}</div><div class="l">周期</div></div>
      </div>`;
    const cards = list.map(it => this.card(it)).join('');
    document.getElementById('gh_body').innerHTML = stat + cards;
  },

  card(it) {
    const isAI = it.domain === 'AI';
    const tagClass = isAI ? 'tag-ai'
      : (it.domain === '学习' ? 'tag-learn' : (it.domain === '工具' ? 'tag-tool' : 'tag-gray'));
    const langDot = (it.language && LANG_COLOR[it.language]) ? LANG_COLOR[it.language] : '#bbb';
    const zh = it.zh || it.description || '';
    // ④ 已消化过 → 自动灰显
    const isDig = this.digested && this.digested.has(it.name);
    const digestBtn = isDig
      ? `<span class="gh-digested">已消化</span>`
      : `<button class="btn gh-digest" onclick="GitHubWeekly.digest('${esc(it.name)}')">消化到认知</button>`;
    return `
      <div class="gh-card ${isAI ? 'ai' : ''} ${it.rank === 1 ? 'top' : ''}">
        <div class="gh-body">
          <div class="gh-repo">
            <div class="gh-rank">${it.rank}</div>
            <a class="gh-name" href="${esc(it.url)}" target="_blank" rel="noopener">${esc(it.name)}</a>
            <span class="tag ${tagClass}">${esc(it.domain)}</span>
            <span class="gh-digest-wrap gh-digest-wrap-desktop">${digestBtn}</span>
          </div>
          <div class="gh-zh">${esc(zh)}</div>
          <div class="gh-meta">
            <span class="gh-star">★ ${fmtStars(it.stars || 0)}</span>
            ${it.language ? `<span class="gh-lang"><span class="dot" style="background:${langDot}"></span>${esc(it.language)}</span>` : ''}
            <span class="gh-digest-wrap gh-digest-wrap-mobile">${digestBtn}</span>
          </div>
        </div>
      </div>`;
  },

  async digest(name) {
    if (!this.data) return;
    const it = this.data.items.find(i => i.name === name);
    if (!it) return;
    // 找到当前点击的按钮，立即显示加载态
    const cardBtns = Array.from(document.querySelectorAll('.gh-digest'))
      .filter(b => b.getAttribute('onclick') && b.getAttribute('onclick').includes(name));
    const btn = cardBtns[0];
    if (btn) {
      btn.disabled = true;
      btn.textContent = '提炼中…';
      btn.style.opacity = '0.6';
    }
    try {
      // 调后端 DeepSeek 结构化提炼
      const resp = await fetch(apiUrl('/api/digest-github'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: it.name,
          url: it.url,
          description: it.description || '',
          zh: it.zh || '',
        })
      });
      const j = await resp.json();
      if (!j.ok) throw new Error(j.error || '提炼失败');
      const note = j.note || (it.zh || it.description || '');
      const tags = (it.domain === 'AI' ? ['AI', '科技'] : ['科技']).concat('github-weekly');
      const now = Date.now();
      await window.DB.add('learn_notes', {
        url: it.url,
        title: it.name,
        note: note,
        tags: tags,
        source: 'github-weekly',
        status: 'done',
        createdAt: now,
        updatedAt: now
      });
      if (this.digested) this.digested.add(name);
      if (window.DB.syncNow) {
        try { await window.DB.syncNow(); } catch (e) {}
      }
      if (window.toast) window.toast('已提炼并写入认知模块，正在跳转…');
      else alert('已提炼并写入认知模块');
      setTimeout(() => { if (window.navigateTo) window.navigateTo('learn'); }, 600);
      // 标记该卡按钮为已消化（替换为灰色标签）
      cardBtns.forEach(b => {
        const span = document.createElement('span');
        span.className = 'gh-digested';
        span.textContent = '已消化';
        b.replaceWith(span);
      });
    } catch (e) {
      // 失败时恢复按钮
      cardBtns.forEach(b => {
        b.disabled = false;
        b.textContent = '消化到认知';
        b.style.opacity = '1';
      });
      if (window.toast) window.toast('提炼失败：' + e.message);
      else alert('提炼失败：' + e.message);
    }
  }
};

// ===== 局部工具 =====
function fmtStars(n) {
  n = n || 0;
  if (n >= 1000) return (n / 1000).toFixed(1) + 'k';
  return String(n);
}
const LANG_COLOR = {
  Python: '#3572A5', JavaScript: '#f1e05a', TypeScript: '#2b7489', Go: '#00ADD8',
  Rust: '#dea584', Java: '#b07219', 'C++': '#f34b7d', C: '#555555', Ruby: '#701516',
  PHP: '#4F5D95', Swift: '#F05138', Kotlin: '#A97BFF', Shell: '#89e051',
  'Jupyter Notebook': '#DA5B0B', HTML: '#e34c26', CSS: '#563d7c', Vue: '#41b883'
};

window.GitHubWeekly = GitHubWeekly;
