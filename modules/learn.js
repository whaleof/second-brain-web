// modules/learn.js - 认知：把在网上看到的知识（抖音/网页）存成带领域标签的素材书签
// MVP：粘贴链接 + 标题 + 可选笔记 + 多选区领域标签；v2 再接「一键 AI 分析」提炼观点
// 数据：learn_notes（自动参与既有局域网同步 / 磁盘备份 / 导出导入）

const Learn = {
  filter: 'all',                  // 'all' 或某个领域标签
  statusFilter: 'all',            // 'all' | 'pending'(待消化) | 'done'(已消化)
  recallQuery: '',                // 已提交的语义回忆查询（非空即进入召回模式）
  recallLoading: false,
  recallResults: null,            // [{n, score}]（score 仅语义模式有）
  recallTerms: [],                // 高亮词（查询去掉停用词后）
  expandedIds: new Set(),         // 当前展开的认知卡 ID，render() 后仍保持展开

  // 领域标签（对应你想沉淀的方向：挣钱/理财/法律/自媒体/科技/地缘…）
  TAGS: [
    '挣钱', '理财', '法律', '自媒体', '科技', 'AI', '职场',
    '地缘', '股市', '经济', '商业', '新闻', '油价汇价'
  ],

  // 标签配色（循环复用现有 .tag 色板）
  TAG_COLORS: ['', 'tag-mint', 'tag-yellow', 'tag-blue', 'tag-gray'],

  tagColor(tag) {
    const i = this.TAGS.indexOf(tag);
    return this.TAG_COLORS[(i < 0 ? 0 : i) % this.TAG_COLORS.length];
  },

  // 把旧格式「由今日碰撞生成（主题）：标题A ⇄ 标题B。洞察...」
  // 整理成新三段式「【碰撞主题】...\n【连接笔记】...\n【碰撞洞察】...」
  // 只在进入认知模块时自动跑一次，已新格式/非碰撞来源自动跳过。
  _collisionMigrated: false,
  async migrateCollisionNotes(all) {
    if (this._collisionMigrated) return;
    this._collisionMigrated = true;
    let changedCount = 0;
    for (const n of all) {
      if (n.source !== 'collision') continue;
      const text = String(n.note || '');
      if (!text || text.startsWith('【碰撞主题】')) continue;
      const m = text.match(/^由今日碰撞生成（([^）]+)）：(.+)$/s);
      if (!m) continue;
      const theme = m[1];
      const body = m[2];
      // 优先从 title 解析两条连接笔记（title 是完整标题，note 可能被截短）
      const titleMatch = String(n.title || '').match(/碰撞灵感：[^—]+ — (.+)\s*⇄\s*(.+)$/);
      let titleA = '', titleB = '';
      if (titleMatch) {
        titleA = titleMatch[1].replace(/…$/, '').trim();
        titleB = titleMatch[2].replace(/…$/, '').trim();
      }
      // 兜底：从正文里按 ⇄ 拆
      if (!titleA || !titleB) {
        const split = body.split('⇄');
        if (split.length >= 2) {
          titleA = split[0].trim();
          const right = split.slice(1).join('⇄').trim();
          const dotIdx = right.search(/。/);
          if (dotIdx > 0) {
            titleB = right.slice(0, dotIdx).trim();
          } else {
            titleB = right;
          }
        }
      }
      // 洞察 = 去掉标题A和标题B后的剩余部分
      let insight = body;
      if (titleA && titleB) {
        const prefix = titleA + ' ⇄ ' + titleB;
        const idx = body.indexOf(prefix);
        if (idx >= 0) {
          insight = body.slice(idx + prefix.length).replace(/^[。：\s]+/, '');
        }
      }
      n.note = '【碰撞主题】' + theme +
               '\n【连接笔记】' + (titleA || '笔记 A') + ' ⇄ ' + (titleB || '笔记 B') +
               '\n【碰撞洞察】' + (insight || body);
      n.updatedAt = Date.now();
      try {
        await window.DB.put('learn_notes', n);
        changedCount++;
      } catch (e) { console.error('整理旧碰撞笔记失败：', e); }
    }
    if (changedCount > 0) {
      this.toast('已整理 ' + changedCount + ' 条旧碰撞笔记的格式');
    }
  },

  // ===== 主渲染 =====

  async render() {
    const content = document.getElementById('content');

    // 召回模式：框里有字 → 纯语义排序结果，不叠加标签/状态筛选
    if ((this.recallQuery || '').trim()) {
      content.innerHTML = this.renderRecallBox() + this.renderRecallResults();
      return;
    }

    // 浏览模式：标签 + 状态筛选（保持原习惯，想按标签翻就清空框）
    const all = await window.DB.getAll('learn_notes');
    all.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));

    // 先把旧格式「由今日碰撞生成...」统一整理成新三段式，再显示
    await this.migrateCollisionNotes(all);

    // [A方案·2026-08-09] 今日碰撞入口已隐藏：不再每日自动计算碰撞对。
    // 保留 computeCollisions / _coreView / _collisionConnect 等底层零件，
    // 未来做「消化后即时推荐」可直接复用，无需重写。
    this.collisionPairs = []; // 禁用自动生成；如需恢复改为 await this.getCollisionPairs(all)
    const mergedSet = this._buildMergedSet(all);
    const ignoredSet = this._ignoredPairs();
    for (const p of this.collisionPairs || []) {
      const key = this._pairKey(p.gidA, p.gidB);
      p.merged = mergedSet.has(key);
      p.ignored = ignoredSet.has(key);
    }

    // 状态筛选（待消化 / 已消化）
    const statusFiltered = this.statusFilter === 'all'
      ? all
      : all.filter(n => (n.status || 'done') === this.statusFilter);
    // 标签筛选
    const filtered = this.filter === 'all'
      ? statusFiltered
      : statusFiltered.filter(n => Array.isArray(n.tags) && n.tags.includes(this.filter));

    content.innerHTML = `
      ${this.renderRecallBox()}
      ${'' /* [A方案·2026-08-09] 隐藏「今日碰撞」入口：前端不再渲染碰撞卡片带，底层零件保留 */}
      ${this.renderStatusBar(all)}
      ${this.renderFilter(all)}
      ${this.renderDigestSummary(statusFiltered)}
      ${filtered.length ? this.renderList(filtered) : this.renderEmpty()}
    `;
  },

  // ===== 对话式回忆 UI =====

  renderRecallBox() {
    const val = (this.recallQuery || '');
    const collapsed = localStorage.getItem('sb_recall_collapsed') === '1';
    const caret = collapsed ? '▸' : '▾';
    return (
      '<div class="recall-card">' +
        '<div class="recall-head recall-head-toggle" onclick="Learn.toggleRecallBox()">' +
          '<div class="recall-head-text">' +
            '<div class="recall-title">对话式回忆</div>' +
          '</div>' +
          '<span class="recall-caret">' + caret + '</span>' +
        '</div>' +
        '<div class="recall-body" id="recall_body" style="' + (collapsed ? 'display:none' : '') + '">' +
          '<div class="recall-input-row">' +
            '<input class="input recall-input" id="recall_input" placeholder="只记得一星半点？用大白话说，比如：上次那个讲注意力税的视频说啥来着" ' +
              'value="' + esc(val) + '" onkeydown="if(event.key===\'Enter\')Learn.submitRecall()">' +
            '<button class="btn btn-primary" onclick="Learn.submitRecall()">回忆</button>' +
          '</div>' +
        '</div>' +
      '</div>'
    );
  },

  toggleRecallBox() {
    const body = document.getElementById('recall_body');
    if (!body) return;
    const willCollapse = body.style.display !== 'none';
    body.style.display = willCollapse ? 'none' : '';
    const caret = document.querySelector('.recall-caret');
    if (caret) caret.textContent = willCollapse ? '▸' : '▾';
    localStorage.setItem('sb_recall_collapsed', willCollapse ? '1' : '0');
  },

  renderRecallResults() {
    if (this.recallLoading) {
      return '<div class="recall-state">⏳ 正在本地检索…（首次加载模型约 20–40 秒，之后离线可用）</div>';
    }
    const results = this.recallResults || [];
    if (!results.length) {
      return '<div class="recall-state">没有匹配的笔记。换个说法试试，或 <a class="link" onclick="Learn.clearRecall()">清空回到浏览</a></div>';
    }
    return (
      '<div class="recall-res-header"><span>召回 ' + results.length + ' 条 · 按相关度排序</span>' +
      '<a class="link" onclick="Learn.clearRecall()">清空回到浏览</a></div>' +
      results.map(r => this.renderCard(r.n, { score: r.score, hl: this.recallTerms })).join('')
    );
  },

  submitRecall() {
    const el = document.getElementById('recall_input');
    const q = ((el && el.value) || '').trim();
    if (!q) return;
    this.runRecall(q);
  },

  recallFromChip(q) {
    const el = document.getElementById('recall_input');
    if (el) el.value = q;
    this.runRecall(q);
  },

  clearRecall() {
    this.recallQuery = '';
    this.recallResults = null;
    this.recallLoading = false;
    this.recallTerms = [];
    this.render();
  },

  async runRecall(query) {
    this.recallQuery = query;
    this.recallTerms = extractHighlightTerms(query);
    this.recallLoading = true;
    this.recallResults = null;
    this.render();
    try {
      const notes = await window.DB.getAll('learn_notes');
      if (!notes.length) {
        this.recallResults = [];
        this.recallLoading = false;
        this.render();
        return;
      }
      const embedder = await getEmbedder();
      if (embedder.type === 'semantic') {
        const emap = await this.ensureEmbeddings(notes, embedder);
        const qvec = await embedText(embedder, this._noteText({ title: query, note: '' }));
        const scored = notes
          .map(n => ({ n, vec: emap.get(n.gid) }))
          .filter(x => x.vec)
          .map(x => ({ n: x.n, score: cosineSimilarity(qvec, x.vec) }))
          .sort((a, b) => b.score - a.score)
          .slice(0, 12);
        this.recallResults = scored;
      } else {
        this.recallResults = keywordRank(notes, query).slice(0, 12);
      }
    } catch (e) {
      console.error('回忆失败：', e);
      try {
        const notes = await window.DB.getAll('learn_notes');
        this.recallResults = keywordRank(notes, query).slice(0, 12);
      } catch (_) { this.recallResults = []; }
    }
    this.recallLoading = false;
    this.render();
  },

  _noteText(n) {
    return [n.title || '', n.note || ''].filter(Boolean).join('\n');
  },

  async ensureEmbeddings(notes, embedder) {
    const cached = await window.DB.getAll('learn_embeddings');
    const cmap = new Map(cached.map(c => [c.gid, c]));
    const map = new Map();
    for (const n of notes) {
      const gid = n.gid;
      if (!gid) continue;
      const c = cmap.get(gid);
      if (c && c.vec && c.updatedAt === n.updatedAt) {
        map.set(gid, c.vec);
      } else {
        const vec = await embedText(embedder, this._noteText(n));
        await window.DB._putRaw('learn_embeddings', { gid, vec, updatedAt: n.updatedAt });
        map.set(gid, vec);
      }
    }
    return map;
  },

  // 从抖音分享文本中提取真实链接：分享文本往往是一大段，结尾才带 https://v.douyin.com/xxx
  extractDigestUrl(text) {
    const t = (text || '').trim();
    if (!t) return '';
    // 优先取完整 https/http 链接（去掉尾部常见标点/空白）
    const m = t.match(/https?:\/\/[^\s，。！？、）+）\]]+/i);
    if (m) return m[0];
    // 退而求其次：抖音短码形如 WmD:/ ... 或 v.douyin.com/xxxxx（无协议）
    const m2 = t.match(/(?:https?:\/\/)?(?:www\.)?v\.douyin\.com\/[^\s，。！？、）+）\]]+/i);
    if (m2) return m2[0].startsWith('http') ? m2[0] : 'https://' + m2[0];
    return '';
  },

  // 按规范化链接在本地笔记里找是否已存在（用于轮询超时后兜底确认笔记已入库）
  async _localNoteByUrl(url) {
    if (!url || !window.DB) return null;
    const norm = (u) => (u || '').trim().replace(/\/+$/, '').split('?')[0].toLowerCase();
    const target = norm(url);
    if (!target) return null;
    try {
      const notes = await window.DB.getAll('learn_notes');
      return notes.find(n => norm(n.url) === target) || null;
    } catch (e) { return null; }
  },

  // 智能消化：输入链接弹窗
  openDigest() {
    showModal({
      title: '智能消化',
      body: `
        <div class="form-group">
          <label class="form-label">视频链接</label>
          <input class="input" id="dg_url" placeholder="在此粘贴抖音「分享→复制链接」的完整地址（https://v.douyin.com/xxx）" oninput="Learn.onDigestUrlInput()">
          <div class="form-hint" id="dg_hint">自动下载视频 → 本地转写中文 → AI 提炼观点，约 30-90 秒。需本机 server.py 运行中。</div>
        </div>
        <div id="dg_progress" style="display:none"></div>
      `,
      footer: `
        <button class="btn btn-secondary" onclick="hideModal()">取消</button>
        <button class="btn btn-primary" id="dg_btn" onclick="Learn.startDigest()" disabled>智能消化</button>
      `
    });
    setTimeout(() => { const el = document.getElementById('dg_url'); if (el) el.focus(); }, 50);
  },

  onDigestUrlInput() {
    const el = document.getElementById('dg_url');
    const btn = document.getElementById('dg_btn');
    if (!el || !btn) return;
    const v = (el.value || '').trim();
    const url = this.extractDigestUrl(v);
    // 只要有内容、或能从分享文本中提取到链接，就启用按钮
    btn.disabled = v.length < 5 && !url;
    // 根据内容类型切换提示
    const hint = document.getElementById('dg_hint');
    if (hint) {
      if (!v) hint.textContent = '自动下载视频 → 本地转写中文 → AI 提炼观点，约 30-90 秒。需本机 server.py 运行中。';
      else if (url && url === v) hint.textContent = '已识别链接，点击「智能消化」开始处理';
      else if (url) hint.textContent = '已从分享文本中提取到链接，点击「智能消化」开始处理';
      else hint.textContent = '⚠️ 未识别到有效链接，请确认粘贴内容包含 https://v.douyin.com/xxx（抖音分享文本结尾一般有）';
    }
  },

  // 统一消化流程：提交 → 轮询（后台模式：关弹窗不中断）→ 同步 → 刷新
  async runDigest(url) {
    // 进度更新：弹窗开着就写进度条，关了就静默跳过
    const prog = (t) => {
      const el = document.getElementById('dg_progress');
      if (el) el.innerHTML = `<div class="learn-digest-prog">${t}</div>`;
    };
    showModal({
      title: '智能消化中',
      body: `<div id="dg_progress"><div class="learn-digest-prog">⏳ 已提交，开始处理…</div></div>`,
      footer: `<button class="btn btn-secondary" onclick="hideModal()">后台运行</button>`
    });
    showDigestBadge('running', '已提交，开始处理…');
    try {
      const resp = await fetch(apiUrl('/api/digest'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ url })
      });
      const j = await resp.json();
      if (!resp.ok || !j.ok) throw new Error(j.error || '启动失败（请确认本机 server.py 已运行并在设置里配置了后端地址）');
      const jobId = j.job_id;
      let done = false;
      let lastResult = null;
      for (let i = 0; i < 100; i++) {       // 最多约 7.5 分钟（转写+分析在弱网/首跑时常超 3 分钟）
        await new Promise(r => setTimeout(r, 4500));
        const s = await fetch(apiUrl(`/api/digest/status?job_id=${encodeURIComponent(jobId)}`));
        const sj = await s.json();
        if (!sj.ok) throw new Error(sj.error || '状态查询失败');
        if (sj.status === 'done') {
          const res = sj.result || {};
          lastResult = res;
          const who = [res.author ? '@' + res.author : '', res.publishDate || '']
            .filter(Boolean).join(' · ');
          if (res.dup) {
            prog(`⚠️ 已消化过：${esc(res.title || '该作品')}${who ? '（' + esc(who) + '）' : ''}，已跳过重复`);
            showDigestBadge('done', '⚠️ 已消化过，已跳过重复');
          } else {
            prog(`已消化：${esc(res.title || '完成')}`);
            showDigestBadge('done', '已消化：' + esc(res.title || '完成'));
          }
          done = true;
          break;
        } else if (sj.status === 'error') {
          throw new Error(sj.error || '消化失败');
        } else {
          prog('⏳ ' + esc(sj.step || '处理中…'));
          showDigestBadge('running', esc(sj.step || '处理中…'));
        }
      }
      if (!done) {
        // 前端轮询上限到了，但后端可能仍在跑、笔记可能已经写进 master.json。
        // 主动同步一次：若笔记已入库就当成成功，避免用户以为失败而反复粘贴。
        if (window.DB && window.DB.syncNow) {
          try { await window.DB.syncNow(); } catch (e) {}
        }
        const hit = await this._localNoteByUrl(url);
        if (hit) {
          const msg = '笔记已生成，已在「待消化」（本次处理较慢，已自动同步）';
          prog(msg);
          showDigestBadge('done', msg);
          toast(msg);
          await this.render();
          return;
        }
        throw new Error('处理时间较长，后台可能仍在消化；请稍后点「同步」或刷新，去「待消化」查看');
      }
      if (window.DB && window.DB.syncNow) {
        prog('🔄 正在同步到本机…');
        await window.DB.syncNow();
      }
      // 无论弹窗是否开着，都 toast + 刷新列表
      const res2 = lastResult || {};
      const title = res2.dup ? '该作品已消化过，已跳过重复' : '消化完成，已加入「待消化」';
      prog(title);
      try { hideModal(); } catch(e) {}  // 弹窗可能已关，忽略
      showDigestBadge('done', title);
      toast(title);
      await this.render();
    } catch (e) {
      showDigestBadge('error', '❌ 消化出错：' + e.message);
      const el = document.getElementById('dg_progress');
      if (el) {
        el.innerHTML = `<div class="learn-digest-prog err">❌ ${esc(e.message)}</div>`;
      } else {
        // 弹窗已关，用 toast 报错
        try { hideModal(); } catch(ex) {}
        toast('❌ 消化出错：' + e.message);
      }
    }
  },

  async startDigest() {
    const raw = (document.getElementById('dg_url').value || '').trim();
    if (!raw) return toast('请先粘贴视频链接');
    // 自动从分享文本中提取真实链接（支持整段抖音分享文案）
    const url = this.extractDigestUrl(raw) || raw;
    if (url.length < 5) return toast('内容太短，请粘贴完整的抖音分享链接');
    // 若成功从长文本提取出链接，回填输入框，让用户看到实际提交的是什么
    if (url !== raw) {
      const el = document.getElementById('dg_url');
      if (el) el.value = url;
    }
    await this.runDigest(url);
  },

  // === 批量智能消化：多行输入，逐个提取链接并消化 ===
  openBatchDigest() {
    showModal({
      title: '智能消化',
      body: `
        <p class="modal-tip">每行粘贴一个抖音分享链接或分享文案（可多行）。</p>
        <textarea class="textarea" id="dg_batch" rows="7" placeholder="https://v.douyin.com/xxx/&#10;9.74 WmD:/ ... 复制此链接，打开Dou音搜索...&#10;https://v.douyin.com/yyy/"></textarea>
        <div id="dg_batch_hint" class="learn-digest-hint"></div>`,
      footer: `<button class="btn btn-primary" onclick="Learn.startBatchDigest()">智能消化</button>
               <button class="btn btn-secondary" onclick="hideModal()">关闭</button>`
    });
    setTimeout(() => { const el = document.getElementById('dg_batch'); if (el) el.focus(); }, 50);
  },

  startBatchDigest() {
    const raw = (document.getElementById('dg_batch') || {}).value || '';
    if (!raw.trim()) return toast('请先粘贴链接');
    hideModal();
    this.runBatchDigest(raw);
  },

  // 批量：提取所有链接 → 滑动窗口并发（上限 3）→ 浮标汇总进度
  async runBatchDigest(raw) {
    const lines = raw.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
    const urls = [];
    for (const line of lines) {
      const u = this.extractDigestUrl(line);
      if (u) urls.push(u);
    }
    if (!urls.length) { toast('未识别到任何有效链接'); return; }
    const uniq = [...new Set(urls)];
    const total = uniq.length;
    const jobs = uniq.map(u => ({ url: u, status: 'pending' }));
    const CONC = 3;            // 最多并行 3 条，避免压垮本机
    let idx = 0, active = 0, finished = 0;
    showDigestBadge('running', `智能消化：共 ${total} 条，最多并行 ${CONC} 条…`);

    const pollOne = async (job) => {
      while (job.status === 'running') {
        await new Promise(r => setTimeout(r, 4500));
        try {
          const s = await fetch(apiUrl(`/api/digest/status?job_id=${encodeURIComponent(job.jobId)}`));
          const sj = await s.json();
          if (sj.status === 'done') { job.status = 'done'; job.result = sj.result || {}; finished++; }
          else if (sj.status === 'error') { job.status = 'error'; job.error = sj.error || '消化失败'; finished++; }
        } catch (e) {
          job.status = 'error'; job.error = e.message; finished++;
        }
      }
    };

    const submitOne = async (job) => {
      try {
        const resp = await fetch(apiUrl('/api/digest'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ url: job.url })
        });
        const j = await resp.json();
        if (j.ok && j.job_id) { job.jobId = j.job_id; job.status = 'running'; }
        else { job.status = 'error'; job.error = j.error || '启动失败'; finished++; }
      } catch (e) { job.status = 'error'; job.error = e.message; finished++; }
      await pollOne(job);
    };

    while (finished < total || active > 0) {
      while (active < CONC && idx < total) {
        const job = jobs[idx++];
        job.status = 'submitting';
        active++;
        submitOne(job).finally(() => { active--; });
      }
      await new Promise(r => setTimeout(r, 4500));
      const done = jobs.filter(j => j.status === 'done').length;
      const err = jobs.filter(j => j.status === 'error').length;
      const running = jobs.filter(j => j.status === 'running' || j.status === 'submitting').length;
      showDigestBadge('running', `智能消化中：成功${done} 失败${err} 进行中${running} / 共${total}`);
    }

    const done = jobs.filter(j => j.status === 'done').length;
    const err = jobs.filter(j => j.status === 'error').length;
    if (window.DB && window.DB.syncNow) {
      try { await window.DB.syncNow(); } catch (e) {}
    }
    if (err === 0) showDigestBadge('done', '智能消化完成');
    else showDigestBadge('error', `智能消化结束：成功${done} 失败${err} / 共${total}（失败项请看后端日志）`);
    await this.render();
  },

  renderFilter(all) {
    // 统计各标签数量
    const counts = {};
    all.forEach(n => (n.tags || []).forEach(t => { counts[t] = (counts[t] || 0) + 1; }));
    const chip = (key, label, count) => `
      <button class="filter-chip ${this.filter === key ? 'active' : ''}" onclick="Learn.setFilter('${key}')">
        ${label}${count != null ? ` <span class="fcount">${count}</span>` : ''}
      </button>`;
    const tags = this.TAGS
      .filter(t => counts[t])
      .map(t => chip(t, t, counts[t]))
      .join('');
    return `
      <div class="filter-bar">
        ${chip('all', '全部', all.length)}
        ${tags}
      </div>`;
  },

  // 状态分段：全部 / 待消化 / 已消化（与标签筛选叠加）
  renderStatusBar(all) {
    const cnt = { pending: 0, done: 0 };
    all.forEach(n => { const s = n.status || 'done'; cnt[s] = (cnt[s] || 0) + 1; });
    const tab = (key, label, count) => `
      <button class="learn-status-tab ${this.statusFilter === key ? 'active' : ''}" onclick="Learn.setStatusFilter('${key}')">
        ${label}${count != null ? ` <span class="fcount">${count}</span>` : ''}
      </button>`;
    return `
      <div class="learn-status-bar">
        ${tab('all', '全部')}
        ${tab('pending', '待消化', cnt.pending)}
        ${tab('done', '已消化', cnt.done)}
      </div>`;
  },

  setStatusFilter(key) {
    this.statusFilter = key;
    this.render();
  },

  // 每日消化视图：在「待消化」视角下逼清积压
  renderDigestSummary(statusFiltered) {
    if (this.statusFilter !== 'pending') return '';
    const total = statusFiltered.length;
    if (!total) return `<div class="learn-digest-summary ok">🎉 待消化已清空，今天没有积压</div>`;
    const todayStart = new Date(); todayStart.setHours(0, 0, 0, 0);
    const today = statusFiltered.filter(n => (n.createdAt || 0) >= todayStart.getTime()).length;
    return `<div class="learn-digest-summary">
      待消化 <b>${total}</b> 条 · 今日新增 <b>${today}</b> 条 —— 消化完它们才算清积压
    </div>`;
  },

  renderEmpty() {
    return `
      <div class="empty">
        <div class="empty-icon">📚</div>
        <div class="empty-text">还没有认知素材<br>点右下角 + 粘贴一个抖音/网页链接开始积累</div>
      </div>`;
  },

  renderList(items) {
    return items.map(n => this.renderCard(n)).join('');
  },

  renderCard(n, opts = {}) {
    const simBadge = (opts && opts.score != null)
      ? '<span class="ln-sim">相似度 ' + Math.round((opts.score || 0) * 100) + '%</span>'
      : '';
    const titleHtml = n.url
      ? `<a class="learn-title" href="${esc(n.url)}" target="_blank" rel="noopener">${esc(n.title || n.url)}</a>`
      : `<div class="learn-title">${esc(n.title || '(无标题)')}</div>`;

    const tags = (n.tags || []).map(t =>
      `<span class="tag ${this.tagColor(t)}">${esc(t)}</span>`).join('');

    // 来源标签：只显示非抖音的（抖音是默认来源，每个都显示没意义）
    const srcBadge = (n.source === 'douyin') ? ''
      : (n.url ? `<span class="learn-src">链接</span>` : '');

    const authorHtml = n.author
      ? `<span class="learn-author">@${esc(n.author)}</span>` : '';

    const isPending = (n.status || 'done') === 'pending';
    const statusBadge = isPending
      ? `<span class="learn-status pending">待消化</span>`
      : `<span class="learn-status done">已消化</span>`;

    const markBtn = isPending
      ? `<button class="list-item-action" title="标记已消化" onclick="Learn.setStatus(${n.id}, 'done')">✓</button>`
      : `<button class="list-item-action" title="退回待消化" onclick="Learn.setStatus(${n.id}, 'pending')">↺</button>`;

    const hasStructured = n.note && /^(核心问题|主线|核心观点|结论|适用场景|行动建议|作者在干嘛|关联工作台)/.test(n.note);
    const collapsible = hasStructured || (n.source === 'collision');
    const expandId = 'lnexp_' + (n.id || Math.random().toString(36).slice(2,8));
    const isExpanded = n.id != null && this.expandedIds.has(n.id);

    return `
      <div class="card learn-card">
        <div class="learn-card-head">
          <div class="learn-title-row">
            ${collapsible
              ? `<button class="ln-toggle" onclick="event.stopPropagation();Learn.toggleExpand('${expandId}',this)" title="${isExpanded ? '收起详情' : '展开详情'}">${isExpanded ? '▼' : '▶'}</button>`
              : ''}
            ${titleHtml}
            ${authorHtml}
          </div>
        </div>
        ${tags ? `<div class="learn-tags">${tags}</div>` : ''}
        ${n.note ? `<div id="${expandId}" class="ln-collapsible ${collapsible && !isExpanded ? '' : 'ln-open'}" style="text-indent:0!important;padding-left:0!important;margin-left:0!important;">${this.renderNote(n.note, opts && opts.hl)}</div>` : ''}
        <div class="learn-meta">
          ${simBadge}
          ${srcBadge}
          ${statusBadge}
          <span class="learn-time">${relativeTime(n.createdAt)}</span>
          <div class="learn-actions">
            ${markBtn}
            <button class="list-item-action" title="编辑" onclick="Learn.openEdit(${n.id})">✎</button>
            <button class="list-item-action" title="删除" onclick="Learn.del(${n.id})">🗑</button>
          </div>
        </div>
      </div>`;
  },

  // 把引擎产出的结构化 note（核心观点/结论/适用场景/行动建议）渲染成带分块的小结；
  // 手动纯文本笔记原样分段显示。先转义再套格式，避免 XSS。
  // 统一去除所有段落开头的空白（含全角空格/不间断空格等 Unicode 空白），保持视觉整齐。
  // 用 inline style 彻底封死缩进，不依赖外部 CSS（避免缓存/选择器/优先级问题）
  renderNote(note, hlTerms) {
    const SECTIONS = ['核心问题', '主线', '核心观点', '结论', '适用场景', '行动建议'];
    // 预处理：把常见 markdown 语法转成纯文本，保留【】子标题标记
    // 注意：保留 1. 2. 3. 数字编号，前端会渲染成 <ol> 有序列表
    let rawNote = String(note)
      .replace(/^#{1,6}\s*/gm, '')           // 去掉 ### ## # 标题标记
      .replace(/\*\*(.+?)\*\*/g, '$1')       // 去掉 **加粗**
      .replace(/\*(.+?)\*/g, '$1')            // 去掉 *斜体*
      .replace(/`(.+?)`/g, '$1')             // 去掉 `行内代码`
      .replace(/^\s*[-*]\s+/gm, '· ')        // - 列表项 → · 列表项（保留无序列表）
      .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1') // [text](url) → text
      .trim();
    const lines = rawNote.split('\n');
    let html = '';
    let inList = false;      // 无序列表 <ul>
    let inOrdered = false;   // 有序列表 <ol>
    const closeList = () => {
      if (inList) { html += '</ul>'; inList = false; }
      if (inOrdered) { html += '</ol>'; inOrdered = false; }
    };
    // 暴力去白：首尾所有 Unicode 空白类字符全部清除
    const clean = s => s
      .replace(/^[\s\S]*?(\S[\s\S]*)$/, '$1')   // 去掉开头所有非打印/空白
      .replace(/^[\s\u00a0\u3000\u2000-\u200a\u202f\u205f\ufeff\t\r\n]+/g, '')
      .trim();
    // 内联样式：强制无首行缩进；列表容器保留 padding-left 以便显示编号
    const IS = ' style="text-indent:0!important;padding-left:0!important;margin-left:0!important;"';
    const LIS = ' style="text-indent:0!important;"';
    // 识别【子标题】模式（在段落开头）—— 分级着色避免满屏红字
    const SUB_LABEL_RE = /^【(.+?)】\s*/;
    // 一级（红）：全文最关键的 takeaway
    const LABEL_TIER1 = ['核心观点', '结论'];
    // 二级（深色粗体）：重要结构标签
    const LABEL_TIER2 = ['核心价值', '技术创新点', '潜在局限', '适用场景', '行动建议', '研究价值',
      '最佳场景', '不适用场景', '碰撞主题', '连接笔记', '碰撞洞察'];
    for (const raw of lines) {
      const trimmed = clean(raw);
      if (!trimmed || trimmed.length === 0) { closeList(); continue; }
      if (SECTIONS.includes(trimmed)) {
        closeList();
        const first = trimmed[0];
        const rest = trimmed.slice(1);
        html += `<div class="ln-section"${IS}><span class="ln-sec-mark">${esc(first)}</span>${hlText(esc(rest), hlTerms)}</div>`;
      } else if (/^(作者在干嘛|关联工作台)[：:]/.test(trimmed)) {
        // 两行格式：「作者在干嘛：xxx」/「关联工作台：xxx」→ label 单独标红
        closeList();
        const m = trimmed.match(/^(作者在干嘛|关联工作台)([：:])(.*)$/);
        if (m) {
          const [, label, sep, content] = m;
          html += `<div class="ln-para"${IS}><span class="ln-sub-label">${esc(label)}</span>${esc(sep)}${content ? hlText(esc(content.trim()), hlTerms) : ''}</div>`;
        } else {
          html += `<div class="ln-para"${IS}>${hlText(esc(trimmed), hlTerms)}</div>`;
        }
      } else if (SUB_LABEL_RE.test(trimmed)) {
        // 【子标题】→ 按级别分样式
        closeList();
        const label = trimmed.match(SUB_LABEL_RE)[1];
        const content = trimmed.replace(SUB_LABEL_RE, '');
        const tier = LABEL_TIER1.includes(label) ? '' : (LABEL_TIER2.includes(label) ? '-2' : '-3');
        html += `<div class="ln-para"${IS}><span class="ln-sub-label${tier}">${esc(label)}</span>${content ? hlText(esc(content), hlTerms) : ''}</div>`;
      } else if (/^[·•\-]\s/.test(trimmed)) {
        if (inOrdered) { html += '</ol>'; inOrdered = false; }
        if (!inList) { html += `<ul class="ln-list"${LIS}>`; inList = true; }
        html += `<li${IS}>${hlText(esc(clean(trimmed.replace(/^[·•\-]\s/, ''))), hlTerms)}</li>`;
      } else if (/^\d+\.\s/.test(trimmed)) {
        if (inList) { html += '</ul>'; inList = false; }
        if (!inOrdered) { html += `<ol class="ln-list ln-ordered"${LIS}>`; inOrdered = true; }
        html += `<li${IS}>${hlText(esc(clean(trimmed.replace(/^\d+\.\s/, ''))), hlTerms)}</li>`;
      } else {
        closeList();
        html += `<div class="ln-para"${IS}>${hlText(esc(trimmed), hlTerms)}</div>`;
      }
    }
    closeList();
    return html;
  },

  // ===== 筛选 =====

  setFilter(key) {
    this.filter = key;
    this.render();
  },

  // ===== 编辑（新增统一走顶部「粘贴视频链接，一键智能消化」，不再有手动 + 添加 弹窗） =====

  openEdit(id) {
    (async () => {
      const n = await window.DB.get('learn_notes', id);
      if (n) this.openEditor(n);
    })();
  },

  openEditor(note) {
    const isEdit = !!note;
    const tags = note ? (note.tags || []) : [];
    const tagChips = this.TAGS.map(t => `
      <button type="button" class="learn-tag-chip ${tags.includes(t) ? 'active' : ''}" data-tag="${t}" onclick="Learn.toggleTag(this)">${t}</button>
    `).join('');

    showModal({
      title: isEdit ? '编辑认知素材' : '新增认知素材',
      body: `
        <div class="form-group">
          <label class="form-label">链接（抖音/网页）</label>
          <input class="input" id="ln_url" placeholder="粘贴抖音或网页链接，如 https://v.douyin.com/xxx/" value="${note ? esc(note.url || '') : ''}">
        </div>
        <div class="form-group">
          <label class="form-label">标题 / 这条在讲什么</label>
          <input class="input" id="ln_title" placeholder="视频标题或一句话概括" value="${note ? esc(note.title || '') : ''}">
        </div>
        ${isEdit ? `
        <div class="form-group">
          <label class="form-label">博主名（可选，留空则不显示）</label>
          <input class="input" id="ln_author" placeholder="如：@某某博主（不用加 @）" value="${esc(note.author || '')}">
        </div>` : ''}
        <div class="form-group">
          <label class="form-label">笔记（可选）</label>
          <textarea class="textarea" id="ln_note" placeholder="记几句重点。v2 可一键 AI 分析提炼观点">${note ? esc(note.note || '') : ''}</textarea>
        </div>
        <div class="form-group">
          <label class="form-label">领域标签（可多选）</label>
          <div class="learn-tag-row">${tagChips}</div>
        </div>
      `,
      footer: `
        <button class="btn btn-secondary" onclick="hideModal()">取消</button>
        <button class="btn btn-primary" onclick="Learn.save(${isEdit ? note.id : 'null'})">${isEdit ? '保存' : '保存素材'}</button>
      `
    });
  },

  toggleTag(el) {
    el.classList.toggle('active');
  },

  async save(id) {
    const url = (document.getElementById('ln_url').value || '').trim();
    const title = (document.getElementById('ln_title').value || '').trim();
    const note = (document.getElementById('ln_note').value || '').trim();
    const tags = Array.from(document.querySelectorAll('.learn-tag-chip.active'))
      .map(el => el.dataset.tag);
    const authorEl = document.getElementById('ln_author');
    const author = authorEl ? (authorEl.value || '').trim() : '';

    if (!url && !title) return toast('至少填链接或标题');
    if (!title && url) {
      // 没填标题时，用链接兜底（避免空卡片）
    }

    const source = /douyin|tiktok/i.test(url) ? 'douyin' : 'link';
    const now = Date.now();

    if (id && id !== 'null') {
      const old = await window.DB.get('learn_notes', id);
      await window.DB.put('learn_notes', {
        ...old,
        url, title, note, tags, source, author,
        updatedAt: now
      });
      toast('已更新');
    } else {
      await window.DB.add('learn_notes', {
        url, title, note, tags, source,
        status: 'done',            // 手动保存视为已消化；只有引擎消化出的才是 pending
        createdAt: now,
        updatedAt: now
      });
      toast('已存为认知素材');
    }
    hideModal();
    await this.render();
  },

  async del(id) {
    const ok = await confirmDialog('删除这条认知素材？');
    if (!ok) return;
    const note = await window.DB.get('learn_notes', id);
    await window.DB.delete('learn_notes', id);
    if (note && note.gid) {
      try { await window.DB._addTombstoneIfNewer({ gid: note.gid, storeName: 'learn_notes', deletedAt: Date.now() }); }
      catch (e) { console.warn('tombstone 失败', e); }
    }
    toast('已删除');
    await this.render();
  },

  // 标记已消化 / 退回待消化
  toggleExpand(id, btn) {
    const el = document.getElementById(id);
    if (!el) return;
    const open = el.classList.toggle('ln-open');
    btn.textContent = open ? '▼' : '▶';
    btn.title = open ? '收起详情' : '展开详情';
    // 把展开状态记到内存集合，render() 重新调用后仍保持展开，避免闪回
    const noteId = parseInt(String(id).replace('lnexp_', ''), 10);
    if (!isNaN(noteId)) {
      if (open) this.expandedIds.add(noteId);
      else this.expandedIds.delete(noteId);
    }
  },

  async setStatus(id, status) {
    const n = await window.DB.get('learn_notes', id);
    if (!n) return;
    await window.DB.put('learn_notes', { ...n, status, updatedAt: Date.now() });
    toast(status === 'done' ? '已标记为消化' : '已退回待消化');
    await this.render();
  },

  // ===== 今日碰撞（知识碰撞器）：把旧笔记两两关联，产出灵感 =====
  // 纯前端、离线、无需模型：用「共享标签 + 文本重叠 + 同周消化」打分，取 top 并去重主标签。

  _ignoredPairs() {
    try { return new Set(JSON.parse(localStorage.getItem('sb_collision_ignored') || '[]')); }
    catch (e) { return new Set(); }
  },

  _pairKey(gidA, gidB) {
    return [String(gidA), String(gidB)].sort().join('|');
  },

  _addIgnored(gidA, gidB) {
    const set = this._ignoredPairs();
    set.add(this._pairKey(gidA, gidB));
    try { localStorage.setItem('sb_collision_ignored', JSON.stringify([...set])); } catch (e) {}
  },

  _removeIgnored(gidA, gidB) {
    const set = this._ignoredPairs();
    set.delete(this._pairKey(gidA, gidB));
    try { localStorage.setItem('sb_collision_ignored', JSON.stringify([...set])); } catch (e) {}
  },

  // 已并入的碰撞 pair → 生成的 note gid（用于判断“已并入”是否仍有效）
  _mergedMap() {
    try { return JSON.parse(localStorage.getItem('sb_collision_merged') || '{}'); }
    catch (e) { return {}; }
  },

  _setMerged(gidA, gidB, noteGid) {
    const map = this._mergedMap();
    map[this._pairKey(gidA, gidB)] = noteGid;
    try { localStorage.setItem('sb_collision_merged', JSON.stringify(map)); } catch (e) {}
  },

  _removeMerged(pairKey) {
    const map = this._mergedMap();
    delete map[pairKey];
    try { localStorage.setItem('sb_collision_merged', JSON.stringify(map)); } catch (e) {}
  },

  // 清理已删除的 merged note；并把现存旧 collision note 反推回 merged map，
  // 同时从 ignored 中移除（避免旧数据一直卡死“已并入”）
  _cleanStaleMerged(all) {
    const notes = all || [];
    const noteByGid = new Map(notes.map(n => [n.gid, n]));
    const map = this._mergedMap();
    // 1) 删除 note 已不存在的映射
    for (const key of Object.keys(map)) {
      if (!noteByGid.has(map[key])) delete map[key];
    }

    // 2) 旧数据迁移：从 source==='collision' 的 note 文本中反推 pairKey
    const titleToGid = new Map();
    for (const n of notes) {
      if (!n.title) continue;
      if (!titleToGid.has(n.title)) titleToGid.set(n.title, n.gid);
    }
    for (const n of notes) {
      if (n.source !== 'collision') continue;
      const titles = [...String(n.note || '').matchAll(/《([^》]+?)》/g)].map(m => m[1]).filter(Boolean);
      if (titles.length < 2) continue;
      const gA = titleToGid.get(titles[0]), gB = titleToGid.get(titles[1]);
      if (!gA || !gB) continue;
      const key = this._pairKey(gA, gB);
      map[key] = n.gid;
    }

    // 3) 把已被识别为 merged 的 pair 从 ignored 里放出来，否则删了 note 也会一直“已并入”
    const ignored = this._ignoredPairs();
    let ignoredChanged = false;
    for (const key of Object.keys(map)) {
      if (ignored.has(key)) { ignored.delete(key); ignoredChanged = true; }
    }

    try {
      localStorage.setItem('sb_collision_merged', JSON.stringify(map));
      if (ignoredChanged) localStorage.setItem('sb_collision_ignored', JSON.stringify([...ignored]));
    } catch (e) {}
  },

  _buildMergedSet(all) {
    const notes = all || [];
    const noteByGid = new Map(notes.map(n => [n.gid, n]));
    const map = this._mergedMap();
    const set = new Set();
    for (const [key, gid] of Object.entries(map)) {
      if (noteByGid.has(gid)) set.add(key);
    }
    return set;
  },

  async getCollisionPairs(all) {
    const today = new Date().toISOString().slice(0, 10);
    const cacheKey = 'sb_collision_' + today;
    this._cleanStaleMerged(all);
    const ignored = this._ignoredPairs();
    let pairs = null;
    if (this._forceRegen) {
      this._forceRegen = false;
      pairs = this.computeCollisions(all);
      try { localStorage.setItem(cacheKey, JSON.stringify(pairs)); } catch (e) {}
    } else {
      try {
        const c = localStorage.getItem(cacheKey);
        if (c) pairs = JSON.parse(c);
      } catch (e) { pairs = null; }
      if (!pairs) {
        pairs = this.computeCollisions(all);
        try { localStorage.setItem(cacheKey, JSON.stringify(pairs)); } catch (e) {}
      }
    }
    return (pairs || []);
  },

  computeCollisions(notes) {
    const list = (notes || []).filter(n => n && (n.title || n.note));
    const pairs = [];
    for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i], b = list[j];
        const ta = new Set(a.tags || []), tb = new Set(b.tags || []);
        const shared = [...ta].filter(t => tb.has(t));
        if (shared.length < 1) continue;
        const sim = this._textOverlap(a, b);
        const sameWeek = this._sameWeek(a.createdAt, b.createdAt);
        const score = shared.length * 2 + sim * 1.5 + (sameWeek ? 0.5 : 0);
        const connect = this._collisionConnect(shared, a, b);
        pairs.push({
          gidA: a.gid, gidB: b.gid,
          titleA: a.title || '(无标题)', titleB: b.title || '(无标题)',
          sharedTags: shared,
          connect: connect,
          text: this._collisionText(a, b, shared, connect),
          score
        });
      }
    }
    pairs.sort((x, y) => y.score - x.score);
    const seen = {}; const out = [];
    const seenConnects = new Set();
    for (const p of pairs) {
      const key = p.sharedTags[0] || 'x';
      if ((seen[key] || 0) >= 2) continue;
      // 避免同一「合起来看」结论重复出现（根因：旧逻辑只按标签 fallback，
      // 不同 pair 共享同一标签时会输出完全一样的句子）
      const connectPlain = (p.connect || '').trim();
      if (connectPlain && seenConnects.has(connectPlain)) continue;
      if (connectPlain) seenConnects.add(connectPlain);
      seen[key] = (seen[key] || 0) + 1;
      out.push(p);
      if (out.length >= 5) break;
    }
    return out;
  },

  _tokenize(s) {
    return new Set((s || '').toLowerCase().replace(/[^\w一-鿿]+/g, ' ').split(/\s+/).filter(t => t.length >= 2));
  },

  _textOverlap(a, b) {
    const sa = this._tokenize((a.title || '') + ' ' + (a.note || ''));
    const sb = this._tokenize((b.title || '') + ' ' + (b.note || ''));
    if (!sa.size || !sb.size) return 0;
    let inter = 0; sa.forEach(t => { if (sb.has(t)) inter++; });
    return inter / (sa.size + sb.size - inter || 1);
  },

  _sameWeek(ca, cb) {
    if (!ca || !cb) return false;
    const off = 4 * 86400000;
    return Math.floor((ca - off) / 604800000) === Math.floor((cb - off) / 604800000);
  },

  _summary(n) {
    const t = (n.note || n.title || '').replace(/\n+/g, ' ').trim();
    return t.length > 34 ? t.slice(0, 34) + '…' : t;
  },

  // 今日碰撞卡片标题用的超短摘要（约 14 字，避免两条长标题硬拼换行）
  _mini(text) {
    const t = (text || '').replace(/\n+/g, ' ').trim();
    return t.length > 14 ? t.slice(0, 14) + '…' : t;
  },

  // 把核心观点截成适合塞进「合起来看」里的短句（默认 22 字，避免结论太长）
  _shortCore(text, maxLen = 22) {
    const t = (text || '').replace(/\n+/g, ' ').trim();
    return t.length > maxLen ? t.slice(0, maxLen) + '…' : t;
  },

  // 生成「合起来看」的碰撞结论。不再只按共享标签查静态表，而是把 A/B 两条笔记的
  // 核心观点吃进来，生成只针对这两条内容的具体问题/洞察，避免同一万能句式复读。
  _collisionConnect(shared, a, b) {
    const theme = shared[0] || '这个主题';
    const ca = this._coreView(a);
    const cb = this._coreView(b);
    const sa = this._shortCore(ca);
    const sb = this._shortCore(cb);

    const hasHow = s => /怎么|如何|做法|步骤|建议|方法|技巧|路径|流程|操作|执行/.test(s);
    const hasScene = s => /场景|应用|落地|项目|业务|案例|行业|公司|产品|岗位|工作/.test(s);
    const hasModel = s => /模型|框架|架构|象限|原则|理论|模式|标准|系统/.test(s);
    const hasTrend = s => /趋势|未来|时代|变化|升级|变革|新|演进|方向/.test(s);
    const hasProblem = s => /问题|痛点|难点|瓶颈|卡点|坑|困境|风险|挑战/.test(s);
    const hasPerson = s => /人|用户|客户|普通人|小白|老板|员工|博主|创作者|消费者/.test(s);

    const aHow = hasHow(ca), bHow = hasHow(cb);
    const aScene = hasScene(ca), bScene = hasScene(cb);
    const aModel = hasModel(ca), bModel = hasModel(cb);
    const aTrend = hasTrend(ca), bTrend = hasTrend(cb);
    const aProb = hasProblem(ca), bProb = hasProblem(cb);
    const aPerson = hasPerson(ca), bPerson = hasPerson(cb);

    // 按主题定制，但结论里必须嵌入 A/B 的短核心观点，防止模板化
    const byTheme = {
      'AI': () => `把「${sa}」的能力接进「${sb}」的场景，边界该画在哪？`,
      'agent': () => `按「${sa}」拆解任务，哪些环节可以交给 Agent 按「${sb}」的边界执行？`,
      '工作流': () => `把「${sa}」和「${sb}」拼成一步工作流，先后顺序是什么？`,
      '知识管理': () => `「${sa}」和「${sb}」这两张卡片，该用哪个标签/结构把它们真正连起来？`,
      '调研': () => `用「${sa}」的方法去验证「${sb}」的结论，会缺什么数据？`,
      '周榜': () => `「${sa}」和「${sb}」这两个前沿点，哪个更接近你的下一步动作？`
    };
    if (byTheme[theme]) return byTheme[theme]();

    if (theme === '挣钱' || theme === '自媒体' || theme === '商业') {
      if (aHow && bHow) return `先复制「${sa}」的玩法，再套用「${sb}」的变现逻辑，最小闭环是什么？`;
      if (aPerson && bHow) return `「${sa}」这群人，用「${sb}」的方法能跑通吗？`;
      return `把「${sa}」和「${sb}」串起来，普通人第一步能复制什么？`;
    }

    if (theme === '科技') {
      if (aTrend && bScene) return `技术趋势「${sa}」落到场景「${sb}」里，最大的卡点是什么？`;
      if (aModel && bHow) return `用「${sa}」这套技术方案去做「${sb}」，实施成本会卡在哪？`;
      return `「${sa}」和「${sb}」两个技术点拼在一起，会产生什么新组合？`;
    }

    if (theme === '法律') {
      return `「${sa}」这条规则，对「${sb}」里的行为会怎么判？`;
    }

    if (theme === '经济' || theme === '股市' || theme === '油价汇价') {
      return `「${sa}」这个变量变化时，「${sb}」那边的定价/行为会怎么跟？`;
    }

    if (theme === '地缘') {
      return `「${sa}」与「${sb}」两个地缘变量，会通过哪条线互相放大？`;
    }

    // 内容模式兜底：即使不命中主题，也把 A/B 核心观点织进去，避免万能句
    if (aModel && bScene) return `用「${sa}」这个框架去看「${sb}」这个场景，会多看到什么？`;
    if (aHow && bScene) return `用「${sa}」的方法去落地「${sb}」的场景，第一步该做什么？`;
    if (aScene && bHow) return `「${sa}」这个场景，能不能用「${sb}」的方法跑起来？`;
    if (aHow && bHow) return `「${sa}」和「${sb}」两种做法，哪个更适合你现在的阶段？`;
    if (aProb && bHow) return `「${sa}」这个难题，能不能用「${sb}」的思路解？卡点在哪？`;
    if (aHow && bProb) return `「${sa}」这个方法，放到「${sb}」这个问题里会失效吗？`;
    if (aTrend && bHow) return `在「${sa}」这个趋势下，「${sb}」的方法还成立吗？`;
    if (aTrend && bScene) return `趋势「${sa}」和场景「${sb}」交汇，会诞生什么新需求？`;
    if (aPerson && bTrend) return `「${sa}」这类人在「${sb}」的趋势里，机会/风险是什么？`;

    // 最后兜底：仍嵌入内容，绝不返回“怎么把这两点结合起来”
    return `「${sa}」与「${sb}」都落在「${theme}」里，合起来能回答一个什么具体问题？`;
  },

  _collisionText(a, b, shared, connect) {
    const theme = shared[0] || '这个主题';
    const sA = this._summary(a), sB = this._summary(b);
    return '两条都落在<b>「' + esc(theme) + '」</b>：一条讲「' + esc(sA) + '」，一条讲「' + esc(sB) + '」——合起来看：<b>' + esc(connect) + '</b>。';
  },

  // 从碰撞文本里兜底提取「合起来看」的结论（兼容旧缓存）
  _extractFusion(text) {
    const m = String(text || '').match(/合起来看[：:]\s*(?:<b>)?(.+?)(?:<\/b>)?(?:。|$)/);
    return m ? m[1].trim() : '新的碰撞灵感';
  },

  // 提取单条笔记的「核心观点」；没有则取首句/首段，避免省略号
  _coreView(n) {
    const text = (n.note || n.title || '').replace(/\n+/g, ' ').trim();
    const m = text.match(/(?:【)?核心观点(?:】)?[·:：\s]+([^。\n]{5,120}[。！？]?)/);
    if (m) return m[1].trim();
    const first = text.split(/[。！？]/).filter(s => s.trim())[0] || text;
    return first.length > 120 ? first.slice(0, 120) + '…' : first;
  },

  renderCollisionBand(pairs) {
    if (!pairs || !pairs.length) {
      return '<div class="collision-band collision-empty">💡 今日碰撞：笔记还不够多，先去消化几条，明天这里会自动连出新想法</div>';
    }
    const cards = pairs.map((p, i) => {
      const done = p.merged || p.ignored;
      return `
      <div class="spark ${done ? 'spark-done' : ''}">
        <div class="spark-link">${esc(this._mini(p.titleA))}<span class="mid">⇄</span>${esc(this._mini(p.titleB))}</div>
        <div class="spark-text">${p.text}</div>
        <div class="spark-foot">
          <div class="spark-tags">${p.sharedTags.map(t => '<span class="tag ' + this.tagColor(t) + '">' + esc(t) + '</span>').join('')}</div>
          <div class="spark-acts">
            ${done
              ? `<span class="mini-done">已并入 ✓</span>`
              : `<button class="mini-btn" onclick="Learn.mergeCollision(${i})">并入认知</button>
                 <button class="mini-btn secondary" onclick="Learn.ignoreCollision(${i})">忽略</button>`}
          </div>
        </div>
      </div>`;
    }).join('');
    return `
      <div class="collision-band">
        <div class="collision-head">
          <div>
            <div class="collision-title">💡 今日碰撞</div>
          </div>
          <button class="btn-ghost" title="重新算一遍关联，不会写入认知" onclick="Learn.regenerateCollisions()">重新生成</button>
        </div>
        <div class="carousel">${cards}</div>
      </div>`;
  },

  async paintCollision() {
    const el = document.getElementById('collision_area');
    if (!el) return;
    const all = await window.DB.getAll('learn_notes');
    this._cleanStaleMerged(all);
    const mergedSet = this._buildMergedSet(all);
    const ignoredSet = this._ignoredPairs();
    for (const p of this.collisionPairs || []) {
      const key = this._pairKey(p.gidA, p.gidB);
      p.merged = mergedSet.has(key);
      p.ignored = ignoredSet.has(key);
    }
    el.innerHTML = this.renderCollisionBand(this.collisionPairs);
  },

  async regenerateCollisions() {
    this._forceRegen = true;
    const all = await window.DB.getAll('learn_notes');
    this.collisionPairs = await this.getCollisionPairs(all);
    this.paintCollision();
    this.toast('已重新生成碰撞结果 ✨（仅刷新，不写入认知）');
  },

  async mergeCollision(i) {
    const p = (this.collisionPairs || [])[i];
    if (!p) return;
    const all = await window.DB.getAll('learn_notes');
    const a = all.find(n => n.gid === p.gidA) || { title: p.titleA || '(无标题)', note: '' };
    const b = all.find(n => n.gid === p.gidB) || { title: p.titleB || '(无标题)', note: '' };
    const theme = p.sharedTags[0] || '灵感';
    const fusion = p.connect || this._extractFusion(p.text);
    const note = {
      gid: generateGid(),
      title: fusion,
      note: '【碰撞主题】' + theme + '\n【连接笔记】\n· 《' + (a.title || '(无标题)') + '》：' + this._coreView(a) + '\n· 《' + (b.title || '(无标题)') + '》：' + this._coreView(b) + '\n【碰撞洞察】' + fusion,
      tags: Array.from(new Set(['灵感', theme])),
      status: 'pending',
      source: 'collision',
      createdAt: Date.now(),
      updatedAt: Date.now()
    };
    // [A方案·2026-08-09] 禁用自动写库：今日碰撞入口已隐藏，mergeCollision 不再被前端触发。
    // 保留整段函数与 _coreView 等底层零件，未来做「消化后即时推荐」可直接复用，无需重写。
    // try { await window.DB.put('learn_notes', note); } catch (e) { console.error('并入认知失败：', e); return; }
    this._setMerged(p.gidA, p.gidB, note.gid);
    this.paintCollision();
    this.toast('已并入认知 → 写入「待消化」');
  },

  ignoreCollision(i) {
    const p = (this.collisionPairs || [])[i];
    if (!p) return;
    this._addIgnored(p.gidA, p.gidB);
    this.collisionPairs.splice(i, 1);
    this.paintCollision();
    this.toast('已忽略这条碰撞');
  },

  _plain(html) {
    const d = document.createElement('div');
    d.innerHTML = html || '';
    return d.textContent || '';
  },

  toast(msg) {
    let t = document.getElementById('learn_toast');
    if (!t) {
      t = document.createElement('div');
      t.id = 'learn_toast';
      t.className = 'learn-toast';
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(this._toastTimer);
    this._toastTimer = setTimeout(() => t.classList.remove('show'), 1800);
  }
};

