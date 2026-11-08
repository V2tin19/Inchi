/**
 * _test-agent.mjs —— 助手大脑的离线断言测试（直驱 handler + 假 D1，不进 git）
 *
 * 跑法：node .workbuddy/_test-agent.mjs
 * 不需要 LLM key：只测正则快车道 + 卡片确认 + 撤销 + 打卡 + 查询；
 * LLM 兜底路径单独验「未配 key 时优雅报错」。
 * ⚠️ 每次跑都是全新的内存库，无状态。
 */

import assert from 'node:assert';
import { handleAgentMessage, confirmCard, cancelCard } from '../functions/api/agent/_agent.js';

/* ---------- 假 D1：只实现 brain 用到的那几条 SQL ---------- */
function fakeEnv() {
  const store = new Map();   /* key -> { payload, updated_at } */
  const env = {
    ADMIN_TOKEN: 'test-token',
    __store: store,
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async first() {
                if (/SELECT (payload, updated_at|payload) FROM doc WHERE key = \?/.test(sql)) {
                  const row = store.get(args[0]);
                  return row ? { payload: row.payload, updated_at: row.updated_at } : null;
                }
                return null;
              },
              async run() {
                if (/INSERT (OR REPLACE )?INTO doc/.test(sql)) {
                  const [key, payload, updatedAt] = args;
                  store.set(key, { payload, updated_at: updatedAt });
                  return;
                }
                if (/CREATE TABLE/.test(sql)) return;
                if (/UPDATE doc SET payload = \?, updated_at = \? WHERE key = \?/.test(sql)) {
                  const [payload, updatedAt, key] = args;
                  store.set(key, { payload, updated_at: updatedAt });
                  return;
                }
                throw new Error('fake DB: 未实现的 SQL: ' + sql);
              }
            };
          }
        };
      }
    }
  };
  return env;
}

const FAILS = [];
function check(name, cond, detail = '') {
  if (cond) console.log(`  ok  ${name}`);
  else { FAILS.push(name); console.log(`FAIL  ${name}  ${detail}`); }
}

const env = fakeEnv();
const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);

/* ---------- 1. 帮助 ---------- */
let r = await handleAgentMessage(env, '帮助');
check('帮助', r.reply.includes('记学习') && r.reply.includes('查安排'), r.reply);

/* ---------- 2. 快车道录入 → 卡片（不落库） ---------- */
r = await handleAgentMessage(env, '今天下午学了2小时数据结构，刷了王道课后题');
check('录入出卡片', r.reply.includes('确认后就写进台账') && r.cards.length === 1
  && r.cards[0].type === 'log_confirm', JSON.stringify(r));
const card = r.cards[0];
check('卡片内容', card.payload.sessions.length === 1
  && card.payload.sessions[0].subject === '数据结构'
  && card.payload.sessions[0].minutes === 120
  && card.payload.sessions[0].date === today, JSON.stringify(card.payload));
check('没确认前不落库', !(env.__store.get('study')));

/* 过期/重复确认 */
let r2 = await confirmCard(env, 'c_not_exist');
check('过期卡片提示', r2.reply.includes('过期'), r2.reply);

/* ---------- 3. 确认 → 落库 + 撤销栈 ---------- */
r2 = await confirmCard(env, card.id);
check('确认落库', r2.reply.includes('✅ 今天 · 数据结构 · 2小时'), r2.reply);
let study = JSON.parse(env.__store.get('study').payload);
check('session 同构', study.sessions.length === 1
  && study.sessions[0].source === 'agent'
  && study.sessions[0].duration === 120
  && study.sessions[0].date === today, JSON.stringify(study.sessions));
check('撤销栈有一条', JSON.parse(env.__store.get('agent_undo').payload).length === 1);

/* ---------- 4. 撤销 ---------- */
r = await handleAgentMessage(env, '撤销刚才那条');
check('撤销成功', r.reply.includes('↩️ 已撤销'), r.reply);
study = JSON.parse(env.__store.get('study').payload);
check('撤销后台账为空', study.sessions.length === 0, JSON.stringify(study.sessions));
r = await handleAgentMessage(env, '撤销');
check('空栈提示', r.reply.includes('没有可撤销'), r.reply);

