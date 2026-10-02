// apertus - the primary reasoning lane (Hack Apertus, Track 2B).
// Swiss open LLMs via an OpenAI-compatible chat endpoint. The API key is read
// from the environment (APERTUS_API_KEY or APERTUS_BASE_URL pointed at a
// compatible gateway) at call time, used in one Authorization header, and never
// stored, logged, or echoed. 8B is the cheap hand; 70B the deciding hand.
import { request } from 'node:http';
import { request as requestSecure } from 'node:https';
import { createHash } from 'node:crypto';
import { audit } from './store.js';

export const APERTUS_MODELS = {
  'apertus-8b':  { model: 'Apertus-8B',  good_at: ['reasoning', 'drafting', 'classification'] },
  'apertus-70b': { model: 'Apertus-70B', good_at: ['decisions', 'review', 'long-reasoning'] },
};

export function apertusConfig() {
  const key = process.env.APERTUS_API_KEY || null;
  const base = process.env.APERTUS_BASE_URL || 'https://api.apertus.ai';
  const url = new URL(base.replace(/\/+$/, '') + '/v1/chat/completions');
  return { key, url };
}

export function apertusAvailable() {
  return Boolean(apertusConfig().key);
}

// last 6 chars of a sha256 - lets tests/ops confirm WHICH key is loaded without
// ever exposing the key itself. Returns null when no key.
export function keyFingerprint() {
  const { key } = apertusConfig();
  if (!key) return null;
  return createHash('sha256').update(key).digest('hex').slice(0, 6);
}

export function laneDef(name) {
  const spec = APERTUS_MODELS[name];
  if (!spec) return null;
  return {
    name,
    identity: 'apertus-class',
    good_at: spec.good_at,
    cost: 'metered',
    talks: 'http',
    proves: 'citations',
    craft: ['cite-or-concede'],
    invoke: { kind: 'apertus', model: spec.model, env: 'APERTUS_API_KEY' },
  };
}

// One chat completion. Returns { text, usage, model }.
// Options: { model: 'Apertus-8B'|'Apertus-70B', temperature, max_tokens, timeoutMs, signal }
export async function apertusChat(messages, opts = {}) {
  const { key, url } = apertusConfig();
  if (!key) {
    const err = new Error('APERTUS_API_KEY not set - live Apertus calls are skipped (export it to enable)');
    err.code = 'CADRE_SKIP';
    throw err;
  }
  const model = opts.model || 'Apertus-8B';
  const body = JSON.stringify({
    model,
    messages,
    temperature: opts.temperature ?? 0.3,
    max_tokens: opts.max_tokens ?? 2048,
  });
  const payload = await httpPostJson(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${key}`,   // used once, never logged
      'user-agent': 'cadre/0.2',
    },
    body,
    timeoutMs: opts.timeoutMs ?? 120000,
    signal: opts.signal,
  });
  const choice = payload.choices?.[0];
  const text = choice?.message?.content;
  if (typeof text !== 'string') {
    throw new Error(`apertus: unexpected response shape (no choices[0].message.content)`);
  }
  return {
    text,
    usage: payload.usage || null,
    model: payload.model || model,
  };
}

export function httpPostJson(url, { method, headers, body, timeoutMs, signal }) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? requestSecure : request;
    const req = lib(url, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf-8');
        if (res.statusCode < 200 || res.statusCode >= 300) {
          const err = new Error(`apertus: HTTP ${res.statusCode} ${text.slice(0, 300)}`);
          err.statusCode = res.statusCode;
          reject(err);
          return;
        }
        try { resolve(JSON.parse(text)); } catch { reject(new Error('apertus: non-JSON response')); }
      });
    });
    req.on('error', reject);
    const timer = setTimeout(() => {
      const err = new Error(`apertus: timeout after ${timeoutMs}ms`);
      err.code = 'CADRE_TIMEOUT';
      req.destroy(err);
      reject(err);
    }, timeoutMs);
    if (signal) {
      signal.addEventListener('abort', () => {
        const err = new Error('apertus: aborted');
        err.code = 'CADRE_ABORT';
        req.destroy(err);
        reject(err);
      }, { once: true });
    }
    req.end(body);
    // clear the timeout on settle to keep the process from hanging on to the handle
    req.on('close', () => clearTimeout(timer));
  });
}

// File an audit event for an apertus call: model, timing, token usage - never the key.
export function auditCall(runId, lane, result, error) {
  audit({
    kind: 'apertus-call',
    run: runId,
    lane,
    model: result?.model || null,
    usage: result?.usage || null,
    ok: !error,
    error: error ? String(error.message).slice(0, 200) : null,
  });
}
