/**
 * Notes —— 便签（草稿池，可分组、可拖动）
 *
 * 一句话一张纸：随手钉、随手改、随手撕；点「转任务」把它变成工作台里的一张牌。
 * 分组只是把纸片分区：拖到分区头/分区间即换组，组内拖动排序；
 * 「未分组」恒在恒第一；组可以建（≤8）也可以删（组里的纸回落未分组）。
 */

const Notes = {
  apiBase: localStorage.getItem('inchi_apibase') || '',
  token: localStorage.getItem('inchi_token') || 'cairn-token',
  items: [],
  groups: ['未分组'],
  _editingId: null,
  _dragId: null,
  _groupForm: false,

  headers() {
    return { 'content-type': 'application/json', 'authorization': `Bearer ${this.token}` };
  },

  esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  },

  toast(msg) {
    if (window.Inchi && Inchi.showToast) Inchi.showToast(msg);
  },

  async enter() {
    await this.refresh();
  },

  async refresh() {
    try {
      const res = await fetch(`${this.apiBase}/api/admin/agent/notes`, { headers: this.headers() });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      this.items = Array.isArray(data.items) ? data.items : [];
      this.groups = Array.isArray(data.groups) && data.groups.length ? data.groups : ['未分组'];
      this.render();
    } catch (err) {
      const grid = document.getElementById('notes-grid');
      if (grid) grid.innerHTML = `<div class="notes-empty">便签池暂时够不着（${this.esc(err.message)}）</div>`;
    }
  },

  async add(event) {
    if (event) event.preventDefault();
    const input = document.getElementById('note-input');
    const content = input.value.trim();
    if (!content) return;
    input.value = '';
    try {
      await fetch(`${this.apiBase}/api/admin/agent/notes`, {
        method: 'POST', headers: this.headers(),
        body: JSON.stringify({ content, group: this._pinGroup || '未分组' })
      });
      await this.refresh();
    } catch (err) {
      this.toast(`没钉上：${err.message}`);
      input.value = content;   /* 还给用户，别吞字 */
    }
  },

  edit(id) {
    this._editingId = id;
    this.render();
    const ta = document.getElementById(`note-edit-${CSS.escape(id)}`);
    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  },

  async saveEdit(id) {
    const ta = document.getElementById(`note-edit-${CSS.escape(id)}`);
    const content = ta ? ta.value.trim() : '';
    this._editingId = null;
    if (!content) { this.render(); return; }
    try {
      await fetch(`${this.apiBase}/api/admin/agent/notes`, {
        method: 'PUT', headers: this.headers(), body: JSON.stringify({ id, content })
      });
    } catch (err) {
      this.toast(`没存上：${err.message}`);
    }
    await this.refresh();
  },

  cancelEdit() {
    this._editingId = null;
    this.render();
  },

  async remove(id) {
    try {
      const res = await fetch(`${this.apiBase}/api/admin/agent/notes?id=${encodeURIComponent(id)}`, {
        method: 'DELETE', headers: this.headers()
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      this.toast('撕掉了。');
    } catch (err) {
      this.toast(`没撕掉：${err.message}`);
    }
    await this.refresh();
  },

  /* 转任务：把第一行当任务名塞进工作台的任务弹窗，确认后撕掉原便签 */
  toTask(id) {
    const note = this.items.find(n => n.id === id);
    if (!note || !window.Workbench) return;
    const firstLine = note.content.split('\n')[0].slice(0, 60) || note.content.slice(0, 60);
    Workbench.openTaskModal({ name: firstLine, noteId: id });
  },

  async removeSilent(id) {
    try {
      await fetch(`${this.apiBase}/api/admin/agent/notes?id=${encodeURIComponent(id)}`, {
        method: 'DELETE', headers: this.headers()
      });
    } catch { /* 转任务已成功，便签撕不撕不掉不碍事 */ }
  },

  /* ---------- 分组 ---------- */
  toggleGroupForm() {
    this._groupForm = !this._groupForm;
    this.render();
    if (this._groupForm) document.getElementById('note-group-input')?.focus();
  },

  async createGroup(event) {
    if (event) event.preventDefault();
    const input = document.getElementById('note-group-input');
    const name = input ? input.value.trim() : '';
    if (!name) return;
    try {
      const res = await fetch(`${this.apiBase}/api/admin/agent/notes`, {
        method: 'POST', headers: this.headers(),
        body: JSON.stringify({ action: 'group_create', name })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      this._groupForm = false;
      await this.refresh();
    } catch (err) { this.toast(`没建上：${err.message}`); }
  },

  async deleteGroup(name) {
    if (name === '未分组') return;
    try {
      const res = await fetch(`${this.apiBase}/api/admin/agent/notes`, {
        method: 'POST', headers: this.headers(),
        body: JSON.stringify({ action: 'group_delete', name })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      this.toast('分组收掉了，纸都在未分组里。');
      await this.refresh();
    } catch (err) { this.toast(`没删掉：${err.message}`); }
  },

  /* ---------- 拖拽：换组 / 组内排序 ---------- */
  onDragStart(event, id) {
    this._dragId = id;
    if (event.dataTransfer) {
      event.dataTransfer.setData('text/plain', id);
      event.dataTransfer.effectAllowed = 'move';
    }
  },

  onDragEnd() {
    this._dragId = null;
    document.querySelectorAll('.note-section.drag-over').forEach(s => s.classList.remove('drag-over'));
  },

  onSectionDragOver(event, group) {
    if (!this._dragId) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = 'move';
    const sec = document.querySelector(`.note-section[data-group="${CSS.escape(group)}"]`);
    if (sec) sec.classList.add('drag-over');
  },

  onSectionDragLeave(group) {
    const sec = document.querySelector(`.note-section[data-group="${CSS.escape(group)}"]`);
    if (sec) sec.classList.remove('drag-over');
  },

  async dropToSection(event, group) {
    event.preventDefault();
    const id = this._dragId || (event.dataTransfer && event.dataTransfer.getData('text/plain'));
    this.onDragEnd();
    if (!id) return;
    const note = this.items.find(n => n.id === id);
    if (!note) return;

    /* 落点两侧的 order 取中值（只在该组的纸片里算） */
    const siblings = this.items
      .filter(n => n.group === group && n.id !== id)
      .sort((x, y) => (Number.isFinite(x.order) ? x.order : 1e9) - (Number.isFinite(y.order) ? y.order : 1e9));
    const rows = event.currentTarget ? [...event.currentTarget.querySelectorAll('.note-card[data-id]')] : [];
    let afterId = null;
    for (const row of rows) {
      if (row.dataset.id === id) continue;
      if (row.getBoundingClientRect().top > event.clientY) { afterId = row.dataset.id; break; }
    }
    const idx = afterId ? siblings.findIndex(n => n.id === afterId) : siblings.length;
    const orderAt = (i) => (Number.isFinite(siblings[i]?.order) ? siblings[i].order : null);
    const prev = idx > 0 ? orderAt(idx - 1) : null;
    const next = idx < siblings.length ? orderAt(idx) : null;
    let order;
    if (prev !== null && next !== null) order = (prev + next) / 2;
    else if (prev !== null) order = prev + 10;
    else if (next !== null) order = Math.max(0, next - 10);
    else order = siblings.length ? 10 : 10;

    try {
      await fetch(`${this.apiBase}/api/admin/agent/notes`, {
        method: 'PUT', headers: this.headers(),
        body: JSON.stringify({ id, group, order })
      });
      await this.refresh();
    } catch (err) { this.toast(`没挪成：${err.message}`); }
  },

  /* ---------- 渲染 ---------- */
  render() {
    const grid = document.getElementById('notes-grid');
    const count = document.getElementById('notes-count');
    if (count) count.textContent = String(this.items.length);
    if (!grid) return;

    const head = document.getElementById('notes-group-tools');
    if (head) {
      head.innerHTML = this._groupForm
        ? `<form class="note-group-form" onsubmit="Notes.createGroup(event)">
             <input type="text" id="note-group-input" class="form-input" maxlength="12" placeholder="分组名，例如：项目灵感">
             <button type="submit" class="btn-ghost-mini">建好</button>
             <button type="button" class="text-link-btn" onclick="Notes.toggleGroupForm()">取消</button>
           </form>`
        : '';
    }

    if (!this.items.length) {
      grid.innerHTML = '<div class="notes-empty">池子很干净。想到什么，随时钉一张。</div>';
      return;
    }

    const sections = this.groups.map(group => {
      const list = this.items.filter(n => (n.group || '未分组') === group);
      /* drop 属性必须无条件挂上：dragstart 不会触发重渲染，条件渲染会让真实拖拽落空 */
      return `
        <section class="note-section"
                 data-group="${this.esc(group)}"
                 ondragover="Notes.onSectionDragOver(event, '${this.esc(group)}')"
                 ondragleave="Notes.onSectionDragLeave('${this.esc(group)}')"
                 ondrop="Notes.dropToSection(event, '${this.esc(group)}')">
          <div class="note-section-head">
            <span class="note-section-name">${this.esc(group)}</span>
            <span class="note-section-count mono">${list.length}</span>
            ${group !== '未分组' ? `<button type="button" class="text-link-btn note-del" onclick="Notes.deleteGroup('${this.esc(group)}')" title="删分组，纸回落未分组">✕</button>` : ''}
          </div>
          ${list.length
            ? list.map(n => this.renderCard(n)).join('')
            : '<div class="notes-empty" style="padding:10px 0;">这一摞是空的，拖一张过来。</div>'}
        </section>
      `;
    }).join('');

    grid.innerHTML = sections;
  },

  renderCard(n) {
    if (this._editingId === n.id) {
      return `
        <div class="note-card editing" data-id="${n.id}">
          <textarea class="note-edit" id="note-edit-${this.esc(n.id)}" maxlength="500"
            onkeydown="if(event.key==='Enter'&&!event.shiftKey){event.preventDefault();Notes.saveEdit('${n.id}')}">${this.esc(n.content)}</textarea>
          <div class="note-foot">
            <span class="note-date mono">${this.esc(this.fmtDate(n.createdAt))}</span>
            <button type="button" class="text-link-btn" onclick="Notes.cancelEdit()">取消</button>
            <button type="button" class="text-link-btn" onclick="Notes.saveEdit('${n.id}')">存</button>
          </div>
        </div>
      `;
    }
    return `
      <div class="note-card" data-id="${n.id}" draggable="true"
           ondragstart="Notes.onDragStart(event, '${n.id}')"
           ondragend="Notes.onDragEnd()">
        <div class="note-content" onclick="Notes.edit('${n.id}')" title="点击改字">${this.esc(n.content)}</div>
        <div class="note-foot">
          <span class="note-date mono">${this.esc(this.fmtDate(n.createdAt))}</span>
          <button type="button" class="text-link-btn" onclick="Notes.toTask('${n.id}')">转任务</button>
          <button type="button" class="text-link-btn note-del" onclick="Notes.remove('${n.id}')">✕</button>
        </div>
      </div>
    `;
  },

  fmtDate(iso) {
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return `${d.getMonth() + 1}/${d.getDate()}`;
  }
};

window.Notes = Notes;
