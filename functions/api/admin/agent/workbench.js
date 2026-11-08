/**
 * /api/admin/agent/workbench —— 工作台专用读写口（SPEC v2 · Phase 1 / M1）
 *
 *   GET  /api/admin/agent/workbench              今日遥测 + 任务 + 发牌
 *        顺带做两件后台事：更新 lastSeenMs；按低谷缓冲结算并固定当日目标。
 *   POST /api/admin/agent/workbench              按 action 分发：
 *        { action: 'set_state',    state }                       拨档位
 *        { action: 'session_stop', taskId, minutes, summary?, nextStep? }
 *                                                      正向计时结算：入台账，
 *                                                      nextStep 非空则覆写任务 firstStep
 *        { action: 'task_create',  name, category, energy, firstStep?, targetMinutes? }
 *        { action: 'task_update',  id, patch }                    白名单字段
 *        { action: 'set_quota',    baseTargetMinutes }
 *
 * 数据落点（沿用 _store.js 读-合-写，全走服务端合并写）：
 *   agent_tasks —— 任务（v2 新字段 category/energy/firstStep/status，见 _router.js）
 *   study       —— 时长条目（v1 台账，进度条口径不变；v2 附加 stateAtTime/summary/nextStep）
 *   agent_state —— { current, setAt, lastSeenMs }
 *   agent_quota —— { baseTargetMinutes, dates: { [date]: { effectiveTargetMinutes, isRecovery } } }
 *
 * 令牌：环境变量 ADMIN_TOKEN，Authorization: Bearer <令牌>
 */

import { json, dbMissing, requireAdmin, isValidDate } from '../../_shared.js';
import { readDoc, writeDoc, newId, nowIso } from '../../agent/_store.js';
import { shanghaiToday, weekdayPy } from '../../agent/_nlu.js';
import { llmChat, llmReadyAsync } from '../../_llm.js';
import {
  CATEGORIES, ENERGIES, STATE_CN,
  normalizeTasks, dealWithFallback, computeRecovery, spectrumOf
} from '../../agent/_router.js';

const NO_STORE = { 'cache-control': 'no-store' };

const RECOVERY_NOTICE = '刚从休息状态回来，先挑件顺手的小事找回手感吧。';

/* 分类是用户自己的语义，不是系统钦定的：默认给三颗种子，可增可自定义颜色。
   legacy 字段用于把 v1 的 CORE/EXPLORE/CHORE 枚举迁到种子 id 上。 */
const DEFAULT_CATEGORIES = [
  { id: 'cat_core', name: '核心正事', color: '#81A1C1', legacy: 'CORE' },
  { id: 'cat_explore', name: '个人探索', color: '#EBCB8B', legacy: 'EXPLORE' },
  { id: 'cat_chore', name: '日常杂项', color: '#A3BE8C', legacy: 'CHORE' }
];

