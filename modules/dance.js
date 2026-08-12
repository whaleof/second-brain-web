// modules/dance.js - 扒舞清单：5阶段看板 + 每日练习日志

const Dance = {
  stages: [
    { key: 'wishlist',label: '扒舞清单', icon: '📝', color: '#B5B5B5' },
    { key: 'bawu',    label: '扒舞',     icon: '🔍', color: '#8FB8E0' },
    { key: 'practice',label: '练习',     icon: '💃', color: '#FFD68A' },
    { key: 'video',   label: '拍视频',   icon: '🎬', color: '#F4A6B5' },
    { key: 'done',    label: '已完成',   icon: '✅', color: '#7BC4A4' }
  ],

  currentFilter: 'all',
  currentSong: null,  // 当前查看详情的歌曲 ID

  stageIndex(key) {
    return this.stages.findIndex(s => s.key === key);
  },

  fmtShortDate(ts) {
    const d = new Date(ts);
    return (d.getMonth()+1) + '/' + d.getDate();
  },

  fmtDateRange(start, end) {
    if (!start) return '';
    const s = this.fmtShortDate(start);
    if (!end) return s + '起';
    const e = this.fmtShortDate(end);
    return s === e ? s : `${s}-${e}`;
  },

  // 格式化分钟
  fmtMinutes(mins) {
    if (mins < 60) return mins + '分钟';
    const h = Math.floor(mins / 60);
    const m = mins % 60;
    return m > 0 ? `${h}小时${m}分` : `${h}小时`;
  },

  getStageTime(song, stageKey) {
    return {
      start: song[`${stageKey}Start`],
      end: song[`${stageKey}End`]
    };
  },

  // ========== 列表视图 ==========
  async render() {
    this.currentSong = null;
    const content = document.getElementById('content');
    try {
      const songs = await window.DB.getAll('dance_songs');
      const logs = await window.DB.getAll('dance_logs');
      // 跨设备引用：songId 存的是 gid，按 gid 映射
      const songByGid = {};
      songs.forEach(s => { if (s.gid) songByGid[s.gid] = s; });

      // 统计每首歌各阶段的累计时长
      const songStats = {};
      songs.forEach(s => {
        const songLogs = logs.filter(l => l.songId === s.gid);
        const stats = { bawu: 0, practice: 0, video: 0 };
        songLogs.forEach(l => {
          if (stats[l.stage] !== undefined) stats[l.stage] += (l.minutes || 0);
        });
        songStats[s.gid] = stats;
      });

      // 阶段数量统计
      const counts = {};
      this.stages.forEach(st => counts[st.key] = 0);
      songs.forEach(s => { if (counts[s.stage] !== undefined) counts[s.stage]++; });

      // 筛选
      const filtered = this.currentFilter === 'all'
        ? songs.filter(s => s.stage !== 'done')
        : songs.filter(s => s.stage === this.currentFilter);

      content.innerHTML = `
        <!-- 统计卡片（横向滑动，5个） -->
        <div class="filter-bar" style="gap:6px;padding-bottom:4px">
          ${this.stages.map(st => `
            <div class="dance-stat-chip ${Dance.currentFilter === st.key ? 'active' : ''}" onclick="Dance.setFilter('${st.key}')" style="background:${Dance.currentFilter === st.key ? st.color : 'var(--card)'};border-color:${Dance.currentFilter === st.key ? st.color : 'var(--border)'}">
              <div class="dance-stat-chip-icon">${st.icon}</div>
              <div class="dance-stat-chip-val" style="color:${Dance.currentFilter === st.key ? 'white' : st.color}">${counts[st.key]}</div>
              <div class="dance-stat-chip-label" style="color:${Dance.currentFilter === st.key ? 'rgba(255,255,255,0.8)' : 'var(--text-sub)'}">${st.label}</div>
            </div>
          `).join('')}
        </div>

        <!-- 歌曲列表 -->
        <div style="display:flex;flex-direction:column;gap:8px;margin-top:4px">
          ${filtered.length === 0 ? `
            <div class="empty" style="padding:50px 20px">
              <div class="empty-icon">🎵</div>
              <div class="empty-text">${this.currentFilter === 'all' ? '还没有歌曲，点击右下角 + 添加' : '该阶段暂无歌曲'}</div>
            </div>
          ` : filtered.sort((a,b) => b.createdAt - a.createdAt).map(s => this.renderSongCard(s, songStats[s.gid])).join('')}
        </div>
      `;
    } catch (err) {
      content.innerHTML = `<div class="empty"><div class="empty-icon">⚠️</div><div class="empty-text">加载失败: ${esc(err.message)}</div></div>`;
    }
  },

  renderSongCard(s, stats) {
    const isDone = s.stage === 'done';
    const currentIdx = this.stageIndex(s.stage);
    const currentStage = this.stages[currentIdx];
    const stageMins = stats ? (stats[s.stage] || 0) : 0;

    // 生成下拉选项 HTML（使用 gid 作为跨设备标识）
    const dropdownId = `dd_${s.gid}`;
    const dropdownHtml = this.stages.map(st => `
      <div class="dance-dd-item ${s.stage === st.key ? 'current' : ''}" onclick="event.stopPropagation();Dance.setStage('${s.gid}','${st.key}')">
        <span>${st.icon}</span>
        <span>${st.label}</span>
      </div>
    `).join('');

    return `
      <div class="dance-song-card ${isDone ? 'dance-done' : ''}" onclick="Dance.openDetail('${s.gid}')">
        <div class="dance-song-header">
          <div class="dance-song-info">
            <div class="dance-song-name">${esc(s.name)}</div>
            <div class="dance-song-choreo">编舞：${esc(s.choreographer || '未知')}</div>
          </div>

          <!-- 右侧阶段标签，点击弹出下拉 -->
          <div class="dance-stage-dropdown-wrapper" onclick="event.stopPropagation();Dance.toggleDropdown('${dropdownId}')">
            <div class="dance-stage-dropdown-trigger" style="background:${currentStage.color}15;color:${currentStage.color}">
              ${currentStage.icon} ${currentStage.label}
              ${stageMins > 0 ? ` · ${this.fmtMinutes(stageMins)}` : ''}
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="margin-left:2px"><polyline points="6 9 12 15 18 9"/></svg>
            </div>
            <div class="dance-stage-dropdown-menu" id="${dropdownId}" onclick="event.stopPropagation()">
              ${dropdownHtml}
            </div>
          </div>
        </div>

        <div class="dance-song-footer">
          <span class="text-xs text-sub">${relativeTime(s.createdAt)}添加</span>
          <span class="dance-song-actions">
            ${!isDone ? `<button class="btn btn-sm btn-secondary" onclick="event.stopPropagation();Dance.openLog('${s.gid}')" style="padding:3px 8px;font-size:11px">+ 记录</button>` : ''}
            <button class="btn btn-sm btn-ghost" onclick="event.stopPropagation();Dance.deleteSong('${s.gid}')" style="padding:3px 6px;font-size:11px;color:var(--danger)">删除</button>
          </span>
        </div>
      </div>
    `;
  },

  // ========== 歌曲详情（日志列表） ==========
  async openDetail(songGid) {
    const song = await window.DB.getByGid('dance_songs', songGid);
    if (!song) return;
    this.currentSong = songGid;

    const logs = await window.DB.getAll('dance_logs');
    const songLogs = logs.filter(l => l.songId === songGid).sort((a,b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);

    // 各阶段累计
    const stageMins = { bawu: 0, practice: 0, video: 0 };
    songLogs.forEach(l => {
      if (stageMins[l.stage] !== undefined) stageMins[l.stage] += (l.minutes || 0);
    });

    const currentIdx = this.stageIndex(song.stage);
    const content = document.getElementById('content');

    content.innerHTML = `
      <div class="dance-detail">
        <!-- 返回 -->
        <button class="btn btn-ghost btn-sm" onclick="Dance.render()" style="margin-bottom:8px;padding-left:0">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
          返回清单
        </button>

        <!-- 歌曲信息 -->
        <div class="card" style="padding:14px">
          <div class="dance-detail-header">
            <div>
              <div style="font-size:18px;font-weight:700">${esc(song.name)}</div>
              <div class="text-small text-sub" style="margin-top:2px">编舞：${esc(song.choreographer || '未知')}</div>
            </div>
            <div class="dance-song-badge" style="background:${this.stages[currentIdx].color}15;color:${this.stages[currentIdx].color}">
              ${this.stages[currentIdx].icon} ${this.stages[currentIdx].label}
            </div>
          </div>

          <!-- 阶段切换 -->
          <div class="dance-stage-row" style="margin-top:10px;margin-bottom:0">
            ${this.stages.map((stage, i) => {
              const isCurrent = song.stage === stage.key;
              const isPassed = currentIdx > i;
              return `
              <button class="dance-stage-btn ${isCurrent ? 'current' : ''} ${isPassed ? 'passed' : ''}"
                      onclick="Dance.setStage('${song.gid}','${stage.key}')">
                <span class="dance-stage-icon">${isPassed && stage.key !== 'wishlist' ? '✓' : stage.icon}</span>
                <span class="dance-stage-label">${stage.label}</span>
              </button>`;
            }).join('')}
          </div>
        </div>

        <!-- 各阶段时长汇总 -->
        <div class="dance-summary-row">
          <div class="dance-summary-item">
            <span>🔍 扒舞</span>
            <strong>${this.fmtMinutes(stageMins.bawu)}</strong>
          </div>
          <div class="dance-summary-item">
            <span>💃 练习</span>
            <strong>${this.fmtMinutes(stageMins.practice)}</strong>
          </div>
          <div class="dance-summary-item">
            <span>🎬 拍视频</span>
            <strong>${this.fmtMinutes(stageMins.video)}</strong>
          </div>
        </div>

        <!-- 日志列表 -->
        <div class="card" style="padding:12px">
          <div class="card-title" style="margin-bottom:8px">
            <span>📋 练习日志</span>
            <span class="card-extra" onclick="Dance.openLog('${song.gid}')">+ 添加</span>
          </div>

          ${songLogs.length === 0 ? `
            <div class="empty" style="padding:30px 20px">
              <div class="empty-icon">📝</div>
              <div class="empty-text">还没有记录，点击右上角添加</div>
            </div>
          ` : songLogs.map(l => {
            const st = this.stages.find(x => x.key === l.stage);
            return `
            <div class="dance-log-item">
              <div class="dance-log-left">
                <span class="dance-log-stage-tag" style="background:${st?.color || '#B5B5B5'}20;color:${st?.color || '#888'}">${st?.icon || ''} ${st?.label || ''}</span>
                <span class="dance-log-date">${l.date}</span>
              </div>
              <div class="dance-log-right">
                <span class="dance-log-mins">${l.minutes || 0}分钟</span>
                <button class="tl-clear-btn" onclick="event.stopPropagation();Dance.deleteLog(${l.id})" title="删除">✕</button>
              </div>
              ${l.notes ? `<div class="dance-log-notes">${esc(l.notes)}</div>` : ''}
            </div>`;
          }).join('')}
        </div>
      </div>
    `;
  },

  // ========== 添加日志弹窗 ==========
  async openLog(songGid) {
    const song = await window.DB.getByGid('dance_songs', songGid);
    if (!song) return;

    // 当前阶段对应的可选阶段
    const stageOptions = [
      { key: 'bawu', label: '🔍 扒舞' },
      { key: 'practice', label: '💃 练习' },
      { key: 'video', label: '🎬 拍视频' }
    ];

    showModal({
      title: `记录 · ${esc(song.name)}`,
      body: `
        <div class="row" style="gap:8px">
          <div class="form-group" style="flex:1">
            <label class="form-label">日期</label>
            <input class="input" id="dl_date" type="date" value="${todayStr()}" />
          </div>
          <div class="form-group" style="flex:1">
            <label class="form-label">时长 (分钟)</label>
            <input class="input" id="dl_mins" type="number" value="30" min="1" />
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">阶段</label>
          <select class="select" id="dl_stage">
            ${stageOptions.map(o => `<option value="${o.key}" ${song.stage === o.key ? 'selected' : ''}>${o.label}</option>`).join('')}
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">备注（可选）</label>
          <input class="input" id="dl_notes" placeholder="练了什么内容..." />
        </div>
      `,
      footer: `
        <button class="btn btn-ghost" onclick="hideModal()">取消</button>
        <button class="btn btn-primary" id="dl_save">保存</button>
      `
    });

    setTimeout(() => {
      document.getElementById('dl_mins').focus();
      document.getElementById('dl_mins').select();
      document.getElementById('dl_save').onclick = async () => {
        const date = document.getElementById('dl_date').value;
        const minutes = parseInt(document.getElementById('dl_mins').value) || 0;
        const stage = document.getElementById('dl_stage').value;
        const notes = document.getElementById('dl_notes').value.trim();

        if (!minutes) { toast('请输入时长'); return; }

        await window.DB.add('dance_logs', {
          songId: song.gid, date, minutes, stage, notes,
          createdAt: Date.now()
        });
        hideModal();
        toast('已记录 ✓');
        this.currentSong ? this.openDetail(this.currentSong) : this.render();
      };
    }, 100);
  },

  // ========== 操作 ==========
  // 切换下拉菜单
  toggleDropdown(id) {
    const menu = document.getElementById(id);
    if (!menu) return;
    const isOpen = menu.classList.contains('show');
    // 关闭所有其他下拉
    document.querySelectorAll('.dance-stage-dropdown-menu').forEach(m => m.classList.remove('show'));
    if (!isOpen) {
      menu.classList.add('show');
      // 点击其他地方关闭
      const closeHandler = (e) => {
        if (!menu.contains(e.target)) {
          menu.classList.remove('show');
          document.removeEventListener('click', closeHandler);
        }
      };
      setTimeout(() => document.addEventListener('click', closeHandler), 10);
    }
  },

  setFilter(key) {
    this.currentFilter = key;
    this.render();
  },

  async setStage(songGid, newStage) {
    const song = await window.DB.getByGid('dance_songs', songGid);
    if (!song || song.stage === newStage) return;

    const oldStage = song.stage;
    const now = Date.now();

    const update = { ...song, stage: newStage };

    if (oldStage === 'bawu') update.bawuEnd = now;
    if (oldStage === 'practice') update.practiceEnd = now;
    if (oldStage === 'video') update.videoEnd = now;
    if (newStage === 'bawu') update.bawuStart = now;
    if (newStage === 'practice') update.practiceStart = now;
    if (newStage === 'video') update.videoStart = now;

    await window.DB.put('dance_songs', update);

    const newLabel = this.stages.find(s => s.key === newStage)?.label || '';
    toast(`${esc(song.name)} → ${newLabel}`);
    this.currentSong ? this.openDetail(song.gid) : this.render();
  },

  async deleteLog(logId) {
    const ok = await confirmDialog('删除这条记录？');
    if (!ok) return;
    const log = await window.DB.get('dance_logs', logId);
    await window.DB.delete('dance_logs', logId);
    if (log && log.gid) {
      try { await window.DB._addTombstoneIfNewer({ gid: log.gid, storeName: 'dance_logs', deletedAt: Date.now() }); }
      catch (e) { console.warn('tombstone 写入失败', e); }
    }
    toast('已删除');
    if (this.currentSong) this.openDetail(this.currentSong);
  },

  openAdd() {
    showModal({
      title: '添加歌曲',
      body: `
        <div class="form-group">
          <label class="form-label">歌名</label>
          <input class="input" id="ds_name" placeholder="输入歌名" autocomplete="off" />
        </div>
        <div class="form-group">
          <label class="form-label">编舞师</label>
          <input class="input" id="ds_choreo" placeholder="编舞师名字" autocomplete="off" />
        </div>
      `,
      footer: `
        <button class="btn btn-ghost" onclick="hideModal()">取消</button>
        <button class="btn btn-primary" id="ds_save">添加</button>
      `
    });
    setTimeout(() => {
      const nameInput = document.getElementById('ds_name');
      nameInput.focus();
      document.getElementById('ds_choreo').addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); document.getElementById('ds_save').click(); }
      });
      nameInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); document.getElementById('ds_save').click(); }
      });
      document.getElementById('ds_save').onclick = async () => {
        const name = nameInput.value.trim();
        const choreographer = document.getElementById('ds_choreo').value.trim();
        if (!name) { toast('请输入歌名'); return; }
        await window.DB.add('dance_songs', {
          name, choreographer,
          stage: 'wishlist',
          createdAt: Date.now()
        });
        hideModal();
        toast('已添加 🎵');
        Dance.render();
      };
    }, 100);
  },

  async deleteSong(songGid) {
    const ok = await confirmDialog('确定删除这首歌及其所有记录？');
    if (!ok) return;
    const song = await window.DB.getByGid('dance_songs', songGid);
    if (!song) return;
    // 同时删除关联日志（按 gid 匹配）
    const logs = await window.DB.getAll('dance_logs');
    const relatedGids = [];
    for (const l of logs) {
      if (l.songId === songGid) {
        if (l.gid) relatedGids.push(l.gid);
        await window.DB.delete('dance_logs', l.id);
      }
    }
    await window.DB.delete('dance_songs', song.id);
    // 写 tombstone（08-07 bug fix）
    if (song.gid) {
      try { await window.DB._addTombstoneIfNewer({ gid: song.gid, storeName: 'dance_songs', deletedAt: Date.now() }); }
      catch (e) { console.warn('song tombstone 失败', e); }
    }
    for (const rg of relatedGids) {
      try { await window.DB._addTombstoneIfNewer({ gid: rg, storeName: 'dance_logs', deletedAt: Date.now() }); }
      catch (e) { console.warn('log tombstone 失败', e); }
    }
    toast('已删除');
    this.currentSong ? this.render() : this.render();
  }
};

window.Dance = Dance;
