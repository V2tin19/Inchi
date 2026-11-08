/**
 * Workbench —— 单屏三区工作台（SPEC v2 · M2/M3 · 暗色遥测风）
 *
 * 顶部：状态档位并入顶栏；全局进度条已移除（目标时长属于任务）。
 * 左任务单：可拖拽——组内排序、跨组改档、拖到分类托盘改分类（断点语义）；
 *          悬停出 ⚙ 进入任务设置；收纳后留一根可点的竖条。
 * 右聚光灯：一句话记录 + 「✎ 记一笔」（手动时长，第一动作）/「▶ 计时」（备选，
 *          正向小字，可暂停/继续/放弃，留档与暂停分离）+ 目标时长折叠 + 最近推进（可补改）。
 */

const Workbench = {
  apiBase: localStorage.getItem('inchi_apibase') || '',
  token: localStorage.getItem('inchi_token') || 'cairn-token',

  bundle: null,
  selectedTaskId: null,   /* 手动点选优先于发牌 */
  running: null,          /* { taskId, startedMs, pausedMs? } —— 计时中锁聚光灯 */
  _tick: null,
  _radarCollapsed: false,
  _recover: null,         /* 上次中断未结算的计时记录（刷新恢复询问用） */
  _commitsTaskId: null,
  _commits: null,
  _editingCommit: null,
  _manualCommit: false,
  _taskModalNoteId: null,
  _catColor: null,
  _dragId: null,

  headers() {
    return { 'content-type': 'application/json', 'authorization': `Bearer ${this.token}` };
  },

  esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  },

  /* ---------- 工具 ---------- */
  fmtH(min) { return (Math.round(min / 6) / 10).toFixed(1) + 'h'; },
  fmtShort(min) { return min < 60 ? `${Math.round(min)}分钟` : this.fmtH(min); },
  fmtClock(sec) {
    const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = sec % 60;
    return [h, m, s].map(n => String(n).padStart(2, '0')).join(' : ');
  },
  catCn(c) { return { CORE: '核心正事', EXPLORE: '个人探索', CHORE: '日常杂项' }[c] || '核心正事'; },
  stateCn(s) { return { HIGH: '兴致高涨', NORMAL: '状态平稳', LOW: '电量见底' }[s] || ''; },

  toast(msg) {
    if (window.Inchi && Inchi.showToast) Inchi.showToast(msg);
    else console.log(msg);
  },

  /* ---------- 计时暂存的本地断点 ---------- */
  _saveRun() {
    try {
      if (this.running) {
        localStorage.setItem('inchi_run_v1', JSON.stringify({
          taskId: this.running.taskId,
          startedMs: this.running.startedMs,
          pausedMs: this.running.pausedMs || null
        }));
      } else localStorage.removeItem('inchi_run_v1');
    } catch { /* 存不进就只影响中断恢复 */ }
  },

  _readRun() {
    try {
      const raw = localStorage.getItem('inchi_run_v1');
      if (!raw) return null;
      const r = JSON.parse(raw);
      return (r && r.taskId && Number.isFinite(r.startedMs)) ? r : null;
    } catch { return null; }
  },

  /* ---------- 数据 ---------- */
  async enter() {
    await this.refresh();
  },

  async refresh(keepSelection = true) {
    try {
      const res = await fetch(`${this.apiBase}/api/admin/agent/workbench`, { headers: this.headers() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      this.bundle = await res.json();
      if (!keepSelection || !this.bundle.tasks.some(t => t.id === this.selectedTaskId && t.status === 'active')) {
        this.selectedTaskId = null;
      }
      /* 刷新中断恢复：本地有未结算的计时、内存里又没在走 → 轻声问一句；
         任务已经不在了就顺手清掉孤儿记录 */
      const stored = this._readRun();
      if (stored && !this.bundle.tasks.some(t => t.id === stored.taskId)) {
        this._saveRun();
      }
      this._recover = (!this.running && stored && this.bundle.tasks.some(t => t.id === stored.taskId)) ? stored : null;
      /* 台账可能刚变过（入账/对话记一笔），轨迹缓存一律失效重取 */
      this._commitsTaskId = null;
      this._commits = null;
      this.render();
    } catch (err) {
      this.renderError(`服务端连不上（${err.message}）。工作台先静一会儿，稍后自动重试。`);
      setTimeout(() => this.refresh(), 8000);
    }
  },

  currentTask() {
    const b = this.bundle;
    if (!b) return null;
    if (this.selectedTaskId) {
      const t = b.tasks.find(x => x.id === this.selectedTaskId && x.status === 'active');
      if (t) return t;
    }
    if (b.hint) return b.tasks.find(x => x.id === b.hint.taskId) || null;
    return null;
  },

  async post(body) {
    const res = await fetch(`${this.apiBase}/api/admin/agent/workbench`, {
      method: 'POST', headers: this.headers(), body: JSON.stringify(body)
    });
    const data = await res.json();
    if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
    return data;
  },

  /* ---------- 动作 ---------- */
  async setState(state) {
    try {
      await this.post({ action: 'set_state', state });
      this.selectedTaskId = null;
      await this.refresh(false);
    } catch (err) { this.toast(`没拨成功：${err.message}`); }
  },

  selectTask(id) {
    if (this.running) { this.toast('计时中先暂停或留档，再换下一件'); return; }
    this.selectedTaskId = id;
    this.render();
    if (window.innerWidth < 768) this.closeTaskSheet();   /* 选完即收 */
  },

  toggleRadar() {
    this._radarCollapsed = !this._radarCollapsed;
    this._applyRadar();
  },

  /* 雷达收纳状态统一落到 DOM：竖条显隐 + 布局列宽，两处必须同步 */
  _applyRadar() {
    const radarEl = document.getElementById('wb-radar');
    if (radarEl) radarEl.classList.toggle('collapsed', this._radarCollapsed);
    const cols = document.querySelector('.wb-columns');
    if (cols) cols.classList.toggle('radar-collapsed', this._radarCollapsed);
  },

  /* ---------- 计时状态机：暂停与留档是两件事，点错可以放弃 ---------- */
  startRun() {
    const t = this.currentTask();
    if (!t || this.running) return;
    this._recover = null;
    this.running = { taskId: t.id, startedMs: Date.now(), pausedMs: null };
    this._saveRun();
    this._startTick();
    this._radarCollapsed = true;   /* 点火之后世界只剩眼前这张牌 */
    this.render();
  },

  _startTick() {
    if (this._tick) clearInterval(this._tick);
    if (this.running && this.running.pausedMs) return;   /* 暂停中的表不走 */
    this._tick = setInterval(() => {
      const el = document.getElementById('wb-stopwatch');
      if (el && this.running) {
        el.textContent = this.fmtClock(Math.floor((Date.now() - this.running.startedMs) / 1000));
      }
    }, 1000);
  },

  pauseRun() {
    if (!this.running || this.running.pausedMs) return;
    if (this._tick) { clearInterval(this._tick); this._tick = null; }
    this.running.pausedMs = Date.now();
    this._saveRun();
    this.render();
  },

  resumeRun() {
    if (!this.running || !this.running.pausedMs) return;
    this.running.startedMs += Date.now() - this.running.pausedMs;
    this.running.pausedMs = null;
    this._saveRun();
    this._startTick();
    this.render();
  },

  /* 放弃：这一段不记任何账，静悄悄消失 */
  discardRun() {
    if (!this.running) return;
    if (this._tick) { clearInterval(this._tick); this._tick = null; }
    this.running = null;
    this._saveRun();
    this.toast('这一段没记。');
    this.render();
  },

  _runMinutes() {
    if (!this.running) return 1;
    const end = this.running.pausedMs || Date.now();
    return Math.max(1, Math.round((end - this.running.startedMs) / 60000));
  },

  /* 留档入账：计时中或暂停中都可开卡；入账即结算 */
  openRunCommit() {
    if (!this.running) return;
    this._manualCommit = false;
    document.getElementById('wb-commit-timer-row').style.display = '';
    document.getElementById('wb-commit-manual-row').style.display = 'none';
    const el = document.getElementById('wb-commit-minutes');
    if (el) el.textContent = this.fmtShort(this._runMinutes());
    const s = document.getElementById('wb-f-summary');
    const n = document.getElementById('wb-f-next');
    if (s) s.value = '';
    if (n) n.value = '';
    const m = document.getElementById('wb-commit-modal');
    if (m) m.style.display = 'flex';
    if (s) s.focus();
  },

  /* 记一笔：不走表，手动填时长——这台机器的第一动作。
     开卡时就锁定 taskId，防止卡开着的时候发牌变化把账记到别的任务头上 */
  openManualCommit() {
    const t = this.currentTask();
    if (!t || this.running) return;
    this._manualCommit = true;
    this._commitTaskId = t.id;
    document.getElementById('wb-commit-timer-row').style.display = 'none';
    document.getElementById('wb-commit-manual-row').style.display = '';
    const input = document.getElementById('wb-commit-minutes-input');
    if (input) input.value = '';
    const s = document.getElementById('wb-f-summary');
    const n = document.getElementById('wb-f-next');
    if (s) s.value = '';
    if (n) n.value = '';
    const m = document.getElementById('wb-commit-modal');
    if (m) m.style.display = 'flex';
    if (input) input.focus();
  },

  async submitCommit() {
    let minutes;
    if (this._manualCommit) {
      minutes = Math.round(Number(document.getElementById('wb-commit-minutes-input')?.value) || 0);
      if (minutes < 1 || minutes > 1440) { this.toast('先填个合理的分钟数（1 ~ 1440）'); return; }
    } else {
      if (!this.running) return;
      minutes = this._runMinutes();
    }
    const taskId = this._manualCommit ? this._commitTaskId : this.running.taskId;
    if (!taskId) return;
    const summary = (document.getElementById('wb-f-summary')?.value || '').trim();
    const nextStep = (document.getElementById('wb-f-next')?.value || '').trim();
    this.running = null;
    this._saveRun();
    this._manualCommit = false;
    const m = document.getElementById('wb-commit-modal');
    if (m) m.style.display = 'none';
    try {
      await this.post({ action: 'session_stop', taskId, minutes, summary, nextStep });
      this.toast(nextStep
        ? `已入账 ${this.fmtShort(minutes)}。下次回来，一句话记录已经替你换好了。`
        : `已入账 ${this.fmtShort(minutes)}。动了就算数。`);
    } catch (err) {
      this.toast(`入账失败：${err.message}`);
    }
    await this.refresh();
  },

  cancelCommit(event) {
    if (event && event.target && event.target.id !== 'wb-commit-modal') return;
    const m = document.getElementById('wb-commit-modal');
    if (this._manualCommit) {   /* 记一笔取消 = 关卡片，没有表可续 */
      this._manualCommit = false;
      if (m) m.style.display = 'none';
      return;
    }
    if (!this.running) return;
    if (m) m.style.display = 'none';
    if (this.running.pausedMs) this.render();   /* 暂停中的继续暂停 */
    else this._startTick();
  },

  /* 刷新中断恢复的三选：接着走 / 现在结算 / 不要了 */
  resumeRecord() {
    if (!this._recover) return;
    this.running = {
      taskId: this._recover.taskId,
      startedMs: this._recover.startedMs,
      pausedMs: this._recover.pausedMs || null
    };
    this._recover = null;
    if (!this.running.pausedMs) this._startTick();
    this.render();
  },

  async settleRecord() {
    if (!this._recover) return;
    const { taskId, startedMs, pausedMs } = this._recover;
    const minutes = Math.max(1, Math.round(((pausedMs || Date.now()) - startedMs) / 60000));
    this._recover = null;
    try {
      await this.post({ action: 'session_stop', taskId, minutes });
      this.toast(`已入账 ${this.fmtShort(minutes)}。动了就算数。`);
    } catch (err) {
      this.toast(`入账失败：${err.message}`);
    }
    this._saveRun();
    await this.refresh();
  },

  discardRecord() {
    this._recover = null;
    this._saveRun();
    this.render();
  },

  /* 行动路标的就地编辑：点击文字 → 变输入框 → 失焦/回车静默保存，无按钮 */
  editFirstStep(taskId) {
    this._fstEdit = taskId;
    this.render();
    const input = document.getElementById('wb-firststep-input');
    if (input) {
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); this.commitFirstStep(taskId); }
        if (e.key === 'Escape') { e.preventDefault(); this._fstEdit = null; this.render(); }
      });
      input.addEventListener('blur', () => this.commitFirstStep(taskId));
    }
  },

  async commitFirstStep(taskId) {
    if (this._fstEdit !== taskId) return;   /* 已因失焦/回车保存过 */
    this._fstEdit = null;
    const input = document.getElementById('wb-firststep-input');
    const v = input ? input.value.trim() : '';
    const t = this.bundle && this.bundle.tasks.find(x => x.id === taskId);
    if (t && t.firstStep === v) { this.render(); return; }   /* 没改就退回 */
    try {
      await this.post({ action: 'task_update', id: taskId, patch: { firstStep: v } });
      await this.refresh();
      /* 静默的「✓ 已存」，浮现在路标上 */
      const c = document.getElementById('spot-callout');
      if (c && this._spotTaskId() === taskId) {
        const f = document.createElement('span');
        f.className = 'saved-flash';
        f.textContent = '✓ 已存';
        c.appendChild(f);
        setTimeout(() => f.remove(), 1600);
      }
    } catch (err) {
      this.toast(`没存上：${err.message}`);
      this.render();
    }
  },

  /* ---------- 任务单底部抽屉（手机端） ---------- */
  toggleTaskSheet() {
    if (window.innerWidth >= 768) { this.toggleRadar(); return; }   /* 桌面照旧收起侧栏 */
    const radar = document.getElementById('wb-radar');
    const open = !radar.classList.contains('sheet-open');
    radar.classList.toggle('sheet-open', open);
    document.getElementById('drawer-backdrop').style.display = open ? 'block' : 'none';
    if (open && this.drawer) Inchi.openDrawer(null);   /* 与便签/日历抽屉互斥 */
  },

  closeTaskSheet() {
    if (window.innerWidth >= 768) return;
    const radar = document.getElementById('wb-radar');
    if (radar) radar.classList.remove('sheet-open');
    const bd = document.getElementById('drawer-backdrop');
    if (bd) bd.style.display = 'none';
  },

  /* ---------- 目标胶囊 ---------- */
  toggleGoalPop(taskId) {
    this._goalPop = this._goalPop === taskId ? null : taskId;
    this.render();
  },

  renderGoalPop(t) {
    if (this._goalPop !== t.id) return '';
    return `
      <div class="goal-pop" onclick="event.stopPropagation()">
        <input type="number" id="goal-input" class="quota-edit-input mono" min="0.5" max="1000" step="0.5"
               value="${t.targetMinutes ? (Math.round(t.targetMinutes / 6) / 10) : ''}" placeholder="10"> 小时
        <button type="button" class="btn-ghost-mini" onclick="Workbench.saveGoal('${t.id}')">保存</button>
        ${t.targetMinutes ? `<button type="button" class="text-link-btn" onclick="Workbench.clearGoal('${t.id}')">清空</button>` : ''}
      </div>`;
  },

  async saveGoal(taskId) {
    const hours = Number(document.getElementById('goal-input')?.value);
    if (!hours || hours <= 0 || hours > 1000) { this.toast('填个合理的小时数'); return; }
    try {
      await this.post({ action: 'task_update', id: taskId, patch: { targetMinutes: Math.round(hours * 60) } });
      this._goalPop = null;
      this.toast('目标记上了。');
      await this.refresh();
    } catch (err) { this.toast(`没存上：${err.message}`); }
  },

  async clearGoal(taskId) {
    try {
      await this.post({ action: 'task_update', id: taskId, patch: { targetMinutes: 0 } });
      this._goalPop = null;
      this.toast('目标清掉了。');
      await this.refresh();
    } catch (err) { this.toast(`没清掉：${err.message}`); }
  },

  /* ---------- 快速记录栏：[45m] 记一笔 → 入账 ---------- */
  async quickLog(taskId) {
    const minutes = Math.round(Number(document.getElementById('ql-min')?.value) || 0);
    if (!(minutes >= 1) || minutes > 1440) { this.toast('先在左边填个合理的分钟数'); return; }
    const summary = (document.getElementById('ql-text')?.value || '').trim();
    try {
      await this.post({ action: 'session_stop', taskId, minutes, summary });
      this.toast(`已入账 ${this.fmtShort(minutes)}。动了就算数。`);
      await this.refresh();
    } catch (err) { this.toast(`没记上：${err.message}`); }
  },

  /* ---------- 随手记备忘栏：失焦自动保存 ---------- */
  _bindScratch(taskId) {
    const ta = document.getElementById('wb-scratch');
    if (!ta) return;
    const t = this.bundle && this.bundle.tasks.find(x => x.id === taskId);
    ta.addEventListener('blur', async () => {
      const v = ta.value.slice(0, 2000);
      if (!t || v === (t.scratchpad || '')) return;   /* 没改就闭嘴 */
      try {
        await this.post({ action: 'task_update', id: taskId, patch: { scratchpad: v } });
        if (t) t.scratchpad = v;
        const hint = ta.parentElement.querySelector('.scratch-hint');
        if (hint) {
          hint.textContent = '✓ 已存';
          setTimeout(() => { hint.textContent = '随手记 · 失焦自动保存'; }, 1600);
        }
      } catch (err) { this.toast(`没存上：${err.message}`); }
    });
  },

  /* ---------- 分类管理弹层（列表 / 改名改色 / 删除 / 新增） ---------- */
  toggleCatPop(taskId) {
    this._catPop = this._catPop && this._catPop.taskId === taskId ? null : { taskId, editId: null, add: false };
    this.render();
  },

  catPopEdit(editId) {
    this._catPop.editId = this._catPop.editId === editId ? null : editId;
    this._catPop.add = false;
    this.render();
  },

  catPopAdd() {
    this._catPop.add = !this._catPop.add;
    this._catPop.editId = null;
    this.render();
  },

  catPopColor(c) {
    this._catColor = c;
    this.render();
  },

  async catPopSave(editId) {
    const wrapId = editId ? `cat-edit-${editId}` : 'cat-add-form';
    const wrap = document.getElementById(wrapId);
    const name = wrap ? wrap.querySelector('.cp-name').value.trim() : '';
    const color = this._catColor || '#81A1C1';
    try {
      const data = editId
        ? await this.post({ action: 'category_update', id: editId, name, color })
        : await this.post({ action: 'category_create', name, color });
      this.bundle.categories = data.categories;
      this._catColor = null;
      this._catPop.editId = null;
      this._catPop.add = false;
      this.render();
      this.toast(editId ? '分类改好了。' : '分类建好了。');
    } catch (err) { this.toast(`没存上：${err.message}`); }
  },

  async catPopDelete(catId) {
    try {
      const data = await this.post({ action: 'category_delete', id: catId });
      this.bundle.categories = data.categories;
      this.render();
      this.toast('分类删掉了。');
    } catch (err) { this.toast(`${err.message}`); }
  },

  async setTaskCategory(taskId, categoryId) {
    try {
      await this.post({ action: 'task_update', id: taskId, patch: { categoryId } });
      this._catPop = null;
      await this.refresh();
    } catch (err) { this.toast(`没换上：${err.message}`); }
  },

  renderCatPop(t) {
    if (!this._catPop || this._catPop.taskId !== t.id) return '';
    const PALETTE = ['#B48EAD', '#A3BE8C', '#EBCB8B', '#D08770', '#BF616A', '#88C0D0', '#8FBCBB', '#9DA5B4', '#C9958F', '#A5836D'];
    const cats = (this.bundle && this.bundle.categories) || [];
    const swatches = (sel) => PALETTE.map(c =>
      `<button type="button" class="cat-swatch ${c === sel ? 'sel' : ''}" style="background:${c}" onclick="Workbench.catPopColor('${c}')"></button>`).join('');
    const rows = cats.map(c => {
      if (this._catPop.editId === c.id) {
        const cur = this._catColor || c.color;
        return `
          <div class="cp-row cp-editing" id="cat-edit-${c.id}">
            <input type="text" class="cp-name form-input" maxlength="10" value="${this.esc(c.name)}">
            <div class="cp-palette">${swatches(cur)}</div>
            <div class="cp-actions">
              <button type="button" class="btn-ghost-mini" onclick="Workbench.catPopEdit(null)">取消</button>
              <button type="button" class="btn-ghost-mini" onclick="Workbench.catPopSave('${c.id}')">保存</button>
            </div>
          </div>`;
      }
      return `
        <div class="cp-row ${t.categoryId === c.id ? 'current' : ''}">
          <button type="button" class="cp-pick" onclick="Workbench.setTaskCategory('${t.id}', '${c.id}')" title="把当前任务归到这里">
            <i class="cat-dot" style="background:${c.color}"></i>${this.esc(c.name)}
          </button>
          <button type="button" class="text-link-btn" onclick="Workbench.catPopEdit('${c.id}')">改</button>
          <button type="button" class="text-link-btn note-del" onclick="Workbench.catPopDelete('${c.id}')" title="删分类（有任务挂着时不许删）">✕</button>
        </div>`;
    }).join('');
    const addForm = this._catPop.add
      ? `<div class="cp-row cp-editing" id="cat-add-form">
           <input type="text" class="cp-name form-input" maxlength="10" placeholder="新分类名">
           <div class="cp-palette">${swatches(this._catColor)}</div>
           <div class="cp-actions">
             <button type="button" class="btn-ghost-mini" onclick="Workbench.catPopAdd()">取消</button>
             <button type="button" class="btn-ghost-mini" onclick="Workbench.catPopSave(null)">建好</button>
           </div>
         </div>`
      : `<button type="button" class="cp-add" onclick="Workbench.catPopAdd()">＋ 新分类</button>`;
    return `
      <div class="cat-pop" onclick="event.stopPropagation()">
        <div class="cat-pop-hint mono">点名字 = 归类当前任务</div>
        ${rows}
        ${addForm}
      </div>`;
  },

  /* ---------- 任务单拖拽：组内排序 / 跨组改档 / 拖到分类托盘 ---------- */
  onDragStart(event, taskId) {
    this._dragId = taskId;
    if (event.dataTransfer) {
      event.dataTransfer.setData('text/plain', taskId);
      event.dataTransfer.effectAllowed = 'move';
    }
    const tray = document.getElementById('cat-tray');
    if (tray) {
      const cats = (this.bundle && this.bundle.categories) || [];
      tray.innerHTML = '<span class="cat-tray-label">松手改分类：</span>'
        + cats.map(c => `
          <span class="cat-tray-chip" ondragover="event.preventDefault()" ondrop="Workbench.dropToCategory(event, '${c.id}')">
            <i class="cat-dot" style="background:${c.color}"></i>${this.esc(c.name)}
          </span>`).join('');
      tray.style.display = 'flex';
    }
  },

  onDragEnd() {
    this._dragId = null;
    const tray = document.getElementById('cat-tray');
    if (tray) { tray.style.display = 'none'; tray.innerHTML = ''; }
    document.querySelectorAll('.radar-group.drag-over').forEach(g => g.classList.remove('drag-over'));
  },

  onGroupDragOver(event, state) {
    if (!this._dragId) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    const group = document.querySelector(`.radar-group.st-${state}`);
    if (group) group.classList.add('drag-over');
  },

  onGroupDragLeave(state) {
    const group = document.querySelector(`.radar-group.st-${state}`);
    if (group) group.classList.remove('drag-over');
  },

  async dropToGroup(event, state) {
    event.preventDefault();
    const id = this._dragId || (event.dataTransfer && event.dataTransfer.getData('text/plain'));
    this.onDragEnd();
    if (!id) return;
    const b = this.bundle;
    const task = b && b.tasks.find(t => t.id === id);
    if (!task) return;

    if (task.energy !== state) {
      /* 跨组 = 改档位。历史记录的 stateAtTime 早已逐条存快照，天然断点。 */
      try {
        await this.post({ action: 'task_update', id, patch: { energy: state } });
        this.toast(`挪到「${this.stateCn(state)}」了。`);
      } catch (err) { this.toast(`没挪成：${err.message}`); }
      await this.refresh();
      return;
    }

    /* 组内 = 排序。按落点两侧的 order 取中值。 */
    const siblings = b.tasks
      .filter(t => t.energy === state && t.status !== 'archived' && t.id !== id)
      .sort((x, y) => (Number.isFinite(x.order) ? x.order : 1e9) - (Number.isFinite(y.order) ? y.order : 1e9));
    const rows = event.currentTarget ? [...event.currentTarget.querySelectorAll('.radar-item')] : [];
    const afterId = (() => {
      for (const row of rows) { if (row.dataset.id === id) continue; if (row.getBoundingClientRect().top > event.clientY) return row.dataset.id; }
      return null;
    })();
    const idx = afterId ? siblings.findIndex(t => t.id === afterId) : siblings.length;
    const orderAt = (i) => (Number.isFinite(siblings[i]?.order) ? siblings[i].order : null);
    const prev = idx > 0 ? orderAt(idx - 1) : null;
    const next = idx < siblings.length ? orderAt(idx) : null;
    let order;
    if (prev !== null && next !== null) order = (prev + next) / 2;
    else if (prev !== null) order = prev + 10;
    else if (next !== null) order = Math.max(0, next - 10);
    else order = siblings.length ? (Number.isFinite(siblings[siblings.length - 1].order) ? siblings[siblings.length - 1].order + 10 : 10) : 10;

    try {
      await this.post({ action: 'task_reorder', updates: [{ id, order }] });
      await this.refresh();
    } catch (err) { this.toast(`没排上：${err.message}`); }
  },

  async dropToCategory(event, categoryId) {
    event.preventDefault();
    const id = this._dragId || (event.dataTransfer && event.dataTransfer.getData('text/plain'));
    this.onDragEnd();
    if (!id) return;
    try {
      await this.post({ action: 'task_update', id, patch: { categoryId } });
      /* 断点语义：会记账的每条记录早已存了自己的分类快照，历史不动 */
      this.toast('分类改了。前面的记录保持原样，后面的按新的来。');
    } catch (err) { this.toast(`没改上：${err.message}`); }
    await this.refresh();
  },

  /* ---------- 任务设置（悬停 ⚙） ---------- */
  openTaskEdit(taskId) {
    const t = this.bundle && this.bundle.tasks.find(x => x.id === taskId);
    if (!t) return;
    this._editId = taskId;
    document.getElementById('wb-e-name').value = t.name;
    document.getElementById('wb-e-first').value = t.firstStep || '';
    document.getElementById('wb-e-goal').value = t.targetMinutes ? (Math.round(t.targetMinutes / 6) / 10) : '';
    const cats = (this.bundle && this.bundle.categories) || [];
    document.getElementById('wb-e-cat').innerHTML = cats.map(c => `
      <button type="button" class="seg-chip ${c.id === t.categoryId ? 'sel' : ''}" data-v="${c.id}" onclick="Workbench.pickChip('wb-e-cat', this)">
        <i class="cat-dot" style="background:${c.color}"></i>${this.esc(c.name)}
      </button>`).join('');
    document.getElementById('wb-e-energy').innerHTML = ['HIGH', 'NORMAL', 'LOW'].map(s => `
      <button type="button" class="seg-chip st-${s} ${s === t.energy ? 'sel' : ''}" data-v="${s}" onclick="Workbench.pickChip('wb-e-energy', this)">${this.stateCn(s)}</button>`).join('');
    const susp = document.getElementById('wb-e-toggle-suspend');
    if (susp) susp.textContent = t.status === 'suspended' ? '恢复进行' : '搁置';
    document.getElementById('wb-task-edit-modal').style.display = 'flex';
  },

  closeTaskEdit(event) {
    if (event && event.target && event.target.id !== 'wb-task-edit-modal') return;
    document.getElementById('wb-task-edit-modal').style.display = 'none';
    this._editId = null;
  },

  async saveTaskEdit() {
    const id = this._editId;
    if (!id) return;
    const patch = {
      name: document.getElementById('wb-e-name').value.trim(),
      categoryId: this.chipVal('wb-e-cat') || undefined,
      energy: this.chipVal('wb-e-energy') || undefined,
      firstStep: document.getElementById('wb-e-first').value.trim(),
      targetMinutes: Math.round((Number(document.getElementById('wb-e-goal').value) || 0) * 60)
    };
    try {
      await this.post({ action: 'task_update', id, patch });
      this.toast('改好了。');
      document.getElementById('wb-task-edit-modal').style.display = 'none';
      this._editId = null;
      await this.refresh();
    } catch (err) { this.toast(`没存上：${err.message}`); }
  },

  async toggleSuspendFromEdit() {
    const id = this._editId;
    const t = this.bundle && this.bundle.tasks.find(x => x.id === id);
    if (!t) return;
    try {
      await this.post({ action: 'task_update', id, patch: { status: t.status === 'suspended' ? 'active' : 'suspended' } });
      document.getElementById('wb-task-edit-modal').style.display = 'none';
      this._editId = null;
      await this.refresh();
    } catch (err) { this.toast(`没改成：${err.message}`); }
  },

  /* 封存结案：两步确认。档案室还没建，误封的任务目前没有恢复入口。 */
  archiveFromEdit() {
    const id = this._editId;
    if (!id) return;
    const btn = document.getElementById('wb-e-archive-btn');
    if (!btn) return;
    if (!this._archiveArmed) {
      this._archiveArmed = true;
      btn.textContent = '确认封存？';
      this._archiveTimer = setTimeout(() => {
        this._archiveArmed = false;
        btn.textContent = '封存结案';
      }, 3000);
      return;
    }
    clearTimeout(this._archiveTimer);
    this._archiveArmed = false;
    btn.textContent = '封存结案';
    this.post({ action: 'task_update', id, patch: { status: 'archived' } })
      .then(() => {
        this.toast('已封存结案。这件事彻底翻篇了。');
        document.getElementById('wb-task-edit-modal').style.display = 'none';
        this._editId = null;
        return this.refresh();
      })
      .catch(err => this.toast(`没封上：${err.message}`));
  },

  /* ---------- 新增任务弹窗 ---------- */
  openTaskModal(prefill) {
    const m = document.getElementById('wb-task-modal');
    if (!m) return;
    this._taskModalNoteId = (prefill && prefill.noteId) || null;
    document.getElementById('wb-f-name').value = (prefill && prefill.name) || '';
    document.getElementById('wb-f-first').value = '';
    this.renderCatChips(prefill && prefill.categoryId);
    this.closeCatCustom();
    const energy = prefill && prefill.energy;
    if (energy) {
      document.querySelectorAll('#wb-f-energy .seg-chip').forEach(c => c.classList.toggle('sel', c.dataset.v === energy));
    }
    m.style.display = 'flex';
    document.getElementById('wb-f-name').focus();
  },

  /* 分类 chips 是动态的：来自用户自己的分类表，末尾挂一个「＋ 自定义」 */
  renderCatChips(selectedId) {
    const box = document.getElementById('wb-f-cat');
    if (!box) return;
    const cats = (this.bundle && this.bundle.categories) || [];
    const selId = selectedId || (cats[0] && cats[0].id);
    box.innerHTML = cats.map(c => `
      <button type="button" class="seg-chip ${c.id === selId ? 'sel' : ''}" data-v="${c.id}" onclick="Workbench.pickChip('wb-f-cat', this)">
        <i class="cat-dot" style="background:${c.color}"></i>${this.esc(c.name)}
      </button>`).join('')
      + '<button type="button" class="seg-chip cat-add" onclick="Workbench.openCatCustom()">＋ 自定义</button>';
  },

  openCatCustom() {
    const f = document.getElementById('wb-cat-custom');
    if (!f) return;
    f.style.display = 'block';
    this.renderPalette();
    document.getElementById('wb-cat-name')?.focus();
  },

  closeCatCustom() {
    const f = document.getElementById('wb-cat-custom');
    if (f) f.style.display = 'none';
  },

  renderPalette() {
    const PALETTE = ['#81A1C1', '#A3BE8C', '#EBCB8B', '#B48EAD', '#88C0D0', '#D08770', '#BF616A', '#8FBCBB'];
    const box = document.getElementById('wb-cat-palette');
    if (!box) return;
    if (!this._catColor) this._catColor = PALETTE[0];
    box.innerHTML = PALETTE.map(c => `
      <button type="button" class="cat-swatch ${c === this._catColor ? 'sel' : ''}" style="background:${c}"
              data-c="${c}" onclick="Workbench.pickColor('${c}')" title="${c}"></button>`).join('');
  },

  pickColor(c) {
    this._catColor = c;
    this.renderPalette();
  },

  async createCategory() {
    const name = document.getElementById('wb-cat-name').value.trim();
    if (!name) { this.toast('先给类别起个名'); return; }
    try {
      const data = await this.post({ action: 'category_create', name, color: this._catColor });
      this.bundle.categories = data.categories;
      document.getElementById('wb-cat-name').value = '';
      this.closeCatCustom();
      this.renderCatChips(data.category.id);   /* 建好即选中 */
      this.toast('类别建好了。');
    } catch (err) { this.toast(`没建上：${err.message}`); }
  },

  closeTaskModal(event) {
    if (event && event.target && event.target.id !== 'wb-task-modal') return;
    const m = document.getElementById('wb-task-modal');
    if (m) m.style.display = 'none';
    this._taskModalNoteId = null;
  },

  pickChip(groupId, btn) {
    document.querySelectorAll(`#${groupId} .seg-chip`).forEach(c => c.classList.remove('sel'));
    btn.classList.add('sel');
  },

  chipVal(groupId) {
    const sel = document.querySelector(`#${groupId} .seg-chip.sel`);
    return sel ? sel.dataset.v : null;
  },

  async submitTask(event) {
    if (event) event.preventDefault();
    const name = document.getElementById('wb-f-name').value.trim();
    if (!name) return;
    const fromNoteId = this._taskModalNoteId || null;
    try {
      await this.post({
        action: 'task_create',
        name,
        categoryId: this.chipVal('wb-f-cat') || undefined,
        energy: this.chipVal('wb-f-energy') || 'NORMAL',
        firstStep: document.getElementById('wb-f-first').value.trim()
      });
      this.closeTaskModal();
      if (fromNoteId && window.Notes) {
        await Notes.removeSilent(fromNoteId);   /* 便签落地成任务了，纸就撕掉 */
        this.toast('放进池子了，便签已收走。');
        await Notes.refresh();
      } else {
        this.toast('放进池子了。');
      }
      await this.refresh();
    } catch (err) { this.toast(`没放进去：${err.message}`); }
  },

  /* ---------- 聚光灯此刻锁定的任务 ---------- */
  _spotTaskId() {
    if (this.running) return this.running.taskId;
    const t = this.currentTask();
    return t ? t.id : null;
  },

  /* ---------- 渲染 ---------- */
  render() {
    const b = this.bundle;
    if (!b) return;

    /* 顶栏：今日光谱条 */
    this.renderTopSpectrum();

    /* 档位开关高亮（在顶栏） */
    document.querySelectorAll('#wb-state-switch .state-btn').forEach(btn => {
      btn.classList.toggle('sel', btn.dataset.state === b.state);
    });

    /* 提示行：只报低谷缓冲这一件事 */
    const notice = document.getElementById('wb-notice');
    if (notice) {
      notice.textContent = b.notice || '';
      notice.style.display = b.notice ? 'block' : 'none';
    }

    this._applyRadar();
    this.renderRadar();
    this.renderSpotlight();
  },

  /* 顶栏左：今日有效时长光谱条（分类着色），数字可点调每日目标 */
  renderTopSpectrum() {
    const bar = document.getElementById('tb-spectrum-bar');
    const text = document.getElementById('tb-spectrum-text');
    if (!bar || !this.bundle) return;
    const { spectrum, quota, categories } = this.bundle;
    const catInfo = (k) => {
      const c = (categories || []).find(x => x.id === k);
      return c || { name: k, color: '#81A1C1' };
    };
    const pct = (m) => Math.min(100, quota.effective > 0 ? (m / quota.effective) * 100 : 0);
    bar.innerHTML = spectrum.total === 0
      ? ''
      : Object.entries(spectrum)
          .filter(([k, m]) => k !== 'total' && m > 0)
          .map(([k, m]) => {
            const info = catInfo(k);
            return `<i class="tb-seg" style="width:${pct(m)}%;background:${info.color}" title="${this.esc(info.name)} ${this.fmtShort(m)}"></i>`;
          }).join('');
    if (text) text.textContent = `今日已推进 ${this.fmtShort(spectrum.total)} / ${this.fmtH(quota.effective)}`;
  },

  toggleQuotaEdit() {
    const input = document.getElementById('wb-quota-input');
    if (!input) return;
    const show = input.style.display === 'none';
    input.style.display = show ? 'inline-block' : 'none';
    if (show) {
      input.value = this.bundle ? this.bundle.quota.base : '';
      input.focus();
    }
  },

  async saveQuota() {
    const input = document.getElementById('wb-quota-input');
    if (!input) return;
    const v = Number(input.value);
    input.style.display = 'none';
    if (!v || v < 15 || v > 1440) return;
    try {
      await this.post({ action: 'set_quota', baseTargetMinutes: v });
      await this.refresh();
    } catch (err) { this.toast(`没改上：${err.message}`); }
  },

  renderRadar() {
    const box = document.getElementById('wb-radar-groups');
    if (!box || !this.bundle) return;
    const b = this.bundle;
    const cur = this.running ? this.running.taskId : (this.currentTask() || {}).id;
    const groups = ['HIGH', 'NORMAL', 'LOW'].map(st => {
      const list = b.tasks
        .filter(t => t.energy === st && t.status !== 'archived')
        .sort((x, y) =>
          (Number.isFinite(x.order) ? x.order : 1e9) - (Number.isFinite(y.order) ? y.order : 1e9)
          || (Date.parse(y.lastCommitAt) || 0) - (Date.parse(x.lastCommitAt) || 0)
          || String(x.id).localeCompare(String(y.id)));
      const dim = b.state && st !== b.state ? 'dim' : '';
      const items = list.map(t => {
        const catInfo = t.categoryInfo || { color: '#81A1C1' };
        return `
        <div class="radar-item ${t.status === 'suspended' ? 'suspended' : ''} ${t.id === cur ? 'sel' : ''}"
             data-id="${t.id}" draggable="true"
             ondragstart="Workbench.onDragStart(event, '${t.id}')"
             ondragend="Workbench.onDragEnd()"
             onclick="Workbench.selectTask('${t.id}')"
             title="${this.esc(t.firstStep || '还没有一句话记录')}">
          <span class="radar-dot" style="background:${catInfo.color}"></span>
          <span class="radar-name">${this.esc(t.name)}</span>
          ${t.todayMinutes > 0 ? `<span class="radar-min mono">${this.fmtShort(t.todayMinutes)}</span>` : ''}
          ${t.status === 'suspended' ? '<span class="radar-tag">搁置</span>' : ''}
          <button type="button" class="radar-gear" onclick="event.stopPropagation(); Workbench.openTaskEdit('${t.id}')" title="调整这个任务">⚙</button>
        </div>
      `;}).join('');
      return `
        <div class="radar-group st-${st} ${dim}"
             ondragover="Workbench.onGroupDragOver(event, '${st}')"
             ondragleave="Workbench.onGroupDragLeave('${st}')"
             ondrop="Workbench.dropToGroup(event, '${st}')">
          <div class="radar-group-head">
            <span class="radar-group-name">${this.stateCn(st)}</span>
            <span class="radar-group-count mono">${list.length}</span>
            <button type="button" class="radar-add" onclick="event.stopPropagation(); Workbench.openTaskModal({ energy: '${st}' })" title="直接添加一个${this.stateCn(st)}档的任务">＋</button>
          </div>
          ${items || '<div class="radar-empty">这一组还空着</div>'}
        </div>
      `;
    }).join('');
    box.innerHTML = groups;
  },

  renderSpotlight() {
    const el = document.getElementById('wb-spotlight');
    if (!el || !this.bundle) return;
    const b = this.bundle;

    /* 刷新中断恢复：优先于一切，轻声问一句，三选一 */
    if (this._recover && !this.running) {
      const t = b.tasks.find(x => x.id === this._recover.taskId);
      if (t) {
        const mins = Math.max(1, Math.round(((this._recover.pausedMs || Date.now()) - this._recover.startedMs) / 60000));
        el.innerHTML = `
          <div class="recover-tag mono">未结算的计时</div>
          <h2 class="spot-title">${this.esc(t.name)}</h2>
          <div class="recover-line">上次在这件事上走了 <strong class="mono">${this.fmtShort(mins)}</strong>，还没记到今天。要怎么处理？</div>
          <div class="spot-actions recover-actions">
            <button type="button" class="btn-primary" onclick="Workbench.resumeRecord()">接着走表</button>
            <button type="button" class="btn-secondary" onclick="Workbench.settleRecord()">记入今天</button>
            <button type="button" class="text-link-btn" onclick="Workbench.discardRecord()">不要了</button>
          </div>
        `;
        return;
      }
      this._recover = null;   /* 任务已不在，静默丢弃 */
    }

    const runningTask = this.running ? b.tasks.find(t => t.id === this.running.taskId) : null;
    const t = runningTask || this.currentTask();

    if (!t) {
      el.innerHTML = b.state ? `
        <div class="spot-empty">
          <div class="spot-empty-line">这一档下还没有能上的事。</div>
          <div class="spot-empty-sub">往池子里放一件${this.stateCn(b.state)}状态下顺手的小事，或者先换一档。</div>
          <button type="button" class="wb-ghost-btn" onclick="Workbench.openTaskModal()">＋ 新增任务</button>
        </div>
      ` : `
        <div class="spot-empty">
          <div class="spot-empty-line">先拨档位，再发牌。</div>
          <div class="spot-empty-sub">右上角选一个最接近现在的状态，系统只推一件对应的事。</div>
        </div>
      `;
      this._commitsTaskId = null;
      this._commits = null;
      return;
    }

    const catInfo = t.categoryInfo || { name: this.catCn(t.category), color: '#81A1C1' };
    const running = !!runningTask;
    const paused = running && !!this.running.pausedMs;
    const sec = running ? Math.floor(((this.running.pausedMs || Date.now()) - this.running.startedMs) / 1000) : 0;

    /* 分类标签 + 目标胶囊并排；点击分类标弹出管理层 */
    const goalPct = t.targetMinutes ? Math.min(100, Math.round(((t.totalMinutes || 0) / t.targetMinutes) * 100)) : 0;
    const goalBadge = t.targetMinutes
      ? `<button type="button" class="goal-badge" onclick="Workbench.toggleGoalPop('${t.id}')" title="点击调整">
           <span class="goal-fill" style="width:${goalPct}%"></span>
           <span class="goal-text mono">${this.fmtH(t.totalMinutes || 0)} / ${this.fmtH(t.targetMinutes)}</span>
         </button>`
      : `<button type="button" class="goal-badge ghost" onclick="Workbench.toggleGoalPop('${t.id}')">＋ 目标时长</button>`;

    /* 行动路标：软底便签条，点击就地编辑，失焦/回车静默保存 */
    const callout = this._fstEdit === t.id
      ? `<div class="spot-callout editing" id="spot-callout" style="border-left-color:${catInfo.color}">
           <input type="text" id="wb-firststep-input" class="form-input mono" maxlength="200"
                  value="${this.esc(t.firstStep)}" placeholder="写个 2 分钟内能上手的动作">
         </div>`
      : `<div class="spot-callout" id="spot-callout" style="border-left-color:${catInfo.color}"
             onclick="Workbench.editFirstStep('${t.id}')" title="点击修改">
           ${t.firstStep ? this.esc(t.firstStep) : '<span class="callout-hint">点击设置一个 2 分钟内能上手的微小动作，或直接开始记一笔。</span>'}
         </div>`;

    /* 主操作栏：记一笔为主，计时为辅（点击展开走表） */
    let mainBar;
    if (running && !paused) {
      mainBar = `
        <span class="stopwatch-lg mono" id="wb-stopwatch">${this.fmtClock(sec)}</span>
        <div class="run-controls">
          <button type="button" class="btn-secondary" onclick="Workbench.pauseRun()">暂停</button>
          <button type="button" class="btn-primary" onclick="Workbench.openRunCommit()">留档入账</button>
          <button type="button" class="text-link-btn" onclick="Workbench.discardRun()">放弃</button>
        </div>`;
    } else if (running && paused) {
      mainBar = `
        <span class="stopwatch-lg mono paused" id="wb-stopwatch">${this.fmtClock(sec)}</span>
        <div class="run-controls">
          <button type="button" class="btn-secondary" onclick="Workbench.resumeRun()">继续</button>
          <button type="button" class="btn-primary" onclick="Workbench.openRunCommit()">留档入账</button>
          <button type="button" class="text-link-btn" onclick="Workbench.discardRun()">放弃</button>
        </div>`;
    } else {
      mainBar = `
        <div class="quick-log main">
          <span class="ql-min-wrap mono">
            <input type="number" id="ql-min" min="1" max="1440" placeholder="45"
                   onkeydown="if(event.key==='Enter'){event.preventDefault();Workbench.quickLog('${t.id}')}">
            <em>m</em>
          </span>
          <input type="text" id="ql-text" class="ql-text" maxlength="500" placeholder="记一笔推进内容…"
                 onkeydown="if(event.key==='Enter'){event.preventDefault();Workbench.quickLog('${t.id}')}">
          <button type="button" class="ql-commit" onclick="Workbench.quickLog('${t.id}')">记入</button>
          <button type="button" class="ql-timer" onclick="Workbench.startRun()" title="展开走表计时">⏱ 计时</button>
        </div>`;
    }

    el.innerHTML = `
      <div class="spot-grid">
        <div class="spot-main">
          <div class="spot-head-row">
            <button type="button" class="spot-cat" style="color:${catInfo.color};background:${catInfo.color}1A"
                    onclick="Workbench.toggleCatPop('${t.id}')" title="点击管理分类">${this.esc(catInfo.name)}</button>
            ${goalBadge}
            <button type="button" class="sheet-toggle" onclick="Workbench.toggleTaskSheet()">☰ 切换任务 (${b.tasks.filter(x => x.status === 'active').length})</button>
            ${this.renderGoalPop(t)}
            ${this.renderCatPop(t)}
          </div>
          <h2 class="spot-title">${this.esc(t.name)}</h2>
          ${callout}
          <div class="spot-actions">${mainBar}</div>
          <div class="spot-timeline">
            <div class="timeline-list" id="wb-commits"></div>
          </div>
        </div>
        <div class="spot-aside">
          <textarea id="wb-scratch" class="spot-scratch" maxlength="2000"
                    placeholder="随手记 · 页码、链接、备忘…">${this.esc(t.scratchpad || '')}</textarea>
          <div class="scratch-hint mono">随手记 · 失焦自动保存</div>
        </div>
      </div>
    `;
    this._bindScratch(t.id);
    this._fillCommits(t.id);
  },

  renderError(msg) {
    const el = document.getElementById('wb-spotlight');
    if (el) el.innerHTML = `<div class="spot-empty"><div class="spot-empty-line">${this.esc(msg)}</div></div>`;
  },

  /* ---------- 最近推进轨迹：条目可补改话 / 日期 / 时长；点旁边就退回 ---------- */
  async _fillCommits(taskId) {
    if (!taskId) return;
    if (this._commitsTaskId !== taskId || !this._commits) {
      this._commitsTaskId = taskId;
      try {
        const res = await fetch(`${this.apiBase}/api/admin/agent/workbench?commits=${encodeURIComponent(taskId)}&limit=5`, { headers: this.headers() });
        if (res.ok) {
          const data = await res.json();
          if (this._commitsTaskId === taskId) this._commits = data.commits || [];
        }
      } catch { this._commits = []; }
    }
    if (this._commitsTaskId !== taskId) return;
    this._renderCommitsList();
  },

  _renderCommitsList() {
    const box = document.getElementById('wb-commits');
    if (!box) return;
    const list = this._commits || [];
    if (!list.length) {
      box.innerHTML = '<div class="tl-empty">尚无推进记录，完成一阶段后在上方记一笔即可</div>';
      return;
    }
    box.innerHTML = `
      ${list.map(c => (this._editingCommit === c.id ? `
        <div class="tl-item editing" data-commit-edit="${c.id}">
          <input type="date" class="commit-edit-date mono" id="ce-date" value="${this.esc(c.date)}">
          <input type="number" class="commit-edit-min mono" id="ce-min" min="1" max="1440" value="${Math.round(c.minutes)}">
          <input type="text" class="commit-edit-input mono" id="ce-sum" maxlength="500"
                 value="${this.esc(c.summary)}" placeholder="一句话，留空即无">
          <button type="button" class="commit-edit-save" onclick="Workbench.saveCommitEdit('${c.id}')">存</button>
        </div>
      ` : `
        <div class="tl-item" onclick="Workbench.beginCommitEdit('${c.id}')" title="点击补改日期、时长或这句话">
          <span class="tl-date mono">${this.esc(this.dayLabel(c.date))}</span>
          <span class="tl-min mono">${this.esc(this.fmtShort(c.minutes))}</span>
          <span class="tl-text ${c.summary ? '' : 'is-plain'}">${c.summary ? this.esc(c.summary) : '常规推进'}</span>
          <button type="button" class="tl-del" onclick="event.stopPropagation(); Workbench.deleteSession('${c.id}')" title="记错了？删掉这条">✕</button>
        </div>
      `)).join('')}
    `;
    if (this._editingCommit) {
      const row = box.querySelector(`[data-commit-edit="${this._editingCommit}"]`);
      if (row) row.querySelector('#ce-sum')?.focus();
      this._armOutsideCancel();
    }
  },

  beginCommitEdit(sessionId) {
    this._editingCommit = sessionId;
    this._renderCommitsList();
  },

  /* 点编辑行以外的任何地方 → 退回原样，不存 */
  _armOutsideCancel() {
    if (this._outsideHandler) document.removeEventListener('click', this._outsideHandler);
    this._outsideHandler = (e) => {
      const row = document.querySelector(`[data-commit-edit="${this._editingCommit}"]`);
      if (row && row.contains(e.target)) return;
      document.removeEventListener('click', this._outsideHandler);
      this._outsideHandler = null;
      this._editingCommit = null;
      this._renderCommitsList();
    };
    /* 等当前这次点击冒泡完再挂，免得立刻自己触发自己 */
    setTimeout(() => document.addEventListener('click', this._outsideHandler), 0);
  },

  async saveCommitEdit(sessionId) {
    const date = document.getElementById('ce-date')?.value;
    const minutes = Math.round(Number(document.getElementById('ce-min')?.value) || 0);
    const summary = document.getElementById('ce-sum')?.value.trim() ?? '';
    this._editingCommit = null;
    if (this._outsideHandler) { document.removeEventListener('click', this._outsideHandler); this._outsideHandler = null; }
    if (minutes < 1 || minutes > 1440) { this.toast('时长得是 1 ~ 1440 分钟'); await this._fillCommits(this._commitsTaskId); return; }
    try {
      await this.post({ action: 'edit_commit', sessionId, summary, date, minutes });
      this.toast('改好了。');
    } catch (err) { this.toast(`没存上：${err.message}`); }
    this._commits = null;
    await this._fillCommits(this._commitsTaskId);
  },

  async deleteSession(sessionId) {
    try {
      await this.post({ action: 'session_delete', sessionId });
      this.toast('删掉了这条。');
    } catch (err) { this.toast(`没删掉：${err.message}`); }
    await this.refresh();   /* 总账、光谱、目标进度都要跟着走 */
  },

  dayLabel(dateStr) {
    if (!dateStr) return '';
    const fmt = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    const now = new Date();
    const today = fmt(now);
    const yest = fmt(new Date(now.getTime() - 86400000));
    if (dateStr === today) return '今天';
    if (dateStr === yest) return '昨天';
    return dateStr.slice(5);
  }
};