async function readCategories(env) {
  const { data } = await readDoc(env, 'agent_categories');
  const items = data && Array.isArray(data.items)
    ? data.items.filter(c => c && typeof c === 'object' && c.id && c.name && /^#[0-9A-Fa-f]{6}$/.test(c.color))
    : [];
  if (items.length) return items;
  const seeds = DEFAULT_CATEGORIES.map(({ id, name, color }) => ({ id, name, color }));
  await writeDoc(env, 'agent_categories', { items: seeds });
  return seeds;
}

/* 把任务上的分类解析成 categoryId + categoryInfo（老枚举映射到种子 id） */
function resolveTaskCategories(tasks, categories) {
  const byLegacy = new Map(DEFAULT_CATEGORIES.filter(d => d.legacy).map(d => [d.legacy, d.id]));
  return tasks.map(t => {
    const cid = (t.categoryId && categories.some(c => c.id === t.categoryId))
      ? t.categoryId
      : (categories.find(c => c.id === byLegacy.get(t.category)) || categories[0]).id;
    const info = categories.find(c => c.id === cid);
    return { ...t, categoryId: cid, categoryInfo: { id: info.id, name: info.name, color: info.color } };
  });
}

const clampMinutes = (v, lo, hi) => Math.min(hi, Math.max(lo, Math.round(Number(v) || 0)));

function toMs(v) {
  const n = Date.parse(v);
  return Number.isFinite(n) ? n : 0;
}

async function readTasks(env) {
  const { data } = await readDoc(env, 'agent_tasks');
  const tasks = normalizeTasks(data && data.tasks);
  return { tasks, rawDoc: data || {} };
}

/**
 * 每个任务的今日投入、累计投入与最近留档时刻。
 * 归账口径与 tasks.js 的 withProgress 一致：task_id 优先，科目名兜底。
 */
function annotate(tasks, sessions, today) {
  const todayMin = new Map();
  const totalMin = new Map();
  const lastCommit = new Map();
  for (const s of sessions) {
    if (!s || typeof s !== 'object') continue;
    const m = Math.max(0, Math.round(Number(s.duration) || 0));
    const iso = toMs(s.createdAt) || toMs(s.date ? s.date + 'T00:00:00+08:00' : '');
    const hit = (t) => {
      if (s.task_id) return s.task_id === t.id;
      return !s.task_id && t.subject && s.subject === t.subject;
    };
    for (const t of tasks) {
      if (!hit(t)) continue;
      if (s.date === today) todayMin.set(t.id, (todayMin.get(t.id) || 0) + m);
      totalMin.set(t.id, (totalMin.get(t.id) || 0) + m);
      if (iso) lastCommit.set(t.id, Math.max(lastCommit.get(t.id) || 0, iso));
    }
  }
  return tasks.map(t => ({
    ...t,
    todayMinutes: todayMin.get(t.id) || 0,
    totalMinutes: totalMin.get(t.id) || 0,
    lastCommitAt: lastCommit.get(t.id) ? new Date(lastCommit.get(t.id)).toISOString() : undefined
  }));
}

/** 日历回顾：[from, to] 区间内每天的总投入、分类构成与条目（只读，不落库） */
async function aggregateDays(env, from, to) {
  const { tasks } = await readTasks(env);
  const categories = await readCategories(env);
  const resolved = resolveTaskCategories(tasks, categories);
  const { data: study } = await readDoc(env, 'study');
  const sessions = study && Array.isArray(study.sessions) ? study.sessions : [];
  const byDay = {};
  for (const s of sessions) {
    if (!s || typeof s !== 'object' || typeof s.date !== 'string') continue;
    if (s.date < from || s.date > to) continue;
    const m = Math.max(0, Math.round(Number(s.duration) || 0));
    if (!m) continue;
    const d = byDay[s.date] || (byDay[s.date] = []);
    d.push(s);
  }
  const days = {};
  for (const [date, list] of Object.entries(byDay)) {
    list.sort((a, b) => (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0));
    days[date] = {
      minutes: list.reduce((acc, s) => acc + Math.round(Number(s.duration) || 0), 0),
      byCat: spectrumOf(list, resolved),
      sessions: list.map(s => ({
        subject: String(s.subject || '').slice(0, 60),
        minutes: Math.max(0, Math.round(Number(s.duration) || 0)),
        summary: String(s.summary || s.content || '').slice(0, 120)
      }))
    };
  }
  return { days, categories };
}

/* ---------------- GET：工作台遥测包 ---------------- */
export async function onRequestGet({ env, request }) {
  if (!env.DB) return dbMissing();
  const rejected = requireAdmin(request, env);
  if (rejected) return rejected;

  /* 只读支线：查某任务的最近推进（聚光灯轨迹用），不动 lastSeen */
  const commitsFor = new URL(request.url).searchParams.get('commits');
  if (commitsFor) {
    const limit = Math.min(20, Math.max(1, Number(new URL(request.url).searchParams.get('limit')) || 5));
    const { tasks } = await readTasks(env);
    const task = tasks.find(t => t.id === commitsFor);
    if (!task) return json({ ok: true, commits: [] }, 200, NO_STORE);
    const { data: study } = await readDoc(env, 'study');
    const sessions = study && Array.isArray(study.sessions) ? study.sessions : [];
    const commits = sessions
      .filter(s => s && typeof s === 'object' && (s.task_id === task.id || (!s.task_id && task.subject && s.subject === task.subject)))
      .sort((a, b) => (Date.parse(b.createdAt) || 0) - (Date.parse(a.createdAt) || 0))
      .slice(0, limit)
      .map(s => ({
        id: s.id,
        date: s.date,
        minutes: Math.max(0, Math.round(Number(s.duration) || 0)),
        summary: String(s.summary || s.content || '').slice(0, 200),
        stateAtTime: s.stateAtTime || null
      }));
    return json({ ok: true, commits }, 200, NO_STORE);
  }

  /* 只读支线：日历回顾数据（?month=YYYY-MM 或 ?from=&to=），不动 lastSeen。
     周视图会跨月，所以区间查询是一等公民。 */
  const params = new URL(request.url).searchParams;
  const monthParam = params.get('month');
  let rangeFrom = params.get('from');
  let rangeTo = params.get('to');
  if (monthParam && /^\d{4}-\d{2}$/.test(monthParam)) {
    const [y, m] = monthParam.split('-').map(Number);
    rangeFrom = `${monthParam}-01`;
    rangeTo = `${y}-${String(m).padStart(2, '0')}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
  }
  if (rangeFrom && rangeTo && isValidDate(rangeFrom) && isValidDate(rangeTo) && rangeFrom <= rangeTo) {
    const agg = await aggregateDays(env, rangeFrom, rangeTo);
    return json({ ok: true, from: rangeFrom, to: rangeTo, days: agg.days, categories: agg.categories }, 200, NO_STORE);
  }

  const today = shanghaiToday();
  const [{ tasks, rawDoc }, { data: study }, { data: stateData }, { data: quotaData }, categories] = await Promise.all([
    readTasks(env),
    readDoc(env, 'study'),
    readDoc(env, 'agent_state'),
    readDoc(env, 'agent_quota'),
    readCategories(env)
  ]);

  const sessions = study && Array.isArray(study.sessions) ? study.sessions : [];
  const todaySessions = sessions.filter(s => s && s.date === today);
  const tasksLive = annotate(resolveTaskCategories(tasks, categories), sessions, today);

  /* 档位：上次拨的档隔天作废（回到「未报到」），重新拨才发牌 */
  const stateDoc = stateData && typeof stateData === 'object' ? stateData : {};
  const state = (ENERGIES.includes(stateDoc.current) && stateDoc.setDate === today)
    ? stateDoc.current
    : null;

  /* 低谷缓冲：按 lastSeenMs 结算，并固定写入当日 dates（当日不再漂移） */
  const quota = quotaData && typeof quotaData === 'object' ? quotaData : {};
  const base = clampMinutes(quota.baseTargetMinutes || 240, 15, 1440);
  const rec = computeRecovery({
    lastSeenMs: stateDoc.lastSeenMs,
    nowMs: Date.now(),
    baseMinutes: base,
    todayStr: today,
    datesMap: quota.dates
  });
  const prev = quota.dates && quota.dates[today];
  if (!prev || prev.effectiveTargetMinutes !== rec.effectiveTargetMinutes || !!prev.isRecovery !== rec.isRecovery) {
    await writeDoc(env, 'agent_quota', {
      baseTargetMinutes: base,
      dates: { ...(quota.dates || {}), [today]: rec }
    });
  }

  /* 更新最后活跃时刻（低谷缓冲的判定源；一分钟内重复打开不反复写） */
  const lastSeenMs = Date.now();
  if (!stateDoc.lastSeenMs || (lastSeenMs - Number(stateDoc.lastSeenMs)) > 60 * 1000) {
    await writeDoc(env, 'agent_state', { ...stateDoc, lastSeenMs });
  }

  /* 发牌：未拨档不发（前端显示「先拨档位」）；拨了就顺档位往下找 */
  let hint = null;
  if (state) {
    const { tasks: dealt, dealtFrom } = dealWithFallback(tasksLive, state);
    if (dealt.length) hint = { taskId: dealt[0].id, dealtFrom, demoted: dealtFrom !== state };
  }

  return json({
    ok: true,
    today,
    state,
    quota: { base, effective: rec.effectiveTargetMinutes, isRecovery: rec.isRecovery },
    spectrum: spectrumOf(todaySessions, tasksLive),
    categories,
    tasks: tasksLive,
    hint,
    notice: rec.isRecovery ? RECOVERY_NOTICE : null,
    taskCount: tasksLive.filter(t => t.status !== 'archived').length
  }, 200, NO_STORE);
}

/* ---------------- POST：动作分发 ---------------- */
export async function onRequestPost({ env, request }) {
  if (!env.DB) return dbMissing();
  const rejected = requireAdmin(request, env);
  if (rejected) return rejected;

  let body;
  try { body = await request.json(); } catch { return json({ error: '请求体不是合法的 JSON' }, 400, NO_STORE); }
  if (!body || typeof body !== 'object') return json({ error: '请求体不能为空' }, 400, NO_STORE);

  const today = shanghaiToday();

  try {
    switch (body.action) {
      case 'set_state': return await setState(env, body);
      case 'session_stop': return await sessionStop(env, body, today);
      case 'task_create': return await taskCreate(env, body);
      case 'task_update': return await taskUpdate(env, body);
      case 'set_quota': return await setQuota(env, body);
      case 'edit_commit': return await editCommit(env, body);
      case 'session_delete': return await sessionDelete(env, body);
      case 'category_create': return await categoryCreate(env, body);
      case 'category_update': return await categoryUpdate(env, body);
      case 'category_delete': return await categoryDelete(env, body);
      case 'task_reorder': return await taskReorder(env, body);
      case 'week_review': return await weekReview(env, body);
      default: return json({ error: '未知的 action' }, 400, NO_STORE);
    }
  } catch (e) {
    return json({ error: e.message || String(e) }, 500, NO_STORE);
  }
}

/* ---------- 拨档位 ---------- */
async function setState(env, body) {
  if (!ENERGIES.includes(body.state)) return json({ error: '档位必须是 HIGH / NORMAL / LOW' }, 400, NO_STORE);
  const { data } = await readDoc(env, 'agent_state');
  const doc = data && typeof data === 'object' ? data : {};
  await writeDoc(env, 'agent_state', {
    ...doc,
    current: body.state,
    setAt: nowIso(),
    setDate: shanghaiToday(),
    lastSeenMs: Date.now()
  });
  return json({ ok: true, state: body.state, stateCn: STATE_CN[body.state] }, 200, NO_STORE);
}

/* ---------- 正向计时结算 ---------- */
async function sessionStop(env, body, today) {
  const minutes = Math.round(Number(body.minutes));
  if (!(minutes >= 1)) return json({ error: '时长必须是正数（分钟）' }, 400, NO_STORE);
  if (minutes > 1440) return json({ error: '单条不能超过 24 小时（1440 分钟）' }, 400, NO_STORE);

  const { tasks, rawDoc } = await readTasks(env);
  const categories = await readCategories(env);
  const task = resolveTaskCategories(tasks, categories).find(t => t.id === body.taskId);
  if (!task) return json({ error: '没找到这个任务' }, 404, NO_STORE);
  if (task.status === 'archived') return json({ error: '这个任务已封存，不能再记账' }, 400, NO_STORE);

  const summary = String(body.summary || '').trim().slice(0, 500);
  const nextStep = String(body.nextStep || '').trim().slice(0, 200);

  /* 断点续传：下次接力点非空 → 覆写任务 firstStep */
  let updatedTask = task;
  const nextTasks = rawDoc.tasks;
  if (nextStep) {
    updatedTask = { ...task, firstStep: nextStep, updatedAt: nowIso() };
    for (let i = 0; i < nextTasks.length; i++) {
      if (nextTasks[i].id === task.id) nextTasks[i] = { ...nextTasks[i], firstStep: nextStep, updatedAt: updatedTask.updatedAt };
    }
  }

  const { data: stateData } = await readDoc(env, 'agent_state');
  const state = stateData && ENERGIES.includes(stateData.current) ? stateData.current : null;

  const session = {
    id: newId(),
    subject: task.subject || task.name,
    duration: minutes,
    content: summary,
    date: today,
    createdAt: nowIso(),
    source: 'workbench',
    task_id: task.id,
    /* 断点语义：入账那一刻任务属于哪个分类就存哪个，之后改分类不改历史 */
    categoryId: task.categoryId || task.category
  };
  if (summary) session.summary = summary;
  if (nextStep) session.nextStep = nextStep;
  if (state) session.stateAtTime = state;

  /* 台账合并写（与 study-session.js 同构，进度条口径不变） */
  const { data: study } = await readDoc(env, 'study');
  const sd = study && typeof study === 'object' ? study : {};
  sd.sessions = Array.isArray(sd.sessions) ? sd.sessions : [];
  const todayBefore = sd.sessions.filter(s => s && s.date === today);
  sd.sessions.push(session);
  if (nextStep) await writeDoc(env, 'agent_tasks', { tasks: nextTasks });
  await writeDoc(env, 'study', sd);

  return json({
    ok: true,
    session,
    task: updatedTask,
    spectrum: spectrumOf([...todayBefore, session], nextTasks)
  }, 200, NO_STORE);
}

/* ---------- 新增任务 ---------- */
async function taskCreate(env, body) {
  const name = String(body.name || '').trim().slice(0, 60);
  if (!name) return json({ error: '任务名称不能为空' }, 400, NO_STORE);
  const categories = await readCategories(env);
  let categoryId = null;
  if (body.categoryId) {
    const hit = categories.find(c => c.id === body.categoryId);
    if (!hit) return json({ error: '没有这个分类' }, 400, NO_STORE);
    categoryId = hit.id;
  } else {
    const legacy = CATEGORIES.includes(body.category) ? body.category : 'CORE';
    categoryId = (DEFAULT_CATEGORIES.find(d => d.legacy === legacy) || DEFAULT_CATEGORIES[0]).id;
  }
  const legacyOf = (DEFAULT_CATEGORIES.find(d => d.id === categoryId) || {}).legacy;
  const energy = ENERGIES.includes(body.energy) ? body.energy : 'NORMAL';
  const firstStep = String(body.firstStep || '').trim().slice(0, 200);
  const targetMinutes = body.targetMinutes ? clampMinutes(body.targetMinutes, 15, 10080) : null;

  const { rawDoc } = await readTasks(env);
  const task = {
    id: newId(),
    name,
    subject: name,
    aliases: [],
    categoryId,
    category: legacyOf || 'CORE',   /* v1 兼容位 */
    energy,
    firstStep,
    status: 'active',
    archived: false,
    createdAt: nowIso(),
    updatedAt: nowIso()
  };
  if (targetMinutes) { task.targetMinutes = targetMinutes; task.cycle = 'total'; }
  await writeDoc(env, 'agent_tasks', { tasks: [...(rawDoc.tasks || []), task] });
  return json({ ok: true, task }, 200, NO_STORE);
}

/* ---------- 改任务（白名单字段） ---------- */
async function taskUpdate(env, body) {
  const id = String(body.id || '');
  if (!id) return json({ error: '需要 id 字段' }, 400, NO_STORE);
  const patch = body.patch && typeof body.patch === 'object' ? body.patch : {};

  const { tasks, rawDoc } = await readTasks(env);
  const t = tasks.find(x => x.id === id);
  if (!t) return json({ error: '没找到这个任务' }, 404, NO_STORE);

  const next = { ...t, updatedAt: nowIso() };
  if (patch.name !== undefined) { next.name = String(patch.name).trim().slice(0, 60) || t.name; next.subject = next.name; }
  if (patch.categoryId !== undefined) {
    const categories = await readCategories(env);
    if (!categories.some(c => c.id === patch.categoryId)) return json({ error: '没有这个分类' }, 400, NO_STORE);
    next.categoryId = patch.categoryId;
    const legacyOf = (DEFAULT_CATEGORIES.find(d => d.id === patch.categoryId) || {}).legacy;
    if (legacyOf) next.category = legacyOf;
  }
  if (patch.category !== undefined && !patch.categoryId && CATEGORIES.includes(patch.category)) {
    next.category = patch.category;
    const mapped = (DEFAULT_CATEGORIES.find(d => d.legacy === patch.category) || {}).id;
    if (mapped) next.categoryId = mapped;
  }
  if (patch.energy !== undefined && ENERGIES.includes(patch.energy)) next.energy = patch.energy;
  if (patch.firstStep !== undefined) next.firstStep = String(patch.firstStep).trim().slice(0, 200);
  if (patch.scratchpad !== undefined) next.scratchpad = String(patch.scratchpad || '').slice(0, 2000);
  if (patch.targetMinutes !== undefined) {
    next.targetMinutes = patch.targetMinutes ? clampMinutes(patch.targetMinutes, 15, 10080) : undefined;
    if (next.targetMinutes) next.cycle = 'total';
  }
  if (patch.status !== undefined) {
    if (!['active', 'suspended', 'archived'].includes(patch.status)) {
      return json({ error: 'status 必须是 active / suspended / archived' }, 400, NO_STORE);
    }
    next.status = patch.status;
    next.archived = patch.status === 'archived';   /* 双写兼容 v1 */
  }

  await writeDoc(env, 'agent_tasks', { tasks: rawDoc.tasks.map(x => (x.id === id ? next : x)) });
  return json({ ok: true, task: next }, 200, NO_STORE);
}

/* ---------- 每日目标 ---------- */
async function setQuota(env, body) {
  const base = clampMinutes(body.baseTargetMinutes, 15, 1440);
  if (!base) return json({ error: '目标时长必须是 15 ~ 1440 分钟' }, 400, NO_STORE);
  const { data } = await readDoc(env, 'agent_quota');
  const doc = data && typeof data === 'object' ? data : {};
  await writeDoc(env, 'agent_quota', { ...doc, baseTargetMinutes: base });
  return json({ ok: true, baseTargetMinutes: base }, 200, NO_STORE);
}

/* ---------- 删一条记错的账（记错时长就该能撤，不该让用户忍着） ---------- */
async function sessionDelete(env, body) {
  const id = String(body.sessionId || '');
  if (!id) return json({ error: '需要 sessionId 字段' }, 400, NO_STORE);
  const { data: study } = await readDoc(env, 'study');
  const sd = study && typeof study === 'object' ? study : {};
  sd.sessions = Array.isArray(sd.sessions) ? sd.sessions : [];
  const before = sd.sessions.length;
  sd.sessions = sd.sessions.filter(s => !(s && s.id === id));
  if (sd.sessions.length === before) return json({ error: '没找到这条记录' }, 404, NO_STORE);
  await writeDoc(env, 'study', sd);
  return json({ ok: true, deleted: id }, 200, NO_STORE);
}

/* ---------- AI 一键周评：代码硬算事实，LLM 只把话说成人话；没配 Key 就纯事实版 ---------- */
async function weekReview(env, body) {
  const from = String(body.from || '');
  const to = String(body.to || '');
  if (!isValidDate(from) || !isValidDate(to) || from > to) return json({ error: '区间不合法' }, 400, NO_STORE);

  const agg = await aggregateDays(env, from, to);
  const categories = agg.categories;
  const days = agg.days;
  const catName = (id) => (categories.find(c => c.id === id) || {}).name || id;

  /* 事实层：全部代码硬算，一个形容词都不造 */
  const totalMin = Object.values(days).reduce((a, d) => a + d.minutes, 0);
  const byCat = {};
  for (const d of Object.values(days)) {
    for (const [k, m] of Object.entries(d.byCat)) {
      if (k === 'total' || !m) continue;
      byCat[k] = (byCat[k] || 0) + m;
    }
  }
  const dayCount = Object.keys(days).length;
  const daysOfWeek = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  const dowOf = (date) => daysOfWeek[weekdayPy(date)];
  const topDay = Object.entries(days).sort((a, b) => b[1].minutes - a[1].minutes)[0];
  const topCat = Object.entries(byCat).sort((a, b) => b[1] - a[1])[0];
  const facts = {
    from, to,
    totalMinutes: totalMin,
    recordedDays: dayCount,
    spanDays: Math.round((Date.parse(to) - Date.parse(from)) / 86400000) + 1,
    byCategory: Object.entries(byCat).map(([k, m]) => ({ name: catName(k), minutes: m })),
    topDay: topDay ? { label: dowOf(topDay[0]), date: topDay[0], minutes: topDay[1].minutes } : null,
    entries: Object.entries(days)
      .flatMap(([date, d]) => d.sessions.map(s => ({ date, dow: dowOf(date), subject: s.subject, minutes: s.minutes, summary: s.summary })))
      .sort((a, b) => (Date.parse(a.date + 'T00:00:00') || 0) - (Date.parse(b.date + 'T00:00:00') || 0))
  };

  if (!totalMin) {
    return json({
      ok: true,
      review: '这一周还没有留下任何记录。空着的一周不是欠账，只是还没开始。',
      offline: true
    }, 200, NO_STORE);
  }

  if (await llmReadyAsync(env)) {
    try {
      const factLines = facts.entries
        .map(e => `· ${e.dow} ${e.subject} ${e.minutes}分钟${e.summary ? `（${e.summary}）` : ''}`).join('\n');
      const catLines = facts.byCategory.map(c => `${c.name} ${c.minutes}分钟`).join('，');
      const review = await llmChat(env, [
        { role: 'system', content: '你是理序的周回顾代笔。基于用户本周的真实投入数据写一段回顾。'
          + '要求：白话中文，120~200 字；只陈述事实与构成，不评判勤奋懒惰，不灌鸡汤，不用感叹号；'
          + '可以点出一个事实性观察（比如哪类占大头、哪几天空着）；结尾给一句基于数据的具体观察建议。' },
        { role: 'user', content: `区间 ${facts.from} ~ ${facts.to}（${facts.spanDays} 天，有记录 ${facts.recordedDays} 天）。
总投入 ${facts.totalMinutes} 分钟。分类构成：${catLines}。
单日最高：${facts.topDay ? facts.topDay.label + ' ' + facts.topDay.minutes + ' 分钟' : '无'}。
条目：
${factLines}` }
      ], { maxTokens: 500, temperature: 0.5 });
      if (review) return json({ ok: true, review, offline: false }, 200, NO_STORE);
    } catch { /* LLM 挂了落事实版 */ }
  }

  /* 离线事实版 */
  const pct = (m) => Math.round((m / totalMin) * 100);
  const catText = facts.byCategory.map(c => `${c.name} ${pct(c.minutes)}%`).join('，');
  const review = `本周共投入 ${facts.totalMinutes} 分钟，有记录 ${facts.recordedDays}/${facts.spanDays} 天。`
    + `构成：${catText}。`
    + (facts.topDay ? `单日最高是${facts.topDay.label}（${facts.topDay.minutes} 分钟）。` : '')
    + `把本周的构成当数据看就好，下周想往哪边挪一点，由你决定。`;
  return json({ ok: true, review, offline: true }, 200, NO_STORE);
}

/* ---------- 自定义分类 ---------- */
async function categoryCreate(env, body) {
  const name = String(body.name || '').trim().slice(0, 10);
  const color = String(body.color || '').trim().toUpperCase();
  if (!name) return json({ error: '类别名不能为空' }, 400, NO_STORE);
  if (!/^#[0-9A-Fa-f]{6}$/.test(color)) return json({ error: '颜色得是 #RRGGBB' }, 400, NO_STORE);

  const items = await readCategories(env);
  if (items.some(c => c.name === name)) return json({ error: '已经有这个名字的类别了' }, 400, NO_STORE);
  if (items.length >= 12) return json({ error: '类别够多了，先管好手里这几类' }, 400, NO_STORE);

  const cat = { id: 'cat_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 5), name, color };
  items.push(cat);
  await writeDoc(env, 'agent_categories', { items });
  return json({ ok: true, category: cat, categories: items }, 200, NO_STORE);
}

/* ---------- 分类改名 / 改色 ---------- */
async function categoryUpdate(env, body) {
  const id = String(body.id || '');
  if (!id) return json({ error: '需要 id 字段' }, 400, NO_STORE);
  const items = await readCategories(env);
  const cat = items.find(c => c.id === id);
  if (!cat) return json({ error: '没找到这个分类' }, 404, NO_STORE);

  if (body.name !== undefined) {
    const name = String(body.name || '').trim().slice(0, 10);
    if (!name) return json({ error: '类别名不能为空' }, 400, NO_STORE);
    if (items.some(c => c.id !== id && c.name === name)) return json({ error: '已经有这个名字的类别了' }, 400, NO_STORE);
    cat.name = name;
  }
  if (body.color !== undefined) {
    const color = String(body.color || '').trim().toUpperCase();
    if (!/^#[0-9A-Fa-f]{6}$/.test(color)) return json({ error: '颜色得是 #RRGGBB' }, 400, NO_STORE);
    cat.color = color;
  }
  await writeDoc(env, 'agent_categories', { items });
  return json({ ok: true, category: cat, categories: items }, 200, NO_STORE);
}

/* ---------- 删除分类：还有任务挂着时不许删（先挪走） ---------- */
async function categoryDelete(env, body) {
  const id = String(body.id || '');
  if (!id) return json({ error: '需要 id 字段' }, 400, NO_STORE);
  const items = await readCategories(env);
  if (!items.some(c => c.id === id)) return json({ error: '没找到这个分类' }, 404, NO_STORE);
  if (items.length <= 1) return json({ error: '至少要留一个分类' }, 400, NO_STORE);

  const { rawDoc } = await readTasks(env);
  const cat = items.find(c => c.id === id);
  const legacyOf = (DEFAULT_CATEGORIES.find(d => d.id === id) || {}).legacy;
  const usedBy = (rawDoc.tasks || []).filter(t => {
    if (t.categoryId) return t.categoryId === id;
    return legacyOf && t.category === legacyOf;
  });
  if (usedBy.length) {
    return json({ error: `还有 ${usedBy.length} 个任务在「${cat.name}」里，先在任务设置里挪走再删` }, 400, NO_STORE);
  }

  await writeDoc(env, 'agent_categories', { items: items.filter(c => c.id !== id) });
  return json({ ok: true, categories: items.filter(c => c.id !== id) }, 200, NO_STORE);
}

/* ---------- 补改一条留档：话 / 日期 / 时长 都可改（空话存即清空，不删记录） ---------- */
async function editCommit(env, body) {
  const id = String(body.sessionId || '');
  if (!id) return json({ error: '需要 sessionId 字段' }, 400, NO_STORE);

  const { data: study } = await readDoc(env, 'study');
  const sd = study && typeof study === 'object' ? study : {};
  sd.sessions = Array.isArray(sd.sessions) ? sd.sessions : [];
  const s = sd.sessions.find(x => x && x.id === id);
  if (!s) return json({ error: '没找到这条推进记录' }, 404, NO_STORE);

  if (body.summary !== undefined) {
    const summary = String(body.summary || '').trim().slice(0, 500);
    s.summary = summary;
    s.content = summary;   /* v1 统计与卡片口径都吃 content */
  }
  if (body.date !== undefined) {
    const date = String(body.date || '').trim();
    if (!isValidDate(date)) return json({ error: 'date 必须是 YYYY-MM-DD' }, 400, NO_STORE);
    if (date > shanghaiToday()) return json({ error: '不能改到未来的日期' }, 400, NO_STORE);
    s.date = date;
  }
  if (body.minutes !== undefined) {
    const minutes = Math.round(Number(body.minutes));
    if (!(minutes >= 1)) return json({ error: '时长必须是正数（分钟）' }, 400, NO_STORE);
    if (minutes > 1440) return json({ error: '单条不能超过 24 小时（1440 分钟）' }, 400, NO_STORE);
    s.duration = minutes;
  }
  await writeDoc(env, 'study', sd);
  return json({ ok: true, session: s }, 200, NO_STORE);
}

/* ---------- 拖拽排序：一批 order 一次落库 ----------
   注意：readTasks 返回的 tasks 是 normalize 后的副本，直接改副本再写 rawDoc
   等于什么都没写 —— 必须落在 rawDoc.tasks 的原始条目上。 */
async function taskReorder(env, body) {
  const updates = Array.isArray(body.updates) ? body.updates : [];
  if (!updates.length) return json({ error: '需要 updates 数组' }, 400, NO_STORE);

  const { rawDoc } = await readTasks(env);
  const now = nowIso();
  let touched = 0;
  for (const u of updates.slice(0, 60)) {
    const raw = (rawDoc.tasks || []).find(x => x.id === u.id);
    if (!raw) continue;
    const order = Number(u.order);
    if (Number.isFinite(order) && order >= 0) {
      raw.order = order;
      raw.updatedAt = now;
      touched++;
    }
  }
  if (!touched) return json({ error: '没有匹配到任何任务' }, 404, NO_STORE);
  await writeDoc(env, 'agent_tasks', { tasks: rawDoc.tasks });
  return json({ ok: true, touched }, 200, NO_STORE);
}
