// modules/drinks.js - 饮品记录模块 (日历 + 类型图标)
const Drinks = {
  currentDate: todayStr(),
  currentMonth: new Date().getMonth(),
  currentYear: new Date().getFullYear(),
  types: [
    { key: 'milktea', label: '奶茶', icon: 'milktea', color: '#D4A574' },
    { key: 'coffee',  label: '咖啡', icon: 'coffee', color: '#6F4E37' },
    { key: 'fruit',   label: '果茶', icon: 'fruit', color: '#F4A460' },
    { key: 'other',   label: '其他', icon: 'other', color: '#8FB8E0' }
  ],

  // 简洁线条风 SVG 图标 (参考侧边栏 Lucide 风格)
  iconSVG(type, size) {
    const s = size || 24;
    const sw = 2; // stroke-width 统一
    const svgs = {
      // 奶茶：杯子 + 封口 + 吸管 + 珍珠
      milktea: `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="#C4956A" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8h14l-1 11a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 8z"/><line x1="4" y1="8" x2="20" y2="8"/><line x1="15" y1="3" x2="13" y2="8"/><circle cx="10" cy="14" r="1" fill="#C4956A"/><circle cx="14" cy="16" r="1" fill="#C4956A"/><circle cx="9" cy="18" r="0.8" fill="#C4956A"/></svg>`,
      // 咖啡：杯子 + 把手 + 热气
      coffee: `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="#8B6914" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"><path d="M5 10h12v7a3 3 0 0 1-3 3H8a3 3 0 0 1-3-3v-7z"/><path d="M17 11h2a3 3 0 0 1 0 6h-2"/><path d="M8 3c0 1-1 1.5-1 2.5S8 7 8 8"/><path d="M12 3c0 1-1 1.5-1 2.5S12 7 12 8"/><path d="M16 3c0 1-1 1.5-1 2.5S16 7 16 8"/></svg>`,
      // 果茶(青提)：杯子 + 吸管 + 青提圆球
      fruit: `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="#7BC4A4" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"><path d="M5 8h14l-1 11a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 8z"/><line x1="4" y1="8" x2="20" y2="8"/><line x1="15" y1="3" x2="13" y2="8"/><circle cx="10" cy="13" r="1.5" fill="none"/><circle cx="14" cy="15" r="1.5" fill="none"/><circle cx="10" cy="17" r="1.2" fill="none"/></svg>`,
      // 其他：饮料杯 + 吸管
      other: `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="#5C8FBF" stroke-width="${sw}" stroke-linecap="round" stroke-linejoin="round"><path d="M7 8h10l-1 12a2 2 0 0 1-2 2H10a2 2 0 0 1-2-2L7 8z"/><line x1="6" y1="8" x2="18" y2="8"/><line x1="14" y1="3" x2="12" y2="8"/><line x1="9" y1="13" x2="15" y2="13"/></svg>`
    };
    return svgs[type] || svgs.other;
  },

  // 爱心 SVG（评分用，filled=true 为实心粉心）
  heartSVG(filled, size) {
    const s = size || 24;
    if (filled) {
      return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="#F4688B" stroke="#F4688B" stroke-width="1.4" stroke-linejoin="round"><path d="M12 20.5C12 20.5 3.5 15 3.5 9.2 3.5 6.3 5.6 4.5 8 4.5c1.8 0 3.1 1 4 2.2 0.9-1.2 2.2-2.2 4-2.2 2.4 0 4.5 1.8 4.5 4.7C20.5 15 12 20.5 12 20.5z"/></svg>`;
    }
    return `<svg width="${s}" height="${s}" viewBox="0 0 24 24" fill="none" stroke="#D8C4C9" stroke-width="1.4" stroke-linejoin="round"><path d="M12 20.5C12 20.5 3.5 15 3.5 9.2 3.5 6.3 5.6 4.5 8 4.5c1.8 0 3.1 1 4 2.2 0.9-1.2 2.2-2.2 4-2.2 2.4 0 4.5 1.8 4.5 4.7C20.5 15 12 20.5 12 20.5z"/></svg>`;
  },

  // 渲染 5 颗爱心
  renderHearts(count, size) {
    const n = size || 16;
    let html = '';
    for (let i = 1; i <= 5; i++) {
      html += this.heartSVG(i <= count, n);
    }
    return html;
  },

  // 添加页评分选择（点同一颗可取消）
  setRating(k) {
    Drinks._rating = (Drinks._rating === k) ? 0 : k;
    const box = document.getElementById('dr_rating');
    if (box) box.innerHTML = [1,2,3,4,5].map(n => `<span class="drink-heart" onclick="Drinks.setRating(${n})">${Drinks.heartSVG(n <= Drinks._rating, 24)}</span>`).join('');
  },

  async render() {
    const content = document.getElementById('content');
    try {
      const records = await window.DB.getAll('drink_records');
      // 当月记录
      const monthRecords = records.filter(r => {
        const d = new Date(r.date + 'T00:00:00');
        return d.getFullYear() === this.currentYear && d.getMonth() === this.currentMonth;
      });
      // 当天记录
      const todayRecords = records.filter(r => r.date === this.currentDate);
      // 当月有记录的日期集合
      const markedDates = new Set(monthRecords.map(r => r.date));

      content.innerHTML = `
        <!-- 月份切换 -->
        <div class="card" style="padding:12px">
          <div class="row-between" style="margin-bottom:10px">
            <button class="btn btn-secondary btn-sm" onclick="Drinks.prevMonth()"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg></button>
            <span style="font-size:16px;font-weight:700">${this.currentYear}年 ${this.currentMonth + 1}月</span>
            <button class="btn btn-secondary btn-sm" onclick="Drinks.nextMonth()"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></button>
          </div>
          <!-- 日历 -->
          ${this.renderCalendar(markedDates, monthRecords)}
        </div>

        <!-- 当天记录 -->
        <div class="card" style="padding:12px">
          <div class="card-title" style="margin-bottom:8px">
            <span>${this.currentDate === todayStr() ? '今天' : this.currentDate} 的饮品</span>
            <span class="drinks-add-btn" onclick="Drinks.openAdd()">+ 添加</span>
          </div>
          ${todayRecords.length === 0 ? `
            <div class="empty" style="padding:24px 20px">
              <div class="empty-icon">🥤</div>
              <div class="empty-text">今天还没喝饮品</div>
            </div>
          ` : todayRecords.sort((a,b) => b.time.localeCompare(a.time)).map(r => this.renderRecord(r)).join('')}
        </div>

        <!-- 当月统计 -->
        <div class="stat-grid" style="grid-template-columns:repeat(4,1fr);gap:6px">
          ${this.types.map(t => {
            const count = monthRecords.filter(r => r.type === t.key).length;
            return `<div class="stat-card" style="padding:10px 8px;text-align:center">
              <div style="display:flex;justify-content:center">${this.iconSVG(t.icon, 24)}</div>
              <div class="stat-value" style="font-size:20px;color:${t.color}">${count}</div>
              <div class="stat-label" style="font-size:10px">${t.label}</div>
            </div>`;
          }).join('')}
        </div>
      `;
    } catch (err) {
      content.innerHTML = `<div class="empty"><div class="empty-icon">⚠️</div><div class="empty-text">加载失败</div></div>`;
    }
  },

  renderCalendar(markedDates, monthRecords) {
    const daysInMonth = new Date(this.currentYear, this.currentMonth + 1, 0).getDate();
    const firstDay = new Date(this.currentYear, this.currentMonth, 1).getDay(); // 0=Sun
    const today = todayStr();
    let html = '<div class="drink-calendar">';
    // 星期头
    const dayNames = ['日', '一', '二', '三', '四', '五', '六'];
    dayNames.forEach(d => { html += `<div class="drink-cal-header">${d}</div>`; });
    // 空白格
    for (let i = 0; i < firstDay; i++) { html += '<div class="drink-cal-day empty"></div>'; }
    // 日期格
    for (let day = 1; day <= daysInMonth; day++) {
      const dateStr = `${this.currentYear}-${String(this.currentMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const isToday = dateStr === today;
      const isSelected = dateStr === this.currentDate;
      const isMarked = markedDates.has(dateStr);
      // 获取该日期的类型图标（手绘风小圆点）
      const dayRecs = monthRecords.filter(r => r.date === dateStr);
      const dayTypes = [...new Set(dayRecs.map(r => r.type))].map(k => {
        const t = this.types.find(x => x.key === k);
        return t ? t.color : '';
      }).filter(Boolean).slice(0, 3);
      const dotsHtml = dayTypes.map(c => `<span class="drink-cal-dot" style="background:${c}"></span>`).join('');
      html += `<div class="drink-cal-day ${isToday ? 'today' : ''} ${isSelected ? 'selected' : ''} ${isMarked ? 'marked' : ''}" onclick="Drinks.selectDate('${dateStr}')">
        <span class="drink-cal-num">${day}</span>
        ${dotsHtml ? `<span class="drink-cal-icons">${dotsHtml}</span>` : ''}
      </div>`;
    }
    html += '</div>';
    return html;
  },

  renderRecord(r) {
    const t = this.types.find(x => x.key === r.type);
    const hearts = r.rating ? `<span class="drink-hearts" style="display:inline-flex;align-items:center;gap:1px;vertical-align:middle">${this.renderHearts(r.rating, 16)}</span>` : '';
    const priceTag = r.price ? `<span style="color:#F4688B;font-weight:700;white-space:nowrap">¥${parseFloat(r.price).toFixed(2)}</span>` : '';
    const brand = r.brand ? `<span class="tag" style="background:${t?.color || '#B5B5B5'}18;color:${t?.color || '#888'};margin-right:6px;white-space:nowrap;flex-shrink:0">${esc(r.brand)}</span>` : '';
    const time = r.time ? `<span class="text-xs text-sub" style="white-space:nowrap;flex-shrink:0">${r.time}</span>` : '';
    return `<div class="drink-record-item" onclick="Drinks.openEdit(${r.id})" title="点击编辑" style="cursor:pointer">
      <div class="drink-record-icon">${this.iconSVG(t?.icon || 'other', 28)}</div>
      <div class="drink-record-info" style="flex:1;min-width:0">
        <div class="drink-record-name" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${esc(r.name || '未知')}</div>
        <div class="drink-record-meta" style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:4px">
          <span style="display:inline-flex;align-items:center;gap:6px;min-width:0;overflow:hidden">${brand}</span>
          ${time}
        </div>
        <div class="drink-record-meta" style="display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:4px">
          <span style="display:inline-flex;align-items:center;gap:6px;min-width:0;overflow:hidden">${hearts}</span>
          ${priceTag}
        </div>
      </div>
      <button class="tl-clear-btn" onclick="event.stopPropagation();Drinks.deleteRecord(${r.id})">✕</button>
    </div>`;
  },

  selectDate(dateStr) {
    this.currentDate = dateStr;
    this.render();
  },

  prevMonth() {
    if (this.currentMonth === 0) { this.currentMonth = 11; this.currentYear--; }
    else { this.currentMonth--; }
    this.render();
  },

  nextMonth() {
    if (this.currentMonth === 11) { this.currentMonth = 0; this.currentYear++; }
    else { this.currentMonth++; }
    this.render();
  },

  // 公共表单体（新增/编辑复用）
  formBody(r) {
    const now = new Date();
    const timeStr = r ? (r.time || '')
      : `${String(now.getHours()).padStart(2,'0')}:${String(now.getMinutes()).padStart(2,'0')}`;
    const type = r ? (r.type || 'milktea') : 'milktea';
    const rating = r ? (r.rating || 0) : (Drinks._rating || 0);
    return `
      <div class="form-group">
        <label class="form-label">名称</label>
        <input class="input" id="dr_name" placeholder="比如：伯牙绝弦、生椰拿铁..." value="${r ? esc(r.name || '') : ''}" autocomplete="off" />
      </div>
      <div class="form-group">
        <label class="form-label">品牌</label>
        <input class="input" id="dr_brand" placeholder="比如：霸王茶姬、瑞幸..." value="${r ? esc(r.brand || '') : ''}" autocomplete="off" />
      </div>
      <div class="form-group">
        <label class="form-label">类型</label>
        <div class="drink-type-grid">
          ${this.types.map(t => `
            <label class="drink-type-radio" onclick="document.getElementById('dr_type_${t.key}').checked=true">
              <input type="radio" name="dr_type" id="dr_type_${t.key}" value="${t.key}" ${t.key === type ? 'checked' : ''} style="display:none" />
              <span class="drink-type-opt">${this.iconSVG(t.icon, 18)} ${t.label}</span>
            </label>
          `).join('')}
        </div>
      </div>
      <div class="row" style="gap:8px;align-items:flex-end">
        <div class="form-group" style="flex:2">
          <label class="form-label">评分</label>
          <div id="dr_rating" style="display:flex;gap:3px;cursor:pointer;align-items:center">
            ${[1,2,3,4,5].map(k => `<span class="drink-heart" onclick="Drinks.setRating(${k})">${Drinks.heartSVG(k <= rating, 22)}</span>`).join('')}
          </div>
        </div>
        <div class="form-group" style="flex:1">
          <label class="form-label">价格(¥)</label>
          <input class="input" id="dr_price" type="number" step="0.01" min="0" placeholder="自动记账" value="${r && r.price ? esc(String(r.price)) : ''}" />
        </div>
      </div>
      <div class="row" style="gap:8px">
        <div class="form-group" style="flex:1">
          <label class="form-label">日期</label>
          <input class="input" id="dr_date" type="date" value="${r ? r.date : this.currentDate}" />
        </div>
        <div class="form-group" style="flex:1">
          <label class="form-label">时间</label>
          <input class="input" id="dr_time" type="time" value="${timeStr}" />
        </div>
      </div>
    `;
  },

  openAdd() {
    Drinks._rating = 0;
    showModal({
      title: '添加饮品',
      body: this.formBody(null),
      footer: `
        <button class="btn btn-ghost" onclick="hideModal()">取消</button>
        <button class="btn btn-primary" id="dr_save">保存</button>
      `
    });
    setTimeout(() => {
      document.getElementById('dr_name').focus();
      document.getElementById('dr_save').onclick = () => this.saveNew();
    }, 100);
  },

  async saveNew() {
    const name = document.getElementById('dr_name').value.trim();
    const brand = document.getElementById('dr_brand').value.trim();
    const type = document.querySelector('input[name="dr_type"]:checked')?.value || 'milktea';
    const date = document.getElementById('dr_date').value;
    const time = document.getElementById('dr_time').value;
    if (!name) { toast('请输入饮品名称'); return; }
    const price = parseFloat(document.getElementById('dr_price').value) || 0;
    const rating = Drinks._rating || 0;
    const drinkId = await window.DB.add('drink_records', { name, brand, type, date, time, rating, price: price || 0, createdAt: Date.now() });
    // 价格 > 0 时自动同步到记账模块（记一笔「餐饮」支出）
    if (price > 0) {
      const finGid = window.DB.generateGid();
      const finId = await window.DB.add('finance_records', {
        gid: finGid, type: 'expense', amount: price, category: '餐饮', date,
        note: '饮品：' + name + (brand ? ' · ' + brand : ''),
        createdAt: Date.now(), source: 'drinks'
      });
      await window.DB.put('drink_records', { id: drinkId, financeId: finGid });
    }
    hideModal();
    toast('已记录 🥤' + (price > 0 ? ' · 已同步记账' : ''));
    this.currentDate = date;
    this.render();
  },

  openEdit(id) {
    (async () => {
      const r = await window.DB.get('drink_records', id);
      if (!r) return;
      Drinks._rating = r.rating || 0;
      showModal({
        title: '编辑饮品',
        body: this.formBody(r),
        footer: `
          <button class="btn btn-danger" id="dr_del">删除</button>
          <button class="btn btn-ghost" onclick="hideModal()">取消</button>
          <button class="btn btn-primary" id="dr_save">保存</button>
        `
      });
      setTimeout(async () => {
        document.getElementById('dr_save').onclick = () => this.saveEdit(r);
        document.getElementById('dr_del').onclick = async () => {
          const ok = await confirmDialog('删除这条记录？');
          if (!ok) return;
          if (r.financeId) {
            const fin = await window.DB.getByGid('finance_records', r.financeId);
            if (fin) await window.DB.delete('finance_records', fin.id);
          }
          await window.DB.delete('drink_records', id);
          hideModal();
          toast('已删除' + (r.financeId ? ' · 同步移除记账' : ''));
          this.render();
        };
      }, 50);
    })();
  },

  async saveEdit(r) {
    const name = document.getElementById('dr_name').value.trim();
    const brand = document.getElementById('dr_brand').value.trim();
    const type = document.querySelector('input[name="dr_type"]:checked')?.value || 'milktea';
    const date = document.getElementById('dr_date').value;
    const time = document.getElementById('dr_time').value;
    if (!name) { toast('请输入饮品名称'); return; }
    const newPrice = parseFloat(document.getElementById('dr_price').value) || 0;
    const rating = Drinks._rating || 0;
    const oldPrice = r.price || 0;
    const updated = { ...r, name, brand, type, date, time, rating, price: newPrice };

    // 记账同步：financeId 存的是 gid，跨设备引用稳定
    let finRecord = null;
    if (r.financeId) {
      finRecord = await window.DB.getByGid('finance_records', r.financeId);
    }
    if (newPrice > 0 && oldPrice > 0 && finRecord) {
      // 原本就记了账 → 更新金额/日期/备注
      await window.DB.put('finance_records', {
        id: finRecord.id, gid: r.financeId, type: 'expense', amount: newPrice, category: '餐饮', date,
        note: '饮品：' + name + (brand ? ' · ' + brand : ''),
        source: 'drinks', createdAt: finRecord.createdAt || Date.now()
      });
    } else if (newPrice > 0 && (oldPrice === 0 || !finRecord)) {
      // 原先没记账 → 补建一条
      const finGid = window.DB.generateGid();
      await window.DB.add('finance_records', {
        gid: finGid, type: 'expense', amount: newPrice, category: '餐饮', date,
        note: '饮品：' + name + (brand ? ' · ' + brand : ''),
        createdAt: Date.now(), source: 'drinks'
      });
      updated.financeId = finGid;
    } else if (newPrice === 0 && finRecord) {
      // 价格清空 → 移除原记账
      await window.DB.delete('finance_records', finRecord.id);
      delete updated.financeId;
    }
    await window.DB.put('drink_records', updated);
    hideModal();
    const hint = newPrice > 0 ? ' · 已同步记账' : (oldPrice > 0 ? ' · 已移除记账' : '');
    toast('已更新 🥤' + hint);
    this.currentDate = date;
    this.render();
  },

  async deleteRecord(id) {
    const ok = await confirmDialog('删除这条记录？');
    if (!ok) return;
    const rec = await window.DB.get('drink_records', id);
    if (rec && rec.financeId) {
      const fin = await window.DB.getByGid('finance_records', rec.financeId);
      if (fin) {
        await window.DB.delete('finance_records', fin.id);
        if (fin.gid) {
          try { await window.DB._addTombstoneIfNewer({ gid: fin.gid, storeName: 'finance_records', deletedAt: Date.now() }); }
          catch (e) { console.warn('finance tombstone 失败', e); }
        }
      }
    }
    await window.DB.delete('drink_records', id);
    if (rec && rec.gid) {
      try { await window.DB._addTombstoneIfNewer({ gid: rec.gid, storeName: 'drink_records', deletedAt: Date.now() }); }
      catch (e) { console.warn('drink tombstone 失败', e); }
    }
    toast('已删除' + (rec && rec.financeId ? ' · 同步移除记账' : ''));
    this.render();
  }
};

window.Drinks = Drinks;
