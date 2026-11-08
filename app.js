/**
 * Cairn (理序) — 核心应用控制器
 *
 * v2 起主屏是工作台（workbench.js）：拨档 → 发牌 → 正向计时。
 * 这里保留三块 v1 资产：对话录入（NLU + 卡片确认 + 撤销）、系统与 AI 设置、通知面板。
 * v1 的单日时间轴 / 月历 / 手动排期已随三视图退役，代码在 git 历史里。
 */

/** 本地时区的 YYYY-MM-DD。toISOString() 是 UTC 日期，东八区 0~8 点会算成昨天。 */
function localDateStr(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

const Inchi = {
  apiBase: localStorage.getItem('inchi_apibase') || '',
  /* localStorage key 沿用 v1 名字，避免把已保存的令牌 / 服务地址弄丢 */
  token: localStorage.getItem('inchi_token') || 'cairn-token',

  mode: 'workbench',
  theme: 'dark',

  notifItems: [],
  unreadNotifs: [],
  aiModelOptions: [],
  _filteredModels: [],
  _aiHasSavedKey: false,

  async init() {
    this.initTheme();
    this.initMode();

    await this.checkNotifications();

    /* ESC 逐层退：抽屉 → 控制台 → 弹窗（设置 / 模型列表 / 任务 / 留档 / 通知） */
    window.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        if (this.drawer) { this.openDrawer(null); return; }
        const consoleEl = document.getElementById('cmd-console');
        if (consoleEl && consoleEl.style.display !== 'none') { this.toggleConsole(false); return; }
        this.closeSettingsModal();
        this.hideModelPick();
        if (window.Workbench) {
          Workbench.closeTaskModal();
          Workbench.closeTaskEdit();
          Workbench.cancelCommit();
        }
        const panel = document.getElementById('notif-panel');
        if (panel) panel.style.display = 'none';
      }
    });

    /* Alt+S 便签抽屉（闪念入口）、Alt+D 日历抽屉。
       用 e.code（键位）判定：Alt 组合下 e.key 在部分布局会变形 */
    window.addEventListener('keydown', (e) => {
      if (!e.altKey || e.ctrlKey || e.metaKey) return;
      if (e.code === 'KeyS') { e.preventDefault(); this.toggleDrawer('notes'); }
      if (e.code === 'KeyD') { e.preventDefault(); this.toggleDrawer('calendar'); }
    });

    /* 点击面板外部关闭通知面板与模型列表 */
    document.addEventListener('click', (e) => {
      const panel = document.getElementById('notif-panel');
      if (panel && panel.style.display !== 'none') {
        const bell = document.getElementById('notif-btn');
        if (!panel.contains(e.target) && !(bell && bell.contains(e.target))) {
          panel.style.display = 'none';
        }
      }
      const pop = document.getElementById('model-pick-pop');
      if (pop && pop.style.display !== 'none' && !pop.contains(e.target)) {
        const fetchBtn = document.getElementById('ai-fetch-models-btn');
        if (!(fetchBtn && fetchBtn.contains(e.target))) this.hideModelPick();
      }
    });

    setInterval(() => this.checkNotifications(), 60000);

    /* 命令栏占位文案随屏宽精简（手机上避免截断） */
    const dockInput = document.getElementById('user-input');
    const setDockPlaceholder = () => {
      if (dockInput) dockInput.placeholder = window.innerWidth < 768
        ? '> 记一笔、扔闪念或问一句…'
        : '随手记一笔、扔个闪念、问一句…（回车发送，卡片确认后生效）';
    };
    setDockPlaceholder();
    window.addEventListener('resize', setDockPlaceholder);

    /* PWA：手机加到主屏后由 Service Worker 提供离线外壳；API 永远走网络 */
    if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
      navigator.serviceWorker.register('/sw.js').catch((err) => console.warn('SW 注册失败:', err));
    }
  },

  headers() {
    return {
      'content-type': 'application/json',
      'authorization': `Bearer ${this.token}`
    };
  },

  /* ================= 抽屉与控制台（主视图恒为工作台） ================= */
  drawer: null,
  _chatLoaded: false,

  openDrawer(name) {
    if (name !== 'notes' && name !== 'calendar') name = null;
    this.drawer = name;
    const backdrop = document.getElementById('drawer-backdrop');
    for (const key of ['notes', 'calendar']) {
      const el = document.getElementById(`drawer-${key}`);
      if (el) el.classList.toggle('open', key === name);
      const btn = document.getElementById(`drawer-${key}-btn`);
      if (btn) btn.classList.toggle('sel', key === name);
    }
    if (backdrop) backdrop.style.display = name ? 'block' : 'none';
    if (name === 'notes' && window.Notes) Notes.enter();
    if (name === 'calendar' && window.MonthView) MonthView.enter();
  },

  toggleDrawer(name) {
    this.openDrawer(this.drawer === name ? null : name);
    if (this.drawer === 'notes') document.getElementById('note-input')?.focus();
  },

  toggleConsole(open) {
    const c = document.getElementById('cmd-console');
    if (!c) return;
    const show = open === undefined ? c.style.display === 'none' : !!open;
    c.style.display = show ? 'flex' : 'none';
    if (show && !this._chatLoaded) {
      this._chatLoaded = true;
      this.loadChatHistory();
    }
    if (show) this.scrollChatBottom();
  },

  initMode() {
    /* 主视图恒为工作台；抽屉与控制台按需滑出 */
    if (window.Workbench) Workbench.enter();
  },

  /* ================= 浅色 / 夜间主题 ================= */
  initTheme() {
    try { this.theme = localStorage.getItem('inchi_theme') === 'light' ? 'light' : 'dark'; } catch { this.theme = 'dark'; }
    this.applyTheme();
  },

  applyTheme() {
    document.documentElement.setAttribute('data-theme', this.theme);
    const icon = document.getElementById('theme-icon');
    if (icon) icon.textContent = this.theme === 'light' ? '☀' : '☾';
  },

  toggleTheme() {
    this.theme = this.theme === 'light' ? 'dark' : 'light';
    try { localStorage.setItem('inchi_theme', this.theme); } catch { /* 存不进就只切本页 */ }
    this.applyTheme();
  },

  /* ================= 对话录入（命令行控制台） ================= */
  async sendMessage(event) {
    if (event) event.preventDefault();
    const input = document.getElementById('user-input');
    const text = input.value.trim();
    if (!text) return;

    input.value = '';
    this.toggleConsole(true);
    this.appendUserMsg(text, true);

    const sendBtn = document.getElementById('send-btn');
    if (sendBtn) sendBtn.disabled = true;

    try {
      const res = await fetch(`${this.apiBase}/api/admin/agent/chat`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ text, source: 'web' })
      });

      const data = await res.json();
      if (data.error) throw new Error(data.error);
      this.appendAgentMsg(data.reply || '已收到', data.cards || [], true);

      /* 台账可能变了 → 顶栏光谱与任务单都要跟上 */
      if (window.Workbench) Workbench.refresh();
    } catch (err) {
      this.appendAgentMsg(`处理失败：${err.message}`, [], true);
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
          <div class="card-summary">确认将这条成果写入今日台账？</div>
          <div class="card-details">
            日期：${s.date || '今天'}<br>
            科目：<strong>${s.subject || '未分类'}</strong><br>
            时长：<strong>${s.minutes || 0} 分钟</strong> (${((s.minutes || 0)/60).toFixed(1)}h)<br>
            备注：${s.note || '无'}
          </div>
          <div class="card-actions">
            <button class="btn-primary" onclick="Inchi.confirmCard('${cid}')">落库</button>
            <button class="btn-secondary" onclick="Inchi.cancelCard('${cid}')">取消</button>
          </div>
        </div>
      `;
    }

    if (card.type === 'task_confirm') {
      const t = card.payload?.task || {};
      return `
        <div class="action-card" id="card-${cid}">
          <div class="card-heading">确立新任务</div>
          <div class="card-summary">识别到周期性目标，放进任务池？</div>
          <div class="card-details">
            任务：<strong>${t.name}</strong><br>
            科目：${t.subject || '未分类'}<br>
            目标：每${t.cycle === 'daily' ? '天' : '周'} ${t.targetMinutes} 分钟
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
      cardEl.innerHTML = `<div class="card-details">已写入台账。</div>`;
    }

    try {
      const res = await fetch(`${this.apiBase}/api/admin/agent/chat`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ confirm: cardId })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      this.showToast('已写入台账');
      if (data.reply) this.appendAgentMsg(data.reply, [], true);

      if (window.Workbench) Workbench.refresh();
    } catch (err) {
      this.showToast(`确认失败: ${err.message}`);
    }
  },

  async cancelCard(cardId) {
    const cardEl = document.getElementById(`card-${cardId}`);
    if (cardEl) cardEl.remove();

    try {
      const res = await fetch(`${this.apiBase}/api/admin/agent/chat`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({ cancel: cardId })
      });
      const data = await res.json();
      this.showToast(data.error ? `${data.error}` : '已取消');
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

  async loadChatHistory() {
    try {
      const res = await fetch(`${this.apiBase}/api/admin/agent/chat`, { headers: this.headers() });
      if (!res.ok) return;
      const data = await res.json();
      if (!data.messages) return;

      const stream = document.getElementById('chat-stream');
      /* 清空除第一条欢迎语以外的内容 */
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

  /* ================= 系统与 AI 设置（v1 资产） ================= */

  /** 常见服务商预设（base + 默认模型；模型不确定的就留空让用户拉列表挑） */
  AI_PRESETS: {
    deepseek:    { base: 'https://api.deepseek.com',            model: 'deepseek-chat' },
    siliconflow: { base: 'https://api.siliconflow.cn/v1',       model: '' },
    openai:      { base: 'https://api.openai.com/v1',           model: 'gpt-4o-mini' },
    moonshot:    { base: 'https://api.moonshot.cn/v1',          model: '' },
    glm:         { base: 'https://open.bigmodel.cn/api/paas/v4', model: '' },
    openrouter:  { base: 'https://openrouter.ai/api/v1',        model: '' },
    ollama:      { base: 'http://localhost:11434/v1',           model: '' }
  },

  async openSettingsModal() {
    const modal = document.getElementById('settings-modal');
    const tokenInput = document.getElementById('setting-token');
    const apiInput = document.getElementById('setting-apibase');
    const statusBox = document.getElementById('settings-ai-status');

    if (tokenInput) tokenInput.value = this.token;
    if (apiInput) apiInput.value = this.apiBase;
    if (statusBox) statusBox.innerHTML = '正在探测后端 AI 状态…';
    this.setAiFeedback('');

    if (modal) modal.style.display = 'flex';

    /* 先拉已保存的自定义配置填表（Key 只回掩码，不回填原文） */
    this._aiHasSavedKey = false;
    try {
      const res = await fetch(`${this.apiBase}/api/admin/agent/ai-config`, { headers: this.headers() });
      if (res.ok) {
        const data = await res.json();
        const baseEl = document.getElementById('ai-base-url');
        const modelEl = document.getElementById('ai-model');
        const keyEl = document.getElementById('ai-api-key');
        if (baseEl) baseEl.value = data.config?.baseUrl || '';
        if (modelEl) modelEl.value = data.config?.model || '';
        if (keyEl) {
          keyEl.value = '';
          keyEl.placeholder = data.config?.hasKey
            ? `已保存：${data.config.apiKeyMasked}（留空则不修改）`
            : 'sk-…（支持直接整段粘贴）';
        }
        this._aiHasSavedKey = Boolean(data.config?.hasKey);
        if (data.source === 'ui') {
          this.setAiFeedback('当前生效：网页保存的自定义配置', 'ok');
        } else if (data.source === 'env') {
          this.setAiFeedback('当前生效：服务端环境变量 (.env)。在上方填写并保存即可覆盖。', '');
        }
      }
    } catch { /* 端点不存在（旧版后端）时静默 */ }

    try {
      const res = await fetch(`${this.apiBase}/api/status`);
      if (res.ok) {
        const data = await res.json();
        if (data.llm?.configured) {
          const srcTag = data.llm.source === 'ui' ? '来源：网页自定义配置' : '来源：服务端环境变量';
          statusBox.innerHTML = `已就绪：模型 <code>${this.escapeHtml(data.llm.model)}</code><br><span class="status-sub">端点: ${this.escapeHtml(data.llm.base)} · ${srcTag}</span>`;
        } else {
          statusBox.innerHTML = `未配置 AI 接口<br><span class="status-sub">当前处于离线规则引擎模式（记一笔、计时入账可用）。在上方「自定义 AI 接口」填好并保存即可启用。</span>`;
        }
      } else {
        statusBox.innerHTML = `未能获取 AI 状态 (HTTP ${res.status})`;
      }
    } catch (err) {
      statusBox.innerHTML = `无法连接到服务端 (${err.message})<br><span class="status-sub">请检查服务地址或当前网络</span>`;
    }
  },

  closeSettingsModal(event) {
    if (event && event.target && event.target.id !== 'settings-modal') return;
    const modal = document.getElementById('settings-modal');
    if (modal) modal.style.display = 'none';
    this.hideModelPick();
  },

  /* ---------- 自定义 AI 接口：预设 / 清洗 / 粘贴 / 复制 ---------- */

  applyAiPreset(key) {
    const preset = this.AI_PRESETS[key];
    if (!preset) return;
    const baseEl = document.getElementById('ai-base-url');
    const modelEl = document.getElementById('ai-model');
    if (baseEl) baseEl.value = preset.base;
    if (modelEl) modelEl.value = preset.model;
    this.setAiFeedback(`已填入 ${key} 预设${preset.model ? '，默认模型 ' + preset.model : '，可点「一键获取模型列表」挑选模型'}`, 'ok');
    const keyEl = document.getElementById('ai-api-key');
    if (keyEl && !keyEl.value) keyEl.focus();
  },

  /** 输入中的轻度清洗：剥掉误粘的 /chat/completions 后缀 */
  normalizeAiBaseUrl() {
    const el = document.getElementById('ai-base-url');
    if (!el) return;
    const cleaned = this.cleanAiBaseUrl(el.value);
    if (cleaned !== el.value) el.value = cleaned;
  },

  cleanAiBaseUrl(raw) {
    let v = String(raw || '').trim().replace(/["']/g, '');
    if (!v) return '';
    if (!/^https?:\/\//i.test(v) && !/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(v)) {
      v = 'https://' + v;
    }
    v = v.replace(/\/+$/, '');
    v = v.replace(/\/(v1\/)?chat\/completions$/i, '');
    return v;
  },

  cleanAiKey(raw) {
    return String(raw || '').replace(/^bearer\s+/i, '').replace(/["'\s]/g, '');
  },

  onAiKeyInput() {
    const el = document.getElementById('ai-api-key');
    if (!el) return;
    const cleaned = this.cleanAiKey(el.value);
    if (cleaned !== el.value) el.value = cleaned;
  },

  /** 粘贴识别：整段 JSON 配置自动拆字段；普通粘贴自动清洗 */
  onAiPaste(event) {
    const text = (event.clipboardData || window.clipboardData)?.getData('text') || '';
    const target = event.target;
    if (!target) return;
    const trimmed = text.trim();

    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const obj = JSON.parse(trimmed);
        const base = obj.baseUrl || obj.base_url || obj.base || obj.apiBase || '';
        const key = obj.apiKey || obj.api_key || obj.key || '';
        const model = obj.model || '';
        if (base || key || model) {
          event.preventDefault();
          if (base) document.getElementById('ai-base-url').value = this.cleanAiBaseUrl(base);
          if (key) document.getElementById('ai-api-key').value = this.cleanAiKey(key);
          if (model) document.getElementById('ai-model').value = String(model).trim();
          this.setAiFeedback('已识别整段 JSON 配置并自动填好各字段', 'ok');
          return;
        }
      } catch { /* 不是 JSON，按普通文本粘贴 */ }
    }

    if (target.id === 'ai-api-key') {
      event.preventDefault();
      target.value = this.cleanAiKey(text);
      this.setAiFeedback('已自动清洗粘贴的 Key（去掉空白 / 引号 / Bearer 前缀）', '');
    } else if (target.id === 'ai-base-url') {
      event.preventDefault();
      target.value = this.cleanAiBaseUrl(text);
    }
  },

  toggleKeyVisible() {
    const el = document.getElementById('ai-api-key');
    if (!el) return;
    el.type = el.type === 'password' ? 'text' : 'password';
  },

  async copyField(btn) {
    const inputId = btn?.dataset?.copy;
    const el = inputId && document.getElementById(inputId);
    if (!el || !el.value.trim()) {
      this.setAiFeedback('这个字段还是空的，没有东西可复制', '');
      return;
    }
    try {
      await navigator.clipboard.writeText(el.value.trim());
      btn.classList.add('copied');
      const original = btn.textContent;
      btn.textContent = '已复制';
      setTimeout(() => {
        btn.classList.remove('copied');
        btn.textContent = original;
      }, 1200);
    } catch (err) {
      this.setAiFeedback(`复制失败：${err.message}`, 'err');
    }
  },

  async copyAiConfigJson() {
    const cfg = {
      baseUrl: document.getElementById('ai-base-url')?.value.trim() || '',
      apiKey: document.getElementById('ai-api-key')?.value.trim() || '',
      model: document.getElementById('ai-model')?.value.trim() || ''
    };
    if (!cfg.baseUrl && !cfg.apiKey && !cfg.model) {
      this.setAiFeedback('配置是空的，先填好或先从剪贴板导入', '');
      return;
    }
    try {
      await navigator.clipboard.writeText(JSON.stringify(cfg, null, 2));
      this.setAiFeedback('已复制全部配置为 JSON，可发给别的设备粘贴导入', 'ok');
    } catch (err) {
      this.setAiFeedback(`复制失败：${err.message}`, 'err');
    }
  },

  setAiFeedback(msg, type = '') {
    const el = document.getElementById('ai-config-feedback');
    if (!el) return;
    el.textContent = msg || '';
    el.className = `ai-config-feedback ${type}`.trim();
  },

  /* ---------- 一键获取模型列表 ---------- */
  async fetchModelList() {
    const btn = document.getElementById('ai-fetch-models-btn');
    const baseEl = document.getElementById('ai-base-url');
    const keyEl = document.getElementById('ai-api-key');
    if (!btn || !baseEl || !keyEl) return;

    btn.disabled = true;
    const originalLabel = btn.textContent;
    btn.textContent = '获取中…';
    this.setAiFeedback('正在拉取模型列表…');

    try {
      const res = await fetch(`${this.apiBase}/api/admin/agent/ai-config`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          action: 'models',
          baseUrl: this.cleanAiBaseUrl(baseEl.value),
          apiKey: keyEl.value.trim()
        })
      });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);

      this.aiModelOptions = data.models || [];
      if (!this.aiModelOptions.length) {
        this.setAiFeedback('接口没有返回任何模型，请确认 Key 与地址', 'err');
        return;
      }
      this.setAiFeedback(`拉到 ${this.aiModelOptions.length} 个模型，点击挑选（当前路径 ${data.path}）`, 'ok');
      this.showModelPick();
    } catch (err) {
      this.setAiFeedback(`获取模型列表失败：${err.message}`, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  },

  showModelPick() {
    const pop = document.getElementById('model-pick-pop');
    const search = document.getElementById('model-pick-search');
    if (!pop) return;
    if (search) search.value = '';
    this.renderModelList('');
    pop.style.display = 'flex';
    if (search) search.focus();
  },

  hideModelPick() {
    const pop = document.getElementById('model-pick-pop');
    if (pop) pop.style.display = 'none';
  },

  renderModelList(filter) {
    const list = document.getElementById('model-pick-list');
    if (!list) return;
    const kw = String(filter || '').trim().toLowerCase();
    const models = kw
      ? this.aiModelOptions.filter(m => m.toLowerCase().includes(kw))
      : this.aiModelOptions;

    if (!models.length) {
      list.innerHTML = '<div class="model-pick-empty">没有匹配的模型</div>';
      return;
    }
    /* 用索引回查而不是把模型名拼进 onclick，避免特殊字符破坏属性 */
    this._filteredModels = models.slice(0, 300);
    list.innerHTML = this._filteredModels.map((m, idx) =>
      `<div class="model-pick-item" onclick="Inchi.pickModelByIndex(${idx})">${this.escapeHtml(m)}</div>`
    ).join('');
  },

  filterModelList() {
    const search = document.getElementById('model-pick-search');
    this.renderModelList(search ? search.value : '');
  },

  pickModelByIndex(idx) {
    const id = (this._filteredModels || [])[idx];
    if (!id) return;
    const el = document.getElementById('ai-model');
    if (el) el.value = id;
    this.hideModelPick();
    this.setAiFeedback(`已选择模型：${id}`, 'ok');
  },

  /* 服务器地址归一：裸 IP:端口默认补 http://（局域网服务是 http） */
  cleanServerBase(raw) {
    let v = String(raw || '').trim().replace(/\/+$/, '');
    if (!v) return '';
    if (!/^https?:\/\//i.test(v)) v = 'http://' + v;
    return v;
  },

  /* ---------- 服务器连接测试：验证自建服务地址 + 令牌能否打通 ---------- */
  async testServerConnection() {
    const el = document.getElementById('server-conn-result');
    if (!el) return;
    const raw = (document.getElementById('setting-apibase')?.value || '').trim().replace(/\/+$/, '');
    const base = this.cleanServerBase(raw);
    el.textContent = '正在连接…';
    el.className = 'server-conn-result';
    const tryFetch = async (b) => {
      const res = await fetch(`${b}/api/status`, { headers: this.headers() });
      const data = await res.json();
      if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
      return data;
    };
    try {
      const data = await tryFetch(base);
      el.innerHTML = `✓ 已连通：${this.escapeHtml(data.name || '服务')} v${this.escapeHtml(data.version || '?')} · AI ${data.llm?.configured ? '已接入' : '未配置'}`;
      el.className = 'server-conn-result ok';
    } catch (err) {
      el.textContent = `连不上：${err.message}`;
      el.className = 'server-conn-result err';
    }
  },

  /* ---------- 连接测试 / 保存 / 清除 ---------- */
  async testAiConnection() {
    const btn = document.getElementById('ai-test-btn');
    const baseEl = document.getElementById('ai-base-url');
    const keyEl = document.getElementById('ai-api-key');
    const modelEl = document.getElementById('ai-model');
    if (!btn || !baseEl || !keyEl || !modelEl) return;

    btn.disabled = true;
    const originalLabel = btn.textContent;
    btn.textContent = '测试中…';
    this.setAiFeedback('正在向接口发一条测试消息…');

    try {
      const res = await fetch(`${this.apiBase}/api/admin/agent/ai-config`, {
        method: 'POST',
        headers: this.headers(),
        body: JSON.stringify({
          action: 'test',
          baseUrl: this.cleanAiBaseUrl(baseEl.value),
          apiKey: keyEl.value.trim(),
          model: modelEl.value.trim()
        })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (!data.ok) throw new Error(data.error || '接口报错');
      this.setAiFeedback(`连接成功 · ${data.model} · 延迟 ${data.latencyMs}ms${data.reply ? ` · 回复「${data.reply}」` : ''}`, 'ok');
    } catch (err) {
      this.setAiFeedback(`连接失败：${err.message}`, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = originalLabel;
    }
  },

  async saveSettings() {
    const tokenInput = document.getElementById('setting-token');
    const apiInput = document.getElementById('setting-apibase');
    const baseEl = document.getElementById('ai-base-url');
    const keyEl = document.getElementById('ai-api-key');
    const modelEl = document.getElementById('ai-model');

    const newToken = tokenInput ? tokenInput.value.trim() : '';
    const newApi = this.cleanServerBase(apiInput ? apiInput.value : '');

    this.token = newToken || 'cairn-token';
    localStorage.setItem('inchi_token', this.token);
    if (window.Workbench) Workbench.token = this.token;
    for (const mod of [window.Notes, window.MonthView]) {
      if (mod) mod.token = this.token;
    }

    this.apiBase = newApi;
    if (window.Workbench) { Workbench.apiBase = newApi; Workbench.token = this.token; }
    /* 所有模块的地址/令牌一起切，远程接入才完整 */
    for (const mod of [window.Notes, window.MonthView]) {
      if (mod) { mod.apiBase = newApi; mod.token = this.token; }
    }
    if (newApi) {
      localStorage.setItem('inchi_apibase', newApi);
    } else {
      localStorage.removeItem('inchi_apibase');
    }

    /* 保存自定义 AI 配置：Key 留空且已有保存的 Key → 不覆盖（keepApiKey） */
    let aiSaved = null;
    try {
      const keyVal = keyEl ? keyEl.value.trim() : '';
      const res = await fetch(`${this.apiBase}/api/admin/agent/ai-config`, {
        method: 'PUT',
        headers: this.headers(),
        body: JSON.stringify({
          baseUrl: baseEl ? this.cleanAiBaseUrl(baseEl.value) : '',
          apiKey: keyVal,
          model: modelEl ? modelEl.value.trim() : '',
          keepApiKey: !keyVal && this._aiHasSavedKey
        })
      });
      aiSaved = await res.json();
      if (!res.ok) throw new Error(aiSaved.error || `HTTP ${res.status}`);
    } catch (err) {
      this.showToast(`AI 接口配置保存失败：${err.message}`);
    }

    this.closeSettingsModal();
    if (aiSaved?.saved) {
      this.showToast('AI 接口已切换为网页自定义配置，即时生效');
    } else if (aiSaved?.cleared) {
      this.showToast('已清除自定义 AI 配置，回落到服务端 .env');
    } else {
      this.showToast('设置已保存');
    }
    if (window.Workbench) Workbench.refresh();
  },

  async clearAiConfig() {
    const baseEl = document.getElementById('ai-base-url');
    const keyEl = document.getElementById('ai-api-key');
    const modelEl = document.getElementById('ai-model');
    if (baseEl) baseEl.value = '';
    if (keyEl) keyEl.value = '';
    if (modelEl) modelEl.value = '';
    this._aiHasSavedKey = false;
    if (keyEl) keyEl.placeholder = 'sk-…（支持直接整段粘贴）';
    this.setAiFeedback('已清空表单。保存后将回落到服务端 .env 配置', '');
  },

  /* ================= 通知（v1 资产） ================= */
  async checkNotifications() {
    try {
      const res = await fetch(`${this.apiBase}/api/admin/agent/outbox?unread=1`, { headers: this.headers() });
      if (!res.ok) return;
      const { items } = await res.json();
      this.unreadNotifs = Array.isArray(items) ? items : [];
      this.updateNotifBadge();
    } catch {}
  },

  updateNotifBadge() {
    const countEl = document.getElementById('notif-count');
    if (!countEl) return;
    const n = this.unreadNotifs.length;
    if (n > 0) {
      countEl.textContent = n > 99 ? '99+' : String(n);
      countEl.style.display = 'inline-block';
    } else {
      countEl.style.display = 'none';
    }
  },

  toggleNotifs() {
    const panel = document.getElementById('notif-panel');
    if (!panel) return;
    if (panel.style.display === 'none' || !panel.style.display) {
      panel.style.display = 'flex';
      this.loadNotifList();
    } else {
      panel.style.display = 'none';
    }
  },

  async loadNotifList() {
    const list = document.getElementById('notif-list');
    if (!list) return;
    list.innerHTML = '<div class="notif-empty">加载中…</div>';
    try {
      const res = await fetch(`${this.apiBase}/api/admin/agent/outbox?take=30`, { headers: this.headers() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const { items } = await res.json();
      this.notifItems = Array.isArray(items) ? items : [];
      this.renderNotifList();
    } catch (err) {
      list.innerHTML = `<div class="notif-empty">读取失败：${this.escapeHtml(err.message)}</div>`;
    }
  },

  renderNotifList() {
    const list = document.getElementById('notif-list');
    if (!list) return;
    if (!this.notifItems.length) {
      list.innerHTML = '<div class="notif-empty">暂无通知</div>';
      return;
    }
    list.innerHTML = this.notifItems.map(i => `
      <div class="notif-item ${i.read ? '' : 'unread'}" onclick="Inchi.markNotifRead('${i.id}')" title="${i.read ? '' : '点击标记已读'}">
        <div class="notif-item-text">${this.escapeHtml(i.text)}</div>
        <div class="notif-item-meta">
          <span class="kind-tag">${this.notifKindLabel(i.kind)}</span>
          <span>${this.fmtNotifTime(i.ts)}</span>
          ${i.channel === 'qq' ? '<span>· 同步 QQ</span>' : ''}
        </div>
      </div>
    `).join('');
  },

  notifKindLabel(kind) {
    const map = {
      morning_report: '晨报', noon_check: '午间巡检', evening_log: '晚间日志',
      weekly_report: '周报', schedule: '排期', note: '备忘'
    };
    return map[kind] || (kind || '通知');
  },

  fmtNotifTime(ts) {
    if (!ts) return '';
    const d = new Date(ts);
    if (isNaN(d.getTime())) return '';
    const hhmm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
    return localDateStr(d) === localDateStr() ? hhmm : `${localDateStr(d).slice(5)} ${hhmm}`;
  },

  async markNotifRead(id) {
    const item = this.notifItems.find(x => x.id === id);
    if (item && item.read) return;
    try {
      await fetch(`${this.apiBase}/api/admin/agent/outbox`, {
        method: 'PATCH',
        headers: this.headers(),
        body: JSON.stringify({ ids: [id], read: true })
      });
      if (item) item.read = true;
      this.unreadNotifs = this.unreadNotifs.filter(x => x.id !== id);
      this.renderNotifList();
      this.updateNotifBadge();
    } catch (err) {
      this.showToast(`标记已读失败：${err.message}`);
    }
  },

  async markAllNotifsRead() {
    const unreadIds = this.notifItems.filter(i => !i.read).map(i => i.id);
    if (!unreadIds.length) return;
    try {
      await fetch(`${this.apiBase}/api/admin/agent/outbox`, {
        method: 'PATCH',
        headers: this.headers(),
        body: JSON.stringify({ ids: unreadIds, read: true })
      });
      this.notifItems.forEach(i => { i.read = true; });
      this.unreadNotifs = [];
      this.renderNotifList();
      this.updateNotifBadge();
      this.showToast('已全部标记为已读');
    } catch (err) {
      this.showToast(`操作失败：${err.message}`);
    }
  },

  /* ================= 公共小件 ================= */
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

  escapeHtml(str) {
    return String(str || '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }
};

/* const 声明不会自动挂到 window，这里显式挂上：
   workbench.js 的 toast 回调与 inline onclick 都可能经由 window 找到这里 */
window.Inchi = Inchi;

window.addEventListener('DOMContentLoaded', () => {
  Inchi.init();
});
