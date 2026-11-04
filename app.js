/**
 * Inchi (寸序) — 核心应用控制器
 * 融合 OneKichan 经典三重视图（单日规划时间轴 + 日历 + 对话助手）与 Claude 美学
 */

const Inchi = {
  apiBase: '',
  token: localStorage.getItem('inchi_token') || 'inchi-token',
  
  selDate: new Date().toISOString().slice(0, 10),
  monthCursor: { y: new Date().getFullYear(), m: new Date().getMonth() },
  mode: 'split', // split | day | month | chat

  plan: { days: {}, exam_date: '2026-12-26' },
  tasks: [],
  taskProgress: {},

  HOUR_START: 7, // 07:00 开始
  HOUR_END: 24,  // 24:00 结束
  HOUR_H: 56,    // 每小时高度 56px

  async init() {
    this.updateTopbarDate();
    this.initMode();

    await Promise.all([
      this.loadPlan(),
      this.loadTasks(),
      this.loadChatHistory(),
      this.checkNotifications()
    ]);

    this.renderAll();

    // 每分钟更新一次当前时间红线与通知
    setInterval(() => {
      this.paintNowline();
    }, 60000);
    setInterval(() => this.checkNotifications(), 60000);
  },

  headers() {
    return {
      'content-type': 'application/json',
      'authorization': `Bearer ${this.token}`
    };
  },

  setMode(newMode) {
    this.mode = newMode;
    const ws = document.getElementById('workspace');
    ws.className = `mode-${newMode}`;

    document.querySelectorAll('#modebar .seg-btn').forEach(btn => {
      btn.classList.toggle('sel', btn.dataset.mode === newMode);
    });

    const viewDay = document.getElementById('view-day');
    const viewMonth = document.getElementById('view-month');
    if (newMode === 'month') {
      viewDay.style.display = 'none';
      viewMonth.style.display = 'flex';
      this.renderMonthGrid();
    } else {
      viewDay.style.display = 'flex';
      viewMonth.style.display = 'none';
      this.renderDay();
    }
  },

  initMode() {
    if (window.innerWidth < 860) {
      this.setMode('day');
    } else {
      this.setMode('split');
    }
  },

  renderAll() {
    this.renderWeekStrip();
    this.renderDay();
    this.renderFlexTasks();
    this.renderMonthGrid();
    this.updateCountdown();
  },

  /* ================= 1. 数据加载 ================= */
  async loadPlan() {
    try {
      const res = await fetch(`${this.apiBase}/api/admin/kaoyan-plan`, { headers: this.headers() });
      if (res.ok) {
        this.plan = await res.json();
      }
    } catch (err) {
      console.warn('读取计划失败:', err);
    }
  },

  async loadTasks() {
    try {
      const res = await fetch(`${this.apiBase}/api/admin/agent/tasks`, { headers: this.headers() });
      if (res.ok) {
        const data = await res.json();
        this.tasks = data.tasks || [];
        this.taskProgress = data.progress || {};
      }
    } catch (err) {
      console.warn('读取任务失败:', err);
    }
  },

  async loadChatHistory() {
    try {
      const res = await fetch(`${this.apiBase}/api/admin/agent/chat`, { headers: this.headers() });
      if (!res.ok) return;
      const data = await res.json();
      if (!data.messages) return;

      const stream = document.getElementById('chat-stream');
      // 清空除了第一条欢迎语以外的内容
      while (stream.children.length > 1) {
        stream.removeChild(stream.lastChild);
      }

      for (const m of data.messages) {
        if (m.role === 'user') {
          this.appendUserMsg(m.text, false);
        } else {
          this.appendAgentMsg(m.text, m.cards || [], false);
        }
      }
      this.scrollChatBottom();
    } catch (err) {
      console.warn('读取聊天记录失败:', err);
    }
  },

  /* ================= 2. 单日规划时间轴 (Day Planner) ================= */
  renderDay() {
    const dLabel = document.getElementById('current-date-label');
    const dowCn = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const curDate = new Date(this.selDate);
    if (dLabel) {
      dLabel.textContent = `${this.selDate} ${dowCn[curDate.getDay()]}`;
    }

    // 绘制 07:00 - 24:00 时间刻度
    const hourCol = document.getElementById('hour-col');
    const timeGrid = document.getElementById('time-grid');
    const totalHours = this.HOUR_END - this.HOUR_START;
    const totalHeight = totalHours * this.HOUR_H;

    if (hourCol.childElementCount === 0) {
      for (let h = this.HOUR_START; h <= this.HOUR_END; h++) {
        const lbl = document.createElement('span');
        lbl.className = 'hour-label';
        lbl.textContent = `${String(h).padStart(2, '0')}:00`;
        lbl.style.top = `${(h - this.HOUR_START) * this.HOUR_H}px`;
        hourCol.appendChild(lbl);
      }
    }

    hourCol.style.height = `${totalHeight}px`;
    timeGrid.style.height = `${totalHeight}px`;

    // 清理旧的时间块
    timeGrid.querySelectorAll('.time-block').forEach(n => n.remove());

    // 渲染属于该天的 slots
    const dayData = this.plan?.days?.[this.selDate];
    const slots = dayData?.slots || [];
    let plannedMin = 0;
    let doneMin = 0;

    slots.forEach(slot => {
      const startM = this.toMin(slot.start);
      const endM = this.toMin(slot.end);
      if (endM <= startM) return;

      const dur = endM - startM;
      plannedMin += dur;
      if (slot.status === 'done') doneMin += dur;

      // 转换为从 07:00 (420 分钟) 起算的 top & height
      const startOffset = Math.max(0, startM - this.HOUR_START * 60);
      const top = (startOffset / 60) * this.HOUR_H;
      const height = Math.max(26, (dur / 60) * this.HOUR_H - 4);

      const block = document.createElement('div');
      block.className = `time-block ${this.getSubjectClass(slot.subject)} ${slot.status === 'done' ? 'done' : ''}`;
      block.style.top = `${top}px`;
      block.style.height = `${height}px`;

      block.innerHTML = `
        <div class="block-time">${slot.start} - ${slot.end}</div>
        <div class="block-title">${this.escapeHtml(slot.subject)} ${slot.topic ? '· ' + this.escapeHtml(slot.topic) : ''}</div>
      `;

      block.addEventListener('click', () => this.openBlockModal(slot));
      timeGrid.appendChild(block);
    });

    // 更新今日统计
    const statsEl = document.getElementById('pane-date-stats');
    if (statsEl) {
      const pct = plannedMin > 0 ? Math.round((doneMin / plannedMin) * 100) : 0;
      statsEl.innerHTML = `计划 <strong>${(plannedMin / 60).toFixed(1)}小时</strong> · 已完成 <strong>${pct}%</strong>`;
    }

    this.paintNowline();
  },

  paintNowline() {
    const nowline = document.getElementById('nowline');
    const nowTag = document.getElementById('nowline-tag');
    if (!nowline) return;

    const todayStr = new Date().toISOString().slice(0, 10);
    if (this.selDate !== todayStr) {
      nowline.style.display = 'none';
      return;
    }

    const now = new Date();
    const curMin = now.getHours() * 60 + now.getMinutes();
    const startMin = this.HOUR_START * 60;
    const endMin = this.HOUR_END * 60;

    if (curMin < startMin || curMin > endMin) {
      nowline.style.display = 'none';
      return;
    }

    const top = ((curMin - startMin) / 60) * this.HOUR_H;
    nowline.style.display = 'block';
    nowline.style.top = `${top}px`;
    if (nowTag) {
      nowTag.textContent = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
    }
  },

  /* ================= 3. 周导航条 (Week Strip) ================= */
  renderWeekStrip() {
    const strip = document.getElementById('week-strip');
    if (!strip) return;

    const cur = new Date(this.selDate);
    const dayOfWeek = (cur.getDay() + 6) % 7; // 周一为 0
    const mon = new Date(cur);
    mon.setDate(cur.getDate() - dayOfWeek);

    const todayIso = new Date().toISOString().slice(0, 10);
    const dows = ['一', '二', '三', '四', '五', '六', '日'];
    const cells = [];

    for (let i = 0; i < 7; i++) {
      const d = new Date(mon);
      d.setDate(mon.getDate() + i);
      const iso = d.toISOString().slice(0, 10);
      const hasPlan = (this.plan?.days?.[iso]?.slots || []).length > 0;

      const isSel = iso === this.selDate;
      const isToday = iso === todayIso;

      cells.push(`
        <button type="button" class="week-cell ${isSel ? 'sel' : ''} ${isToday ? 'today' : ''}" onclick="Inchi.selectDate('${iso}')">
          <span class="dow">${dows[i]}</span>
          <span class="dom">${d.getDate()}</span>
          <span class="dots"><i class="dot ${hasPlan ? 'has-plan' : ''}"></i></span>
        </button>
      `);
    }

    strip.innerHTML = cells.join('');
  },

  selectDate(iso) {
    this.selDate = iso;
    this.renderWeekStrip();
    this.renderDay();
  },

  navDay(delta) {
    const d = new Date(this.selDate);
    d.setDate(d.getDate() + delta);
    this.selectDate(d.toISOString().slice(0, 10));
  },

  jumpToday() {
    this.selectDate(new Date().toISOString().slice(0, 10));
  },

  /* ================= 4. 月日历 (Month Grid) ================= */
  renderMonthGrid() {
    const { y, m } = this.monthCursor;
    const titleEl = document.getElementById('month-title');
    if (titleEl) titleEl.textContent = `${y} 年 ${m + 1} 月`;

    const firstDay = new Date(y, m, 1);
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const lead = (firstDay.getDay() + 6) % 7; // 周一为 0
    const todayIso = new Date().toISOString().slice(0, 10);

    const grid = document.getElementById('month-cells-grid');
    if (!grid) return;

    const cells = [];

    // 前置占位格
    for (let i = 0; i < lead; i++) {
      cells.push(`<div class="m-cell empty" style="opacity:0.35"></div>`);
    }

    // 当月天数
    for (let day = 1; day <= daysInMonth; day++) {
      const iso = `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const slots = this.plan?.days?.[iso]?.slots || [];
      const hasPlan = slots.length > 0;
      const isToday = iso === todayIso;
      const isSel = iso === this.selDate;

      const dots = slots.slice(0, 3).map(s => `<i class="dot has-plan"></i>`).join('');

      cells.push(`
        <div class="m-cell ${isToday ? 'today' : ''} ${isSel ? 'sel' : ''}" onclick="Inchi.selectDate('${iso}'); Inchi.setMode('day');">
          <span class="m-cell-num">${day}</span>
          <div class="m-cell-dots">${dots}</div>
        </div>
      `);
    }

    grid.innerHTML = cells.join('');
  },

  navMonth(delta) {
    let { y, m } = this.monthCursor;
    m += delta;
    if (m < 0) { m = 11; y--; }
    if (m > 11) { m = 0; y++; }
    this.monthCursor = { y, m };
    this.renderMonthGrid();
  },

  /* ================= 5. 灵活安排 (Flexible Tasks) ================= */
  renderFlexTasks() {
    const countEl = document.getElementById('flex-count');
    const container = document.getElementById('flex-task-cards');
    if (!container) return;

    if (countEl) countEl.textContent = `${this.tasks.length} 项`;

    container.innerHTML = this.tasks.map(t => {
      const p = this.taskProgress[t.id] || { actualMinutes: 0, targetMinutes: t.targetMinutes || 60, pct: 0 };
      const pct = Math.min(100, Math.round(p.pct || 0));
      return `
        <div class="flex-task-card" onclick="Inchi.useChip('今天学${t.name}一小时')">
          <div class="ft-header">
            <span>${t.name}</span>
            <span style="color:var(--terracotta)">${pct}%</span>
          </div>
          <div class="ft-progress"><div class="ft-bar" style="width:${pct}%"></div></div>
          <div class="ft-sub">
            <span>目标 ${(p.targetMinutes / 60).toFixed(0)}h / 周</span>
            <span style="color:var(--text-secondary)">点击排入今天 🗓️</span>
          </div>
        </div>
      `;
    }).join('');
  },

  /* ================= 6. 对话交互 (AI Assistant Chat) ================= */
  async sendMessage(event) {
    if (event) event.preventDefault();
    const input = document.getElementById('user-input');
    const text = input.value.trim();
    if (!text) return;

    input.value = '';
    this.appendUserMsg(text, true);

    const sendBtn = document.getElementById('send-btn');
    if (sendBtn) sendBtn.disabled = true;

    try {
      const res = await fetch(`${this.apiBase}/api/admin/agent/chat`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ message: text })
      });

      const data = await res.json();
      this.appendAgentMsg(data.reply || '已收到', data.cards || [], true);

      // 实时联动：刷新计划与任务，时间轴和日历立刻自动重绘！
      await Promise.all([this.loadPlan(), this.loadTasks()]);
      this.renderAll();
    } catch (err) {
      this.appendAgentMsg(`⚠️ 处理失败：${err.message}`, [], true);
    } finally {
      if (sendBtn) sendBtn.disabled = false;
    }
  },

  appendUserMsg(text, scroll = true) {
    const stream = document.getElementById('chat-stream');
    const msg = document.createElement('div');
    msg.className = 'chat-message msg-user';
    msg.textContent = text;
    stream.appendChild(msg);
    if (scroll) this.scrollChatBottom();
  },

  appendAgentMsg(text, cards = [], scroll = true) {
    const stream = document.getElementById('chat-stream');
    const msg = document.createElement('div');
    msg.className = 'chat-message msg-agent';

    let html = `<div class="agent-bubble">${this.escapeHtml(text)}</div>`;
    for (const card of cards) {
      html += this.renderCard(card);
    }

    msg.innerHTML = html;
    stream.appendChild(msg);
    if (scroll) this.scrollChatBottom();
  },

  renderCard(card) {
    const cid = card.id;
    if (card.type === 'log_confirm') {
      const s = card.payload?.sessions?.[0] || {};
      return `
        <div class="action-card" id="card-${cid}">
          <div class="card-heading">待落库学习成果</div>
          <div class="card-summary">确认将这条成果写入今日台账并打卡？</div>
          <div class="card-details">
            📅 日期：${s.date || '今天'}<br>
            📚 科目：<strong>${s.subject || '未分类'}</strong><br>
            ⏱️ 时长：<strong>${s.minutes || 0} 分钟</strong> (${((s.minutes || 0)/60).toFixed(1)}h)<br>
            📝 备注：${s.note || '无'}
          </div>
          <div class="card-actions">
            <button class="btn-primary" onclick="Inchi.confirmCard('${cid}')">落库打卡</button>
            <button class="btn-secondary" onclick="Inchi.cancelCard('${cid}')">取消</button>
          </div>
        </div>
      `;
    }

    if (card.type === 'task_confirm') {
      const t = card.payload?.task || {};
      return `
        <div class="action-card" id="card-${cid}">
          <div class="card-heading">确立新弹性任务</div>
          <div class="card-summary">识别到周期性目标，加入弹性任务面板？</div>
          <div class="card-details">
            🎯 任务：<strong>${t.name}</strong><br>
            📚 科目：${t.subject || '未分类'}<br>
            ⏱️ 目标：每${t.cycle === 'daily' ? '天' : '周'} ${t.targetMinutes} 分钟
          </div>
          <div class="card-actions">
            <button class="btn-primary" onclick="Inchi.confirmCard('${cid}')">确立任务</button>
            <button class="btn-secondary" onclick="Inchi.cancelCard('${cid}')">取消</button>
          </div>
        </div>
      `;
    }

    return '';
  },

  async confirmCard(cardId) {
    const cardEl = document.getElementById(`card-${cardId}`);
    if (cardEl) {
      cardEl.innerHTML = `<div class="card-details" style="color:var(--sage)">✅ 已落库成功并更新时间轴</div>`;
    }

    try {
      const res = await fetch(`${this.apiBase}/api/admin/agent/chat`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ action: 'confirm', cardId })
      });
      const data = await res.json();
      this.showToast('✅ 已成功写入台账');
      if (data.reply) this.appendAgentMsg(data.reply, [], true);

      await Promise.all([this.loadPlan(), this.loadTasks()]);
      this.renderAll();
    } catch (err) {
      this.showToast(`❌ 确认失败: ${err.message}`);
    }
  },

  async cancelCard(cardId) {
    const cardEl = document.getElementById(`card-${cardId}`);
    if (cardEl) cardEl.remove();

    try {
      await fetch(`${this.apiBase}/api/admin/agent/chat`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ action: 'cancel', cardId })
      });
      this.showToast('已取消');
    } catch (err) {
      console.warn(err);
    }
  },

  useChip(text) {
    const input = document.getElementById('user-input');
    if (!input) return;
    input.value = text;
    this.sendMessage();
  },

  /* ================= 7. 弹窗与通用组件 ================= */
  openBlockModal(slot) {
    const mask = document.getElementById('modal-mask');
    const title = document.getElementById('modal-block-title');
    const body = document.getElementById('modal-block-body');
    const actions = document.getElementById('modal-block-actions');

    title.textContent = `${slot.subject} · 时间块详情`;
    body.innerHTML = `
      ⏰ 时段：<strong>${slot.start} - ${slot.end}</strong><br>
      📚 科目：<strong>${slot.subject}</strong><br>
      🎯 内容：${slot.topic || '暂无详细主题'}<br>
      📌 状态：<span style="color:${slot.status === 'done' ? 'var(--sage)' : 'var(--terracotta)'}">
        ${slot.status === 'done' ? '已完成 ✅' : '待执行 ⏳'}
      </span>
    `;

    actions.innerHTML = `
      <button class="btn-primary" onclick="Inchi.markSlotDone('${slot.start}')">
        ${slot.status === 'done' ? '标为未完成' : '打卡完成 ✅'}
      </button>
      <button class="btn-secondary" onclick="Inchi.closeModal()">关闭</button>
    `;

    mask.style.display = 'flex';
  },

  async markSlotDone(start) {
    const day = this.plan?.days?.[this.selDate];
    if (day && day.slots) {
      const s = day.slots.find(x => x.start === start);
      if (s) {
        s.status = s.status === 'done' ? 'todo' : 'done';
        this.renderDay();
        this.showToast(s.status === 'done' ? '✅ 时间块已标为完成' : '已重置为待执行');
      }
    }
    this.closeModal();
  },

  closeModal() {
    const mask = document.getElementById('modal-mask');
    if (mask) mask.style.display = 'none';
  },

  updateTopbarDate() {
    const pill = document.getElementById('current-date-label');
    const dowCn = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const cur = new Date();
    if (pill) pill.textContent = `${cur.toISOString().slice(0, 10)} ${dowCn[cur.getDay()]}`;
  },

  updateCountdown() {
    const pill = document.getElementById('countdown-pill');
    if (!pill) return;
    const today = new Date().toISOString().slice(0, 10);
    const exam = this.plan?.exam_date || '2026-12-26';
    const diff = Math.ceil((new Date(exam) - new Date(today)) / (1000 * 3600 * 24));
    pill.textContent = diff >= 0 ? `初试倒计时 ${diff} 天` : '考试已结束';
  },

  async checkNotifications() {
    try {
      const res = await fetch(`${this.apiBase}/api/admin/agent/outbox?unread=1`, { headers: this.headers() });
      if (!res.ok) return;
      const { items } = await res.json();
      const countEl = document.getElementById('notif-count');
      if (countEl) {
        if (items && items.length > 0) {
          countEl.textContent = items.length;
          countEl.style.display = 'inline-block';
        } else {
          countEl.style.display = 'none';
        }
      }
    } catch {}
  },

  toggleNotifs() {
    this.useChip('查安排');
  },

  showToast(msg) {
    const slot = document.getElementById('toast-slot');
    if (!slot) return;
    const toast = document.createElement('div');
    toast.className = 'undo-toast';
    toast.innerHTML = `<span>${msg}</span>`;
    slot.appendChild(toast);
    setTimeout(() => toast.remove(), 3500);
  },

  scrollChatBottom() {
    const stream = document.getElementById('chat-stream');
    if (stream) stream.scrollTo({ top: stream.scrollHeight, behavior: 'smooth' });
  },

  toMin(hhmm) {
    if (!hhmm) return 0;
    const [h, m] = hhmm.split(':').map(Number);
    return (h || 0) * 60 + (m || 0);
  },

  getSubjectClass(subj) {
    if (!subj) return '';
    if (subj.includes('数')) return 'subj-math';
    if (subj.includes('408') || subj.includes('计算机') || subj.includes('代码')) return 'subj-408';
    if (subj.includes('英') || subj.includes('词')) return 'subj-eng';
    return '';
  },

  escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }
};

window.addEventListener('DOMContentLoaded', () => {
  Inchi.init();
});