/* const 声明不会自动挂到 window；app.js 的视图切换经由 window.Workbench 进入工作台 */
window.Workbench = Workbench;

/* 点击弹层以外的地方 → 收起分类管理与目标编辑 */
document.addEventListener('click', (e) => {
  if (!window.Workbench) return;
  if (Workbench._catPop && !e.target.closest('.cat-pop, .spot-cat')) { Workbench._catPop = null; Workbench.render(); }
  if (Workbench._goalPop && !e.target.closest('.goal-pop, .goal-badge')) { Workbench._goalPop = null; Workbench.render(); }
});

/* 全局快捷键：Tab 收起 / 展开雷达（对话输入框聚焦时不抢） */
window.addEventListener('keydown', (e) => {
  if (e.key !== 'Tab') return;
  const chatView = document.getElementById('view-chat');
  if (chatView && chatView.style.display !== 'none') return;
  const tag = (document.activeElement && document.activeElement.tagName) || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
  e.preventDefault();
  Workbench.toggleRadar();
});

/* 目标时长 / 手动分钟输入框：回车保存 */
window.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && e.target && (e.target.id === 'wb-goal-input' || e.target.id === 'wb-commit-minutes-input')) {
    e.preventDefault();
    if (e.target.id === 'goal-input') {
      const t = Workbench._spotTaskId();
      if (t) Workbench.saveGoal(t);
    } else {
      Workbench.submitCommit();
    }
  }
});
