// modules/internship.js → 工作模块

const Internship = {
  currentTab: 'logs', // logs | projects | skills

  async render() {
    const content = document.getElementById('content');
    try {
      const logs = await window.DB.getAll('work_logs');
      logs.sort((a, b) => b.date.localeCompare(a.date) || b.createdAt - a.createdAt);

      content.innerHTML = `
        <div class="tabs">
          <div class="tab ${this.currentTab === 'logs' ? 'active' : ''}" onclick="Internship.switchTab('logs')">📋 日志</div>
          <div class="tab ${this.currentTab === 'projects' ? 'active' : ''}" onclick="Internship.switchTab('projects')">📁 项目</div>
          <div class="tab ${this.currentTab === 'skills' ? 'active' : ''}" onclick="Internship.switchTab('skills')">🛠 技能</div>
        </div>
        <div id="workTabContent"></div>
      `;

      await this.renderTab(logs);
    } catch (err) {
      content.innerHTML = `<div class="empty"><div class="empty-icon">⚠️</div><div class="empty-text">加载失败</div></div>`;
    }
  },

  switchTab(tab) {
    this.currentTab = tab;
    this.render();
  },

  async renderTab(logs) {
    const container = document.getElementById('workTabContent');
    if (!container) return;

    if (this.currentTab === 'logs') {
      container.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:8px">
          ${logs.length === 0 ? `
            <div class="empty" style="padding:40px 20px">
              <div class="empty-icon">📋</div>
              <div class="empty-text">还没有工作日志</div>
            </div>
          ` : logs.map(l => `
            <div class="card" style="padding:12px">
              <div class="row-between mb-8">
                <div class="row" style="gap:6px">
                  <span class="tag tag-blue">${esc(l.project || '日常')}</span>
                  <span class="text-small text-sub">${l.date}</span>
                </div>
                <div class="row" style="gap:4px">
                  <button class="tl-clear-btn" onclick="event.stopPropagation();Internship.openLogEdit(${l.id})">✎</button>
                  <button class="tl-clear-btn" onclick="event.stopPropagation();Internship.deleteLog(${l.id})">✕</button>
                </div>
              </div>
              <div style="font-size:14px;white-space:pre-wrap;line-height:1.6">${esc(l.content || '')}</div>
              ${l.link ? `<a href="${esc(l.link)}" target="_blank" class="text-xs text-primary" style="margin-top:6px;display:inline-block">🔗 ${esc(l.link)}</a>` : ''}
            </div>
          `).join('')}
        </div>
        <button class="btn btn-primary btn-block mt-12" onclick="Internship.openAdd()">+ 添加工作日志</button>
      `;
    } else if (this.currentTab === 'projects') {
      const projects = (await window.DB.getAll('work_projects')).sort((a, b) => b.createdAt - a.createdAt);
      container.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:8px">
          ${projects.length === 0 ? `
            <div class="empty" style="padding:40px 20px">
              <div class="empty-icon">📁</div>
              <div class="empty-text">还没有项目</div>
            </div>
          ` : projects.map(p => `
            <div class="card" style="padding:12px" onclick="Internship.openProjectEdit(${p.id})">
              <div class="row-between mb-8">
                <div class="row" style="gap:6px">
                  <span class="tag tag-blue">${esc(p.name || '未命名')}</span>
                  <span class="tag ${p.status === 'done' ? 'tag-gray' : 'tag-mint'}">${p.status === 'done' ? '已完成' : '进行中'}</span>
                </div>
                <button class="tl-clear-btn" onclick="event.stopPropagation();Internship.delProject(${p.id})">✕</button>
              </div>
              ${p.desc ? `<div style="font-size:14px;white-space:pre-wrap;line-height:1.6">${esc(p.desc)}</div>` : ''}
            </div>
          `).join('')}
        </div>
        <button class="btn btn-primary btn-block mt-12" onclick="Internship.openProjectEdit(null)">+ 添加项目</button>
      `;
    } else {
      const skills = (await window.DB.getAll('work_skills')).sort((a, b) => b.createdAt - a.createdAt);
      container.innerHTML = `
        <div style="display:flex;flex-direction:column;gap:8px">
          ${skills.length === 0 ? `
            <div class="empty" style="padding:40px 20px">
              <div class="empty-icon">🛠</div>
              <div class="empty-text">还没有技能</div>
            </div>
          ` : skills.map(s => `
            <div class="card" style="padding:12px" onclick="Internship.openSkillEdit(${s.id})">
              <div class="row-between mb-8">
                <div class="row" style="gap:6px">
                  <span class="tag tag-yellow">${esc(s.name || '未命名')}</span>
                  <span class="text-small text-sub">${'★'.repeat(s.level || 0)}${'☆'.repeat(5 - (s.level || 0))}</span>
                </div>
                <button class="tl-clear-btn" onclick="event.stopPropagation();Internship.delSkill(${s.id})">✕</button>
              </div>
              ${s.note ? `<div style="font-size:14px;white-space:pre-wrap;line-height:1.6">${esc(s.note)}</div>` : ''}
            </div>
          `).join('')}
        </div>
        <button class="btn btn-primary btn-block mt-12" onclick="Internship.openSkillEdit(null)">+ 添加技能</button>
      `;
    }
  },

  openAdd() {
    showModal({
      title: '添加工作日志',
      body: `
        <div class="row" style="gap:8px">
          <div class="form-group" style="flex:1">
            <label class="form-label">日期</label>
            <input class="input" id="wl_date" type="date" value="${todayStr()}" />
          </div>
          <div class="form-group" style="flex:1">
            <label class="form-label">项目</label>
            <input class="input" id="wl_project" placeholder="项目名" />
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">内容</label>
          <textarea class="textarea" id="wl_content" placeholder="今天做了什么？"></textarea>
        </div>
        <div class="form-group">
          <label class="form-label">链接（可选）</label>
          <input class="input" id="wl_link" placeholder="相关链接" />
        </div>
      `,
      footer: `
        <button class="btn btn-ghost" onclick="hideModal()">取消</button>
        <button class="btn btn-primary" id="wl_save">保存</button>
      `
    });
    setTimeout(() => {
      document.getElementById('wl_save').onclick = async () => {
        const date = document.getElementById('wl_date').value;
        const project = document.getElementById('wl_project').value.trim();
        const content = document.getElementById('wl_content').value.trim();
        const link = document.getElementById('wl_link').value.trim();
        if (!content) { toast('请输入内容'); return; }
        await window.DB.add('work_logs', { date, project, content, link, createdAt: Date.now() });
        hideModal();
        toast('已保存');
        Internship.render();
      };
    }, 100);
  },

  async deleteLog(id) {
    const ok = await confirmDialog('删除这条日志？');
    if (!ok) return;
    const log = await window.DB.get('work_logs', id);
    await window.DB.delete('work_logs', id);
    if (log && log.gid) {
      try { await window.DB._addTombstoneIfNewer({ gid: log.gid, storeName: 'work_logs', deletedAt: Date.now() }); }
      catch (e) { console.warn('tombstone 失败', e); }
    }
    toast('已删除');
    this.render();
  },

  async openLogEdit(id) {
    const l = id ? await window.DB.get('work_logs', id) : null;
    showModal({
      title: '编辑工作日志',
      body: `
        <div class="row" style="gap:8px">
          <div class="form-group" style="flex:1">
            <label class="form-label">日期</label>
            <input class="input" id="wl_date" type="date" value="${esc(l?.date || todayStr())}" />
          </div>
          <div class="form-group" style="flex:1">
            <label class="form-label">项目</label>
            <input class="input" id="wl_project" placeholder="项目名" value="${esc(l?.project || '')}" />
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">内容</label>
          <textarea class="textarea" id="wl_content" placeholder="今天做了什么？">${esc(l?.content || '')}</textarea>
        </div>
        <div class="form-group">
          <label class="form-label">链接（可选）</label>
          <input class="input" id="wl_link" placeholder="相关链接" value="${esc(l?.link || '')}" />
        </div>
      `,
      footer: `
        <button class="btn btn-ghost" onclick="hideModal()">取消</button>
        ${id ? '<button class="btn btn-danger" id="wl_del">删除</button>' : ''}
        <button class="btn btn-primary" id="wl_save">保存</button>
      `
    });
    setTimeout(() => {
      document.getElementById('wl_save').onclick = async () => {
        const date = document.getElementById('wl_date').value;
        const project = document.getElementById('wl_project').value.trim();
        const content = document.getElementById('wl_content').value.trim();
        const link = document.getElementById('wl_link').value.trim();
        if (!content) { toast('请输入内容'); return; }
        if (id) {
          const orig = await window.DB.get('work_logs', id);
          await window.DB.put('work_logs', { ...orig, date, project, content, link });
        } else {
          await window.DB.add('work_logs', { date, project, content, link, createdAt: Date.now() });
        }
        hideModal();
        toast('已保存');
        Internship.render();
      };
      if (id) {
        document.getElementById('wl_del').onclick = async () => {
          const ok = await confirmDialog('删除这条日志？');
          if (!ok) return;
          await window.DB.delete('work_logs', id);
          hideModal();
          Internship.render();
        };
      }
    }, 100);
  },

  async openProjectEdit(id) {
    const p = id ? await window.DB.get('work_projects', id) : null;
    showModal({
      title: id ? '编辑项目' : '添加项目',
      body: `
        <div class="form-group">
          <label class="form-label">项目名称</label>
          <input class="input" id="wp_name" placeholder="如：第二大脑" value="${esc(p?.name || '')}" />
        </div>
        <div class="form-group">
          <label class="form-label">状态</label>
          <select class="select" id="wp_status">
            <option value="active" ${!p || p.status === 'active' ? 'selected' : ''}>进行中</option>
            <option value="done" ${p?.status === 'done' ? 'selected' : ''}>已完成</option>
          </select>
        </div>
        <div class="form-group">
          <label class="form-label">描述（可选）</label>
          <textarea class="textarea" id="wp_desc" placeholder="项目目标 / 进展">${esc(p?.desc || '')}</textarea>
        </div>
      `,
      footer: `
        <button class="btn btn-ghost" onclick="hideModal()">取消</button>
        ${id ? '<button class="btn btn-danger" id="wp_del">删除</button>' : ''}
        <button class="btn btn-primary" id="wp_save">保存</button>
      `
    });
    setTimeout(() => {
      document.getElementById('wp_save').onclick = async () => {
        const name = document.getElementById('wp_name').value.trim();
        if (!name) { toast('请输入项目名称'); return; }
        const data = { name, status: document.getElementById('wp_status').value, desc: document.getElementById('wp_desc').value.trim() };
        if (id) {
          const orig = await window.DB.get('work_projects', id);
          await window.DB.put('work_projects', { ...orig, ...data });
        } else {
          await window.DB.add('work_projects', { ...data, createdAt: Date.now() });
        }
        hideModal();
        toast('已保存');
        Internship.render();
      };
      if (id) {
        document.getElementById('wp_del').onclick = async () => {
          const ok = await confirmDialog('删除这个项目？');
          if (!ok) return;
          await window.DB.delete('work_projects', id);
          hideModal();
          Internship.render();
        };
      }
    }, 100);
  },

  async delProject(id) {
    const ok = await confirmDialog('删除这个项目？');
    if (!ok) return;
    const proj = await window.DB.get('work_projects', id);
    await window.DB.delete('work_projects', id);
    if (proj && proj.gid) {
      try { await window.DB._addTombstoneIfNewer({ gid: proj.gid, storeName: 'work_projects', deletedAt: Date.now() }); }
      catch (e) { console.warn('tombstone 失败', e); }
    }
    toast('已删除');
    this.render();
  },

  async openSkillEdit(id) {
    const s = id ? await window.DB.get('work_skills', id) : null;
    let level = s?.level || 0;
    showModal({
      title: id ? '编辑技能' : '添加技能',
      body: `
        <div class="form-group">
          <label class="form-label">技能名称</label>
          <input class="input" id="ws_name" placeholder="如：Python" value="${esc(s?.name || '')}" />
        </div>
        <div class="form-group">
          <label class="form-label">熟练度</label>
          <div id="ws_stars" style="font-size:24px;cursor:pointer;letter-spacing:4px">
            ${[1,2,3,4,5].map(i => `<span onclick="window._setWsLevel(${i})">${i <= level ? '★' : '☆'}</span>`).join('')}
          </div>
        </div>
        <div class="form-group">
          <label class="form-label">备注（可选）</label>
          <textarea class="textarea" id="ws_note" placeholder="如：正在学 FastAPI">${esc(s?.note || '')}</textarea>
        </div>
      `,
      footer: `
        <button class="btn btn-ghost" onclick="hideModal()">取消</button>
        ${id ? '<button class="btn btn-danger" id="ws_del">删除</button>' : ''}
        <button class="btn btn-primary" id="ws_save">保存</button>
      `
    });
    window._setWsLevel = (i) => {
      level = i;
      const box = document.getElementById('ws_stars');
      if (box) box.innerHTML = [1,2,3,4,5].map(n => `<span onclick="window._setWsLevel(${n})">${n <= level ? '★' : '☆'}</span>`).join('');
    };
    setTimeout(() => {
      document.getElementById('ws_save').onclick = async () => {
        const name = document.getElementById('ws_name').value.trim();
        if (!name) { toast('请输入技能名称'); return; }
        const data = { name, level, note: document.getElementById('ws_note').value.trim() };
        if (id) {
          const orig = await window.DB.get('work_skills', id);
          await window.DB.put('work_skills', { ...orig, ...data });
        } else {
          await window.DB.add('work_skills', { ...data, createdAt: Date.now() });
        }
        hideModal();
        toast('已保存');
        Internship.render();
      };
      if (id) {
        document.getElementById('ws_del').onclick = async () => {
          const ok = await confirmDialog('删除这个技能？');
          if (!ok) return;
          await window.DB.delete('work_skills', id);
          hideModal();
          Internship.render();
        };
      }
    }, 100);
  },

  async delSkill(id) {
    const ok = await confirmDialog('删除这个技能？');
    if (!ok) return;
    const sk = await window.DB.get('work_skills', id);
    await window.DB.delete('work_skills', id);
    if (sk && sk.gid) {
      try { await window.DB._addTombstoneIfNewer({ gid: sk.gid, storeName: 'work_skills', deletedAt: Date.now() }); }
      catch (e) { console.warn('tombstone 失败', e); }
    }
    toast('已删除');
    this.render();
  }
};

window.Internship = Internship;