/* ---------- 5. 取消卡片 ---------- */
const yst = new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1, +today.slice(8, 10)) - 86400000).toISOString().slice(0, 10);
r = await handleAgentMessage(env, '昨天晚上背了1小时单词');
check('昨天+单词出卡片', r.cards[0] && r.cards[0].payload.sessions[0].subject === '英语'
  && r.cards[0].payload.sessions[0].date === yst, JSON.stringify(r.cards[0]?.payload));
r = await cancelCard(env, r.cards[0].id);
check('取消卡片', r.reply.includes('没记'), r.reply);

/* ---------- 6. 打卡 ---------- */
r = await handleAgentMessage(env, '打卡');
check('打卡', r.reply.includes('已打卡') && r.reply.includes('连续 1 天'), r.reply);
study = JSON.parse(env.__store.get('study').payload);
check('打卡入库', study.checkin[today] === true);

/* ---------- 7. 考试日期 ---------- */
r = await handleAgentMessage(env, '考试日期 2026-12-26');
check('设考试日期', r.reply.includes('考试日期已设为 2026-12-26'), r.reply);
r = await handleAgentMessage(env, '今天安排');
check('查安排带倒计时', r.reply.includes('距离初试') && r.reply.includes('（这天还没有安排）'), r.reply);
r = await handleAgentMessage(env, '考试倒计时');
check('查倒计时', r.reply.includes('距离初试'), r.reply);

/* ---------- 8. 统计 ---------- */
r = await handleAgentMessage(env, '今天学了多久');
check('今日统计', r.reply.includes('今天学了 0分钟') && r.reply.includes('已打卡 ✅'), r.reply);

/* ---------- 9. 未实现的意图与 LLM 降级 ---------- */
r = await handleAgentMessage(env, '本周总结一下');
check('周报数据版', r.reply.includes('最近 7 天'), r.reply);

/* ---------- 10. 排期：「明天学数学两小时」自动应用 + 撤销 ---------- */
const tmr = new Date(Date.UTC(+today.slice(0, 4), +today.slice(5, 7) - 1, +today.slice(8, 10)) + 86400000).toISOString().slice(0, 10);
r = await handleAgentMessage(env, '明天学数学两小时');
check('排期自动应用', r.reply.includes('排好时间块') && r.reply.includes('数学（1小时30分钟）') && r.reply.includes('数学（30分钟）'), r.reply);
let plan = JSON.parse(env.__store.get('kaoyan').payload);
const tmrSlots = plan.days[tmr].slots;
check('时间块写入 kaoyan plan', tmrSlots.length === 2
  && tmrSlots[0].subject === '数学' && tmrSlots[1].subject === '数学', JSON.stringify(tmrSlots));
const undoTop = JSON.parse(env.__store.get('agent_undo').payload).slice(-1)[0];
check('排期快照入撤销栈', undoTop.kind === 'plan_day' && undoTop.undo.hadDay === false, JSON.stringify(undoTop));

r = await handleAgentMessage(env, '撤销');
check('撤销排期', r.reply.includes('已撤销'), r.reply);
plan = JSON.parse(env.__store.get('kaoyan').payload);
check('撤销后 days 里这天被删掉', !plan.days || !plan.days[tmr], JSON.stringify(plan.days));

/* 排期再排一次 + 重复撤销（hadDay=true 分支） */
r = await handleAgentMessage(env, '明天学英语一小时');
check('再排一次', r.reply.includes('排好时间块'), r.reply);
r = await handleAgentMessage(env, '明天学数学一小时');
check('继续追加不覆盖', JSON.parse(env.__store.get('kaoyan').payload).days[tmr].slots.length === 2,
  JSON.stringify(JSON.parse(env.__store.get('kaoyan').payload).days));
