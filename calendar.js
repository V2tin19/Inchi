/**
 * MonthView —— 日历（回顾视图：月 / 周）
 *
 * 只回顾，不排期。月视图看一个月的节奏，周视图看这一周的进度——
 * 每列一天，条目直接摊开。未来不会有任何安排出现在这里（SPEC 0.3）。
 * 周会跨月，所以数据一律按区间取（?from=&to=）。
 */

const MonthView = {
  apiBase: localStorage.getItem('inchi_apibase') || '',
  token: localStorage.getItem('inchi_token') || 'cairn-token',
  view: 'month',        /* month | week */
  anchor: null,         /* 锚点日期（月视图取其年月，周视图取其所在周） */
  days: {},
  cats: [],             /* 用户自定义分类表（id → 名字/颜色） */
  range: null,          /* { from, to } */
  selected: null,       /* 月视图点选的日 */
  _review: null,        /* { text, offline } AI 周评缓存 */
  _reviewLoading: false,

  headers() {
    return { 'content-type': 'application/json', 'authorization': `Bearer ${this.token}` };
  },

  esc(s) {
    return String(s || '')
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  },

  fmtShort(min) { return min < 60 ? `${Math.round(min)}分钟` : (Math.round(min / 6) / 10).toFixed(1) + 'h'; },

  iso(d) {
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  },

  todayIso() { return this.iso(new Date()); },

  mondayOf(d) {
    const m = new Date(d);
    m.setDate(d.getDate() - ((d.getDay() + 6) % 7));
    return m;
  },

  async enter() {
    this.anchor = new Date();
    this.selected = null;
    await this.refresh();
  },

  setMode(view) {
    if (view !== 'month' && view !== 'week') return;
    this.view = view;
    this.selected = null;
    this._review = null;
    this.refresh();
  },

  nav(delta) {
    const d = new Date(this.anchor);
    if (this.view === 'week') d.setDate(d.getDate() + delta * 7);
    else { d.setDate(1); d.setMonth(d.getMonth() + delta); }
    this.anchor = d;
    this.selected = null;
    this.refresh();
  },

  today() {
    this.anchor = new Date();
    this.selected = null;
    this.refresh();
  },

  /* 当前视图对应的数据区间 */
  currentRange() {
    if (this.view === 'week') {
      const mon = this.mondayOf(this.anchor);
      const sun = new Date(mon);
      sun.setDate(mon.getDate() + 6);
      return { from: this.iso(mon), to: this.iso(sun) };
    }
    const y = this.anchor.getFullYear();
    const m = this.anchor.getMonth();
    return {
      from: `${y}-${String(m + 1).padStart(2, '0')}-01`,
      to: `${y}-${String(m + 1).padStart(2, '0')}-${String(new Date(y, m + 1, 0).getDate()).padStart(2, '0')}`
    };
  },

  async refresh() {
    const range = this.currentRange();
    this.range = range;
    try {
      const res = await fetch(
        `${this.apiBase}/api/admin/agent/workbench?from=${range.from}&to=${range.to}`,
        { headers: this.headers() }
      );
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      this.days = data.days || {};
      this.cats = Array.isArray(data.categories) ? data.categories : [];
      this.render();
    } catch (err) {
      const grid = document.getElementById('cal-grid');
      if (grid) grid.innerHTML = `<div class="notes-empty">日历暂时够不着（${this.esc(err.message)}）</div>`;
    }
  },

  select(date) {
    this.selected = date;
    this.render();
  },

  render() {
    const title = document.getElementById('cal-title');
    const todayBtn = document.getElementById('cal-today-btn');
    document.querySelectorAll('#cal-modes .seg-chip').forEach(c =>
      c.classList.toggle('sel', c.dataset.v === this.view));

    if (this.view === 'week') {
      const dows = ['一', '二', '三', '四', '五', '六', '日'];
      const mon = new Date(this.range.from + 'T00:00:00');
      const sun = new Date(this.range.to + 'T00:00:00');
      if (title) title.textContent = `${this.range.from.slice(5).replace('-', '/')} – ${this.range.to.slice(5).replace('-', '/')}`;
      if (todayBtn) todayBtn.textContent = '回到本周';
      this.renderWeek(dows, mon);
    } else {
      if (title) title.textContent = `${this.anchor.getFullYear()} 年 ${this.anchor.getMonth() + 1} 月`;
      if (todayBtn) todayBtn.textContent = '回到本月';
      this.renderMonth();
    }
    this.renderDetail();
  },

  /* ---------- 月视图 ---------- */
  renderMonth() {
    const grid = document.getElementById('cal-grid');
    if (!grid) return;
    const y = this.anchor.getFullYear();
    const m = this.anchor.getMonth();
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const lead = (new Date(y, m, 1).getDay() + 6) % 7;
    const today = this.todayIso();

    const maxMin = Math.max(60, ...Object.values(this.days).map(d => d.minutes || 0));
    const cells = [];
    for (let i = 0; i < lead; i++) cells.push('<div class="cal-cell empty"></div>');
    for (let day = 1; day <= daysInMonth; day++) {
      const iso = `${y}-${String(m + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      const d = this.days[iso];
      const minutes = d ? d.minutes : 0;
      const level = minutes > 0 ? Math.min(3, Math.ceil(minutes / (maxMin / 3))) : 0;
      const spectrum = this.miniSpectrum(d);
      cells.push(`
        <div class="cal-cell lv-${level} ${iso === today ? 'today' : ''} ${iso === this.selected ? 'sel' : ''} ${minutes > 0 ? 'has-min' : ''}"
             onclick="MonthView.select('${iso}')">
          <span class="cal-num mono">${day}</span>
          ${minutes > 0 ? `<span class="cal-min mono">${this.fmtShort(minutes)}</span>` : ''}
          ${spectrum}
        </div>
      `);
    }
    grid.style.display = 'grid';
    grid.style.gridTemplateColumns = '';
    grid.style.alignContent = 'start';
    grid.style.alignItems = '';
    grid.innerHTML = cells.join('');
    document.getElementById('cal-dow')?.style.setProperty('display', 'grid');
  },

  /* ---------- 周视图（竖排：一天一行，空间不够可滚动） ---------- */
  renderWeek(dows, mon) {
    const grid = document.getElementById('cal-grid');
    if (!grid) return;
    grid.style.display = 'block';
    document.getElementById('cal-dow')?.style.setProperty('display', 'none');
    const today = this.todayIso();

    const rows = [];
    for (let i = 0; i < 7; i++) {
      const d = new Date(mon);
      d.setDate(mon.getDate() + i);
      const iso = this.iso(d);
      const day = this.days[iso];
      const sessions = day ? day.sessions : [];
      rows.push(`
        <div class="cal-wrow ${iso === today ? 'today' : ''} ${sessions.length ? '' : 'quiet'}">
          <div class="cal-wrow-head">
            <span class="cal-wrow-dow">周${dows[i]}</span>
            <span class="cal-wrow-date mono">${iso.slice(5)}</span>
            <span class="cal-wrow-min mono">${day ? this.fmtShort(day.minutes) : '·'}</span>
            ${this.miniSpectrum(day, 'static')}
          </div>
          <div class="cal-wrow-body">
            ${sessions.length
              ? sessions.map(x => `
                <span class="cal-w-session">
                  <span class="mono">${this.esc(this.fmtShort(x.minutes))}</span>
                  ${this.esc(x.subject)}${x.summary ? ` — ${this.esc(x.summary)}` : ''}
                </span>`).join('')
              : '<span class="cal-w-empty">没有投入记录</span>'}
          </div>
        </div>
      `);
    }
    grid.innerHTML = rows.join('');
  },

  /* ---------- 周视图底部：本周混杂大进度条 + AI 一键周评 ---------- */
  weekTotals() {
    const totals = {};
    let total = 0;
    for (const d of Object.values(this.days)) {
      for (const [k, m] of Object.entries(d.byCat || {})) {
        if (k === 'total' || !m) continue;
        totals[k] = (totals[k] || 0) + m;
        total += m;
      }
    }
    return { totals, total };
  },

  renderWeekSummary() {
    const box = document.getElementById('cal-detail');
    if (!box) return;
    const { totals, total } = this.weekTotals();

    const segs = Object.entries(totals).map(([k, m]) => {
      const info = this.cats.find(c => c.id === k) || { name: k, color: '#81A1C1' };
      return `<i class="cal-seg" style="flex:${m};background:${info.color}" title="${this.esc(info.name)} ${this.fmtShort(m)}"></i>`;
    }).join('');

    box.innerHTML = `
      <div class="week-summary">
        <div class="week-bar-row">
          <div class="week-bar">${total ? segs : '<div class="spectrum-empty">这一周还没有投入记录</div>'}</div>
          <span class="week-bar-total mono">本周共 ${total ? this.fmtShort(total) : '0分钟'}</span>
          <button type="button" class="btn-ghost-mini" id="ai-review-btn" onclick="MonthView.loadReview()">
            ${this._reviewLoading ? '评估中…' : 'AI 评估本周'}
          </button>
        </div>
        ${this._review ? `
          <div class="ai-review">
            <div class="ai-review-tag mono">${this._review.offline ? '事实版 · 未接 AI' : 'AI 周评'}</div>
            <div class="ai-review-text">${this.esc(this._review.text)}</div>
          </div>` : ''}
      </div>
    `;
  },

  async loadReview() {
    if (this._reviewLoading || !this.range) return;
    this._reviewLoading = true;
    this.renderWeekSummary();
    try {
      const res = await fetch(`${this.apiBase}/api/admin/agent/workbench`, {
        method: 'POST', headers: this.headers(),
        body: JSON.stringify({ action: 'week_review', from: this.range.from, to: this.range.to })
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      this._review = { text: data.review, offline: !!data.offline };
    } catch (err) {
      this._review = { text: `评估没跑起来（${err.message}）。数据还在，稍后再试。`, offline: true };
    } finally {
      this._reviewLoading = false;
      this.renderWeekSummary();
    }
  },

  miniSpectrum(d, mode) {
    if (!d || !d.minutes) return '';
    const segs = Object.entries(d.byCat)
      .filter(([k, m]) => k !== 'total' && m > 0)
      .map(([k, m]) => {
        const info = this.cats.find(c => c.id === k) || { name: k, color: '#81A1C1' };
        return `<i class="cal-seg" style="flex:${m};background:${info.color}" title="${this.esc(info.name)} ${this.fmtShort(m)}"></i>`;
      })
      .join('');
    return segs ? `<div class="cal-spectrum ${mode === 'static' ? 'static' : ''}">${segs}</div>` : '';
  },

  renderDetail() {
    const box = document.getElementById('cal-detail');
    if (!box) return;
    if (this.view === 'week') { this.renderWeekSummary(); return; }
    if (!this.selected) { box.innerHTML = ''; return; }
    const d = this.days[this.selected];
    const label = this.selected === this.todayIso() ? '今天' : this.selected.slice(5);
    if (!d || !d.minutes) {
      box.innerHTML = `<div class="cal-detail-title mono">${this.esc(label)}</div><div class="notes-empty">这一天没有投入记录。</div>`;
      return;
    }
    box.innerHTML = `
      <div class="cal-detail-title mono">${this.esc(label)} · 共 ${this.esc(this.fmtShort(d.minutes))}</div>
      ${d.sessions.map(s => `
        <div class="cal-session">
          <span class="cal-session-sub">${this.esc(s.subject)}</span>
          <span class="cal-session-min mono">${this.esc(this.fmtShort(s.minutes))}</span>
          <span class="cal-session-text">${s.summary ? this.esc(s.summary) : '<i class="commit-text is-empty">无</i>'}</span>
        </div>
      `).join('')}
    `;
  }
};

window.MonthView = MonthView;
