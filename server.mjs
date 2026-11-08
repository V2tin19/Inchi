/**
 * server.mjs —— 理序 (Cairn) 独立生产级运行服务
 *
 * 适用于：个人 VPS (Ubuntu/Debian/CentOS)、Docker 容器、家用 NAS、本地电脑。
 *
 * 特性：
 * 1. 零编译、零打包：纯原生 Node.js ESM 驱动。
 * 2. 自动加载 .env 配置文件（AI API、令牌、端口）。
 * 3. 持久化存储：自动将日程、学习记录、弹性任务与对话流落盘到 data/inchi_store.json。
 * 4. 内置 OpenAI 兼容协议适配（DeepSeek / 硅基流动 / OpenAI / OpenRouter 等）。
 */

import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { onRequestGet as agentChatGet, onRequestPost as agentChatPost } from './functions/api/admin/agent/chat.js';
import * as agentTasks from './functions/api/admin/agent/tasks.js';
import * as agentWorkbench from './functions/api/admin/agent/workbench.js';
import * as agentNotes from './functions/api/admin/agent/notes.js';
import * as agentSchedule from './functions/api/admin/agent/schedule.js';
import * as agentLogs from './functions/api/admin/agent/logs.js';
import * as agentOutbox from './functions/api/admin/agent/outbox.js';
import * as agentProfile from './functions/api/admin/agent/profile.js';
import * as agentLearn from './functions/api/admin/agent/learn.js';
import * as agentCron from './functions/api/admin/agent/cron/[kind].js';
import * as kaoyanPlan from './functions/api/admin/kaoyan-plan.js';
import * as docHandler from './functions/api/admin/doc.js';
import * as aiConfig from './functions/api/admin/agent/ai-config.js';
import { resolveLlmConfig } from './functions/api/_llm.js';

const ROOT = path.dirname(fileURLToPath(import.meta.url));

/* 1. 加载 .env 环境变量 */
function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  if (fs.existsSync(envPath)) {
    try {
      const content = fs.readFileSync(envPath, 'utf8');
      for (const line of content.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx > 0) {
          const key = trimmed.slice(0, eqIdx).trim();
          let val = trimmed.slice(eqIdx + 1).trim();
          if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
            val = val.slice(1, -1);
          }
          if (process.env[key] === undefined) {
            process.env[key] = val;
          }
        }
      }
    } catch (err) {
      console.warn('读取 .env 文件失败:', err.message);
    }
  }
}
loadEnv();

const PORT = Number(process.env.PORT || 8792);
const TOKEN = process.env.ADMIN_TOKEN || 'cairn-token';
const DATA_DIR = path.join(ROOT, 'data');
const DB_FILE = path.join(DATA_DIR, 'inchi_store.json');

/* 2. 本地持久化数据存储 (模拟 D1 doc 表) */
const store = new Map();
const times = new Map();

function saveDb() {
  try {
    if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
    const dump = {
      store: Object.fromEntries(store.entries()),
      times: Object.fromEntries(times.entries()),
      savedAt: new Date().toISOString()
    };
    fs.writeFileSync(DB_FILE, JSON.stringify(dump, null, 2), 'utf8');
  } catch (err) {
    console.warn('⚠️ 数据持久化写入失败:', err.message);
  }
}

function loadDb() {
  if (fs.existsSync(DB_FILE)) {
    try {
      const raw = JSON.parse(fs.readFileSync(DB_FILE, 'utf8'));
      if (raw.store) {
        for (const [k, v] of Object.entries(raw.store)) store.set(k, v);
      }
      if (raw.times) {
        for (const [k, v] of Object.entries(raw.times)) times.set(k, v);
      }
      return;
    } catch (e) {
      console.warn('⚠️ 读取本地存储文件失败，重置为默认初始化数据:', e.message);
    }
  }

  /* 首次启动无存档，初始化初始画像与任务 */
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
    examDate: '2026-12-26',
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

  saveDb();
}

