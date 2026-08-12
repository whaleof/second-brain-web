// modules/weight.js - 体重记录 + BMI + 趋势图
const Weight = {
  chart: null,

  async render() {
    const content = document.getElementById('content');
    try {
      const records = await window.DB.getAll('weight_records');
      records.sort((a, b) => a.date.localeCompare(b.date));

      const latest = records[records.length - 1];
      const first = records[0];
      const trend = records.length >= 2 ? (latest?.weight - first?.weight).toFixed(1) : 0;
      const trendDir = trend > 0 ? '↑' : trend < 0 ? '↓' : '→';

      // 身高（跨端同步存储）
      let heightRec = await window.DB.getKv('user_height');
      let height = heightRec != null ? String(heightRec) : '';
      const bmi = height && latest ? (latest.weight / ((height / 100) ** 2)).toFixed(1) : '--';

      content.innerHTML = `
        <div class="page-header" onclick="navigateTo('home')"><span class="back-arrow">←</span> 返回首页</div>

        <div class="card" style="padding:16px">
          <div class="row-between mb-12">
            <div>
              <div style="font-size:28px;font-weight:600;color:var(--primary-deep)">${latest ? latest.weight + ' kg' : '-- kg'}</div>
              <div class="text-small text-sub">最近记录 · ${latest ? latest.date : '暂无'}</div>
            </div>
            <div style="text-align:right">
              <div style="font-size:16px;font-weight:600">BMI ${bmi}</div>
              <div class="text-xs text-sub">${Weight.bmiLabel(bmi)}</div>
            </div>
          </div>
          ${records.length >= 2 ? `<div style="font-size:13px;color:${trend > 0 ? 'var(--danger)' : 'var(--success)'}">较最初 ${trendDir} ${Math.abs(trend)} kg</div>` : ''}
        </div>

        <div class="card" style="padding:16px">
          <div class="card-title">📈 体重趋势</div>
          ${records.length < 2
            ? '<div class="text-small text-sub" style="padding:30px 0;text-align:center">至少 2 条记录才显示趋势图</div>'
            : '<div class="chart-wrap tall"><canvas id="weightChart"></canvas></div>'
          }
        </div>

        <div class="card" style="padding:16px">
          <div class="form-group">
            <label class="form-label">身高 (cm)</label>
            <input class="input" id="w_height" type="number" value="${esc(height)}" placeholder="输入身高自动计算 BMI" onchange="Weight.saveHeight(this.value)" />
          </div>
          <div class="row" style="gap:8px">
            <div class="form-group" style="flex:1">
              <label class="form-label">日期</label>
              <input class="input" id="w_date" type="date" value="${todayStr()}" />
            </div>
            <div class="form-group" style="flex:1">
              <label class="form-label">体重 (kg)</label>
              <input class="input" id="w_weight" type="number" step="0.1" placeholder="如 65.5" />
            </div>
          </div>
          <div class="form-group">
            <label class="form-label">备注</label>
            <input class="input" id="w_note" placeholder="如：空腹 / 运动后" />
          </div>
          <button class="btn btn-primary btn-block" onclick="Weight.save()">💾 记录体重</button>
        </div>

        <div class="card" style="padding:16px">
          <div class="card-title">
            <span>📋 历史记录</span>
          </div>
          ${records.length === 0
            ? '<div class="empty"><div class="empty-icon">⚖️</div><div class="empty-text">还没有记录</div></div>'
            : records.reverse().slice(0, 30).map(r => `
              <div class="list-item" onclick="Weight.edit(${r.id})">
                <div style="font-size:20px">⚖️</div>
                <div class="list-item-content">
                  <div class="list-item-title">${r.weight} kg</div>
                  <div class="list-item-sub">${r.date}${r.note ? ' · ' + esc(r.note) : ''}</div>
                </div>
                <button class="list-item-action" onclick="event.stopPropagation();Weight.del(${r.id})">🗑️</button>
              </div>
            `).join('')}
        </div>
      `;

      if (records.length >= 2) {
        setTimeout(() => Weight.renderChart(records), 100);
      }
    } catch (err) {
      content.innerHTML = `
        <div class="empty">
          <div class="empty-icon">⚠️</div>
          <div class="empty-text">加载失败: ${esc(err.message)}</div>
          <button class="btn btn-secondary btn-sm mt-12" onclick="Weight.render()">重试</button>
        </div>
      `;
    }
  },

  bmiLabel(bmi) {
    const n = parseFloat(bmi);
    if (isNaN(n)) return '--';
    if (n < 18.5) return '偏瘦';
    if (n < 24) return '正常';
    if (n < 28) return '偏胖';
    return '肥胖';
  },

  async saveHeight(v) {
    await window.DB.setKv('user_height', v);
    localStorage.removeItem('sb_height');
    Weight.render();
  },

  async save() {
    const weight = parseFloat(document.getElementById('w_weight').value);
    const date = document.getElementById('w_date').value;
    const note = document.getElementById('w_note').value.trim();
    if (!weight || weight <= 0) return toast('请输入有效体重');
    if (!date) return toast('请选择日期');
    // 检查当天是否已有记录
    const records = await window.DB.getAll('weight_records');
    const existing = records.find(r => r.date === date);
    if (existing) {
      await window.DB.put('weight_records', { ...existing, weight, note, updatedAt: Date.now() });
      toast('已更新今日体重');
    } else {
      await window.DB.add('weight_records', { date, weight, note });
      toast('已记录');
    }
    Weight.render();
  },

  async edit(id) {
    const r = await window.DB.get('weight_records', id);
    if (!r) return;
    document.getElementById('w_date').value = r.date;
    document.getElementById('w_weight').value = r.weight;
    document.getElementById('w_note').value = r.note || '';
    document.getElementById('w_weight').focus();
    toast('已加载到表单，修改后点保存');
  },

  async del(id) {
    const ok = await confirmDialog('确定删除？');
    if (!ok) return;
    const rec = await window.DB.get('weight_records', id);
    await window.DB.delete('weight_records', id);
    if (rec && rec.gid) {
      try { await window.DB._addTombstoneIfNewer({ gid: rec.gid, storeName: 'weight_records', deletedAt: Date.now() }); }
      catch (e) { console.warn('tombstone 失败', e); }
    }
    toast('已删除');
    Weight.render();
  },

  renderChart(records) {
    const ctx = document.getElementById('weightChart');
    if (!ctx) return;
    if (this.chart) this.chart.destroy();
    this.chart = new Chart(ctx, {
      type: 'line',
      data: {
        labels: records.map(r => r.date.slice(5)),
        datasets: [{
          label: '体重 (kg)',
          data: records.map(r => r.weight),
          borderColor: '#F4A6B5',
          backgroundColor: 'rgba(244,166,181,0.15)',
          fill: true,
          tension: 0.35,
          pointRadius: 4,
          pointBackgroundColor: '#F4A6B5'
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          y: {
            min: Math.floor(Math.min(...records.map(r => r.weight)) - 1),
            max: Math.ceil(Math.max(...records.map(r => r.weight)) + 1),
            ticks: { font: { size: 10 } }
          },
          x: { ticks: { font: { size: 10 }, maxTicksLimit: 10 } }
        }
      }
    });
  }
};

window.Weight = Weight;
