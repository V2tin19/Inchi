/**
 * Inchi (寸序) — 本地开发与测试服务器
 *
 * 1. 静态资源伺服（Claude 风格网页 index.html / style.css / app.js）
 * 2. 桥接 functions/api/ 真实 handler，提供内存 D1 Mock
 * 3. 运行：node dev-server.mjs (默认端口 8792)
 */

import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { onRequestGet as agentChatGet, onRequestPost as agentChatPost } from './functions/api/admin/agent/chat.js';
import * as agentTasks from './functions/api/admin/agent/tasks.js';
import * as agentSchedule from './functions/api/admin/agent/schedule.js';
import * as agentLogs from './functions/api/admin/agent/logs.js';
import * as agentOutbox from './functions/api/admin/agent/outbox.js';
import * as agentProfile from './functions/api/admin/agent/profile.js';
import * as agentLearn from './functions/api/admin/agent/learn.js';
import * as agentCron from './functions/api/admin/agent/cron/[kind].js';
import * as kaoyanPlan from './functions/api/admin/kaoyan-plan.js';
import * as docHandler from './functions/api/admin/doc.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8792);
const TOKEN = process.env.ADMIN_TOKEN || 'inchi-token';

/* 假 D1 内存存储 */
const store = new Map();
const times = new Map();

function getEnv() {
  return {
    ADMIN_TOKEN: TOKEN,
    DB: {
      prepare(sql) {
        return {
          bind(...args) {
            return {
              async first() {
                if (/SELECT (payload, updated_at|payload) FROM doc WHERE key = \?/.test(sql)) {
                  const key = args[0];
                  if (!store.has(key)) return null;
                  return { payload: JSON.stringify(store.get(key)), updated_at: times.get(key) || '' };
                }
                return null;
              },
              async run() {
                if (/INSERT (OR REPLACE )?INTO doc/.test(sql)) {
                  const [key, payload, updatedAt] = args;
                  setDoc(key, payload, updatedAt);
                  return;
                }
                if (/UPDATE doc SET payload = \?, updated_at = \? WHERE key = \?/.test(sql)) {
                  const [payload, updatedAt, key] = args;
                  setDoc(key, payload, updatedAt);
                  return;
                }
                if (/CREATE TABLE/.test(sql)) return;
                throw new Error('Inchi fake DB: 未实现的 SQL: ' + sql);
              }
            };
          }
        };
      }
    }
  };
}

function setDoc(key, payload, updatedAt) {
  try {
    store.set(key, JSON.parse(payload));
  } catch {
    store.set(key, payload);
  }
  times.set(key, updatedAt || new Date().toISOString());
}

/* 预置一点示例数据，让空界面打开就有亲切感 */
const today = new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
store.set('agent_profile', {
  prefs: ['偏好早上学数学', '番茄钟单块不超过90分钟'],
  schedule: { wake: '07:30', sleep: '23:30', weeklyTargetMinutes: 2400 },
  habits: {
    startMedian: '08:00',
    attendance14: 12,
    dailyAvgMinutes: 320,
    prefWindows: { '数学': '08:00-11:30', '408': '14:00-17:30', '英语': '20:00-22:00' }
  }
});
store.set('agent_tasks', {
  tasks: [
    { id: 't_math', name: '数学强化与真题', subject: '数学', targetMinutes: 900, cycle: 'weekly', priority: 1 },
    { id: 't_408', name: '408 核心突破', subject: '408', targetMinutes: 600, cycle: 'weekly', priority: 2 },
    { id: 't_eng', name: '真题精读与单词', subject: '英语', targetMinutes: 300, cycle: 'weekly', priority: 3 }
  ]
});
store.set('kaoyan', {
  days: {
    [today]: {
      slots: [
        { start: '08:30', end: '10:00', subject: '数学', status: 'done', topic: '高数微分方程强化' },
        { start: '10:15', end: '11:45', subject: '数学', status: 'done', topic: '线性代数二次型' },
        { start: '14:30', end: '16:00', subject: '408', status: 'todo', topic: '操作系统内存管理' }
      ]
    }
  }
});
store.set('study', {
  sessions: [
    { date: today, subject: '数学', duration: 90, note: '完成强化第三章', source: 'agent' },
    { date: today, subject: '数学', duration: 90, note: '线代大题过关', source: 'agent' }
  ],
  checkin: { [today]: true }
});

