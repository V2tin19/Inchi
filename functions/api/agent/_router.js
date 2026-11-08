/**
 * _router.js —— 状态路由的纯函数内核（SPEC v2 · Phase 1 / M1）
 *
 * 四件事，全部是纯函数：不碰 IO，不读 doc，输入什么算什么，测试直驱。
 *
 * 1. normalizeTask(s) —— 老数据缺省补齐，零迁移可用：
 *      无 category → CORE；无 energy → NORMAL；无 firstStep → ''；
 *      v1 的 archived:true 解读为 status:'archived'（双写兼容，读侧两种都认）。
 * 2. dealTasks —— 按档位发牌：只发「进行中」的，断点越新越靠前。
 * 3. computeRecovery —— 低谷缓冲：连续 48 小时无记录 → 当日目标 30%，当日固定。
 * 4. spectrumOf —— 今日时长光谱：按任务分类归账，无主条目归核心正事。
 */

export const CATEGORIES = ['CORE', 'EXPLORE', 'CHORE'];
export const ENERGIES = ['HIGH', 'NORMAL', 'LOW'];
export const STATUSES = ['active', 'suspended', 'archived'];

export const CATEGORY_CN = { CORE: '核心正事', EXPLORE: '个人探索', CHORE: '日常杂项' };
export const STATE_CN = { HIGH: '兴致高涨', NORMAL: '状态平稳', LOW: '电量见底' };

const ISO_MS = (v) => {
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : 0;
};

/** 单个任务缺省补齐。坏条目返回 null 由调用方丢弃。 */
export function normalizeTask(t) {
  if (!t || typeof t !== 'object') return null;
  const status = t.archived
    ? 'archived'
    : (STATUSES.includes(t.status) ? t.status : 'active');
  return {
    ...t,
    category: CATEGORIES.includes(t.category) ? t.category : 'CORE',
    energy: ENERGIES.includes(t.energy) ? t.energy : 'NORMAL',
    firstStep: typeof t.firstStep === 'string' ? t.firstStep.slice(0, 200) : '',
    status,
    /* 双写：v1 的读侧（withProgress、对话匹配）只认 archived 布尔 */
    archived: status === 'archived'
  };
}

export function normalizeTasks(tasks) {
  return (Array.isArray(tasks) ? tasks : []).map(normalizeTask).filter(Boolean);
}

/**
 * 发牌：某档位下的候选队列。
 * 只发「进行中」；suspended 留在雷达里但不参与发牌（搁置是用户自己的决定，
 * 系统不催也不藏）。用户手动拖过的顺序（order）优先，没拖过的按断点新旧。
 */
export function dealTasks(tasks, state) {
  if (!ENERGIES.includes(state)) return [];
  const pool = normalizeTasks(tasks)
    .filter(t => t.status === 'active' && t.energy === state)
    .sort((a, b) =>
      (Number.isFinite(a.order) ? a.order : 1e9) - (Number.isFinite(b.order) ? b.order : 1e9)
      || (ISO_MS(b.lastCommitAt) || ISO_MS(b.updatedAt)) - (ISO_MS(a.lastCommitAt) || ISO_MS(a.updatedAt))
      || String(a.id).localeCompare(String(b.id))
    );
  return pool;
}

/** 发牌落空时的顺位：只降不升。LOW 之下没有更低，返回 null（宁可不发，绝不推硬任务）。 */
export function fallbackState(state) {
  const order = ['HIGH', 'NORMAL', 'LOW'];
  const i = order.indexOf(state);
  return (i >= 0 && i < order.length - 1) ? order[i + 1] : null;
}

/**
 * 从高到低逐档找牌。返回 { tasks, dealtFrom } —— dealtFrom 是实际发牌的档位，
 * 与请求档位不同时前端会提示「这组今天还空着，先拿下一档的」。
 */
export function dealWithFallback(tasks, state) {
  let cur = ENERGIES.includes(state) ? state : 'NORMAL';
  while (cur) {
    const tasks_ = dealTasks(tasks, cur);
    if (tasks_.length) return { tasks: tasks_, dealtFrom: cur };
    cur = fallbackState(cur);
  }
  return { tasks: [], dealtFrom: null };
}

/**
 * 低谷缓冲。连续 48 小时无任何打开/计时记录 → 当日目标 30%（下限 15 分钟）。
 * datesMap 里已存过的当日记录优先 —— 当日固定，不因当天回访时刻不同而漂移；
 * 首次使用（没有 lastSeen）不算停机。
 */
export function computeRecovery({ lastSeenMs, nowMs, baseMinutes, todayStr, datesMap }) {
  const base = Math.min(1440, Math.max(15, Math.round(Number(baseMinutes) || 240)));
  const stored = datesMap && datesMap[todayStr];
  if (stored && Number.isFinite(Number(stored.effectiveTargetMinutes))) {
    return { effectiveTargetMinutes: Math.round(Number(stored.effectiveTargetMinutes)), isRecovery: !!stored.isRecovery };
  }
  let isRecovery = false;
  const last = Number(lastSeenMs);
  if (Number.isFinite(last) && last > 0 && Number.isFinite(nowMs)) {
    isRecovery = (nowMs - last) >= 48 * 3600 * 1000;
  }
  return {
    effectiveTargetMinutes: isRecovery ? Math.max(15, Math.round(base * 0.3)) : base,
    isRecovery
  };
}

/**
 * 今日时长光谱：单条记录自己声明分类优先（会记一笔时的快照），任务现分类兜底。
 * 这是「断点语义」的落点：改分类不改历史，前面的保存，后面的按新的来。
 * 返回 { [分类键]: 分钟, total }。
 */
export function spectrumOf(sessions, tasks) {
  const byId = new Map();
  const bySubject = new Map();
  for (const t of normalizeTasks(tasks)) {
    if (t.id) byId.set(t.id, t);
    if (t.subject) bySubject.set(t.subject, t);
  }
  const out = { total: 0 };
  for (const s of Array.isArray(sessions) ? sessions : []) {
    if (!s || typeof s !== 'object') continue;
    const m = Math.max(0, Math.round(Number(s.duration) || 0));
    if (!m) continue;
    const cat = s.categoryId
      || (s.task_id && byId.get(s.task_id) && (byId.get(s.task_id).categoryId || byId.get(s.task_id).category))
      || (() => { const t = bySubject.get(s.subject); return t && (t.categoryId || t.category); })()
      || 'CORE';
    out[cat] = (out[cat] || 0) + m;
    out.total += m;
  }
  return out;
}