// ===== 本地语义回忆引擎（浏览器内 embedding，离线私密，数据不出浏览器）=====
// 失败（无网络/CDN 被墙）时自动降级为关键词匹配，保证回忆功能始终可用。
let _embedderPromise = null;

// 多 CDN 依次尝试加载 transformers.js 的 ESM 构建（浏览器 import 必须 ESM）
const TRANSFORMERS_CDNS = [
  'https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.1/+esm',
  'https://esm.sh/@xenova/transformers@2.17.1',
  'https://unpkg.com/@xenova/transformers@2.17.1/+esm'
];

async function getEmbedder() {
  if (_embedderPromise) return _embedderPromise;
  _embedderPromise = (async () => {
    let lastErr = null;
    for (const url of TRANSFORMERS_CDNS) {
      try {
        const mod = await import(url);
        if (mod.env) {
          // 国内可访问的 HuggingFace 镜像，避免模型权重拉取被墙
          mod.env.allowRemoteModels = true;
          mod.env.modelRepository = 'https://hf-mirror.com';
        }
        const pipeline = mod.pipeline || (mod.default && mod.default.pipeline);
        if (!pipeline) throw new Error('transformers.js 未导出 pipeline');
        const extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2');
        return { type: 'semantic', extractor };
      } catch (e) {
        lastErr = e;
        console.warn('语义模型加载失败（' + url + '），尝试下一个 CDN：', e);
      }
    }
    console.warn('所有 CDN 均失败，降级为关键词匹配：', lastErr);
    return { type: 'keyword', error: lastErr };
  })();
  return _embedderPromise;
}

