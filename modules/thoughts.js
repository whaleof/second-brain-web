// modules/thoughts.js - 随想：随手记录此刻的想法/感受，每日午间 AI 自动整合成一篇日终思考
// 数据：thoughts（时刻想法）+ thought_digests（日终整合），均走既有局域网同步链路

const Thoughts = {
  date: null,          // 当前查看的日期 YYYY-MM-DD
  kind: 'idea',        // 当前录入类型
  digestOpen: true,    // 整合卡片展开状态

  KINDS: [
    { key: 'idea',  icon: '💭', label: '想法' },
    { key: 'feel',  icon: '💗', label: '感受' },
    { key: 'q',     icon: '🤔', label: '思考' },
    { key: 'spark', icon: '✨', label: '觉察' },
    { key: 'grateful', icon: '🫶', label: '感恩' }
  ],

  kindOf(k) {
    return this.KINDS.find(x => x.key === k) || this.KINDS[0];
  },

  // ===== 主渲染 =====

  async render() {
    if (!this.date) this.date = todayStr();
    const content = document.getElementById('content');

    const all = await window.DB.getAll('thoughts');
    const items = all
      .filter(t => t.date === this.date)
      .sort((a, b) => (a.ts || a.createdAt || 0) - (b.ts || b.createdAt || 0));

    const digest = await this.getDigest(this.date);
    const isToday = this.date === todayStr();

    content.innerHTML = `
      ${this.renderDateNav(items.length, all)}
      ${isToday ? this.renderComposer() : ''}
      ${this.renderDigest(digest, items.length, isToday)}
      ${this.renderTimeline(items)}
      ${!isToday ? this.renderPastHint() : ''}
    `;

    if (isToday) this.bindComposer();
  },

  // ===== 日期导航 =====

  renderDateNav(count, all) {
    const isToday = this.date === todayStr();
    const d = new Date(this.date + 'T12:00:00');
    const weekdays = ['星期日', '星期一', '星期二', '星期三', '星期四', '星期五', '星期六'];
    const dateText = `${d.getMonth() + 1}月${d.getDate()}日 ${weekdays[d.getDay()]}`;
    const totalDays = new Set((all || []).map(t => t.date)).size;

    return `
      <div class="th-datenav">
        <button class="th-nav-arrow" onclick="Thoughts.shiftDate(-1)" title="前一天">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
        </button>
        <div class="th-datenav-center">
          <div class="th-datenav-date">${isToday ? '今天 · ' : ''}${dateText}</div>
          <div class="th-datenav-sub">${count > 0 ? `记下 ${count} 条随想` : '这天还没有记录'}</div>
        </div>
        <button class="th-nav-arrow ${isToday ? 'disabled' : ''}" onclick="Thoughts.shiftDate(1)" title="后一天">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
        </button>
        <button class="th-nav-arrow" onclick="Thoughts.openArchive()" title="全部记录">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v4H4z"/><path d="M5 8v12h14V8"/><line x1="10" y1="13" x2="14" y2="13"/></svg>
          ${totalDays > 0 ? `<span class="th-nav-badge">${totalDays}</span>` : ''}
        </button>
      </div>
    `;
  },

  // ===== AI 日终整合卡片（版本D：阶段式·全浅粉） =====

  renderDigest(digest, count, isToday) {
    if (!digest) {
      if (count === 0) return '';
      return `
        <div class="th-digest th-digest-pending">
          <div class="th-digest-pending-icon">🌙</div>
          <div>
            <div class="th-digest-pending-title">${isToday ? '今日 12:00 自动整合' : '这天暂无整合'}</div>
            <div class="th-digest-pending-sub">${isToday
              ? '午间会把今天这些碎片串成一篇日终思考'
              : '当天没有生成整合，可让 AI 补算'}</div>
          </div>
        </div>
      `;
    }

    const open = this.digestOpen;
    const stages = digest.stages || [];

    // 版本D：把一个阶段渲染成一个卡片
    // 只有「洞察/延伸/落地」标签词本身带粉底，summary和detail都是纯文本
    const stageCard = (st) => {
      const tags = [];
      (st.insights || []).forEach(s => {
        const head = s.summary ? esc(s.summary) + ' — ' : '';
        tags.push(`<div class="th-dg-item"><span class="th-dg-tag">洞察</span>${head}${esc(s.detail || '')}</div>`);
      });
      (st.extensions || []).forEach(s => {
        const head = s.summary ? esc(s.summary) + ' — ' : '';
        tags.push(`<div class="th-dg-item"><span class="th-dg-tag">延伸</span>${head}${esc(s.detail || '')}</div>`);
      });
      (st.actions || []).forEach(a => {
        const t = a.text || (typeof a === 'string' ? a : '');
        const body = a.why ? (t ? esc(t) + ' — ' + esc(a.why) : esc(a.why)) : esc(t);
        tags.push(`<div class="th-dg-item"><span class="th-dg-tag">落地</span>${body}</div>`);
      });

      return `
        <div class="th-dg-stage">
          ${st.time ? `<div class="th-dg-stage-time">${esc(st.time)}</div>` : ''}
          <span class="th-dg-stage-name">${esc(st.name || '')}</span>
          ${tags.length ? `<div class="th-dg-stage-tags">${tags.join('')}</div>` : ''}
        </div>`;
    };

    const body = `
      ${digest.summary ? `<div class="th-dg-summary">${esc(digest.summary)}</div>` : ''}
      ${stages.map(stageCard).join('')}
      ${digest.mood && (digest.mood.summary || digest.mood.detail) ? `<div class="th-dg-mood">🎐 ${esc(digest.mood.summary || '')}${digest.mood.detail ? ' — ' + esc(digest.mood.detail) : ''}</div>` : ''}
      ${digest.note ? `<div class="th-dg-note">${esc(digest.note)}</div>` : ''}
      ${digest.keyword ? `<div style="text-align:right"><span class="th-dg-keyword"># ${esc(digest.keyword)}</span></div>` : ''}
    `;

    return `
      <div class="th-digest">
        <div class="th-dg-head" onclick="Thoughts.toggleDigest()">
          <div class="th-dg-head-left">
            <span class="th-dg-badge">日终整合</span>
            <span class="th-dg-title">${esc(digest.title || '这一天的思考')}</span>
          </div>
          <span class="th-dg-toggle ${open ? 'open' : ''}">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>
          </span>
        </div>
        <div class="th-dg-body ${open ? '' : 'collapsed'}">${body}</div>
        <div class="th-dg-foot">
          ${digest.count ? `基于 ${digest.count} 条随想` : ''}${digest.generatedAt ? ` · ${fmtDateTime(digest.generatedAt)} 生成` : ''}
        </div>
      </div>
    `;
  },

  toggleDigest() {
    this.digestOpen = !this.digestOpen;
    const body = document.querySelector('.th-dg-body');
    const tog = document.querySelector('.th-dg-toggle');
    if (body) body.classList.toggle('collapsed', !this.digestOpen);
    if (tog) tog.classList.toggle('open', this.digestOpen);
  },

  // ===== 时间轴 =====

  renderTimeline(items) {
    if (!items.length) {
      return `<div class="empty"><div class="empty-icon">🫧</div><div class="empty-text">${
        this.date === todayStr() ? '此刻在想什么？在下面写一句' : '这天没有留下随想'
      }</div></div>`;
    }
    return `
      <div class="th-timeline">
        ${items.map(t => {
          const k = this.kindOf(t.kind);
          const time = t.time || (t.ts ? fmtDateTime(t.ts).slice(11) : '');
          return `
            <div class="th-item" onclick="Thoughts.openEdit(${t.id})">
              <div class="th-item-time">
                <span class="th-item-hm">${esc(time)}</span>
                <span class="th-item-dot"></span>
              </div>
              <div class="th-item-body">
                <span class="th-item-kind" title="${k.label}">${k.icon}</span>
                <span class="th-item-text">${esc(t.text || '')}</span>
              </div>
            </div>`;
        }).join('')}
      </div>
    `;
  },

  renderPastHint() {
    return `<div class="th-past-hint" onclick="Thoughts.gotoToday()">← 回到今天继续记录</div>`;
  },

  // ===== 底部快速录入 =====

  renderComposer() {
    return `
      <div class="card th-composer">
        <div class="th-composer-row">
          <textarea class="textarea th-input" id="th_input" rows="1"
            placeholder="此刻在想什么"></textarea>
          <button class="btn btn-primary th-save" onclick="Thoughts.quickSave()">记下</button>
        </div>
        <div class="th-kinds">
          ${this.KINDS.map(k => `
            <button class="th-kind ${this.kind === k.key ? 'active' : ''}" data-kind="${k.key}" onclick="Thoughts.setKind('${k.key}')">
              ${k.icon} ${k.label}
            </button>`).join('')}
        </div>
      </div>
    `;
  },

  bindComposer() {
    const el = document.getElementById('th_input');
    if (!el) return;
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        Thoughts.quickSave();
      }
    });
    el.addEventListener('input', () => Thoughts.autoGrow(el));
    Thoughts.autoGrow(el);
  },

  autoGrow(el) {
    el.style.height = 'auto';
    const lh = parseInt(getComputedStyle(el).lineHeight, 10) || 22;
    const min = lh + 16;     // 1 行起
    const max = lh * 6 + 16; // 最多 6 行
    el.style.height = Math.min(Math.max(el.scrollHeight, min), max) + 'px';
  },

  nowHM() {
    const d = new Date();
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  },

  setKind(k) {
    this.kind = k;
    document.querySelectorAll('.th-composer .th-kind').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.kind === k);
    });
    const el = document.getElementById('th_input');
    if (el) el.focus();
  },

  async quickSave() {
    const el = document.getElementById('th_input');
    if (!el) return;
    const text = el.value.trim();
    if (!text) return toast('先写点什么吧');

    const now = Date.now();
    await window.DB.add('thoughts', {
      date: todayStr(),
      time: this.nowHM(),
      ts: now,
      kind: this.kind,
      text
    });

    el.value = '';
    this.date = todayStr();
    toast('已记下 · ' + this.nowHM());
    await this.render();
    setTimeout(() => {
      const n = document.getElementById('th_input');
      if (n) { n.focus(); n.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    }, 60);
  },

  // ===== 编辑 / 删除 =====

  openEdit(id) {
    (async () => {
      const t = await window.DB.get('thoughts', id);
      if (!t) return;
      showModal({
        title: `${t.time || ''} 的随想`,
        body: `
          <div class="form-group">
            <div class="th-kinds th-kinds-modal">
              ${this.KINDS.map(k => `
                <button class="th-kind ${t.kind === k.key ? 'active' : ''}" data-kind="${k.key}"
                  onclick="Thoughts._pickKind(this)">${k.icon} ${k.label}</button>`).join('')}
            </div>
          </div>
          <div class="form-group">
            <textarea class="textarea" id="th_edit_text" rows="6">${esc(t.text || '')}</textarea>
          </div>
          <div class="form-group">
            <label class="form-label">时刻</label>
            <input class="input" id="th_edit_time" type="time" value="${esc(t.time || '')}" />
          </div>
        `,
        footer: `
          <button class="btn btn-danger" id="th_del">删除</button>
          <button class="btn btn-ghost" onclick="hideModal()">取消</button>
          <button class="btn btn-primary" id="th_save">保存</button>
        `
      });
      setTimeout(() => {
        document.getElementById('th_save').onclick = async () => {
          const text = document.getElementById('th_edit_text').value.trim();
          if (!text) return toast('内容不能为空');
          const time = document.getElementById('th_edit_time').value || t.time;
          const active = document.querySelector('.th-kinds-modal .th-kind.active');
          const kind = active ? active.dataset.kind : (t.kind || 'idea');
          await window.DB.put('thoughts', { ...t, text, time, kind });
          hideModal();
          toast('已更新');
          Thoughts.render();
        };
        document.getElementById('th_del').onclick = async () => {
          const ok = await confirmDialog('删除这条随想？');
          if (!ok) return;
          await window.DB.delete('thoughts', id);
          hideModal();
          toast('已删除');
          Thoughts.render();
        };
      }, 50);
    })();
  },

  _pickKind(btn) {
    document.querySelectorAll('.th-kinds-modal .th-kind').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
  },

  // ===== 日期切换 / 归档 =====

  shiftDate(delta) {
    const d = new Date(this.date + 'T12:00:00');
    d.setDate(d.getDate() + delta);
    const next = fmtDate(d.getTime());
    if (next > todayStr()) return toast('已经是今天了');
    this.date = next;
    this.digestOpen = true;
    this.render();
  },

  gotoToday() {
    this.date = todayStr();
    this.render();
  },

  async openArchive() {
    const all = await window.DB.getAll('thoughts');
    const digests = await window.DB.getAll('thought_digests');
    const digestDates = new Set(digests.map(d => d.date));

    const byDate = {};
    all.forEach(t => {
      if (!byDate[t.date]) byDate[t.date] = 0;
      byDate[t.date]++;
    });
    const dates = Object.keys(byDate).sort().reverse();

    showModal({
      title: '全部随想',
      body: dates.length === 0
        ? '<p class="text-sub" style="text-align:center;padding:20px 0">还没有任何记录</p>'
        : `<div class="th-archive">
            ${dates.map(d => `
              <div class="th-arc-item ${d === this.date ? 'current' : ''}" onclick="Thoughts.jumpTo('${d}')">
                <div class="th-arc-date">${d}${d === todayStr() ? ' · 今天' : ''}</div>
                <div class="th-arc-meta">
                  <span class="th-arc-count">${byDate[d]} 条</span>
                  ${digestDates.has(d) ? '<span class="th-arc-flag">已整合</span>' : ''}
                </div>
              </div>`).join('')}
          </div>`,
      footer: '<button class="btn btn-primary" onclick="hideModal()">关闭</button>'
    });
  },

  jumpTo(date) {
    this.date = date;
    this.digestOpen = true;
    hideModal();
    this.render();
  },

  // ===== 整合数据读取 =====

  async getDigest(date) {
    try {
      const all = await window.DB.getAll('thought_digests');
      const hits = all.filter(d => d.date === date);
      if (!hits.length) return null;
      // 多设备可能生成多份，取最新
      hits.sort((a, b) => (b.generatedAt || b.updatedAt || 0) - (a.generatedAt || a.updatedAt || 0));
      return hits[0];
    } catch (e) {
      console.warn('读取日终整合失败:', e.message);
      return null;
    }
  },

  // 供 FAB 兼容调用
  openAdd() {
    this.gotoToday();
    setTimeout(() => {
      const el = document.getElementById('th_input');
      if (el) { el.focus(); el.scrollIntoView({ behavior: 'smooth', block: 'center' }); }
    }, 100);
  }
};

window.Thoughts = Thoughts;
