/**
 * /api/admin/agent/ai-config —— 自定义 AI 接口（OpenAI 兼容）的存取与诊断口
 *
 *   GET  /api/admin/agent/ai-config      当前生效配置（Key 只回掩码）+ 来源
 *   PUT  /api/admin/agent/ai-config      保存 / 清除
 *        body: { baseUrl, apiKey, model, modelStrong?, keepApiKey? }
 *        全空（且不带 keepApiKey）= 清除，回落到服务端 .env
 *   POST /api/admin/agent/ai-config      诊断动作（不落库）
 *        body: { action: 'models', baseUrl?, apiKey? }   一键获取模型列表
 *        body: { action: 'test',   baseUrl?, apiKey?, model? }  连接测试
 *
 * 令牌：环境变量 ADMIN_TOKEN，Authorization: Bearer <令牌>
 * 保存后的配置写入 doc key 'ai_config'，_llm.resolveLlmConfig 会优先读取它，
 * 所以网页上改配置即时生效，不用动 .env 也不用重启服务。
 */

import { json, dbMissing, requireAdmin } from '../../_shared.js';
import { readDoc, writeDoc } from '../../agent/_store.js';
import { resolveLlmConfig } from '../../_llm.js';

const NO_STORE = { 'cache-control': 'no-store' };
const DOC_KEY = 'ai_config';
const MASK_LEN = 4;

function maskKey(key) {
  const k = String(key || '').trim();
  if (!k) return '';
  if (k.length <= MASK_LEN * 2) return k.slice(0, 2) + '****';
  return `${k.slice(0, MASK_LEN)}****${k.slice(-MASK_LEN)}`;
}