async function embedText(embedder, text) {
  const out = await embedder.extractor(text, { pooling: 'mean', normalize: true });
  return Array.from(out.data);
}

// 向量已 L2 归一化，余弦相似度 = 点积
function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0;
  let dot = 0;
  for (let i = 0; i < a.length; i++) dot += a[i] * b[i];
  return dot;
}

const RECALL_STOP = new Set([
  '的', '了', '吗', '呢', '啊', '吧', '这个', '那个', '讲', '视频', '说', '来着', '啥',
  '什么', '怎么', '怎样', '为什么', '我', '你', '他', '她', '它', '它们', '这', '那',
  '在', '是', '有', '和', '与', '及', '关于', '之前', '以后', '看过', '消化', '内容',
  '回', '想', '记得', '一下', '上次', '这次', '一个', '没有', '不知道', '哪', '里', '那个'
]);

// 从查询里提取用于高亮 / 关键词匹配的词（去停用词）
function extractHighlightTerms(q) {
  const cleaned = (q || '').replace(/[，。！？、；：""''（）()\[\]【】\s]+/g, ' ').trim();
  const terms = new Set();
  cleaned.split(/\s+/).filter(Boolean).forEach(tok => {
    if (/[一-鿿]/.test(tok)) {
      if (tok.length >= 2) terms.add(tok);
      for (let i = 0; i < tok.length - 1; i++) terms.add(tok.slice(i, i + 2));
    } else if (tok.length >= 2) {
      terms.add(tok);
    }
  });
  return [...terms].filter(t => !RECALL_STOP.has(t));
}

