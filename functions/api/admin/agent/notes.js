/**
 * /api/admin/agent/notes —— 便签（草稿池，可分组、可拖动排序）
 *
 *   GET     /api/admin/agent/notes          列表（items）+ 分组顺序（groups）
 *   POST    /api/admin/agent/notes          body: { content, group? }        钉一张
 *           body: { action: 'group_create', name }                           建分组
 *           body: { action: 'group_delete', name }                           删分组（便签回落未分组）
 *   PUT     /api/admin/agent/notes          body: { id, content?, group?, order? }  改字 / 换组 / 排序
 *   DELETE  /api/admin/agent/notes?id=xxx   撕掉
 *
 * doc key: agent_notes —— { items: [{ id, content, group, order, createdAt, updatedAt }], groups: ['未分组', ...] }
 * 「未分组」恒在、恒第一；分组只是把纸片分区，不做颜色不做置顶。
 * 「转为任务」走工作台的任务弹窗确认，确认后由前端回头撕掉原便签。
 *
 * 令牌：环境变量 ADMIN_TOKEN，Authorization: Bearer <令牌>
 */

import { json, dbMissing, requireAdmin } from '../../_shared.js';
import { readDoc, writeDoc, newId, nowIso } from '../../agent/_store.js';

const NO_STORE = { 'cache-control': 'no-store' };
const MAX_CONTENT = 500;
const MAX_NOTES = 200;
const MAX_GROUPS = 8;
const DEFAULT_GROUP = '未分组';

function cleanName(v) {
  /* 分组名会拼进 inline 事件属性，引号和尖括号一开始就禁掉 */
  return String(v || '').replace(/["'\\<>]/g, '').trim().slice(0, 12);
}

/** 读整包：items + groups（groups 缺失/为空时补默认） */
async function readAll(env) {
  const { data } = await readDoc(env, 'agent_notes');
  const doc = data && typeof data === 'object' ? data : {};
  const items = (Array.isArray(doc.items) ? doc.items : [])
    .filter(n => n && typeof n === 'object' && typeof n.content === 'string')
    .map(n => ({
      ...n,
      group: typeof n.group === 'string' ? n.group : DEFAULT_GROUP,
      order: Number.isFinite(n.order) ? n.order : null
    }));
  const groups = Array.isArray(doc.groups) && doc.groups.length
    ? doc.groups.map(cleanName).filter(Boolean)
    : [DEFAULT_GROUP];
  if (!groups.includes(DEFAULT_GROUP)) groups.unshift(DEFAULT_GROUP);
  return { items, groups };
}

async function writeAll(env, items, groups) {
  await writeDoc(env, 'agent_notes', { items: items.slice(0, MAX_NOTES), groups: groups.slice(0, MAX_GROUPS) });
}

/* ---------------- GET ---------------- */
export async function onRequestGet({ env, request }) {
  if (!env.DB) return dbMissing();
  const rejected = requireAdmin(request, env);
  if (rejected) return rejected;

  const { items, groups } = await readAll(env);
  items.sort((a, b) =>
    (Number.isFinite(a.order) ? a.order : 1e9) - (Number.isFinite(b.order) ? b.order : 1e9)
    || (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0));
  return json({ ok: true, items, groups }, 200, NO_STORE);
}

/* ---------------- POST：钉一张 / 分组管理 ---------------- */
export async function onRequestPost({ env, request }) {
  if (!env.DB) return dbMissing();
  const rejected = requireAdmin(request, env);
  if (rejected) return rejected;

  let body;
  try { body = await request.json(); } catch { return json({ error: '请求体不是合法的 JSON' }, 400, NO_STORE); }
  const { items, groups } = await readAll(env);

  if (body && body.action === 'group_create') {
    const name = cleanName(body.name);
    if (!name) return json({ error: '分组名不能为空' }, 400, NO_STORE);
    if (groups.includes(name)) return json({ error: '已经有这个分组了' }, 400, NO_STORE);
    if (groups.length >= MAX_GROUPS) return json({ error: '分组够多了，先管好手里这几摞' }, 400, NO_STORE);
    groups.push(name);
    await writeAll(env, items, groups);
    return json({ ok: true, groups }, 200, NO_STORE);
  }

  if (body && body.action === 'group_delete') {
    const name = cleanName(body.name);
    if (name === DEFAULT_GROUP) return json({ error: '未分组删不掉' }, 400, NO_STORE);
    if (!groups.includes(name)) return json({ error: '没找到这个分组' }, 404, NO_STORE);
    for (const n of items) if (n.group === name) { n.group = DEFAULT_GROUP; n.updatedAt = nowIso(); }
    await writeAll(env, items, groups.filter(g => g !== name));
    return json({ ok: true, groups: groups.filter(g => g !== name) }, 200, NO_STORE);
  }

  const content = String((body && body.content) || '').trim().slice(0, MAX_CONTENT);
  if (!content) return json({ error: '便签不能是空的' }, 400, NO_STORE);
  const group = cleanName(body.group);
  if (group && !groups.includes(group)) return json({ error: '没有这个分组' }, 400, NO_STORE);

  const note = {
    id: newId(), content,
    group: group || DEFAULT_GROUP,
    order: null,
    createdAt: nowIso(), updatedAt: nowIso()
  };
  items.push(note);
  await writeAll(env, items, groups);
  return json({ ok: true, note }, 200, NO_STORE);
}

/* ---------------- PUT：改字 / 换组 / 排序 ---------------- */
export async function onRequestPut({ env, request }) {
  if (!env.DB) return dbMissing();
  const rejected = requireAdmin(request, env);
  if (rejected) return rejected;

  let body;
  try { body = await request.json(); } catch { return json({ error: '请求体不是合法的 JSON' }, 400, NO_STORE); }
  const id = String((body && body.id) || '');
  if (!id) return json({ error: '需要 id 字段' }, 400, NO_STORE);

  const { items, groups } = await readAll(env);
  const note = items.find(n => n.id === id);
  if (!note) return json({ error: '没找到这张便签' }, 404, NO_STORE);

  if (body.content !== undefined) {
    const content = String(body.content || '').trim().slice(0, MAX_CONTENT);
    if (!content) return json({ error: '便签内容不能是空的（要清掉请直接撕）' }, 400, NO_STORE);
    note.content = content;
  }
  if (body.group !== undefined) {
    const group = cleanName(body.group) || DEFAULT_GROUP;
    if (!groups.includes(group)) return json({ error: '没有这个分组' }, 400, NO_STORE);
    note.group = group;
  }
  if (body.order !== undefined) {
    const order = Number(body.order);
    if (Number.isFinite(order) && order >= 0) note.order = order;
  }
  note.updatedAt = nowIso();
  await writeAll(env, items, groups);
  return json({ ok: true, note }, 200, NO_STORE);
}

/* ---------------- DELETE：撕掉 ---------------- */
export async function onRequestDelete({ env, request }) {
  if (!env.DB) return dbMissing();
  const rejected = requireAdmin(request, env);
  if (rejected) return rejected;

  const id = new URL(request.url).searchParams.get('id') || '';
  if (!id) return json({ error: '需要 id 参数' }, 400, NO_STORE);

  const { items, groups } = await readAll(env);
  const next = items.filter(n => n.id !== id);
  if (next.length === items.length) return json({ error: '没找到这张便签（可能已撕）' }, 404, NO_STORE);
  await writeAll(env, next, groups);
  return json({ ok: true, deleted: id }, 200, NO_STORE);
}
