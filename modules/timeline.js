// modules/timeline.js - 一日时间轴：每小时记录做了什么
const Timeline = {
  currentDate: todayStr(),
  expandedGroups: new Set(), // 记录展开的合并组（以起始小时为 key）
  lastTapped: null,
  activeHour: null,

  async render() {
    const content = document.getElementById('content');
    try {
      const allLogs = await window.DB.getAll('timeline_logs');
      const todayLogs = allLogs.filter(l => l.date === this.currentDate);

      // 按 hour 收集全部 logs；展示时把同 hour 多条 content 用 "，" 串成一行
      const hourMap = {};
      for (const log of todayLogs) {
        const hk = Number(log.hour);
        if (!hourMap[hk]) hourMap[hk] = [];
        hourMap[hk].push(log);
      }

      // 构建 0:00 ~ 24:00 的时间轴（覆盖凌晨早起）
      const hours = [];
      for (let h = 0; h <= 24; h++) {
        const list = hourMap[h] || [];
        // 同 hour 多条就用"，"拼一条；空 hour 留空串
        const content = list
          .map(l => (l.content || '').trim())
          .filter(Boolean)
          .join('，');
        hours.push({ hour: h, label: String(h).padStart(2, '0') + ':00', content });
      }

      // 合并连续相同活动，记录每组的所有小时
      const merged = [];
      let i = 0;
      while (i < hours.length) {
        if (!hours[i].content) {
          merged.push({ ...hours[i], span: 1, hours: [hours[i].hour] });
          i++;
          continue;
        }
        let j = i + 1;
        while (j < hours.length && hours[j].content === hours[i].content) j++;
        const groupHours = [];
        for (let k = i; k < j; k++) groupHours.push(hours[k].hour);
        merged.push({ ...hours[i], span: j - i, hours: groupHours });
        i = j;
      }

      // 统计
      const filled = hours.filter(h => h.content).length;
      const total = hours.length;
      const completionRate = Math.round(filled / total * 100);

      content.innerHTML = `
        <div class="tl-sticky-header">
          <div class="tl-header-card">
            <div class="row-between">
              <input class="input tl-date-input" id="tl_date" type="date" value="${this.currentDate}" />
              <div class="tl-nav-group">
                <button class="btn btn-secondary btn-sm" onclick="Timeline.prevDay()"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg></button>
                <button class="btn btn-secondary btn-sm" onclick="Timeline.goToday()">今天</button>
                <button class="btn btn-secondary btn-sm" onclick="Timeline.nextDay()"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg></button>
              </div>
            </div>
            <div class="tl-progress-row">
              <div class="progress tl-progress"><div class="progress-bar" style="width:${completionRate}%"></div></div>
              <span class="tl-progress-text">${filled}/${total} · ${completionRate}%</span>
            </div>
          </div>
          <!-- 快捷填充 -->
          <div class="filter-bar tl-quick-bar">
            <button class="filter-chip tl-quick-chip" onclick="Timeline.quickFillActive('睡觉')">😴 睡觉</button>
            <button class="filter-chip tl-quick-chip" onclick="Timeline.quickFillActive('吃饭')">🍚 吃饭</button>
            <button class="filter-chip tl-quick-chip" onclick="Timeline.quickFillActive('练舞')">💃 练舞</button>
            <button class="filter-chip tl-quick-chip" onclick="Timeline.quickFillActive('刷手机')">📱 刷手机</button>
            <button class="filter-chip tl-quick-chip" onclick="Timeline.quickFillActive('学习')">📖 学习</button>
            <button class="filter-chip tl-quick-chip" onclick="Timeline.quickFillActive('工作')">💻 工作</button>
            <button class="filter-chip tl-quick-chip" onclick="Timeline.quickFillActive('运动')">🏃 运动</button>
          </div>
        </div>

        <!-- 时间轴 -->
        <div class="tl-track">
          ${merged.map((h, idx) => {
            const isLast = idx === merged.length - 1;
            const hasContent = !!h.content;
            const isMerged = h.span > 1;
            const isExpanded = isMerged && this.expandedGroups.has(h.hour);

            // 展开的合并组：渲染所有独立小时
            if (isExpanded) {
              return h.hours.map((hr, hi) => {
                const subLabel = String(hr).padStart(2, '0') + ':00';
                const subIsLast = isLast && hi === h.hours.length - 1;
                return `<div class="tl-hour tl-filled tl-expanded-sub" data-hour="${hr}">
                  <div class="tl-dot-wrapper">
                    <div class="tl-dot tl-dot-filled"></div>
                    ${!subIsLast ? '<div class="tl-line"></div>' : ''}
                  </div>
                  <div class="tl-hour-card">
                    <div class="tl-hour-top">
                      <span class="tl-hour-label">${subLabel}</span>
                      ${hi === 0 ? `<button class="tl-collapse-btn" onclick="event.stopPropagation();Timeline.toggleGroup(${h.hour})" title="收起">▲</button>` : ''}
                      <button class="tl-clear-btn" onclick="event.stopPropagation();Timeline.clearHour(${hr})" title="清除">✕</button>
                    </div>
                    <input class="input tl-hour-input" id="tl_h_${hr}" value="${esc(h.content)}" readonly placeholder="点击两次输入..." onclick="Timeline.activateInput(${hr})" onkeydown="if(event.key==='Enter'){this.blur();Timeline.autoSave(${hr},this.value)}" onblur="Timeline.autoSave(${hr},this.value)" />
                  </div>
                </div>`;
              }).join('');
            }

            // 折叠的合并组或普通小时
            return `<div class="tl-hour ${hasContent ? 'tl-filled' : 'tl-empty'} ${isMerged ? 'tl-merged' : ''}" data-hour="${h.hour}">
              <div class="tl-dot-wrapper">
                <div class="tl-dot ${hasContent ? 'tl-dot-filled' : ''}"></div>
                ${!isLast ? '<div class="tl-line"></div>' : ''}
              </div>
              <div class="tl-hour-card">
                <div class="tl-hour-top">
                  <span class="tl-hour-label ${isMerged ? 'tl-range-label' : ''}">${isMerged ? h.label + ' ~ ' + String(h.hour + h.span - 1).padStart(2,'0') + ':00' : h.label}</span>
                  ${isMerged ? `<span class="tl-span-badge">${h.span}h</span>` : ''}
                  ${isMerged ? `<button class="tl-expand-btn" onclick="event.stopPropagation();Timeline.toggleGroup(${h.hour})" title="展开编辑">▼</button>` : ''}
                  ${isMerged ? `<button class="tl-clear-btn" onclick="event.stopPropagation();Timeline.clearGroup(${h.hour})" title="清除整组">✕</button>` : ''}
                  ${hasContent && !isMerged ? `<button class="tl-clear-btn" onclick="event.stopPropagation();Timeline.clearHour(${h.hour})" title="清除">✕</button>` : ''}
                </div>
                <input class="input tl-hour-input" id="tl_h_${h.hour}" value="${esc(h.content)}" readonly placeholder="点击两次输入..." onclick="Timeline.activateInput(${h.hour})" onkeydown="if(event.key==='Enter'){this.blur();Timeline.autoSave(${h.hour},this.value)}" onblur="Timeline.autoSave(${h.hour},this.value)" />
              </div>
            </div>`;
          }).join('')}
        </div>
      `;

      document.getElementById('tl_date').onchange = (e) => {
        this.currentDate = e.target.value;
        this.expandedGroups.clear();
        Timeline.render();
      };
    } catch (err) {
      content.innerHTML = `
        <div class="empty">
          <div class="empty-icon">⚠️</div>
          <div class="empty-text">加载失败: ${esc(err.message)}</div>
          <button class="btn btn-secondary btn-sm mt-12" onclick="Timeline.render()">重试</button>
        </div>
      `;
    }
  },

  // 切换合并组的展开/收起
  toggleGroup(hour) {
    if (this.expandedGroups.has(hour)) {
      this.expandedGroups.delete(hour);
    } else {
      this.expandedGroups.add(hour);
    }
    this.lastTapped = null;
    this.render();
  },

  // 第一次点击：只高亮不弹键盘；第二次点击同一输入框：弹出键盘
  activateInput(hour) {
    const input = document.getElementById('tl_h_' + hour);
    if (!input) return;
    if (this.lastTapped === hour && input.hasAttribute('readonly')) {
      // 第二次点击同一输入框：移除 readonly，弹出键盘
      input.removeAttribute('readonly');
      input.focus();
    } else if (input.hasAttribute('readonly')) {
      // 第一次点击：保持 readonly，只标记为当前活跃
      this.lastTapped = hour;
      this.activeHour = hour;
      // 视觉反馈：短暂高亮
      input.style.borderColor = 'var(--primary)';
      input.style.background = 'rgba(244,166,181,0.06)';
      setTimeout(() => {
        input.style.borderColor = '';
        input.style.background = '';
      }, 400);
    }
  },

  async quickFillActive(text) {
    if (!this.activeHour) {
      toast('请先点击某个时段');
      return;
    }
    const input = document.getElementById('tl_h_' + this.activeHour);
    if (input) {
      input.value = text;
      input.removeAttribute('readonly');
      await this.autoSave(this.activeHour, text);
      // 高亮芯片动画
      const chips = document.querySelectorAll('.tl-quick-chip');
      chips.forEach(c => {
        if (c.textContent.includes(text)) {
          c.classList.add('active');
          setTimeout(() => c.classList.remove('active'), 600);
        }
      });
    }
  },

  async autoSave(hour, content) {
    hour = Number(hour);
    if (!Number.isFinite(hour)) hour = 0;
    if (typeof content === 'object') {
      // 可能是 blur event，取 value
      content = content?.target?.value || '';
    }
    content = (content || '').trim();
    const input = document.getElementById('tl_h_' + hour);
    const allLogs = await window.DB.getAll('timeline_logs');
    const sameHourLogs = allLogs.filter(l => l.date === this.currentDate && Number(l.hour) === hour);

    // 强制每个 (date, hour) 只保留一条 canonical 记录，避免同小时多条记录被界面串成重复文案。
    // 同小时的多条旧记录会被删除并写 tombstone，保留最新一条更新为当前输入内容。
    const sorted = sameHourLogs.sort((a, b) => (a.updatedAt || 0) - (b.updatedAt || 0));
    const keeper = sorted[sorted.length - 1] || null;

    if (content) {
      if (keeper && keeper.content === content && sorted.length === 1) {
        // 没变化且只有一条，直接返回
        if (input) input.setAttribute('readonly', '');
        this.lastTapped = null;
        return;
      }
      // 删除同小时其他记录（ keeper 由下面的 put/add 处理）
      for (const lg of sorted) {
        if (keeper && lg.id === keeper.id) continue;
        await window.DB.delete('timeline_logs', lg.id);
      }
      if (keeper) {
        await window.DB.put('timeline_logs', { ...keeper, content, updatedAt: Date.now() });
      } else {
        await window.DB.add('timeline_logs', { date: this.currentDate, hour, content });
      }
    } else {
      // 清空该小时：删除全部记录
      for (const lg of sameHourLogs) {
        await window.DB.delete('timeline_logs', lg.id);
      }
    }
    // 加回 readonly
    if (input) input.setAttribute('readonly', '');
    this.lastTapped = null;
    // 重新渲染，确保合并组与重复状态正确
    this.render();
  },

  patchCard(hour, content) {
    const el = document.querySelector(`.tl-hour[data-hour="${hour}"]`);
    if (!el) return;
    const hasContent = !!content;
    el.classList.toggle('tl-filled', hasContent);
    el.classList.toggle('tl-empty', !hasContent);
    const dot = el.querySelector('.tl-dot');
    if (dot) dot.classList.toggle('tl-dot-filled', hasContent);
    const topEl = el.querySelector('.tl-hour-top');
    const clearBtn = topEl?.querySelector('.tl-clear-btn');
    if (hasContent && !clearBtn) {
      topEl.insertAdjacentHTML('beforeend', `<button class="tl-clear-btn" onclick="event.stopPropagation();Timeline.clearHour(${hour})" title="清除">✕</button>`);
    } else if (!hasContent && clearBtn) {
      clearBtn.remove();
    }
  },

  async updateProgress() {
    const allLogs = await window.DB.getAll('timeline_logs');
    const todayLogs = allLogs.filter(l => l.date === this.currentDate);
    const filled = new Set(todayLogs.map(l => l.hour)).size;
    const total = 25;
    const rate = Math.round(filled / total * 100);
    const bar = document.querySelector('.tl-progress .progress-bar');
    const text = document.querySelector('.tl-progress-text');
    if (bar) bar.style.width = rate + '%';
    if (text) text.textContent = `${filled}/${total} · ${rate}%`;
  },

  goToday() {
    this.currentDate = todayStr();
    this.expandedGroups.clear();
    Timeline.render();
  },

  prevDay() {
    const d = new Date(this.currentDate + 'T00:00:00');
    d.setDate(d.getDate() - 1);
    this.currentDate = fmtDate(d);
    this.expandedGroups.clear();
    Timeline.render();
  },

  nextDay() {
    const d = new Date(this.currentDate + 'T00:00:00');
    d.setDate(d.getDate() + 1);
    this.currentDate = fmtDate(d);
    this.expandedGroups.clear();
    Timeline.render();
  },

  async clearHour(hour) {
    const allLogs = await window.DB.getAll('timeline_logs');
    const existingList = allLogs.filter(l => l.date === this.currentDate && l.hour === hour);
    for (const existing of existingList) {
      await window.DB.delete('timeline_logs', existing.id);
      if (existing.gid) {
        try { await window.DB._addTombstoneIfNewer({ gid: existing.gid, storeName: 'timeline_logs', deletedAt: Date.now() }); }
        catch (e) { console.warn('tombstone 失败', e); }
      }
    }
    const input = document.getElementById('tl_h_' + hour);
    if (input) {
      input.value = '';
      input.setAttribute('readonly', '');
    }
    // 展开组内清除后合并关系变化，需重新渲染
    if (document.querySelector(`.tl-expanded-sub[data-hour="${hour}"]`)) {
      this.updateProgress();
      this.render();
    } else {
      this.patchCard(hour, '');
      this.updateProgress();
    }
    toast('已清除');
  },

  // 删除同 hour 的某条附加记录（按 gid 精准删，不影响主条目）
  // 撤回：单一展示不再需要按 gid 删单条；改用 clearHour 删整小时全部 records
  async clearExtra(gid, hour) { /* deprecated：单一展示后此方法不再被任何 UI 触发 */ },

  // 清除整组（合并的所有小时）
  async clearGroup(hour) {
    // 找到该起始小时对应的合并组所有小时
    const allLogs = await window.DB.getAll('timeline_logs');
    const todayLogs = allLogs.filter(l => l.date === this.currentDate);
    const startLog = todayLogs.find(l => l.hour === hour);
    if (!startLog) { toast('无数据'); return; }
    const content = startLog.content;
    // 找出所有连续相同内容的小时
    const hoursToDelete = [];
    for (let h = hour; h <= 24; h++) {
      const lg = todayLogs.find(l => l.hour === h);
      if (lg && lg.content === content) hoursToDelete.push(lg);
      else break;
    }
    for (const lg of hoursToDelete) {
      await window.DB.delete('timeline_logs', lg.id);
      if (lg.gid) {
        try { await window.DB._addTombstoneIfNewer({ gid: lg.gid, storeName: 'timeline_logs', deletedAt: Date.now() }); }
        catch (e) { console.warn('tombstone 失败', e); }
      }
    }
    this.expandedGroups.delete(hour);
    this.render();
    toast(`已清除 ${hoursToDelete.length} 条记录`);
  }
};

window.Timeline = Timeline;