// 在已转义文本上包裹命中高亮（terms 同样先转义再匹配）
function hlText(text, terms) {
  if (!text || !terms || !terms.length) return text;
  const ets = [...new Set(terms.map(t => esc(t)).filter(Boolean))].sort((a, b) => b.length - a.length);
  if (!ets.length) return text;
  const re = new RegExp('(' + ets.map(e => e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|') + ')', 'g');
  return text.replace(re, '<mark class="ln-hl">$1</mark>');
}

// 关键词降级：标题/标签/正文命中计数排序（同时用于高亮）
function keywordRank(notes, query) {
  const qterms = extractHighlightTerms(query).map(t => t.toLowerCase()).filter(Boolean);
  return notes.map(n => {
    const blob = [n.title, n.note, (n.tags || []).join(' ')].join(' ').toLowerCase();
    let score = 0;
    qterms.forEach(t => { if (blob.includes(t)) score += 1; });
    if (n.title && qterms.some(t => (n.title || '').toLowerCase().includes(t))) score += 0.5;
    return { n, score: score > 0 ? Math.min(0.99, 0.5 + score * 0.1) : 0 };
  }).filter(x => x.score > 0).sort((a, b) => b.score - a.score);
}

window.Learn = Learn;

// ===== 消化进度常驻浮标（关弹窗后也能看到进度/完成/出错）=====
function ensureDigestBadge() {
  let b = document.getElementById('digest_floating');
  if (!b) {
    b = document.createElement('div');
    b.id = 'digest_floating';
    b.className = 'digest-floating';
    // 点击任意位置关闭浮标
    b.addEventListener('click', () => { b.remove(); });
    document.body.appendChild(b);
  }
  return b;
}
function showDigestBadge(kind, text) {
  const b = ensureDigestBadge();
  b.className = 'digest-floating' + (kind ? ' ' + kind : '');
  b.innerHTML = `<span class="df-text">${text}</span><span class="df-close">×</span>`;
  b.style.display = 'flex';
  // 取消上一轮 timer（包括把 fade 态拉回来）
  if (b._autoTimer) { clearTimeout(b._autoTimer); b._autoTimer = null; }
  if (b._fadeTimer) { clearTimeout(b._fadeTimer); b._fadeTimer = null; }
  b.style.transition = '';
  b.style.opacity = '';
  b.style.transform = '';
  // 自动消失策略：成功(done) 1 秒后淡出消失；失败(error)/进行中(running) 不自动关，确保用户能看到失败原因
  if (kind === 'done') {
    b._autoTimer = setTimeout(() => {
      if (!b || !b.parentNode) return;
      b.style.transition = 'opacity .35s ease, transform .35s ease';
      b.style.opacity = '0';
      b.style.transform = 'translateY(6px)';
      b._fadeTimer = setTimeout(() => { if (b && b.parentNode) b.remove(); }, 380);
    }, 1000);
  }
}
function hideDigestBadge() {
  const b = document.getElementById('digest_floating');
  if (b) b.remove();
}