r = await handleAgentMessage(env, '撤销');
check('撤销第二次排期，保留第一次', JSON.parse(env.__store.get('kaoyan').payload).days[tmr].slots.length === 1, r.reply);
r = await handleAgentMessage(env, '撤销');
check('撤销第一次排期', !JSON.parse(env.__store.get('kaoyan').payload).days[tmr], r.reply);

/* 学了（过去式）不能被排期劫持 */
r = await handleAgentMessage(env, '今天学了英语一小时');
check('过去式仍是记录', r.reply.includes('确认后就写进台账'), r.reply);
await cancelCard(env, r.cards[0].id);

/* ---------- 11. 弹性任务：「每天背半小时单词」卡片 → 确立 ---------- */
r = await handleAgentMessage(env, '每天背半小时单词');
check('任务卡片', r.cards.length === 1 && r.cards[0].type === 'task_confirm'
  && r.cards[0].payload.task.subject === '英语'
  && r.cards[0].payload.task.targetMinutes === 30
  && r.cards[0].payload.task.cycle === 'daily', JSON.stringify(r.cards[0]));
const taskCard = r.cards[0];
r2 = await confirmCard(env, taskCard.id);
check('任务确立', r2.reply.includes('任务已立'), r2.reply);
const tasksDoc = JSON.parse(env.__store.get('agent_tasks').payload);
check('任务入库', tasksDoc.tasks.length === 1 && tasksDoc.tasks[0].name.includes('背'), JSON.stringify(tasksDoc));
r = await handleAgentMessage(env, '撤销');
check('撤销建任务', JSON.parse(env.__store.get('agent_tasks').payload).tasks.length === 0, r.reply);

/* ---------- 12. 量化日志：「写日志：xxx」→ 卡片 → 确认 → metrics ---------- */
r = await handleAgentMessage(env, '写日志');
check('裸写日志要原话', r.reply.includes('一句话'), r.reply);

r = await handleAgentMessage(env, '写日志：数学刷题有点卡壳，状态一般，背完了list 6');
check('日志出卡片', r.cards.length === 1 && r.cards[0].type === 'daylog_confirm'
  && r.cards[0].payload.raw.includes('卡壳'), JSON.stringify(r.cards[0]));
r2 = await confirmCard(env, r.cards[0].id);
check('日志写好', r2.reply.includes('日志已写好'), r2.reply);
const logsDoc = JSON.parse(env.__store.get('agent_logs').payload);
const dayLog = logsDoc.logs[today];
check('日志结构', dayLog && typeof dayLog.raw === 'string' && typeof dayLog.ai === 'string'
  && dayLog.metrics, JSON.stringify(dayLog).slice(0, 200));
check('metrics 量化', dayLog.metrics.actualMin === 0
  && dayLog.metrics.mood === '一般'
  && dayLog.metrics.streak === 0, JSON.stringify(dayLog.metrics));
check('模板兜底引用原话', dayLog.ai.includes('原话') && dayLog.ai.includes('连续'), dayLog.ai);

r = await handleAgentMessage(env, '撤销');
check('撤销日志', !JSON.parse(env.__store.get('agent_logs').payload).logs[today], r.reply);

/* 状态感受类消息 → 转日志卡片（晚间催日志主路径） */
r = await handleAgentMessage(env, '今天数学卡壳了，有点累');
check('感受转日志卡', r.cards.length === 1 && r.cards[0].type === 'daylog_confirm', r.reply);
await cancelCard(env, r.cards[0].id);

/* ---------- 13. 主动通知：cron 生成 → outbox → 标记 ---------- */
import { onRequestPost as cronPost } from '../functions/api/admin/agent/cron/[kind].js';
import { listItems, unreadCount } from '../functions/api/agent/_outbox.js';

async function cron(kind, query = '') {
  const request = new Request(`http://x/api/admin/agent/cron/${kind}${query}`, {
    method: 'POST', headers: { authorization: 'Bearer test-token' }
  });
  const resp = await cronPost({ env, request, params: { kind } });
  return JSON.parse(await resp.text());
}

/* 空计划时晨报不产生内容 */
let c = await cron('brief', '?dry=1');
check('无计划晨报为空', c.ok && c.queued === false, JSON.stringify(c));

