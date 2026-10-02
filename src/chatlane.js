// chatlane - the generic OpenAI-compatible chat driver. ANY keyed endpoint lane
// (any provider: openai, anthropic-compatible, glm, a user lane with invoke.env) is
// driven by this one code path. Cadre is model-agnostic: providers are data,
// not code. The key is read from the lane's env var at call time, used in one
// Authorization header, never logged or stored.
import { request } from 'node:http';
import { request as requestSecure } from 'node:https';

export const CHAT_KINDS = ['openai-compatible', 'http-chat', 'chat'];

// resolve { key, url, model } for a lane. Precedence:
//   invoke.api_key_env / invoke.base_url / invoke.model  (user lane JSON)
//   then lane.env / lane.endpoint (scanned API lane)
export function resolveChat(lane) {
  const inv = lane.invoke || {};
  const envName = inv.api_key_env || inv.env || lane.env;
  const key = envName ? process.env[envName] || null : null;
  // base URL: direct, or indirect via base_url_env (and APERTUS-style defaults)
  let base = inv.base_url;
  if (!base && inv.base_url_env) base = process.env[inv.base_url_env];
  if (!base && (envName || inv.base_url_env)) {
    // legacy default for endpoint-style lanes that declare an env but no base
    base = null;
  }
  if (!base) return { key, url: null, model: inv.model || lane.model };
  base = base.replace(/\/+$/, '');
  const url = new URL(base.endsWith('/v1') ? base + '/chat/completions' : base + '/v1/chat/completions');
  return { key, url, model: inv.model || lane.model };
}

export function chatLaneAvailable(lane) {
  if (!CHAT_KINDS.includes(lane?.invoke?.kind)) return false;
  return Boolean(resolveChat(lane).key);
}

// messages -> { text, usage, model }. Throws CADRE_SKIP when unkeyed.
export async function chatLane(lane, messages, opts = {}) {
  const { key, url, model: laneModel } = resolveChat(lane);
  if (!key) {
    const err = new Error(`${lane.name}: env key not set - live calls skipped (export ${lane.invoke?.api_key_env || lane.invoke?.env || lane.env || 'the lane key'} to enable)`);
    err.code = 'CADRE_SKIP';
    throw err;
  }
  const model = opts.model || laneModel || 'gpt-4o-mini';
  const body = JSON.stringify({
    model,
    messages,
    temperature: opts.temperature ?? 0.3,
    max_tokens: opts.max_tokens ?? 2048,
  });
  const payload = await postJson(url, {
    headers: { 'content-type': 'application/json', authorization: `Bearer ${key}`, 'user-agent': 'cadre/0.2' },
    body,
    timeoutMs: opts.timeoutMs ?? 120000,
  });
  const text = payload.choices?.[0]?.message?.content;
  if (typeof text !== 'string') throw new Error(`${lane.name}: unexpected response shape (no choices[0].message.content)`);
  return { text, usage: payload.usage || null, model: payload.model || model, lane: lane.name };
}

function postJson(url, { headers, body, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? requestSecure : request;
    const req = lib(url, { method: 'POST', headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(`${url.host}: HTTP ${res.statusCode} ${text.slice(0, 300)}`);
          err.statusCode = res.statusCode;
          reject(err);
          return;
        }
        try { resolve(JSON.parse(text)); } catch { reject(new Error('non-JSON response')); }
      });
    });
    req.on('error', reject);
    const timer = setTimeout(() => {
      const err = new Error(`timeout after ${timeoutMs}ms`);
      err.code = 'CADRE_TIMEOUT';
      req.destroy(err);
      reject(err);
    }, timeoutMs);
    if (body) req.end(body); else req.end();
    req.on('close', () => clearTimeout(timer));
  });
}
