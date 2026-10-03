// invoke - execute work through a lane, whatever it talks.
// terminal (ax lane): delegate to the ax binary. chat kinds (any OpenAI-compatible):
// one POST. The lane contract's `talks` field decides; secrets never leave the
// process that reads them from env.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { chatLane, chatLaneAvailable, CHAT_KINDS } from './chatlane.js';
import { invokeMcpLane } from './mcplane.js';

const run = promisify(execFile);
const AX = process.env.CADRE_AX || join(homedir(), '.local/bin/ax');

export function laneDrivable(lane) {
  const k = lane?.invoke?.kind;
  if (!k) return false;
  if (k === 'command' || k === 'ax' || k === 'agent') return k !== 'agent' || Boolean(lane.invoke?.path || lane.invoke?.bin);
  if (k === 'mcp') return Boolean(lane.invoke?.command || lane.invoke?.url);
  if (k === 'hand') return Boolean(lane.invoke?.bin);
  if (k === 'anthropic') return Boolean(lane.invoke?.env && process.env[lane.invoke.env]);
  if (['openai-compatible', 'http-chat', 'chat'].includes(k)) return chatLaneAvailable(lane);
  return false;
}

function handMemoryPath(name) {
  return join(process.env.CADRE_HOME || join(homedir(), '.cadre'), 'hands-memory', `${name}.jsonl`);
}

