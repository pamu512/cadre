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
  const url = new URL(
    base.endsWith('/chat/completions') || base.endsWith('/messages')
      ? base
      : base.endsWith('/v1') ? base + '/chat/completions' : base + '/v1/chat/completions',
  );
  return { key, url, model: inv.model || lane.model };
}

function loopback(url) {
  try { return ['127.0.0.1', 'localhost', '::1'].includes(url.hostname); } catch { return false; }
}

export function chatLaneAvailable(lane) {
  if (!CHAT_KINDS.includes(lane?.invoke?.kind)) return false;
  const resolved = resolveChat(lane);
  if (resolved.key) return true;
  return Boolean(resolved.url && loopback(resolved.url));
}

// messages -> { text, usage, model }. Throws CADRE_SKIP when unkeyed.
// 429/5xx-aware: honors Retry-After, exponential backoff with jitter, up to
// opts.maxRetries (default 3). A rate-limited lane exhausts retries and
// throws CADRE_RATE_LIMITED so the fallback chain can downshift honestly.
export async function chatLane(lane, messages, opts = {}) {
  const { key, url, model: laneModel } = resolveChat(lane);
  if (!key && !(url && loopback(url))) {
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
  const maxRetries = opts.maxRetries ?? 3;
  let lastErr = null;
  // pace to the window: if a pacing bucket exists for this lane, wait until the
  // window has room rather than spending at hour-one speed
  const bucket = globalThis.CADRE_WINDOW_BUCKETS?.get(lane.name);
  const est = opts.estTokens ?? opts.max_tokens ?? 2048;
  if (bucket) {
    const wait = bucket.waitMsFor(est);
    if (wait === Infinity) {
      const err = new Error(`${lane.name}: single call (~${est} tok) exceeds the whole window - cannot pace`);
      err.code = 'CADRE_RATE_LIMITED';
      throw err;
    }
    if (wait > 60000) {
      const err = new Error(`${lane.name}: window pace wants ${Math.round(wait / 1000)}s, pausing instead of spending`);
      err.code = 'CADRE_PACED';
      err.waitMs = wait;
      throw err;
    }
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  }
  // rate-limit meter: if this lane has a declared rpm/rps ceiling, wait for
  // window room instead of slamming the provider into a 429
  try {
    const { loadMeters, rateGuard } = await import('./meters.js');
    const m = loadMeters().find((x) => x.lane === lane.name);
    if (m && (m.rpm || m.rps)) {
      const okToGo = await rateGuard(lane.name, { rpm: m.rpm, rps: m.rps });
      if (!okToGo) {
        const err = new Error(`${lane.name}: rate-limit meter exhausted (${m.rpm ? m.rpm + ' rpm' : ''}${m.rpm && m.rps ? ' / ' : ''}${m.rps ? m.rps + ' rps' : ''}) - refusing to send rather than eat a 429`);
        err.code = 'CADRE_RATE_LIMITED';
        throw err;
      }
    }
  } catch (e) {
    if (e.code === 'CADRE_RATE_LIMITED') throw e;
    /* meter lookup best-effort */
  }
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (attempt > 0) {
      // Retry-After is the SERVER'S instruction: honor it at face value.
      // Jitter (0.5-1.5x) applies only to our own exponential guesses.
      const waitMs = lastErr.retryAfterMs ?? Math.round(Math.min(60000, 1000 * 2 ** (attempt - 1)) * (0.5 + Math.random()));
      await new Promise((r) => setTimeout(r, waitMs));
    }
    try {
      const headers = { 'content-type': 'application/json', 'user-agent': 'cadre/0.3' };
      if (key) headers.authorization = `Bearer ${key}`;
      const payload = await postJson(url, {
        headers,
        body,
        timeoutMs: opts.timeoutMs ?? 120000,
      });
      const text = payload.choices?.[0]?.message?.content;
      if (typeof text !== 'string') throw new Error(`${lane.name}: unexpected response shape (no choices[0].message.content)`);
      if (bucket) bucket.spend(payload.usage?.total_tokens || est);
      return { text, usage: payload.usage || null, model: payload.model || model, lane: lane.name };
    } catch (e) {
      lastErr = e;
      const retriable = e.statusCode === 429 || (e.statusCode >= 500 && e.statusCode < 600);
      if (e.statusCode === 429) {
        const ra = Number(e.retryAfterSec);
        e.retryAfterMs = Number.isFinite(ra) && ra > 0 ? Math.min(120000, ra * 1000) : undefined;
      }
      if (!retriable || attempt === maxRetries) {
        if (e.statusCode === 429) {
          const err = new Error(`${lane.name}: rate-limited (429) after ${attempt + 1} attempt(s) - backoff exhausted`);
          err.code = 'CADRE_RATE_LIMITED';
          throw err;
        }
        throw e;
      }
    }
  }
  throw lastErr;
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
          const ra = Number(res.headers['retry-after']);
          if (Number.isFinite(ra) && ra > 0) err.retryAfterSec = ra;
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