function setDoc(key, payload, updatedAt) {
  try {
    store.set(key, JSON.parse(payload));
  } catch {
    store.set(key, payload);
  }
  times.set(key, updatedAt || new Date().toISOString());
  saveDb();
}

loadDb();

function getEnv() {
  return {
    ADMIN_TOKEN: process.env.ADMIN_TOKEN || TOKEN,
    LLM_API_KEY: process.env.LLM_API_KEY || '',
    LLM_BASE_URL: process.env.LLM_BASE_URL || 'https://api.deepseek.com',
    LLM_MODEL: process.env.LLM_MODEL || 'deepseek-chat',
    LLM_MODEL_STRONG: process.env.LLM_MODEL_STRONG || '',
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
                throw new Error('Cairn DB: 未实现的 SQL: ' + sql);
              }
            };
          }
        };
      }
    }
  };
}

/* 3. HTTP 调度处理 */
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
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.apk': 'application/vnd.android.package-archive'
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

  /* 系统状态端点 */
  if (p === '/api/status') {
    const env = getEnv();
    const cfg = await resolveLlmConfig(env);
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'access-control-allow-origin': '*'
    });
    return res.end(JSON.stringify({
      ok: true,
      name: '理序 (Cairn)',
      version: '1.0.0',
      llm: {
        configured: Boolean(cfg.apiKey),
        base: cfg.apiBase,
        model: cfg.model,
        source: cfg.source   /* 'ui' 网页配置 | 'env' 环境变量 | 'none' 未配置 */
      }
    }));
  }

  /* API 路由分发 */
  if (p === '/api/admin/agent/chat') {
    if (req.method === 'GET') return callHandler(agentChatGet, req, res, p, raw);
    if (req.method === 'POST') return callHandler(agentChatPost, req, res, p, raw);
  }

  const AGENT_MODS = {
    '/api/admin/agent/tasks': agentTasks,
    '/api/admin/agent/workbench': agentWorkbench,
    '/api/admin/agent/notes': agentNotes,
    '/api/admin/agent/schedule': agentSchedule,
    '/api/admin/agent/logs': agentLogs,
    '/api/admin/agent/outbox': agentOutbox,
    '/api/admin/agent/profile': agentProfile,
    '/api/admin/agent/learn': agentLearn,
    '/api/admin/agent/ai-config': aiConfig,
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
    /* 个人工具迭代快，文本资产一律 no-store，免得浏览器拿旧 JS 配新后端 */
    const noStore = ['.html', '.js', '.mjs', '.css'].includes(ext)
      ? { 'cache-control': 'no-store' }
      : {};
    res.writeHead(200, { 'content-type': MIME[ext] || 'text/plain', ...noStore });
    res.end(data);
  } catch (err) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('Not Found: ' + p);
  }
});

server.listen(PORT, '0.0.0.0', () => {
  const env = getEnv();
  const llmStatus = env.LLM_API_KEY ? `✅ 已接入 (${env.LLM_MODEL} @ ${env.LLM_BASE_URL})` : '⚪ 未配置（纯规则引擎降级运行）';
  console.log(`\n🌿 理序 (Cairn) 独立服务已启动：http://localhost:${PORT}`);
  /* 手机/局域网接入：把非内部网卡的 IPv4 都打出来 */
  for (const [name, list] of Object.entries(os.networkInterfaces())) {
    for (const a of list || []) {
      if (a.family === 'IPv4' && !a.internal) {
        console.log(`📱 局域网接入：http://${a.address}:${PORT}  (${name})`);
      }
    }
  }
  console.log(`   访问令牌：${TOKEN}`);
  console.log(`   AI 引擎：${llmStatus}`);
  console.log(`   本地数据归档目录：${DATA_DIR}`);
  console.log(`   按 Ctrl+C 停止\n`);
});