/* 排上今天的计划再试。
   这里直接把今天的时段写进 kaoyan 计划，不走「今天学数学两小时」——
   确定性排期器会按当前时刻避让（深夜已过睡觉点就排不进今天），直接写库
   让这组 cron 文案断言与运行时刻解耦，白天深夜都能跑。 */
const seedPlan = env.__store.has('kaoyan') ? JSON.parse(env.__store.get('kaoyan').payload) : {};
seedPlan.days = seedPlan.days || {};
seedPlan.days[today] = {
  slots: [{ start: '09:00', end: '10:30', subject: '数学', status: 'todo', topic: '测试时段' }]
};
env.__store.set('kaoyan', { payload: JSON.stringify(seedPlan), updated_at: new Date().toISOString() });

c = await cron('brief', '?dry=1');
check('晨报文案', c.ok && c.text.includes('今天的安排') && c.text.includes('数学'), JSON.stringify(c).slice(0, 200));

c = await cron('evening', '?dry=1');
check('晚间催日志文案', c.ok && c.text.includes('今天已学') && c.text.includes('写进日志'), JSON.stringify(c).slice(0, 200));

c = await cron('midday', '?dry=1');
check('午间文案', c.ok && c.text.includes('中午好'), JSON.stringify(c).slice(0, 200));

/* 真触发 → 入队 → pusher 视角拉取 → 标 sent */
c = await cron('brief');
check('晨报入队', c.ok && c.queued === true, JSON.stringify(c).slice(0, 120));
const items = await listItems(env, { unsent: true, channel: null });
check('pusher 拉到未发送', items.length === 1 && ['qq', 'all'].includes(items[0].channel), JSON.stringify(items).slice(0, 120));
const { markItems } = await import('../functions/api/agent/_outbox.js');
await markItems(env, [items[0].id], { sent: true });
check('标 sent 后拉不到', (await listItems(env, { unsent: true })).length === 0);

/* learn：习惯聚合 */
c = await cron('learn');
check('习惯聚合', c.ok && typeof c.summary === 'string' && c.summary.includes('近14天'), JSON.stringify(c).slice(0, 200));
const profDoc = JSON.parse(env.__store.get('agent_profile').payload);
check('画像入库', profDoc.habits && typeof profDoc.habits.avgDailyMinutes === 'number', JSON.stringify(profDoc.habits).slice(0, 150));

