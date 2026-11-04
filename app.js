/**
 * Inchi (寸序) — 核心前端控制器
 * 极简、沉静、Anthropic 风格的交互流
 */

const Inchi = {
  apiBase: '',
  token: localStorage.getItem('inchi_token') || 'inchi-token',
  
  async init() {
    this.updateClock();
    await Promise.all([
      this.loadHistory(),
      this.refreshDeck(),
      this.checkNotifications()
    ]);

    // 定时轮询通知 (60s)
    setInterval(() => this.checkNotifications(), 60000);
  },

  headers() {
    return {
      'content-type': 'application/json',
      'authorization': `Bearer ${this.token}`
    };
  },

  updateClock() {
    const now = new Date();
    const days = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    const dateStr = now.toISOString().slice(0, 10);
    const dayStr = days[now.getDay()];
    const pill = document.getElementById('date-pill');
    if (pill) pill.textContent = `${dateStr} ${dayStr}`;
  },

  async loadHistory() {
    try {
      const res = await fetch(`${this.apiBase}/api/admin/agent/chat`, { headers: this.headers() });
      if (!res.ok) return;
      const data = await res.json();
      if (!data.messages || data.messages.length === 0) return;

      const thread = document.getElementById('chat-thread');
      // 保留第一条欢迎词，把历史对话推入
      for (const m of data.messages) {
        if (m.role === 'user') {
          this.appendUserMessage(m.text, false);
        } else {
          this.appendAgentMessage(m.text, m.cards || [], false);
        }
      }
      this.scrollToBottom();
    } catch (err) {
      console.warn('读取对话历史失败:', err);
    }
  },

  async refreshDeck() {
    try {
      const [tasksRes, planRes] = await Promise.all([
        fetch(`${this.apiBase}/api/admin/agent/tasks`, { headers: this.headers() }),
        fetch(`${this.apiBase}/api/admin/kaoyan-plan`, { headers: this.headers() })
      ]);

      if (tasksRes.ok) {
        const { tasks, progress } = await tasksRes.json();
        this.renderTasks(tasks || [], progress || {});
      }

      if (planRes.ok) {
        const plan = await planRes.json();
        this.renderPlan(plan);
      }
    } catch (err) {
      console.warn('刷新聚焦看板失败:', err);
    }
  },

  renderTasks(tasks, progress) {
    const container = document.getElementById('task-capsules');
    if (!container || tasks.length === 0) return;

    container.innerHTML = tasks.slice(0, 4).map(t => {
      const p = progress[t.id] || { actualMinutes: 0, targetMinutes: t.targetMinutes || 60, pct: 0 };
      const pct = Math.min(100, Math.round(p.pct || 0));
      const actualH = (p.actualMinutes / 60).toFixed(1);
      const targetH = (p.targetMinutes / 60).toFixed(0);
      return `
        <div class="task-capsule" title="${t.name}">
          <span>${t.name}</span>
          <div class="progress-mini"><div class="progress-mini-bar" style="width:${pct}%"></div></div>
          <span>${actualH}/${targetH}h</span>
        </div>
      `;
    }).join('');
  },

  renderPlan(plan) {
    const today = new Date().toISOString().slice(0, 10);
    const day = plan?.days?.[today];
    const examDate = plan?.exam_date || '2026-12-26';

    // 倒计时
    const diffDays = Math.ceil((new Date(examDate) - new Date(today)) / (1000 * 3600 * 24));
    const countPill = document.getElementById('countdown-pill');
    if (countPill && diffDays >= 0) {
      countPill.textContent = `距离初试 ${diffDays} 天`;
    }

    // 今日 slots 与下一个时间块
    const nextSlotEl = document.getElementById('next-slot');
    if (!day || !day.slots || day.slots.length === 0) {
      if (nextSlotEl) nextSlotEl.innerHTML = `<span>今天暂无排期，对寸序说一句即可自动安排</span>`;
      return;
    }

    const nowHHMM = new Date().toTimeString().slice(0, 5);
    const upcoming = day.slots.find(s => (s.end || '99:99') > nowHHMM);
    if (nextSlotEl) {
      if (upcoming) {
        const isRunning = upcoming.start <= nowHHMM && upcoming.end >= nowHHMM;
        nextSlotEl.innerHTML = `
          <span><strong>${upcoming.start} - ${upcoming.end}</strong> · ${upcoming.subject} ${upcoming.topic || ''}</span>
          <span class="task-capsule" style="color:var(--terracotta)">${isRunning ? '正在进行 🔥' : '即将开始 ⏳'}</span>
        `;
      } else {
        nextSlotEl.innerHTML = `<span>今日时间块已全部完成 ✅</span>`;
      }
    }
  },

  async sendMessage(event) {
    if (event) event.preventDefault();
    const input = document.getElementById('user-input');
    const text = input.value.trim();
    if (!text) return;

    input.value = '';
    this.appendUserMessage(text, true);

    const sendBtn = document.getElementById('send-btn');
    if (sendBtn) sendBtn.disabled = true;

    try {
      const res = await fetch(`${this.apiBase}/api/admin/agent/chat`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ message: text })
      });

      const data = await res.json();
      this.appendAgentMessage(data.reply || '已收到', data.cards || [], true);
      await this.refreshDeck();
    } catch (err) {
      this.appendAgentMessage(`⚠️ 请求出错: ${err.message}`, [], true);
    } finally {
      if (sendBtn) sendBtn.disabled = false;
    }
  },

  appendUserMessage(text, scroll = true) {
    const thread = document.getElementById('chat-thread');
    const msg = document.createElement('div');
    msg.className = 'chat-message msg-user';
    msg.textContent = text;
    thread.appendChild(msg);
    if (scroll) this.scrollToBottom();
  },

  appendAgentMessage(text, cards = [], scroll = true) {
    const thread = document.getElementById('chat-thread');
    const msg = document.createElement('div');
    msg.className = 'chat-message msg-agent';

    let html = `<div class="agent-bubble">${this.escapeHtml(text)}</div>`;
    for (const card of cards) {
      html += this.renderCard(card);
    }

    msg.innerHTML = html;
    thread.appendChild(msg);
    if (scroll) this.scrollToBottom();
  },

  renderCard(card) {
    const cid = card.id;
    if (card.type === 'log_confirm') {
      const s = card.payload?.sessions?.[0] || {};
      return `
        <div class="action-card" id="card-${cid}">
          <div class="card-heading">待确认学习记录</div>
          <div class="card-summary">确认将该条学习成果记录进台账吗？</div>
          <div class="card-details">
            📅 日期：${s.date || '今天'}<br>
            📚 科目：<strong>${s.subject || '未分类'}</strong><br>
            ⏱️ 用时：<strong>${s.minutes || 0} 分钟</strong> (${((s.minutes || 0) / 60).toFixed(1)} 小时)<br>
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
          <div class="card-heading">建立新弹性任务</div>
          <div class="card-summary">识别到长期自律目标，确立该弹性任务吗？</div>
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
      cardEl.innerHTML = `<div class="card-details" style="color:var(--sage)">✅ 已确认落库，正在同步…</div>`;
    }

    try {
      const res = await fetch(`${this.apiBase}/api/admin/agent/chat`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ action: 'confirm', cardId })
      });
      const data = await res.json();
      this.showToast('✅ 已成功写入台账');
      if (data.reply) this.appendAgentMessage(data.reply, [], true);
      await this.refreshDeck();
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
      this.showToast('已取消该卡片');
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
    } catch (err) {
      // quiet
    }
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

  scrollToBottom() {
    window.scrollTo({ top: document.body.scrollHeight, behavior: 'smooth' });
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
