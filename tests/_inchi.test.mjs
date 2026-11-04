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

/* ---------- 10. 排期：「今天学数学两小时」自动应用 + 撤销 ---------- */
r = await handleAgentMessage(env, '今天学数学两小时');
check('排期自动应用', r.reply.includes('排好时间块') && r.reply.includes('数学（1小时30分钟）') && r.reply.includes('数学（30分钟）'), r.reply);
let plan = JSON.parse(env.__store.get('kaoyan').payload);
const todaySlots = plan.days[today].slots;
check('时间块写入 kaoyan plan', todaySlots.length === 2
  && todaySlots[0].subject === '数学' && todaySlots[1].subject === '数学', JSON.stringify(todaySlots));
const undoTop = JSON.parse(env.__store.get('agent_undo').payload).slice(-1)[0];
check('排期快照入撤销栈', undoTop.kind === 'plan_day' && undoTop.undo.hadDay === false, JSON.stringify(undoTop));

r = await handleAgentMessage(env, '撤销');
check('撤销排期', r.reply.includes('已撤销'), r.reply);
plan = JSON.parse(env.__store.get('kaoyan').payload);
check('撤销后 days 里这天被删掉', !plan.days || !plan.days[today], JSON.stringify(plan.days));

/* 排期再排一次 + 重复撤销（hadDay=true 分支） */
r = await handleAgentMessage(env, '今天学英语一小时');
check('再排一次', r.reply.includes('排好时间块'), r.reply);
r = await handleAgentMessage(env, '今天学数学一小时');
check('继续追加不覆盖', JSON.parse(env.__store.get('kaoyan').payload).days[today].slots.length === 2,
  JSON.stringify(JSON.parse(env.__store.get('kaoyan').payload).days));
r = await handleAgentMessage(env, '撤销');
check('撤销第二次排期，保留第一次', JSON.parse(env.__store.get('kaoyan').payload).days[today].slots.length === 1, r.reply);
r = await handleAgentMessage(env, '撤销');
check('撤销第一次排期', !JSON.parse(env.__store.get('kaoyan').payload).days[today], r.reply);

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

/* 排上今天的计划再试 */
await handleAgentMessage(env, '今天学数学两小时');
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

console.log('');
if (FAILS.length) {
  console.log(`❌ ${FAILS.length} 个用例失败：${FAILS.join('、')}`);
  process.exit(1);
}
console.log('✅ 全部通过');
