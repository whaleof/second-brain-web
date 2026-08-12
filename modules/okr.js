// modules/okr.js - 目标 / OKR 看板（Objective + Key Results）
// 数据落 IndexedDB（okr），随局域网同步多端互通。

const OKR_SEEDED_KEY = 'okr_seeded';

const OKR = {
  _form: null,

  async render() {
    const content = document.getElementById('content');
    const list = await this.load();
    // 加载习惯与打卡记录，用于「关键结果 ↔ 习惯」联动
    this._habits = await window.DB.getAll('habits');
    this._logs = await window.DB.getAll('habit_logs');
    if (!localStorage.getItem(OKR_SEEDED_KEY)) {
      if (list.length === 0) await this.seed();
      localStorage.setItem(OKR_SEEDED_KEY, '1');
      return this.render();
    }

    // 自动把未关联、但标题包含习惯名的 KR 关联到对应习惯（仅一次）
    let dirty = false;
    for (const o of list) {
      for (const k of (o.keyResults || [])) {
        if (!k.habitGid) {
          const hit = this._habits.find(h => h.name && (k.title || '').includes(h.name));
          if (hit) { k.habitGid = hit.gid; k.period = k.period || 'weekly'; dirty = true; }
        }
      }
      if (dirty) await window.DB.put('okr', o);
    }

    let html = `
      <div class="card" style="padding:14px;display:flex;align-items:center;justify-content:space-between;margin-bottom:12px">
        <div>
          <div style="font-weight:700;font-size:16px">🎯 我的目标</div>
          <div class="text-xs text-sub">关联习惯后，关键结果随打卡自动更新</div>
        </div>
        <button class="btn btn-primary btn-sm" onclick="OKR.openForm()">+ 新建</button>
      </div>`;

    if (list.length === 0) {
      html += `<div class="empty"><div class="empty-icon">🎯</div><div class="empty-text">还没有目标，点右上角新建一个</div></div>`;
      content.innerHTML = html;
      return;
    }

    html += list.map(o => this.objCard(o)).join('');
    content.innerHTML = html;
  },

  async load() {
    const list = await window.DB.getAll('okr');
    return list.sort((a, b) => (a.order || 0) - (b.order || 0));
  },

  // KR 当前值：关联习惯时，按周期内打卡次数计算；否则取手动值
  krCurrent(k) {
    if (k.habitGid && this._habits && this._logs) {
      const habit = this._habits.find(h => h.gid === k.habitGid);
      return this.countInPeriod(habit, k.period || 'weekly', this._logs);
    }
    return k.current || 0;
  },

  // 统计某习惯在周期(本周/本月)内完成的次数
  countInPeriod(habit, period, logs) {
    if (!habit) return 0;
    const now = new Date();
    let start, end;
    if (period === 'monthly') {
      start = new Date(now.getFullYear(), now.getMonth(), 1);
      end = new Date(now.getFullYear(), now.getMonth() + 1, 1);
    } else { // weekly：周一为起点
      const d = new Date(now); d.setHours(0, 0, 0, 0);
      const day = (d.getDay() + 6) % 7; d.setDate(d.getDate() - day);
      start = d; end = new Date(d); end.setDate(end.getDate() + 7);
    }
    const s = fmtDate(start.getTime()), e = fmtDate(end.getTime());
    return logs.filter(l =>
      (l.habitGid === habit.gid || l.habitId === habit.id) &&
      l.date >= s && l.date < e &&
      (l.done || (l.value || 0) > 0)
    ).length;
  },

  progress(o) {
    const krs = o.keyResults || [];
    if (!krs.length) return 0;
    const sum = krs.reduce((s, k) => s + Math.min(1, this.krCurrent(k) / (k.target || 1)), 0);
    return sum / krs.length;
  },

  objCard(o) {
    const pct = Math.round(this.progress(o) * 100);
    const krs = o.keyResults || [];
    return `<div class="card" style="padding:14px;margin-bottom:12px;border-left:4px solid #E79BB0">
      <div style="display:flex;align-items:flex-start;gap:8px">
        <div style="flex:1;min-width:0">
          <div style="font-weight:700;font-size:16px">${esc(o.title)}</div>
          ${o.desc ? `<div class="text-xs text-sub" style="margin-top:3px">${esc(o.desc)}</div>` : ''}
        </div>
        <button class="tl-clear-btn" onclick="OKR.delObj(${o.id})">✕</button>
      </div>

      <div style="display:flex;align-items:center;gap:10px;margin:10px 0">
        <div style="flex:1;height:8px;border-radius:8px;background:#F2E7EB;overflow:hidden">
          <i style="display:block;height:100%;width:${pct}%;background:#E79BB0;border-radius:8px"></i>
        </div>
        <b style="color:#C9607F;font-size:14px">${pct}%</b>
        <button class="btn btn-secondary btn-sm" onclick="OKR.openForm(${o.id})">编辑</button>
      </div>

      ${(krs.length ? `<div style="border-top:1px dashed #EADFE4;padding-top:8px">` : '') + krs.map((k, i) => this.krRow(o, k, i)).join('') + (krs.length ? `</div>` : '')}
    </div>`;
  },

  krRow(o, k, i) {
    const cur = this.krCurrent(k);
    const pct = Math.min(100, Math.round(cur / (k.target || 1) * 100));
    const step = Math.max(1, Math.round((k.target || 1) / 10));
    const linked = !!k.habitGid;
    const habitName = linked && this._habits ? (this._habits.find(h => h.gid === k.habitGid) || {}).name : '';
    const periodTxt = k.period === 'monthly' ? '本月' : '本周';
    return `<div style="display:flex;align-items:center;gap:8px;padding:6px 0">
      <span style="flex:1;min-width:0">
        <span style="font-size:14px">${esc(k.title)}</span>
        ${linked ? `<span class="tag" style="background:#E8F1EC;color:#5E9C82;margin-left:4px;font-size:11px">🔗 ${esc(habitName)}·${periodTxt}</span>` : ''}
        <span class="text-xs text-sub"> ${cur}/${k.target || 0}${k.unit ? ' ' + esc(k.unit) : ''}</span>
      </span>
      <div style="flex:1;height:6px;border-radius:6px;background:#F2E7EB;overflow:hidden;min-width:40px">
        <i style="display:block;height:100%;width:${pct}%;background:#9CC4B8;border-radius:6px"></i>
      </div>
      ${linked
        ? `<span class="text-xs text-sub" style="white-space:nowrap">自动</span>`
        : `<button class="tl-step" style="width:28px;height:28px;border-radius:8px;border:none;background:#F2E7EB;color:#7A5C68;font-size:16px;font-weight:700;cursor:pointer" onclick="OKR.adjKr(${o.id},${i},-${step})">−</button>
           <button class="tl-step" style="width:28px;height:28px;border-radius:8px;border:none;background:#F2E7EB;color:#7A5C68;font-size:16px;font-weight:700;cursor:pointer" onclick="OKR.adjKr(${o.id},${i},${step})">+</button>`}
    </div>`;
  },

  async adjKr(objId, idx, delta) {
    const list = await this.load();
    const o = list.find(x => x.id === objId);
    if (!o || !o.keyResults[idx]) return;
    if (o.keyResults[idx].habitGid) { toast('关联习惯的关键结果随打卡自动更新'); return; }
    o.keyResults[idx].current = Math.max(0, (o.keyResults[idx].current || 0) + delta);
    await window.DB.put('okr', o);
    this.render();
  },

  async openForm(id) {
    let o = null;
    if (id) o = (await this.load()).find(x => x.id === id);
    this._form = o ? {
      title: o.title, desc: o.desc || '',
      krs: (o.keyResults || []).map(k => ({ ...k }))
    } : { title: '', desc: '', krs: [{ title: '', target: 1, current: 0, unit: '', habitGid: '', period: 'weekly' }] };
    this._formHabits = await window.DB.getAll('habits');

    showModal({
      title: o ? '编辑目标' : '新建目标',
      body: `
        <div class="form-group">
          <label class="form-label">目标名称</label>
          <input class="input" id="okr_title" value="${esc(this._form.title)}" placeholder="比如：三个月学会游泳" autocomplete="off" />
        </div>
        <div class="form-group">
          <label class="form-label">描述（可选）</label>
          <input class="input" id="okr_desc" value="${esc(this._form.desc)}" placeholder="一句话说明意义" autocomplete="off" />
        </div>
        <div class="form-group">
          <label class="form-label">关键结果 (KR)</label>
          <div id="okr_krs">${this.krEditor()}</div>
          <button class="btn btn-secondary btn-sm" style="margin-top:6px" onclick="OKR.addKr()">+ 添加关键结果</button>
          <p class="text-xs text-sub" style="margin-top:6px">提示：给 KR 选择「关联习惯」后，进度会随该习惯在本周/本月的打卡次数自动计算。</p>
        </div>
      `,
      footer: `
        <button class="btn btn-ghost" onclick="hideModal()">取消</button>
        <button class="btn btn-primary" id="okr_save">保存</button>
      `
    });
    setTimeout(() => { document.getElementById('okr_save').onclick = () => this.saveForm(o); }, 80);
  },

  krEditor() {
    const habitOpts = (sel) => `<option value="">不关联</option>` +
      (this._formHabits || []).map(h => `<option value="${esc(h.gid)}" ${sel === h.gid ? 'selected' : ''}>${esc(h.name)}</option>`).join('');
    return this._form.krs.map((k, i) => {
      const linked = !!k.habitGid;
      return `
      <div class="okr-kr-row" data-idx="${i}" style="border:1px solid #EADFE4;border-radius:10px;padding:8px;margin-bottom:8px">
        <div style="display:flex;gap:6px;align-items:center;margin-bottom:6px">
          <input class="input" data-f="title" value="${esc(k.title)}" placeholder="关键结果" style="flex:3;min-width:0" />
          <input class="input" data-f="target" type="number" min="0" value="${k.target}" placeholder="目标次数" style="flex:1.4;min-width:0" />
          <input class="input" data-f="unit" value="${esc(k.unit)}" placeholder="单位" style="flex:1;min-width:0" />
          <button class="tl-clear-btn" onclick="OKR.removeKr(${i})">✕</button>
        </div>
        <div style="display:flex;gap:6px;align-items:center">
          <select class="select" data-f="habitGid" onchange="OKR.onKrHabitChange(${i})" style="flex:2;min-width:0;font-size:13px">${habitOpts(k.habitGid)}</select>
          <select class="select" data-f="period" ${linked ? '' : 'disabled'} style="flex:1.4;min-width:0;font-size:13px">
            <option value="weekly" ${(k.period || 'weekly') === 'weekly' ? 'selected' : ''}>本周</option>
            <option value="monthly" ${(k.period || 'weekly') === 'monthly' ? 'selected' : ''}>本月</option>
          </select>
        </div>
      </div>`;
    }).join('');
  },

  onKrHabitChange(i) {
    this.syncKrFromDom();
    const row = document.querySelector(`#okr_krs .okr-kr-row[data-idx="${i}"]`);
    if (!row) return;
    const sel = row.querySelector('[data-f="habitGid"]');
    const linked = !!sel.value;
    row.querySelector('[data-f="period"]').disabled = !linked;
  },

  // 在刷新编辑器前，先把 DOM 里的输入值同步回 _form.krs
  syncKrFromDom() {
    const rows = document.querySelectorAll('#okr_krs .okr-kr-row');
    rows.forEach((row, i) => {
      if (!this._form.krs[i]) this._form.krs[i] = { title: '', target: 1, current: 0, unit: '', habitGid: '', period: 'weekly' };
      const get = f => { const el = row.querySelector(`[data-f="${f}"]`); return el ? el.value : ''; };
      const linked = !!get('habitGid');
      this._form.krs[i].title = get('title');
      this._form.krs[i].target = parseFloat(get('target')) || 0;
      this._form.krs[i].habitGid = get('habitGid');
      this._form.krs[i].period = get('period') || 'weekly';
      this._form.krs[i].unit = get('unit');
    });
  },

  refreshKrEditor() {
    this.syncKrFromDom();
    const box = document.getElementById('okr_krs');
    if (box) box.innerHTML = this.krEditor();
  },
  addKr() {
    this.syncKrFromDom();
    this._form.krs.push({ title: '', target: 1, current: 0, unit: '', habitGid: '', period: 'weekly' });
    this.refreshKrEditor();
  },
  removeKr(i) {
    this.syncKrFromDom();
    this._form.krs.splice(i, 1);
    const box = document.getElementById('okr_krs');
    if (box) box.innerHTML = this.krEditor();
  },

  async saveForm(o) {
    const title = document.getElementById('okr_title').value.trim();
    if (!title) { toast('请输入目标名称'); return; }
    const desc = document.getElementById('okr_desc').value.trim();
    const krs = [];
    document.querySelectorAll('#okr_krs .okr-kr-row').forEach(row => {
      const get = f => row.querySelector(`[data-f="${f}"]`).value;
      const t = get('title').trim();
      if (!t) return;
      const habitGid = get('habitGid') || '';
      krs.push({
        title: t,
        target: Math.max(0, parseFloat(get('target')) || 0),
        habitGid,
        period: habitGid ? (get('period') || 'weekly') : '',
        current: 0,
        unit: get('unit').trim()
      });
    });
    const data = { title, desc, deadline: '', keyResults: krs, order: o ? o.order : 999 };
    if (o) await window.DB.put('okr', { ...o, ...data });
    else await window.DB.add('okr', data);
    hideModal();
    toast('已保存');
    this.render();
  },

  async delObj(id) {
    const ok = await confirmDialog('删除这个目标？');
    if (!ok) return;
    const obj = await window.DB.get('okr', id);
    await window.DB.delete('okr', id);
    if (obj && obj.gid) {
      try { await window.DB._addTombstoneIfNewer({ gid: obj.gid, storeName: 'okr', deletedAt: Date.now() }); }
      catch (e) { console.warn('tombstone 失败', e); }
    }
    toast('已删除');
    this.render();
  },

  async seed() {
    await window.DB.add('okr', {
      title: '清爽出门计划',
      desc: '把自己收拾干净，愿意走出去',
      order: 1,
      keyResults: [
        { title: '每周洗头', target: 3, current: 0, unit: '次' },
        { title: '每周洗澡', target: 5, current: 0, unit: '次' },
        { title: '每周外出', target: 2, current: 0, unit: '次' }
      ]
    });
    await window.DB.add('okr', {
      title: '舞蹈基本功',
      desc: '用固定练习堆出身体记忆',
      order: 2,
      keyResults: [
        { title: '每周练舞', target: 3, current: 0, unit: '次' },
        { title: '单次练舞 ≥30 分钟', target: 3, current: 0, unit: '次' },
        { title: '连续练舞周数', target: 4, current: 0, unit: '周' }
      ]
    });
  }
};

window.OKR = OKR;