/* ============================================================
   14. v2 状态路由内核（_router.js）+ 工作台端点（workbench.js）
   ============================================================ */
{
  const {
    normalizeTask, dealTasks, dealWithFallback, fallbackState, computeRecovery, spectrumOf
  } = await import('../functions/api/agent/_router.js');
  const { onRequestGet, onRequestPost } = await import('../functions/api/admin/agent/workbench.js');
  const { addDays, weekdayPy } = await import('../functions/api/agent/_nlu.js');

  /* --- 老数据缺省补齐：零迁移可用 --- */
  const legacy = normalizeTask({ id: 't1', name: '旧任务', archived: true });
  check('老数据 archived → 封存，三属性补齐',
    legacy.status === 'archived' && legacy.archived === true
    && legacy.category === 'CORE' && legacy.energy === 'NORMAL' && legacy.firstStep === '',
    JSON.stringify(legacy));
  const fresh = normalizeTask({ id: 't2', name: '新任务', category: 'EXPLORE', energy: 'LOW', firstStep: '打开编辑器', status: 'suspended' });
  check('新字段原样保留', fresh.category === 'EXPLORE' && fresh.energy === 'LOW'
    && fresh.status === 'suspended' && fresh.archived === false, JSON.stringify(fresh));

  /* --- 发牌：只发进行中、断点新者优先、降档只降不升 --- */
  const pool = [
    { id: 'a', name: '高燃A', energy: 'HIGH', status: 'active', lastCommitAt: '2026-11-06T10:00:00Z' },
    { id: 'b', name: '高燃B', energy: 'HIGH', status: 'active', lastCommitAt: '2026-11-07T02:00:00Z' },
    { id: 'c', name: '搁置的', energy: 'HIGH', status: 'suspended' },
    { id: 'd', name: '平稳的', energy: 'NORMAL', status: 'active' }
  ];
  const dealt = dealTasks(pool, 'HIGH');
  check('发牌只出进行中且断点新者先', dealt.length === 2 && dealt[0].id === 'b' && dealt[1].id === 'a', JSON.stringify(dealt));
  check('降档顺位只降不升', fallbackState('HIGH') === 'NORMAL' && fallbackState('LOW') === null);
  const fb = dealWithFallback(pool, 'NORMAL');
  check('本组空则顺位降档', fb.dealtFrom === 'NORMAL' && fb.tasks[0].id === 'd', JSON.stringify(fb));
  const none = dealWithFallback([{ id: 'x', energy: 'LOW', status: 'archived' }], 'LOW');
  check('全空不发牌', none.tasks.length === 0 && none.dealtFrom === null, JSON.stringify(none));

  /* --- 低谷缓冲：48 小时线 + 当日固定 + 首次不触发 --- */
  const now = Date.parse('2026-11-07T10:00:00Z');
  const r1 = computeRecovery({ lastSeenMs: now - 49 * 3600 * 1000, nowMs: now, baseMinutes: 240, todayStr: '2026-11-07', datesMap: {} });
  check('停机超 48h → 目标 30%', r1.isRecovery === true && r1.effectiveTargetMinutes === 72, JSON.stringify(r1));
  const r2q = computeRecovery({ lastSeenMs: now - 2 * 3600 * 1000, nowMs: now, baseMinutes: 240, todayStr: '2026-11-07', datesMap: {} });
  check('正常活跃不触发', r2q.isRecovery === false && r2q.effectiveTargetMinutes === 240, JSON.stringify(r2q));
  const r3 = computeRecovery({ lastSeenMs: now - 100 * 3600 * 1000, nowMs: now, baseMinutes: 240, todayStr: '2026-11-07', datesMap: { '2026-11-07': { effectiveTargetMinutes: 240, isRecovery: false } } });
  check('当日已固定不再漂移', r3.effectiveTargetMinutes === 240 && r3.isRecovery === false, JSON.stringify(r3));
  const r4 = computeRecovery({ lastSeenMs: null, nowMs: now, baseMinutes: 240, todayStr: '2026-11-07', datesMap: {} });
  check('首次使用不触发缓冲', r4.isRecovery === false, JSON.stringify(r4));

  /* --- 光谱归账：task_id → 科目名 → 兜底核心 --- */
  const sp = spectrumOf(
    [{ duration: 60, task_id: 'k1' }, { duration: 30, subject: '英语' }, { duration: 10, subject: '未知科目' }],
    [{ id: 'k1', name: '探索', category: 'EXPLORE', subject: '英语' }]
  );
  check('光谱三分归账', sp.EXPLORE === 90 && sp.CORE === 10 && sp.total === 100, JSON.stringify(sp));

  /* --- 工作台端点：假请求直驱 --- */
  const req = (body) => new Request('http://localhost/api/admin/agent/workbench',
    body
      ? { method: 'POST', headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' }, body: JSON.stringify(body) }
      : { headers: { authorization: 'Bearer test-token' } });
  const post = async (b) => JSON.parse(await (await onRequestPost({ env, request: req(b) })).text());

  let wresp = await onRequestGet({ env, request: req() });
  const bundle = await wresp.json();
  check('bundle 可读', wresp.status === 200 && bundle.ok && bundle.quota.effective >= 15
    && Array.isArray(bundle.tasks) && Array.isArray(bundle.categories) && bundle.categories.length === 3,
    JSON.stringify(bundle).slice(0, 200));

  /* 自定义分类：建一个带颜色的类别，任务落进去 */
  const newCat = await post({ action: 'category_create', name: '考研', color: '#B48EAD' });
  check('自定义分类', newCat.ok && newCat.category.color === '#B48EAD'
    && newCat.categories.length === 4, JSON.stringify(newCat));
  const dupCat = await post({ action: 'category_create', name: '考研', color: '#81A1C1' });
  check('重名分类拒绝', dupCat.error && dupCat.error.includes('名字'), JSON.stringify(dupCat));

  const cr = await post({ action: 'task_create', name: '整理实验数据', category: 'CORE', energy: 'NORMAL', firstStep: '打开表格，把前三列异常数据标黄' });
  check('建任务带三属性', cr.ok && cr.task.categoryId === 'cat_core' && cr.task.energy === 'NORMAL'
    && cr.task.firstStep.includes('标黄'), JSON.stringify(cr));

  check('拨档位', (await post({ action: 'set_state', state: 'NORMAL' })).ok === true);
  const b2 = await (await onRequestGet({ env, request: req() })).json();
  check('拨档后发牌命中', b2.state === 'NORMAL' && b2.hint && b2.hint.taskId === cr.task.id && b2.hint.demoted === false,
    JSON.stringify(b2.hint));

  const stop = await post({ action: 'session_stop', taskId: cr.task.id, minutes: 45, summary: '标完了异常值', nextStep: '写个脚本过滤那两行' });
  check('计时入账带档位', stop.ok && stop.session.duration === 45 && stop.session.stateAtTime === 'NORMAL'
    && stop.session.source === 'workbench', JSON.stringify(stop.session));
  check('接力点覆写第一步', stop.task.firstStep === '写个脚本过滤那两行', JSON.stringify(stop.task));
  const studyDoc = JSON.parse(env.__store.get('study').payload);
  check('台账落库可撤', studyDoc.sessions.some(s => s.id === stop.session.id && s.task_id === cr.task.id),
    JSON.stringify(studyDoc.sessions));
  check('结算光谱入账', stop.spectrum.total === 45, JSON.stringify(stop.spectrum));

  /* 最近推进轨迹（聚光灯的 Git log） */
  const commitsResp = await onRequestGet({
    env,
    request: new Request('http://localhost/api/admin/agent/workbench?commits=' + encodeURIComponent(cr.task.id) + '&limit=5',
      { headers: { authorization: 'Bearer test-token' } })
  });
  const commitsData = await commitsResp.json();
  check('最近推进可查', commitsData.ok && commitsData.commits.length === 1
    && commitsData.commits[0].minutes === 45
    && commitsData.commits[0].summary === '标完了异常值'
    && commitsData.commits[0].stateAtTime === 'NORMAL', JSON.stringify(commitsData));
  const ghost = await (await onRequestGet({
    env,
    request: new Request('http://localhost/api/admin/agent/workbench?commits=no-such-task', { headers: { authorization: 'Bearer test-token' } })
  })).json();
  check('未知任务轨迹为空不报错', ghost.ok && ghost.commits.length === 0, JSON.stringify(ghost));

  /* 补改留档：summary/content 双写，空串即清空 */
  const edited = await post({ action: 'edit_commit', sessionId: stop.session.id, summary: '补记：其实卡了两次' });
  check('补改留档生效', edited.ok && edited.session.summary === '补记：其实卡了两次' && edited.session.content === '补记：其实卡了两次', JSON.stringify(edited));
  const commitsAfterEdit = await (await onRequestGet({
    env,
    request: new Request('http://localhost/api/admin/agent/workbench?commits=' + encodeURIComponent(cr.task.id), { headers: { authorization: 'Bearer test-token' } })
  })).json();
  check('轨迹读到补改后的话', commitsAfterEdit.commits[0].summary === '补记：其实卡了两次', JSON.stringify(commitsAfterEdit));
  const cleared = await post({ action: 'edit_commit', sessionId: stop.session.id, summary: '' });
  check('留空即清空', cleared.ok && cleared.session.summary === '', JSON.stringify(cleared));

  /* 补改日期与时长（断点可修；日期运算走本地时区函数） */
  const yesterday = addDays(today, -1);
  const fixed = await post({ action: 'edit_commit', sessionId: stop.session.id, date: yesterday, minutes: 90 });
  check('补改日期与时长', fixed.ok && fixed.session.date === yesterday && fixed.session.duration === 90, JSON.stringify(fixed));
  const badDate = await post({ action: 'edit_commit', sessionId: stop.session.id, date: '2026-13-99' });
  check('坏日期拒绝', badDate.error && badDate.error.includes('date'), JSON.stringify(badDate));

  /* 拖拽排序：一批 order 落库，发牌尊重手动顺序（order 必须真的持久化） */
  const re = await post({ action: 'task_reorder', updates: [{ id: cr.task.id, order: 1 }] });
  check('排序落库', re.ok === true && re.touched === 1, JSON.stringify(re).slice(0, 120));
  const bundleAfterRe = await (await onRequestGet({ env, request: req() })).json();
  const reorderedTask = bundleAfterRe.tasks.find(t => t.id === cr.task.id);
  check('order 真的持久化了', reorderedTask && reorderedTask.order === 1, JSON.stringify(reorderedTask));
  check('发牌尊重 order', bundleAfterRe.hint && bundleAfterRe.hint.taskId === cr.task.id, JSON.stringify(bundleAfterRe.hint));

  /* 记账快照分类：入账时的 categoryId 存进条目，改分类不改历史；
     老任务（legacy 枚举）的快照也要解析成种子 id */
  check('会记快照分类', stop.session.categoryId === 'cat_core', JSON.stringify(stop.session));
  const spectrumSnap = spectrumOf(
    [{ duration: 30, task_id: 'k1', categoryId: 'cat_x' }],
    [{ id: 'k1', name: '某任务', category: 'EXPLORE' }]
  );
  check('快照优先于任务现分类', spectrumSnap.cat_x === 30 && !spectrumSnap.EXPLORE, JSON.stringify(spectrumSnap));

  /* 随手记备忘栏：task 补 scratchpad 字段 */
  const scratch = await post({ action: 'task_update', id: cr.task.id, patch: { scratchpad: 'P42 起看，附 arXiv 链接' } });
  check('备忘栏落库', scratch.ok && scratch.task.scratchpad.includes('arXiv'), JSON.stringify(scratch));

  /* 记账边界：0 分钟拒绝而不是钳成 1 */
  const zeroMin = await post({ action: 'session_stop', taskId: cr.task.id, minutes: 0 });
  check('零分钟拒绝', zeroMin.error && zeroMin.error.includes('正数'), JSON.stringify(zeroMin));

  check('搁置不等于封存', (await post({ action: 'task_update', id: cr.task.id, patch: { status: 'suspended' } })).task.status === 'suspended');
  const archivedT = (await post({ action: 'task_update', id: cr.task.id, patch: { status: 'archived' } })).task;
  check('封存双写 archived', archivedT.status === 'archived' && archivedT.archived === true, JSON.stringify(archivedT));
  const eStop = await post({ action: 'session_stop', taskId: cr.task.id, minutes: 10 });
  check('已封存不可计时', eStop.error && eStop.error.includes('封存'), JSON.stringify(eStop));

  check('非法档位拒绝', (await post({ action: 'set_state', state: 'ULTRA' })).error.includes('档位'));
  const q = await post({ action: 'set_quota', baseTargetMinutes: 360 });
  check('设每日目标', q.ok && q.baseTargetMinutes === 360, JSON.stringify(q));

  /* --- 便签 CRUD --- */
  const { onRequestGet: notesGet, onRequestPost: notesPost, onRequestPut: notesPut, onRequestDelete: notesDelete } =
    await import('../functions/api/admin/agent/notes.js');
  const noteReq = (method, body, query = '') => new Request('http://localhost/api/admin/agent/notes' + query, {
    method, headers: { authorization: 'Bearer test-token', 'content-type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const noteJson = async (r) => JSON.parse(await r.text());

  const created = await noteJson(await notesPost({ env, request: noteReq('POST', { content: '顺手记一句：路由有点意思' }) }));
  check('钉便签', created.ok && created.note.content.includes('路由'), JSON.stringify(created));
  check('空便签拒绝', (await noteJson(await notesPost({ env, request: noteReq('POST', { content: '  ' }) }))).error.includes('空'));
  const editedNote = await noteJson(await notesPut({ env, request: noteReq('PUT', { id: created.note.id, content: '改完的一句话' }) }));
  check('改便签', editedNote.ok && editedNote.note.content === '改完的一句话', JSON.stringify(editedNote));
  const listed = await noteJson(await notesGet({ env, request: noteReq('GET') }));
  check('便签列表', listed.ok && listed.items.length === 1 && listed.items[0].content === '改完的一句话', JSON.stringify(listed));
  check('撕便签', (await noteJson(await notesDelete({ env, request: noteReq('DELETE', null, '?id=' + created.note.id) }))).ok === true);
  check('再撕报没找到', (await noteJson(await notesDelete({ env, request: noteReq('DELETE', null, '?id=' + created.note.id) }))).error.includes('没找到'));

  /* 便签分组：建组 → 钉进去 → 换组 → 删组回落 */
  await noteJson(await notesPost({ env, request: noteReq('POST', { action: 'group_create', name: '项目灵感' }) }));
  const grouped = await noteJson(await notesPost({ env, request: noteReq('POST', { content: '分组里的一张', group: '项目灵感' }) }));
  check('钉进指定分组', grouped.ok && grouped.note.group === '项目灵感', JSON.stringify(grouped));
  const moved = await noteJson(await notesPut({ env, request: noteReq('PUT', { id: grouped.note.id, group: '未分组', order: 5 }) }));
  check('拖拽换组与排序', moved.ok && moved.note.group === '未分组' && moved.note.order === 5, JSON.stringify(moved));
  await noteJson(await notesPost({ env, request: noteReq('POST', { action: 'group_delete', name: '项目灵感' }) }));
  const afterGDel = await noteJson(await notesGet({ env, request: noteReq('GET') }));
  check('删组后纸回落未分组', afterGDel.groups.includes('项目灵感') === false
    && afterGDel.items.every(n => n.group !== '项目灵感'), JSON.stringify(afterGDel).slice(0, 160));

  /* --- 日历回顾聚合：月（?month=）与区间（?from=&to=，周视图跨月用） ---
     注意：上面补改把那条记录挪到了昨天，这里跟着断言 yesterday（前面已声明） */
  const monthNow = today.slice(0, 7);
  const calResp = await onRequestGet({
    env,
    request: new Request('http://localhost/api/admin/agent/workbench?month=' + monthNow, { headers: { authorization: 'Bearer test-token' } })
  });
  const cal = await calResp.json();
  check('月度聚合有被补改到昨天的那条', cal.ok && cal.from.endsWith('-01') && cal.days[yesterday]
    && cal.days[yesterday].minutes === 90, JSON.stringify(cal).slice(0, 200));
  check('按天分类构成（键为分类 id）', cal.days[yesterday].byCat.cat_core === 90
    && cal.days[yesterday].sessions.length === 1, JSON.stringify(cal.days[yesterday]));

  /* 区间查询：只包住今天的一周 */
  const monday = addDays(today, -weekdayPy(today));
  const sunday = addDays(monday, 6);
  const weekResp = await onRequestGet({
    env,
    request: new Request(`http://localhost/api/admin/agent/workbench?from=${monday}&to=${sunday}`, { headers: { authorization: 'Bearer test-token' } })
  });
  const week = await weekResp.json();
  check('周区间聚合命中昨天', week.ok && week.from === monday && week.to === sunday
    && week.days[yesterday] && week.days[yesterday].minutes === 90, JSON.stringify(week).slice(0, 200));

  const calBad = await (await onRequestGet({
    env,
    request: new Request('http://localhost/api/admin/agent/workbench?month=2026-13', { headers: { authorization: 'Bearer test-token' } })
  })).json();
  check('坏月份返回空月不炸', calBad.ok === true && Object.keys(calBad.days || {}).length === 0, JSON.stringify(calBad).slice(0, 120));
}

console.log('');
if (FAILS.length) {
  console.log(`❌ ${FAILS.length} 个用例失败：${FAILS.join('、')}`);
  process.exit(1);
}
console.log('✅ 全部通过');