async function callHandler(fn, req, res, pathname, raw, params = {}) {
  const authHeader = req.headers['authorization'] || `Bearer ${TOKEN}`;
  const init = {
    method: req.method,
    headers: {
      authorization: authHeader,
      'content-type': req.headers['content-type'] || 'application/json'
    }
  };
  if (req.method === 'POST' || req.method === 'PUT' || req.method === 'PATCH') {
    init.body = raw;
  }
  const request = new Request('http://localhost' + req.url, init);
  try {
    const resp = await fn({ env: getEnv(), request, params });
    const text = await resp.text();
    let body;
    try { body = JSON.parse(text); } catch { body = { data: text }; }
    res.writeHead(resp.status, {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': '*'
    });
    res.end(JSON.stringify(body));
  } catch (err) {
    res.writeHead(500, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ error: err.message || String(err) }));
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png'
};

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'access-control-allow-origin': '*',
      'access-control-allow-headers': '*',
      'access-control-allow-methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS'
    });
    return res.end();
  }

  const u = new URL(req.url, 'http://localhost:' + PORT);
  const p = u.pathname;

  /* 收集请求体 */
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const raw = Buffer.concat(chunks).toString('utf-8');

  /* API 路由分发 */
  if (p === '/api/admin/agent/chat') {
    if (req.method === 'GET') return callHandler(agentChatGet, req, res, p, raw);
    if (req.method === 'POST') return callHandler(agentChatPost, req, res, p, raw);
  }

  const AGENT_MODS = {
    '/api/admin/agent/tasks': agentTasks,
    '/api/admin/agent/schedule': agentSchedule,
    '/api/admin/agent/logs': agentLogs,
    '/api/admin/agent/outbox': agentOutbox,
    '/api/admin/agent/profile': agentProfile,
    '/api/admin/agent/learn': agentLearn,
    '/api/admin/kaoyan-plan': kaoyanPlan,
    '/api/admin/doc': docHandler
  };

  if (AGENT_MODS[p]) {
    const mod = AGENT_MODS[p];
    if (req.method === 'GET' && mod.onRequestGet) return callHandler(mod.onRequestGet, req, res, p, raw);
    if (req.method === 'POST' && mod.onRequestPost) return callHandler(mod.onRequestPost, req, res, p, raw);
    if (req.method === 'PUT' && mod.onRequestPut) return callHandler(mod.onRequestPut, req, res, p, raw);
    if (req.method === 'PATCH' && mod.onRequestPatch) return callHandler(mod.onRequestPatch, req, res, p, raw);
    if (req.method === 'DELETE' && mod.onRequestDelete) return callHandler(mod.onRequestDelete, req, res, p, raw);
  }

  const cronM = /^\/api\/admin\/agent\/cron\/(\w+)$/.exec(p);
  if (cronM && req.method === 'POST') {
    return callHandler(agentCron.onRequestPost, req, res, p, raw, { kind: cronM[1] });
  }

  /* 静态文件伺服 */
  let filePath = path.join(ROOT, p === '/' ? 'index.html' : p);
  if (!fs.existsSync(filePath)) {
    filePath = path.join(ROOT, 'index.html');
  }

  try {
    const data = fs.readFileSync(filePath);
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, { 'content-type': MIME[ext] || 'text/plain' });
    res.end(data);
  } catch (err) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not Found: ' + p);
  }
});

server.listen(PORT, () => {
  console.log(`\n🌿 Inchi (寸序) 开发服务器已启动：http://localhost:${PORT}`);
  console.log(`   令牌：${TOKEN} (已内置自动鉴权)`);
  console.log(`   按 Ctrl+C 停止\n`);
});