/** 与网页端一致的 Base URL 清洗：剥引号/补协议/去尾部斜杠与 chat/completions 路径 */
export function cleanBaseUrl(raw) {
  let v = String(raw || '').trim().replace(/["']/g, '');
  if (!v) return '';
  if (!/^https?:\/\//i.test(v) && !/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?(\/|$)/i.test(v)) {
    v = 'https://' + v;
  }
  v = v.replace(/\/+$/, '');
  v = v.replace(/\/(v1\/)?chat\/completions$/i, '');
  return v;
}

function cleanKey(raw) {
  return String(raw || '').replace(/^bearer\s+/i, '').replace(/["'\s]/g, '');
}

/** OpenAI 兼容模型列表：先试 {base}/models，404/失败再试 {base}/v1/models */
export async function fetchModelIds(apiBase, apiKey, timeoutMs = 20000) {
  const paths = apiBase.toLowerCase().endsWith('/v1') || /\/v\d+$/.test(apiBase)
    ? [`${apiBase}/models`]
    : [`${apiBase}/models`, `${apiBase}/v1/models`];

  let lastErr = '';
  for (const url of paths) {
    let resp, text;
    try {
      resp = await fetch(url, {
        headers: { authorization: `Bearer ${apiKey}` },
        signal: AbortSignal.timeout(timeoutMs)
      });
      text = await resp.text();
    } catch (e) {
      lastErr = e.name === 'TimeoutError' ? '请求模型列表超时' : `连不上接口（${e.message || e}）`;
      continue;
    }
    if (resp.status === 404) { lastErr = `${url} 返回 404`; continue; }
    if (resp.status >= 400) {
      lastErr = `HTTP ${resp.status}：${text.slice(0, 180)}`;
      continue;
    }
    const ids = parseModelIds(text);
    if (ids.length) return { models: ids, path: url.replace(apiBase, '') || '/models' };
    lastErr = `${url} 返回了无法识别的结构`;
  }
  throw new Error(lastErr || '未能获取模型列表');
}

/** 兼容 {data:[{id}]}（OpenAI 系）/ {models:[{name}]}（Ollama 原生）/ 裸数组 / 网关信封 */
function parseModelIds(text) {
  let data;
  try { data = JSON.parse(text); } catch { return []; }
  if (data && typeof data === 'object' && !Array.isArray(data)
    && typeof data.success === 'boolean' && data.data && typeof data.data === 'object') {
    data = data.data;   /* CLINE 一类网关信封 */
  }
  let list = [];
  if (Array.isArray(data)) list = data;
  else if (data && Array.isArray(data.data)) list = data.data;
  else if (data && Array.isArray(data.models)) list = data.models;
  const ids = list
    .map(m => typeof m === 'string' ? m : (m && (m.id || m.name || m.model)) || '')
    .map(s => String(s).trim())
    .filter(Boolean);
  return [...new Set(ids)].sort((a, b) => a.localeCompare(b));
}

/* ---------------- GET：读当前配置 ---------------- */
export async function onRequestGet({ env, request }) {
  if (!env.DB) return dbMissing();
  const rejected = requireAdmin(request, env);
  if (rejected) return rejected;

  const { data, updatedAt } = await readDoc(env, DOC_KEY);
  const saved = data && typeof data === 'object' ? data : null;
  const effective = await resolveLlmConfig(env);

  return json({
    ok: true,
    source: effective.source,   /* 'ui' | 'env' | 'none' */
    config: saved ? {
      baseUrl: saved.baseUrl || '',
      model: saved.model || '',
      modelStrong: saved.modelStrong || '',
      apiKeyMasked: maskKey(saved.apiKey),
      hasKey: Boolean(String(saved.apiKey || '').trim())
    } : { baseUrl: '', model: '', modelStrong: '', apiKeyMasked: '', hasKey: false },
    envFallback: {
      baseUrl: String(env.LLM_BASE_URL || ''),
      model: String(env.LLM_MODEL || ''),
      hasKey: Boolean(String(env.LLM_API_KEY || '').trim())
    },
    updatedAt
  }, 200, NO_STORE);
}

/* ---------------- PUT：保存 / 清除 ---------------- */
export async function onRequestPut({ env, request }) {
  if (!env.DB) return dbMissing();
  const rejected = requireAdmin(request, env);
  if (rejected) return rejected;

  let body;
  try { body = await request.json(); } catch { return json({ error: '请求体不是合法的 JSON' }, 400, NO_STORE); }
  if (!body || typeof body !== 'object') return json({ error: '请求体不能为空' }, 400, NO_STORE);

  const baseUrl = cleanBaseUrl(body.baseUrl);
  const model = String(body.model || '').trim();
  const modelStrong = String(body.modelStrong || '').trim();
  const hasNewKey = typeof body.apiKey === 'string' && cleanKey(body.apiKey).length > 0;

  /* 显式清除：请求里什么都没给（且没有 keepApiKey）—— 写空对象，resolveLlmConfig 回落 .env。
     这个判断必须放在「沿用旧 Key」之前，否则 PUT {} 会变成用旧 Key 原样保存，永远清不掉。 */
  if (!baseUrl && !hasNewKey && !model && !modelStrong && body.keepApiKey !== true) {
    await writeDoc(env, DOC_KEY, {});
    return json({ ok: true, cleared: true, source: 'env' }, 200, NO_STORE);
  }

  const prev = await readDoc(env, DOC_KEY);
  const prevData = prev.data && typeof prev.data === 'object' ? prev.data : {};

  /* keepApiKey：网页端没动 Key 输入框时，保留原 Key 不覆盖 */
  const apiKey = hasNewKey ? cleanKey(body.apiKey) : String(prevData.apiKey || '');

  /* 没有 Key（新的、旧的都没给）也当清除，避免留下半配置状态 */
  if (!apiKey) {
    await writeDoc(env, DOC_KEY, {});
    return json({ ok: true, cleared: true, source: 'env' }, 200, NO_STORE);
  }

  if (baseUrl && !/^https?:\/\//i.test(baseUrl) && !/^(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(:\d+)?/i.test(baseUrl)) {
    return json({ error: `接口地址不合法：${baseUrl}` }, 400, NO_STORE);
  }
  if (model.length > 200 || modelStrong.length > 200) {
    return json({ error: '模型名称过长' }, 400, NO_STORE);
  }

  const next = { baseUrl, model, modelStrong, apiKey, updatedAt: new Date().toISOString() };
  await writeDoc(env, DOC_KEY, next);
  return json({ ok: true, saved: true, apiKeyMasked: maskKey(apiKey), source: 'ui' }, 200, NO_STORE);
}

/* ---------------- POST：诊断动作 ---------------- */
export async function onRequestPost({ env, request }) {
  if (!env.DB) return dbMissing();
  const rejected = requireAdmin(request, env);
  if (rejected) return rejected;

  let body;
  try { body = await request.json(); } catch { return json({ error: '请求体不是合法的 JSON' }, 400, NO_STORE); }
  if (!body || typeof body.action !== 'string') return json({ error: '需要有 action 字段' }, 400, NO_STORE);

  /* 目标配置：请求里给了就用请求里的（保存前先试），否则用已保存的，再回落 .env */
  async function targetConfig() {
    const { data } = await readDoc(env, DOC_KEY);
    const saved = data && typeof data === 'object' ? data : {};
    const envCfg = await resolveLlmConfig(env);
    const reqKey = cleanKey(body.apiKey);
    return {
      apiBase: cleanBaseUrl(body.baseUrl) || cleanBaseUrl(saved.baseUrl) || envCfg.apiBase,
      apiKey: reqKey || String(saved.apiKey || '') || envCfg.apiKey,
      model: String(body.model || '').trim() || String(saved.model || '').trim() || envCfg.model
    };
  }

  try {
    if (body.action === 'models') {
      const cfg = await targetConfig();
      if (!cfg.apiKey) return json({ error: '还没有 API Key，先粘贴 Key 或先保存配置' }, 400, NO_STORE);
      const { models, path } = await fetchModelIds(cfg.apiBase, cfg.apiKey);
      return json({ ok: true, models, path, base: cfg.apiBase, count: models.length }, 200, NO_STORE);
    }

    if (body.action === 'test') {
      const cfg = await targetConfig();
      if (!cfg.apiKey) return json({ error: '还没有 API Key，先粘贴 Key 或先保存配置' }, 400, NO_STORE);
      const started = Date.now();
      const resp = await fetch(`${cfg.apiBase}/chat/completions`, {
        method: 'POST',
        headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({
          model: cfg.model,
          messages: [{ role: 'user', content: '回复「好」一个字即可' }],
          max_tokens: 16,
          temperature: 0
        }),
        signal: AbortSignal.timeout(30000)
      });
      const latencyMs = Date.now() - started;
      const text = await resp.text();
      if (resp.status >= 400) {
        return json({ ok: false, error: `HTTP ${resp.status}：${text.slice(0, 220)}`, latencyMs, base: cfg.apiBase, model: cfg.model }, 200, NO_STORE);
      }
      let reply = '';
      try { reply = JSON.parse(text)?.choices?.[0]?.message?.content || ''; } catch { /* 拿不到就空着 */ }
      return json({ ok: true, latencyMs, base: cfg.apiBase, model: cfg.model, reply: reply.trim().slice(0, 60) }, 200, NO_STORE);
    }

    return json({ error: `未知的 action：${body.action}` }, 400, NO_STORE);
  } catch (e) {
    return json({ ok: false, error: e.message || String(e) }, 200, NO_STORE);
  }
}