function handLines(name) {
  try {
    return readFileSync(handMemoryPath(name), 'utf-8').trim().split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

export function handPrompt(lane, task) {
  const lines = handLines(lane.name).filter((e) => Array.isArray(e.files));
  const text = String(task);
  const overlap = lines.filter((e) => e.files.some((f) => text.includes(f) || text.includes(String(f).split('/').pop())));
  const picked = (overlap.length ? overlap : lines).slice(-5);
  const memory = picked.map((e) => `${e.at} files=${(e.files || []).join(',')} passed=${e.passed} ${e.critique || ''} ${e.task || ''}`).join('\n');
  return [memory ? `previous runs:\n${memory}` : '', task].filter(Boolean).join('\n\n');
}

export function rememberHandOutcome(lane, { files = [], passed = false, critique = '', task = '' } = {}) {
  try {
    const p = handMemoryPath(lane.name);
    mkdirSync(join(p, '..'), { recursive: true });
    appendFileSync(p, JSON.stringify({
      at: new Date().toISOString(),
      files: files.slice(0, 12).map(String),
      passed: Boolean(passed),
      critique: String(critique).slice(0, 160),
      task: String(task).slice(0, 180),
    }) + '\n');
  } catch { /* memory is best-effort */ }
}

export async function invokeLane(lane, task, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 1000 * 60 * 30;
  const kind = lane.invoke?.kind || (lane.talks === 'http' ? 'http' : 'terminal');

  if (kind === 'ax') {
    const axLane = lane.invoke.lane;
    const axArgs = ['build', task, '--impl', axLane];
    if (opts.override) axArgs.push('--override');
    if (opts.context) axArgs.push('-c', opts.context);
    const { stdout } = await run(AX, axArgs, { timeout: timeoutMs, maxBuffer: 1024 * 1024 * 32 });
    return { ok: true, kind, stdout };
  }
  if (CHAT_KINDS.includes(kind)) {
    // any OpenAI-compatible endpoint lane — provider-agnostic driver
    const result = await chatLane(
      lane,
      [
        { role: 'system', content: 'You are the ' + (lane.identity || 'cadre lane') + ' working this task. Be precise. Cite or concede.' },
        { role: 'user', content: task },
      ],
    );
    return { ok: true, kind, text: result.text, usage: result.usage };
  }
  if (kind === 'command') {
    // user lane with a command template: run it with {brief} substituted.
    // B2's local-builder path: any CLI on this machine becomes a builder lane.
    const tpl = String(lane.invoke.command || '');
    if (!tpl) return { ok: false, kind, error: 'invoke.command missing' };
    // split honoring single/double quotes (a plain whitespace split would break
    // any templated argument containing spaces)
    const parts = [];
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let m;
    while ((m = re.exec(tpl)) !== null) parts.push(m[1] ?? m[2] ?? m[3]);
    let args = parts.slice(1).map((a) => a.replaceAll('{brief}', task));
    if (!tpl.includes('{brief}')) args = [...args, task]; // no placeholder: brief becomes the trailing arg
    const cwd = opts.cwd || process.cwd();
    if (opts.allowWrites?.length) {
      const { runConfined } = await import('./sandbox.js');
      const confined = await runConfined(parts[0], args, { allow: opts.allowWrites, cwd, timeout: timeoutMs });
      if (confined.kernel) {
        return confined.ok
          ? { ok: true, kind, stdout: confined.stdout || '' }
          : { ok: false, kind, error: String(confined.error || '').slice(0, 500), stdout: '' };
      }
    }
    try {
      const { stdout } = await run(parts[0], args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 * 16, cwd });
      return { ok: true, kind, stdout };
    } catch (e) {
      return { ok: false, kind, error: String(e.message).slice(0, 500), stdout: e.stdout || '' };
    }
  }
  if (kind === 'hand') {
    const { loadSkills } = await import('./skills.js');
    const skill = loadSkills().find((s) => s.name === lane.invoke.skill);
    const planBin = lane.invoke.bin || null;
    if (!planBin) {
      return { ok: false, kind, error: `hand ${lane.name} is on the roster (skill ${skill?.name || lane.invoke.skill || 'unset'}) but no CLI plan binary is bound` };
    }
    const prompt = [skill?.text || '', handPrompt(lane, task)].filter(Boolean).join('\n\n');
    const base = String(planBin).split('/').pop();
    const promptArgs = base === 'codex' ? ['exec', prompt] : ['-p', prompt];
    try {
      const { stdout } = await run(planBin, promptArgs, { timeout: timeoutMs, maxBuffer: 1024 * 1024 * 4, cwd: opts.cwd || process.cwd() });
      return { ok: true, kind, stdout, skill: skill?.name || null };
    } catch (e) {
      return { ok: false, kind, error: String(e.message).slice(0, 500), stdout: e.stdout || '' };
    }
  }
  if (kind === 'anthropic') {
    const envName = lane.invoke.env;
    const key = envName ? process.env[envName] : null;
    if (!key) return { ok: false, kind, error: `anthropic lane ${lane.name}: env ${envName} is unset` };
    const base = String(lane.invoke.base_url || 'https://api.anthropic.com').replace(/\/+$/, '');
    const { request } = await import('node:https');
    const body = JSON.stringify({
      model: lane.invoke.model || 'claude-3-5-sonnet-latest',
      max_tokens: 1024,
      messages: [{ role: 'user', content: task }],
    });
    const posted = await new Promise((resolve) => {
      const req = request(`${base}/v1/messages`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
          'content-length': Buffer.byteLength(body),
        },
      }, (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let parsed = null;
          try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf-8')); } catch { parsed = null; }
          resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, parsed });
        });
      });
      req.on('error', (e) => resolve({ ok: false, error: e.message }));
      req.end(body);
    });
    const text = posted.parsed?.content?.map((c) => c.text).filter(Boolean).join('\n') || '';
    return posted.ok ? { ok: true, kind, text } : { ok: false, kind, error: posted.error || `anthropic ${posted.status}` };
  }
  if (kind === 'agent') {
    const bin = lane.invoke.path || lane.invoke.bin;
    const promptArgs = lane.invoke.bin === 'codex' || String(bin).endsWith('/codex') ? ['exec', task] : ['-p', task];
    const cwd = opts.cwd || process.cwd();
    if (opts.allowWrites?.length) {
      const { runConfined } = await import('./sandbox.js');
      const confined = await runConfined(bin, promptArgs, { allow: opts.allowWrites, cwd, timeout: timeoutMs });
      if (confined.kernel) {
        return confined.ok
          ? { ok: true, kind, stdout: confined.stdout || '' }
          : { ok: false, kind, error: String(confined.error || '').slice(0, 500), stdout: '' };
      }
    }
    try {
      const { stdout } = await run(bin, promptArgs, { timeout: timeoutMs, maxBuffer: 1024 * 1024 * 8, cwd });
      return { ok: true, kind, stdout };
    } catch (e) {
      return { ok: false, kind, error: String(e.message).slice(0, 500), stdout: e.stdout || '' };
    }
  }
  if (kind === 'slack') {
    const runId = opts.runId ? String(opts.runId) : '';
    if (runId) {
      const inbox = join(process.env.CADRE_HOME || join(homedir(), '.cadre'), 'inbox', `${runId}.txt`);
      if (existsSync(inbox)) return { ok: true, kind, stdout: readFileSync(inbox, 'utf-8') };
    }
    const url = process.env[lane.invoke.env || ''];
    if (!url || !url.startsWith('https://')) {
      return { ok: false, kind, error: `slack lane ${lane.name}: webhook env ${lane.invoke.env} is not set` };
    }
    const { request } = await import('node:https');
    const body = JSON.stringify({ text: task });
    const posted = await new Promise((resolve) => {
      const req = request(url, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } }, (res) => {
        res.resume();
        res.on('end', () => resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode }));
      });
      req.on('error', (e) => resolve({ ok: false, error: e.message }));
      req.end(body);
    });
    if (posted.ok && runId) {
      return { ok: false, waiting: true, kind, error: `waiting for inbox/${runId}.txt` };
    }
    return posted.ok
      ? { ok: true, kind, stdout: `posted to slack (${posted.status})` }
      : { ok: false, kind, error: posted.error || `slack post failed (${posted.status})` };
  }
  if (kind === 'mcp') {
    // MCP server lane. Agent mode chains multiple tools per brief (one server,
    // step-over-step tool picking); single-shot answers one tool.
    if (opts.mcpAgent) {
      const { invokeMcpAgent } = await import('./mcplane.js');
      return await invokeMcpAgent(lane, task, opts);
    }
    return await invokeMcpLane(lane, task, opts);
  }
  if (kind === 'app' || kind === 'cli' || kind === 'key') {
    return { ok: false, error: `lane ${lane.name}: presence-only (it is on this machine; no driver was described)` };
  }
  if (kind === 'http') {
    throw new Error(`lane ${lane.name}: generic http invoke not configured (endpoint lanes need a driver; OpenAI-compatible ones have one)`);
  }
  throw new Error(`lane ${lane.name}: no invoke driver for talks=${lane.talks}`);
}
