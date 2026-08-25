// modules/xhs.js - 小红书发帖工作台（A 方案：云端直出方案，不跳平台）
// 数据：xhs_topics（云端同步）。AI 生成由云端 /api/xhs-generate（DeepSeek）直出，前端渲染。
// 照片墙读取 /api/uploads。改定位/系列/规则只动 config/xhs_config.js。

const XHS = {
  _activeTab: 'photo',
  cfg() { return window.XHS_CONFIG || { series: [], rules: {}, backendGenerate: true, generateEndpoint: '/api/xhs-generate' }; },
  seriesList() { return this.cfg().series || []; },
  seriesName(id) {
    const s = this.seriesList().find(x => x.id === id);
    return s ? s.name : id;
  },
  uploadBase() { return location.origin; },

  // 统一请求封装：复用 db.js 的 token/base 逻辑，避免写操作与主同步链路脱节
  api(path) {
    let base = '';
    try { base = localStorage.getItem('sb_api_base') || ''; } catch (e) {}
    base = (base || '').replace(/\/+$/, '');
    let token = '';
    try {
      const stored = localStorage.getItem('sb_api_token');
      token = (stored === null || stored === undefined || stored === '') ? (typeof DEFAULT_API_TOKEN !== 'undefined' ? DEFAULT_API_TOKEN : '') : stored;
    } catch (e) {
      token = (typeof DEFAULT_API_TOKEN !== 'undefined') ? DEFAULT_API_TOKEN : '';
    }
    if (token) path += (path.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(token);
    if (!base) return path;
    return base + path;
  },

  async render() {
    const content = document.getElementById('content');
    const cfg = this.cfg();
    const topics = await window.DB.getAll('xhs_topics');
    topics.sort((a, b) => (b.createdAt || b.updatedAt || 0) - (a.createdAt || a.updatedAt || 0));
    const posts = await window.DB.getAll('xhs_posts');
    posts.sort((a, b) => (b.publishedAt || 0) - (a.publishedAt || 0));
    const seriesOpts = this.seriesList()
      .map(s => `<option value="${s.id}">${esc(s.name)}</option>`).join('');
    const uploadUrl = this.uploadBase() + '/upload.html';
    const tabs = [['photo', '照片'], ['gen', '方案'], ['topic', '选题'], ['post', '档案']];

    content.innerHTML = `
      <div style="display:flex;align-items:center;gap:8px;background:#fbe3ec;border:1px solid #e08aac;border-radius:12px;padding:9px 12px;margin-bottom:12px">
        <span style="width:8px;height:8px;border-radius:50%;background:#c2416b;flex:0 0 auto"></span>
        <span style="font-size:12px;color:#993556;line-height:1.4">${esc(cfg.positioning || '审美生活记录者')}</span>
      </div>

      <div class="xhs-tabs" style="display:flex;border-bottom:1px solid #ffe0ea;margin-bottom:12px;position:sticky;top:0;background:#fff;z-index:10">
        ${tabs.map(([id, label]) => {
          const active = id === this._activeTab;
          return `<button class="xhs-tab ${active ? 'active' : ''}" data-tab="${id}" onclick="XHS.switchTab('${id}')" style="flex:1;text-align:center;padding:13px 0 11px;font-size:14px;font-weight:${active ? 600 : 500};color:${active ? '#c2416b' : '#8a7d83'};background:none;border:none;cursor:pointer;letter-spacing:1px">${label}</button>`;
        }).join('')}
      </div>

      <div class="xhs-panel" id="xhs-panel-photo" style="display:${this._activeTab === 'photo' ? 'block' : 'none'}">${this.photoPanel(uploadUrl)}</div>
      <div class="xhs-panel" id="xhs-panel-gen" style="display:${this._activeTab === 'gen' ? 'block' : 'none'}">${this.genPanel(seriesOpts)}</div>
      <div class="xhs-panel" id="xhs-panel-topic" style="display:${this._activeTab === 'topic' ? 'block' : 'none'}">${this.topicPanel(topics)}</div>
      <div class="xhs-panel" id="xhs-panel-post" style="display:${this._activeTab === 'post' ? 'block' : 'none'}">${this.postPanel(posts)}</div>
    `;
    XHS.loadGallery();
    XHS.updatePhotoHint();
  },

  switchTab(name) {
    this._activeTab = name;
    document.querySelectorAll('.xhs-tab').forEach(b => {
      const active = b.dataset.tab === name;
      b.classList.toggle('active', active);
      b.style.fontWeight = active ? 600 : 500;
      b.style.color = active ? '#c2416b' : '#8a7d83';
    });
    document.querySelectorAll('.xhs-panel').forEach(p => {
      p.style.display = (p.id === 'xhs-panel-' + name) ? 'block' : 'none';
    });
    const content = document.getElementById('content');
    if (content) content.scrollTop = 0;
  },

  photoPanel(uploadUrl) {
    return `
      <div class="card" style="text-align:center;padding:22px 16px;background:#fff5f8;border:1px dashed #e08aac;border-radius:16px;margin-bottom:14px">
        <div style="font-size:15px;font-weight:600;color:#4b1528">点下面按钮，直接选相册 / 拍照上传</div>
        <div style="font-size:12px;color:#8a7d83;margin-top:6px">手机点一下就能传原图，不用再打开链接了</div>
        <button class="btn btn-primary" style="margin-top:14px;width:100%" onclick="XHS.pickFile()">选择照片上传</button>
        <input type="file" id="xhs_file" accept="image/*" multiple style="display:none" onchange="XHS.uploadFiles(this)" />
        <div style="font-size:11px;color:#8a7d83;margin-top:10px">电脑传图或超大原图：<a href="${esc(uploadUrl)}" target="_blank" style="color:#e08aac">打开上传页</a></div>
      </div>
      <div style="font-size:13px;font-weight:600;color:#4b1528;margin:0 0 8px">最近照片 <span style="font-weight:400;font-size:12px;color:#c2416b;cursor:pointer;margin-left:6px" onclick="XHS.loadGallery()">刷新</span></div>
      <div id="xhs_gallery" style="display:grid;grid-template-columns:repeat(3,1fr);gap:6px">加载中…</div>
    `;
  },

  genPanel(seriesOpts) {
    return `
      <div class="card">
        <div class="form-group">
          <label class="form-label">这组照片属于哪个系列</label>
          <select class="select" id="xhs_series">${seriesOpts}</select>
        </div>
        <div class="form-group">
          <label class="form-label">这组照片想说什么（一句话）<span style="color:#e08aac">*</span></label>
          <textarea class="textarea" id="xhs_topic" rows="2" placeholder="如：江边日落调色 3 张，想表达夏日清透感 / 不露脸 ootd 云逛街试衣">${esc((window._xhs_lastTopic)||'')}</textarea>
          <div class="text-sub" style="font-size:11px;margin-top:2px">一句话讲清「拍了啥 + 想表达什么」，标题正文都围绕它</div>
        </div>
        <div class="form-group">
          <label class="form-label">想表达的情绪 / 亮点（可空）</label>
          <textarea class="textarea" id="xhs_mood" rows="2" placeholder="如：猜猜我留下了哪几件？清透感、夏日松弛">${esc((window._xhs_lastMood)||'')}</textarea>
        </div>
        <div class="form-group">
          <label class="form-label">想让 AI 额外推荐哪类 @ / 标签 / 滤镜方向（可空）</label>
          <input class="input" id="xhs_extra" placeholder="如：清透感滤镜方向、可 @ 的摄影号" />
        </div>
        <div id="xhs_photo_hint" class="text-sub" style="font-size:12px;color:#993556;margin:-4px 0 8px"></div>
        <button class="btn btn-primary btn-block" id="xhs_gen_btn" onclick="XHS.generate()">生成方案</button>
        <div id="xhs_result" style="margin-top:12px"></div>
      </div>
    `;
  },

  topicPanel(topics) {
    const hasTopics = topics.length > 0;
    return `
      <div class="card" style="padding:12px 14px">
        <div class="card-title" style="margin-bottom:10px">本周做什么
          <span style="font-size:12px;color:#c2416b;cursor:pointer" onclick="XHS.recommendTopics(event)">AI 推荐本周选题</span>
        </div>
        <div id="xhs_topic_source" style="font-size:11px;color:#8a7d83;margin:-4px 0 10px;display:none"></div>
        ${hasTopics
          ? topics.map(t => this.topicCard(t)).join('')
          : '<p class="text-sub" style="text-align:center;padding:14px 0">还没有选题。点「AI 推荐本周选题」让云端按你的定位推一批；或「+ 加选题」自己加。</p>'}
        <div style="display:flex;gap:8px;margin-top:10px">
          <button class="btn btn-ghost" style="margin:0;flex:1" onclick="XHS.openTopicEditor()">+ 加选题</button>
          ${hasTopics ? `<button class="btn btn-danger" style="margin:0;flex:0 0 auto" onclick="XHS.clearAllTopics()">清空 ${topics.length} 条</button>` : ''}
        </div>
      </div>
    `;
  },

  postPanel(posts) {
    return `
      ${this.reviewSummary(posts)}
      <div class="card" style="padding:12px 14px">
        <div class="card-title" style="margin-bottom:10px">记录发布</div>
        <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;margin-bottom:12px">
          <button class="btn btn-ghost" onclick="XHS.parseScreenshot()" style="padding:10px 6px;font-size:13px">📸 截图识别</button>
          <button class="btn btn-ghost" onclick="XHS.parseLink()" style="padding:10px 6px;font-size:13px">🔗 贴链接</button>
          <button class="btn btn-ghost" onclick="XHS.markPublished()" style="padding:10px 6px;font-size:13px">⌨️ 手动填写</button>
        </div>
        <div style="font-size:11px;color:#8a7d83;margin:-8px 0 12px">截图最准（含阅读数）· 链接次之（公开数据）· 手动兜底</div>
        <div class="card-title" style="margin-bottom:10px">发布记录 ${posts.length ? '<span style="font-size:12px;color:#993556">共 ' + posts.length + ' 篇</span>' : ''}</div>
        ${posts.length
          ? posts.map(p => this.postCard(p)).join('')
          : '<p class="text-sub" style="text-align:center;padding:14px 0">还没有发布记录。发完一篇后用上面任一入口把数据记回来，方便周复盘。</p>'}
      </div>
    `;
  },

  reviewSummary(posts) {
    if (!posts || !posts.length) return '';
    const now = Date.now();
    const week = 7 * 24 * 3600 * 1000;
    const recent = posts.filter(p => (now - (p.publishedAt || 0)) <= week);
    if (!recent.length) return '';
    // 平均阅读
    const withViews = recent.filter(p => p.views != null);
    const avgViews = withViews.length ? withViews.reduce((s, p) => s + (Number(p.views) || 0), 0) / withViews.length : null;
    // 总赞 + 藏（兼容旧 interact 字段）
    const totalLikes = recent.reduce((s, p) => s + (Number(p.likes) || 0), 0);
    const totalSaves = recent.reduce((s, p) => s + (Number(p.saves) || 0), 0);
    // 数据最好系列（按平均 赞+藏 排）
    const bySeries = {};
    recent.forEach(p => {
      const k = p.series || '未分类';
      if (!bySeries[k]) bySeries[k] = { sum: 0, n: 0 };
      bySeries[k].sum += (Number(p.likes) || 0) + (Number(p.saves) || 0);
      bySeries[k].n++;
    });
    let bestName = '—';
    let bestAvg = -1;
    Object.entries(bySeries).forEach(([k, v]) => {
      const a = v.n ? v.sum / v.n : 0;
      if (a > bestAvg) { bestAvg = a; bestName = this.seriesName(k); }
    });
    return `
      <div style="background:#fbe3ec;border:1px solid #ffe0ea;border-radius:16px;padding:14px 15px;margin-bottom:12px">
        <div style="font-size:12px;color:#993556;font-weight:600;margin-bottom:8px">本周复盘（${recent.length} 篇）</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px">
          <div style="background:#fff;border-radius:10px;padding:9px 10px"><b style="display:block;font-size:16px;color:#c2416b">${avgViews != null ? avgViews.toFixed(0) : '—'}</b><span style="font-size:11px;color:#8a7d83">平均阅读</span></div>
          <div style="background:#fff;border-radius:10px;padding:9px 10px"><b style="display:block;font-size:16px;color:#c2416b">${totalLikes + totalSaves}</b><span style="font-size:11px;color:#8a7d83">总赞 + 藏</span></div>
          <div style="background:#fff;border-radius:10px;padding:9px 10px"><b style="display:block;font-size:14px;color:#c2416b">${esc(bestName)}</b><span style="font-size:11px;color:#8a7d83">数据最好系列</span></div>
          <div style="background:#fff;border-radius:10px;padding:9px 10px"><b style="display:block;font-size:14px;color:#c2416b">${recent.length}</b><span style="font-size:11px;color:#8a7d83">本周发布</span></div>
        </div>
      </div>`;
  },

  // 显示「已传 N 张图，生成时会参考」提示
  async updatePhotoHint() {
    const el = document.getElementById('xhs_photo_hint');
    if (!el) return;
    try {
      const r = await fetch(this.api('/api/uploads'));
      const d = await r.json();
      const n = (d.items || []).length;
      el.innerHTML = n ? `📷 已检测到 <b>${n}</b> 张图，生成时参考最近 <b>${Math.min(n, 6)}</b> 张（云端真的看图分析色彩 / 构图 / 氛围）` : '📷 还没传照片（传了 AI 会更懂你的图）';
    } catch (e) { el.innerHTML = ''; }
  },

  async clearAllTopics() {
    const all = await window.DB.getAll('xhs_topics');
    if (!all.length) return;
    const ok = await confirmDialog(`清空全部 ${all.length} 条选题？（不可恢复）`);
    if (!ok) return;
    await Promise.all(all.map(t => window.DB.delete('xhs_topics', t.id)));
    toast('已清空全部选题');
    XHS.render();
  },

  topicCard(t) {
    const heat = t.heat
      ? '<span style="display:inline-block;background:#e08aac;color:#fff;font-size:11px;padding:1px 8px;border-radius:8px;flex:0 0 auto">热</span>'
      : '';
    const refs = (t.references || []).filter(r => r && r.name).map(r =>
      `<span style="display:inline-block;background:#fff5f8;border:1px solid #ffe0ea;border-radius:6px;padding:1px 6px;margin-right:4px;margin-top:4px;font-size:11px;color:#993556">${esc(r.type || '参考')}：${esc(r.name)}</span>`
    ).join('');
    const detailLines = [
      t.titleStructure ? `标题结构：${esc(t.titleStructure)}` : '',
      t.copyHook ? `文案钩子：${esc(t.copyHook)}` : '',
      t.imageStyle ? `图片风格：${esc(t.imageStyle)}` : ''
    ].filter(Boolean);
    return `
      <div onclick="XHS.openTopicEditor(${t.id})" style="padding:13px 14px;border-radius:14px;border:1px solid #ffe0ea;background:#fff;margin-bottom:10px;cursor:pointer">
        <div style="display:flex;align-items:center;gap:8px">
          <span style="font-size:15px;font-weight:600;color:#4b1528;flex:1">${esc(t.title || '')}</span>
          ${heat}
        </div>
        <div style="font-size:12px;color:#8a7d83;margin-top:5px"><span style="color:#c2416b">${esc(this.seriesName(t.series))}</span>${t.note ? ' · ' + esc(t.note) : ''}</div>
        ${detailLines.length ? `<div style="font-size:11px;color:#8a7d83;margin-top:6px;line-height:1.6">${detailLines.map(l => `<div>• ${l}</div>`).join('')}</div>` : ''}
        ${refs ? `<div style="margin-top:4px">${refs}</div>` : ''}
      </div>`;
  },

  async openTopicEditor(id) {
    let t = null;
    if (id) t = await window.DB.get('xhs_topics', id);
    const seriesOpts = this.seriesList()
      .map(s => `<option value="${s.id}" ${t && t.series === s.id ? 'selected' : ''}>${esc(s.name)}</option>`).join('');
    showModal({
      title: t ? '编辑选题' : '加选题',
      body: `
        <div class="form-group">
          <label class="form-label">系列</label>
          <select class="select" id="xt_series">${seriesOpts}</select>
        </div>
        <div class="form-group">
          <label class="form-label">灵感标题</label>
          <input class="input" id="xt_title" value="${esc(t ? t.title : '')}" placeholder="如：落日调色第一期" />
        </div>
        <div class="form-group">
          <label class="form-label">备注 / 关键词</label>
          <textarea class="textarea" id="xt_note" rows="2">${esc(t ? t.note : '')}</textarea>
        </div>
        <div class="form-group">
          <label class="form-label">标题结构模板（可空）</label>
          <input class="input" id="xt_titleStructure" value="${esc(t ? t.titleStructure : '')}" placeholder="如：场景+情绪+结果" />
        </div>
        <div class="form-group">
          <label class="form-label">文案钩子 / 开头句式（可空）</label>
          <input class="input" id="xt_copyHook" value="${esc(t ? t.copyHook : '')}" placeholder="如：被__硬控30秒" />
        </div>
        <div class="form-group">
          <label class="form-label">图片风格建议（可空）</label>
          <input class="input" id="xt_imageStyle" value="${esc(t ? t.imageStyle : '')}" placeholder="如：冷调城市街拍，3:4竖图" />
        </div>
        <div class="form-group">
          <label class="form-label">对标参考（可空，每行一个：类型|名称|参考理由）</label>
          <textarea class="textarea" id="xt_references" rows="2" placeholder="账号|摄影师小张|封面文字极简有质感&#10;笔记|城市天台追光地图|构图值得学习">${esc(t ? XHS.refsToText(t.references) : '')}</textarea>
        </div>
        <div class="form-group" style="display:flex;align-items:center;gap:8px">
          <input type="checkbox" id="xt_heat" ${t && t.heat ? 'checked' : ''} />
          <label for="xt_heat" style="font-size:13px">标记为当周热门选题（喂给生成器作参考）</label>
        </div>
      `,
      footer: `
        ${t ? '<button class="btn btn-danger" id="xt_del">删除</button>' : ''}
        <button class="btn btn-ghost" onclick="hideModal()">取消</button>
        <button class="btn btn-primary" id="xt_save">保存</button>
      `
    });
    setTimeout(() => {
      document.getElementById('xt_save').onclick = async () => {
        const data = {
          series: document.getElementById('xt_series').value,
          title: document.getElementById('xt_title').value.trim(),
          note: document.getElementById('xt_note').value.trim(),
          titleStructure: document.getElementById('xt_titleStructure').value.trim(),
          copyHook: document.getElementById('xt_copyHook').value.trim(),
          imageStyle: document.getElementById('xt_imageStyle').value.trim(),
          references: XHS.textToRefs(document.getElementById('xt_references').value),
          heat: document.getElementById('xt_heat').checked
        };
        if (!data.title) return toast('填个灵感标题吧');
        if (t) {
          await window.DB.put('xhs_topics', { ...t, ...data, updatedAt: Date.now() });
          toast('已更新');
        } else {
          await window.DB.add('xhs_topics', { ...data, createdAt: Date.now() });
          toast('已加入选题库');
        }
        hideModal();
        XHS.render();
      };
      if (t) document.getElementById('xt_del').onclick = async () => {
        const ok = await confirmDialog('删除这条选题？');
        if (!ok) return;
        await window.DB.delete('xhs_topics', t.id);
        hideModal();
        toast('已删除');
        XHS.render();
      };
    }, 50);
  },

  // ===== 生成方案：云端直出，不跳平台 =====
  async generate() {
    const series = document.getElementById('xhs_series').value;
    const topic = document.getElementById('xhs_topic').value.trim();
    const mood = document.getElementById('xhs_mood').value.trim();
    const extra = document.getElementById('xhs_extra').value.trim();
    if (!topic) return toast('先写「这组照片说一句」');
    window._xhs_lastTopic = topic;
    window._xhs_lastMood = mood;

    const cfg = this.cfg();
    const all = await window.DB.getAll('xhs_topics');
    const heatTopics = all.filter(t => t.heat).map(t => (t.title || '') + (t.note ? '（' + t.note + '）' : ''));
    const heatRefs = heatTopics.join('；');

    // 取最近 6 张传上来的照片 URL，发给云端让 AI 看图
    let photos = [];
    try {
      const r = await fetch(this.api('/api/uploads'));
      const d = await r.json();
      photos = (d.items || []).slice(0, 6).map(it => it.url);
    } catch (e) { photos = []; }

    const btn = document.getElementById('xhs_gen_btn');
    const box = document.getElementById('xhs_result');
    btn.disabled = true;
    btn.textContent = '生成中…（AI 先看图，再写方案，约 10-20 秒）';
    box.innerHTML = `
      <div class="card" style="border-color:#e08aac;background:#fff5f8">
        <p class="text-sub" style="margin:0">🔄 AI 正在分析你传的图 + 写小红书方案，请稍候（表单已保留，不会清空）…</p>
        <div style="margin-top:10px;height:4px;background:#ffe0ea;border-radius:2px;overflow:hidden">
          <div id="xhs_gen_progress" style="width:0%;height:100%;background:#e08aac;transition:width 0.3s"></div>
        </div>
      </div>`;
    box.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    let prog = 0;
    const progTimer = setInterval(() => {
      prog = Math.min(prog + 5, 90);
      const bar = document.getElementById('xhs_gen_progress');
      if (bar) bar.style.width = prog + '%';
    }, 800);

    try {
      const ep = cfg.generateEndpoint || '/api/xhs-generate';
      const q = this.api(ep);
      const r = await fetch(q, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ series: this.seriesName(series), topic, mood, photoHints: extra, heatRefs, photos })
      });
      const d = await r.json();
      clearInterval(progTimer);
      if (!d.ok) {
        box.innerHTML = `<div class="card" style="border-color:#e08aac;background:#fff5f8"><p class="text-sub" style="font-weight:600;color:#c2416b">生成失败：${esc(d.error || '未知错误')}</p>
          <p class="text-sub">可能原因：服务端未配置大模型 key、网络波动、或当前额度耗尽。可稍后重试，或把上面填的内容发给我（WorkBuddy）直接出方案。</p>
          <button class="btn btn-primary btn-block" style="margin-top:10px" onclick="XHS.generate()">再试一次</button></div>`;
        return;
      }
      box.innerHTML = XHS.renderPlan(d.result, d);
      box.scrollIntoView({ behavior: 'smooth', block: 'start' });
    } catch (e) {
      clearInterval(progTimer);
      box.innerHTML = `<div class="card" style="border-color:#e08aac;background:#fff5f8"><p class="text-sub" style="font-weight:600;color:#c2416b">请求出错：${esc(e)}</p>
        <p class="text-sub">你的输入已保留，可重试或刷新页面。</p>
        <button class="btn btn-primary btn-block" style="margin-top:10px" onclick="XHS.generate()">再试一次</button></div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = '重新生成方案';
    }
  },

  // 把大模型返回的 Markdown 渲染成可读卡片（按 ## 模块拆分）
  renderPlan(md, meta = {}) {
    const escapeHtml = s => esc(s);
    if (!md || !String(md).trim()) {
      return '<div class="card" style="margin-top:10px;background:#fff5f8;border-color:#e08aac"><p class="text-sub" style="font-weight:600;color:#c2416b">AI 未返回内容，请重试</p><button class="btn btn-primary btn-block" style="margin-top:10px" onclick="XHS.generate()">再试一次</button></div>';
    }
    const metaNote = meta.note ? `<div class="text-sub" style="font-size:12px;color:#993556;margin-bottom:8px">${esc(meta.note)}</div>` : '';
    const modelInfo = meta.model ? `<span style="font-size:11px;color:#8a7d83">模型：${esc(meta.model)}${meta.photosUsed ? ' · 已参考 ' + meta.photosUsed + ' 张照片' : ''}</span>` : '';
    // 拆分 ## 模块
    const parts = String(md).split(/^##\s+/m).filter(Boolean);
    let blocks = parts.map(p => {
      const nl = p.indexOf('\n');
      const title = nl > 0 ? p.slice(0, nl).trim() : p.trim();
      const body = nl > 0 ? p.slice(nl + 1).trim() : '';
      return { title, body };
    });
    const html = blocks.map(b => {
      const bodyHtml = escapeHtml(b.body)
        .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
        .replace(/\*(.+?)\*/g, '<i>$1</i>')
        .replace(/^(\s*)[-\d]+\.\s+/gm, '$1• ')
        .replace(/\n/g, '<br/>');
      return `<div class="card" style="margin-top:10px">
        <div class="card-title" style="color:#c2416b">${escapeHtml(b.title)}</div>
        <div style="font-size:14px;line-height:1.7;color:#4b1528">${bodyHtml}</div>
      </div>`;
    }).join('');
    return `<div style="margin-top:4px">
      <div class="card" style="background:#fbe3ec;border-color:#e08aac;margin-bottom:10px">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px">
          <span style="font-size:14px;font-weight:600;color:#993556">✅ 方案已生成（云端直出）</span>
          <span>
            <button class="btn btn-ghost btn-sm" onclick="XHS.copyPlan()">复制全部</button>
            <button class="btn btn-primary btn-sm" onclick="XHS.markPublished()">标记已发布</button>
          </span>
        </div>
        ${metaNote}
        ${modelInfo}
      </div>
      ${html}
      <p class="text-sub" style="margin-top:10px">提示：@提及/标签/滤镜方向是 AI 基于你的定位推荐，采纳前可微调；最终发布由你定。</p>
    </div>`;
  },

  copyPlan() {
    const box = document.getElementById('xhs_result');
    if (!box) return;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(box.innerText).then(() => toast('已复制全部方案'), () => toast('复制失败，手动选文字'));
    } else {
      toast('请手动长按选择文字复制');
    }
  },

  refsToText(refs) {
    if (!Array.isArray(refs)) return '';
    return refs.filter(r => r && r.name).map(r => [r.type || '账号', r.name, r.why || ''].join('|')).join('\n');
  },
  textToRefs(text) {
    if (!text || !text.trim()) return [];
    return text.trim().split(/\n+/).map(line => {
      const parts = line.split('|').map(s => s.trim());
      if (parts.length < 2) return null;
      return { type: parts[0] || '账号', name: parts[1], why: parts.slice(2).join('|') };
    }).filter(Boolean);
  },

  // ===== AI 推荐本周选题 =====
  async recommendTopics(ev) {
    const cfg = this.cfg();
    const btn = ev && ev.target;
    if (btn) { btn.disabled = true; btn.textContent = '推荐中…'; }
    try {
      const ep = (cfg.recommendEndpoint || '/api/xhs-topics-recommend');
      const q = this.api(ep);
      const r = await fetch(q, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          positioning: cfg.positioning || '审美生活记录者',
          series: this.seriesList().map(s => ({ id: s.id, name: s.name }))
        })
      });
      const d = await r.json();
      if (!d.ok) { toast('推荐失败：' + (d.error || '')); return; }
      const recs = (d.result || []).filter(Boolean);
      if (!recs.length) { toast('没推荐出内容，稍后再试'); return; }
      const sourceNote = d.sourceNote || '选题由 AI 基于账号定位生成，发布前请结合真实平台搜索二次确认。';
      // 弹窗勾选保留
      showModal({
        title: '✨ AI 推荐本周选题（勾选要保留的）',
        body: `
          <p class="text-sub" style="font-size:11px;color:#8a7d83;margin-bottom:10px">${esc(sourceNote)}</p>
          <div id="xt_recs">${recs.map((t, i) => {
            const detail = [
              t.titleStructure ? `标题结构：${esc(t.titleStructure)}` : '',
              t.copyHook ? `文案钩子：${esc(t.copyHook)}` : '',
              t.imageStyle ? `图片风格：${esc(t.imageStyle)}` : ''
            ].filter(Boolean);
            const refs = (t.references || []).filter(r => r && r.name).map(r =>
              `<span style="display:inline-block;background:#fff5f8;border:1px solid #ffe0ea;border-radius:6px;padding:1px 6px;margin-right:4px;margin-top:4px;font-size:11px;color:#993556">${esc(r.type || '参考')}：${esc(r.name)}</span>`
            ).join('');
            return `
          <label style="display:block;padding:10px 0;border-bottom:1px solid #ffe0ea;cursor:pointer">
            <div style="display:flex;gap:8px;align-items:flex-start">
              <input type="checkbox" data-i="${i}" checked style="margin-top:3px;flex:0 0 auto" />
              <span style="font-size:14px;color:#4b1528;flex:1">${esc(t.title || '')}${t.heat ? '<span style="display:inline-block;background:#e08aac;color:#fff;font-size:11px;padding:1px 8px;border-radius:8px;margin-left:6px">热</span>' : ''}</span>
            </div>
            <div style="font-size:12px;color:#8a7d83;margin:4px 0 0 22px">${esc(this.seriesName(t.series))}${t.note ? ' · ' + esc(t.note) : ''}</div>
            ${detail.length ? `<div style="font-size:11px;color:#8a7d83;margin:4px 0 0 22px;line-height:1.6">${detail.map(l => `<div>• ${l}</div>`).join('')}</div>` : ''}
            ${refs ? `<div style="margin:4px 0 0 22px">${refs}</div>` : ''}
          </label>`;
          }).join('')}</div>`,
        footer: `<button class="btn btn-ghost" onclick="hideModal()">取消</button>
          <button class="btn btn-primary" id="xt_rec_save">保存勾选的选题</button>`
      });
      setTimeout(() => {
        document.getElementById('xt_rec_save').onclick = async () => {
          const checks = Array.from(document.querySelectorAll('#xt_recs input[type=checkbox]'));
          let saved = 0;
          for (const c of checks) {
            if (!c.checked) continue;
            const t = recs[+c.dataset.i];
            const sid = (cfg.series && cfg.series[0] && cfg.series[0].id) || 'default';
            await window.DB.add('xhs_topics', {
              series: t.series || sid,
              title: t.title || '',
              note: t.note || '',
              heat: !!t.heat,
              titleStructure: t.titleStructure || '',
              copyHook: t.copyHook || '',
              imageStyle: t.imageStyle || '',
              references: Array.isArray(t.references) ? t.references : [],
              createdAt: Date.now()
            });
            saved++;
          }
          hideModal();
          toast(`已保存 ${saved} 条选题`);
          XHS.render();
        };
      }, 50);
    } catch (e) {
      toast('推荐出错：' + e);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '✨ AI 推荐本周选题'; }
    }
  },

  // ===== 照片墙：电脑上传 + 手机链接 + 列表 =====
  pickFile() { document.getElementById('xhs_file').click(); },
  async uploadFiles(input) {
    const files = Array.from(input.files || []);
    if (!files.length) return;
    for (const f of files) {
      try {
        const buf = await f.arrayBuffer();
        const r = await fetch(this.api('/api/upload?name=' + encodeURIComponent(f.name)), { method: 'POST', body: buf });
        const d = await r.json();
        if (!d.ok) toast('上传失败：' + (d.error || ''));
      } catch (e) { toast('上传出错：' + e); }
    }
    toast('上传完成');
    input.value = '';
    XHS.loadGallery();
    XHS.updatePhotoHint();
  },

  async loadGallery() {
    const el = document.getElementById('xhs_gallery');
    if (!el) return;
    el.innerHTML = '加载中…';
    try {
      const r = await fetch(this.api('/api/uploads'));
      const data = await r.json();
      if (!data.ok) { el.innerHTML = '加载失败：' + (data.error || ''); return; }
      if (!data.items.length) {
        el.innerHTML = '<p class="text-sub" style="grid-column:1/-1;text-align:center;padding:10px 0">还没有照片，电脑点「上传」或手机开上传链接</p>';
        return;
      }
      el.innerHTML = data.items.map(it => `
        <div class="xhs-photo" data-url="${esc(it.url)}" data-name="${esc(it.name)}" style="aspect-ratio:1;overflow:hidden;border-radius:10px;cursor:pointer">
          <img src="${esc(it.url)}" loading="lazy" alt="${esc(it.name)}" style="width:100%;height:100%;object-fit:cover" />
        </div>`).join('');
      el.querySelectorAll('.xhs-photo').forEach(node => {
        node.addEventListener('click', () => XHS.openPhoto(node.dataset.url, node.dataset.name));
      });
    } catch (e) { el.innerHTML = '加载失败：' + e; }
  },

  openPhoto(url, name) {
    showModal({
      title: name || '照片',
      body: `<img src="${esc(url)}" style="width:100%;border-radius:12px" />
        <p class="text-sub" style="word-break:break-all;margin:8px 0 0">${esc(url)}</p>`,
      footer: `
        <button class="btn btn-ghost" onclick="hideModal()">关闭</button>
        <button class="btn btn-danger" onclick="XHS.deletePhoto('${esc(url)}')">删除</button>
        <button class="btn btn-primary" onclick="XHS.copyPhotoLink('${esc(url)}')">复制链接</button>`
    });
  },

  copyPhotoLink(url) {
    const full = location.origin + url;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(full).then(() => toast('已复制链接，粘贴到对话发我'), () => prompt('复制这个链接发给我：', full));
    } else {
      prompt('复制这个链接发给我：', full);
    }
  },

  async deletePhoto(url) {
    const ok = await confirmDialog('删除这张照片？（云端同时删除，不可恢复）');
    if (!ok) return;
    try {
      const r = await fetch(this.api('/api/upload/delete?name=' + encodeURIComponent(url.split('/').pop())), { method: 'POST' });
      const d = await r.json();
      if (d.ok) { toast('已删除'); hideModal(); XHS.loadGallery(); }
      else toast('删除失败：' + (d.error || ''));
    } catch (e) { toast('删除失败：' + e); }
  },

  // ===== 发帖档案：三通道入库（截图/链接/手动），供周复盘 =====
  postCard(p) {
    // interact 兼容：优先取 likes+saves+comments+shares 之和，旧数据回退到 p.interact
    const interact = (p.likes != null || p.saves != null || p.comments != null || p.shares != null)
      ? ((p.likes||0) + (p.saves||0) + (p.comments||0) + (p.shares||0))
      : p.interact;
    const stats = [
      p.views != null ? '阅读 ' + p.views : '',
      p.likes != null ? '赞 ' + p.likes : '',
      p.saves != null ? '藏 ' + p.saves : '',
      p.comments != null ? '评 ' + p.comments : '',
      p.shares != null ? '转 ' + p.shares : '',
      interact != null && !p.views ? '互动 ' + interact : ''
    ].filter(Boolean).join(' · ');
    return `
      <div style="padding:13px 14px;border-radius:14px;border:1px solid #ffe0ea;background:#fff;margin-bottom:10px;display:flex;align-items:center;gap:8px">
        <div style="flex:1;min-width:0">
          <div style="font-size:15px;font-weight:600;color:#4b1528;white-space:pre-wrap">${esc(p.title || '')}${p.url ? ` <a href="${esc(p.url)}" target="_blank" style="color:#e08aac;font-size:12px">链接</a>` : ''}</div>
          <div style="font-size:12px;color:#8a7d83;margin-top:5px"><span style="color:#c2416b">${esc(this.seriesName(p.series))}</span>${stats ? ' · ' + stats : ''}${p.publishedAt ? ' · ' + fmtDate(p.publishedAt) : ''}</div>
        </div>
        <div style="display:flex;gap:4px;flex:0 0 auto">
          <button class="btn btn-ghost btn-sm" onclick="XHS.editPost(${p.id})">编</button>
          <button class="btn btn-ghost btn-sm" onclick="XHS.deletePost(${p.id})">删</button>
        </div>
      </div>`;
  },

  async markPublished(prefill = {}, editingId = null) {
    const p = editingId ? await window.DB.get('xhs_posts', editingId) : null;
    const seriesOpts = this.seriesList()
      .map(s => {
        const sel = (prefill.series || p?.series) === s.id ? ' selected' : '';
        return `<option value="${s.id}"${sel}>${esc(s.name)}</option>`;
      }).join('');
    const defaultTitle = prefill.title || p?.title || (window._xhs_lastTopic || '').slice(0, 60);
    const val = (k) => {
      if (prefill[k] !== undefined && prefill[k] !== null && prefill[k] !== '') return prefill[k];
      if (p && p[k] !== undefined && p[k] !== null && p[k] !== '') return p[k];
      return '';
    };
    showModal({
      title: editingId ? '编辑发布记录' : '记录这篇发布',
      body: `
        <div class="form-group">
          <label class="form-label">发布标题</label>
          <input class="input" id="xp_title" value="${esc(defaultTitle)}" placeholder="这篇的标题" />
        </div>
        <div class="form-group">
          <label class="form-label">系列</label>
          <select class="select" id="xp_series">${seriesOpts}</select>
        </div>
        <div class="form-group">
          <label class="form-label">阅读数（可空，截图里才有）</label>
          <input class="input" id="xp_views" type="number" value="${val('views')}" placeholder="如 1200" />
        </div>
        <div class="form-group">
          <label class="form-label">点赞数（可空）</label>
          <input class="input" id="xp_likes" type="number" value="${val('likes')}" placeholder="如 80" />
        </div>
        <div class="form-group">
          <label class="form-label">收藏数（可空）</label>
          <input class="input" id="xp_saves" type="number" value="${val('saves')}" placeholder="如 120" />
        </div>
        <div class="form-group">
          <label class="form-label">评论数（可空）</label>
          <input class="input" id="xp_comments" type="number" value="${val('comments')}" placeholder="如 15" />
        </div>
        <div class="form-group">
          <label class="form-label">分享数（可空）</label>
          <input class="input" id="xp_shares" type="number" value="${val('shares')}" placeholder="如 5" />
        </div>
        <div class="form-group">
          <label class="form-label">发布链接（可空）</label>
          <input class="input" id="xp_url" value="${esc(prefill.url != null ? prefill.url : (p?.url || ''))}" placeholder="https://..." />
        </div>
      `,
      footer: `
        <button class="btn btn-ghost" onclick="hideModal()">取消</button>
        <button class="btn btn-primary" id="xp_save">${editingId ? '保存修改' : '保存到发帖档案'}</button>
      `
    });
    setTimeout(() => {
      document.getElementById('xp_save').onclick = async () => {
        const title = document.getElementById('xp_title').value.trim();
        if (!title) return toast('填个标题吧');
        const num = id => { const v = document.getElementById(id).value; return v === '' || v == null ? null : Number(v); };
        const data = {
          title,
          series: document.getElementById('xp_series').value,
          views: num('xp_views'),
          likes: num('xp_likes'),
          saves: num('xp_saves'),
          comments: num('xp_comments'),
          shares: num('xp_shares'),
          url: document.getElementById('xp_url').value.trim()
        };
        if (editingId && p) {
          await window.DB.put('xhs_posts', { ...p, ...data, updatedAt: Date.now() });
          toast('已更新');
        } else {
          await window.DB.add('xhs_posts', { ...data, publishedAt: Date.now() });
          toast('已记入发帖档案');
        }
        hideModal();
        XHS.render();
      };
    }, 50);
  },

  async editPost(id) {
    const p = await window.DB.get('xhs_posts', id);
    if (!p) return toast('记录不存在');
    this.markPublished(p, id);
  },

  async deletePost(id) {
    const ok = await confirmDialog('删除这条发帖记录？');
    if (!ok) return;
    await window.DB.delete('xhs_posts', id);
    toast('已删除');
    XHS.render();
  },

  // 截图识别：上传图片 → 后端调用视觉模型识别数字 → 预填表单
  parseScreenshot() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*';
    input.onchange = async (e) => {
      const file = e.target.files[0];
      if (!file) return;
      showModal({
        title: '📸 截图识别中',
        body: '<p class="text-sub" style="text-align:center;padding:20px 0">AI 正在识别截图中的数字，请稍候…</p>',
        footer: ''
      });
      try {
        const buf = await file.arrayBuffer();
        const r = await fetch(this.api('/api/xhs-parse-screenshot?name=' + encodeURIComponent(file.name)), {
          method: 'POST',
          body: buf
        });
        const d = await r.json();
        if (!d.ok) {
          hideModal();
          toast('识别失败：' + (d.error || '未知错误'));
          return;
        }
        hideModal();
        // 用识别结果预填表单
        this.markPublished({
          title: d.result.title || '',
          views: d.result.views,
          likes: d.result.likes,
          saves: d.result.saves,
          comments: d.result.comments,
          shares: d.result.shares
        });
      } catch (err) {
        hideModal();
        toast('识别出错：' + err);
      }
    };
    input.click();
  },

  // 贴链接：发送链接 → 后端抓取公开页并解析 → 预填表单
  async parseLink() {
    showModal({
      title: '🔗 贴小红书链接',
      body: `
        <p class="text-sub" style="margin-bottom:10px">在 App 里点「分享 → 复制链接」，贴到下面：</p>
        <input class="input" id="xhs_link_input" placeholder="https://www.xiaohongshu.com/..." />
        <p class="text-sub" style="margin-top:8px;font-size:11px">链接只读公开数据，阅读数拿不到（截图里才有）</p>
      `,
      footer: `
        <button class="btn btn-ghost" onclick="hideModal()">取消</button>
        <button class="btn btn-primary" id="xhs_link_parse">开始解析</button>
      `
    });
    setTimeout(() => {
      document.getElementById('xhs_link_parse').onclick = async () => {
        let raw = document.getElementById('xhs_link_input').value.trim();
        if (!raw) return toast('贴个链接');
        // 从复制文案里尝试抽出 http/https 链接
        let url = raw;
        const m = raw.match(/https?:\/\/[^\s\)\]\,]+/i);
        if (m) url = m[0];
        const isXhs = /xiaohongshu\.(com|cn)|xhslink\.(com|cn)|xhs\.cn/i.test(url);
        if (!isXhs) {
          return toast('没识别到小红书链接，请从 App「分享→复制链接」后粘贴');
        }
        showModal({
          title: '🔗 解析中',
          body: '<p class="text-sub" style="text-align:center;padding:20px 0">正在抓取公开页并解析，请稍候…</p>',
          footer: ''
        });
        try {
          const r = await fetch(this.api('/api/xhs-parse-link'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ url })
          });
          const d = await r.json();
          if (!d.ok) {
            hideModal();
            toast('解析失败：' + (d.error || '未知错误'));
            return;
          }
          hideModal();
          // 用解析结果预填表单
          this.markPublished({
            title: d.result.title || '',
            views: d.result.views,
            likes: d.result.likes,
            saves: d.result.saves,
            comments: d.result.comments,
            shares: d.result.shares,
            url: url
          });
        } catch (err) {
          hideModal();
          toast('解析出错：' + err);
        }
      };
    }, 50);
  }
};

window.XHS = XHS;
