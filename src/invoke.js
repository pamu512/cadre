// invoke - execute work through a lane. TWO drivers, no third kind:
//   1. command argv - ax lanes (ax IS a command lane), user command lanes,
//      agent CLIs, and hands (a hand's plan binary driven with argv).
//      With allowWrites the run is kernel-confined via the sandbox, which
//      FAILS CLOSED (no sandbox-exec = no run).
//   2. one chat POST - any OpenAI-compatible endpoint (chatlane.js). The
//      request is built once, posted once; retries stay inside that one
//      driver's backoff.
// Anything else says so and fails. The lane contract's `talks` field
// decides; secrets never leave the process that reads them from env.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { appendFileSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { chatLane, chatLaneAvailable, CHAT_KINDS } from './chatlane.js';

const run = promisify(execFile);
const AX = process.env.CADRE_AX || join(homedir(), '.local/bin/ax');

export function laneDrivable(lane) {
  const k = lane?.invoke?.kind;
  if (!k) return false;
  // argv driver: ax, command, agent, hand (hand needs a bound plan binary)
  if (k === 'command' || k === 'ax') return true;
  if (k === 'agent') return Boolean(lane.invoke?.path || lane.invoke?.bin);
  if (k === 'hand') return Boolean(lane.invoke?.bin);
  // chat driver: keyed or loopback OpenAI-compatible
  if (['openai-compatible', 'http-chat', 'chat'].includes(k)) return chatLaneAvailable(lane);
  return false; // mcp/anthropic/slack/app/cli/key/http are not drivable kinds anymore
}

function handMemoryPath(name) {
  return join(process.env.CADRE_HOME || join(homedir(), '.cadre'), 'hands-memory', `${name}.jsonl`);
}

// hand ledger lines carry provenance: every remembered verdict is a claim
// linked to the run that produced it (run id + evidence paths), so any
// derived memory can be traced back to receipts, and a disproven run can
// be retracted wholesale without touching the rest of the hand's history.
function handLines(name) {
  try {
    return readFileSync(handMemoryPath(name), 'utf-8').trim().split('\n').filter(Boolean).map((line) => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

export function handPrompt(lane, task) {
  const lines = handLines(lane.name).filter((e) => Array.isArray(e.files) && !e.retracted);
  const text = String(task);
  const overlap = lines.filter((e) => e.files.some((f) => text.includes(f) || text.includes(String(f).split('/').pop())));
  const picked = (overlap.length ? overlap : lines).slice(-5);
  const memory = picked.map((e) => `${e.at} files=${(e.files || []).join(',')} passed=${e.passed} ${e.critique || ''} ${e.task || ''}`).join('\n');
  return [memory ? `previous runs:\n${memory}` : '', task].filter(Boolean).join('\n\n');
}

export function rememberHandOutcome(lane, { files = [], passed = false, critique = '', task = '', run = null, evidence = [] } = {}) {
  try {
    const p = handMemoryPath(lane.name);
    mkdirSync(join(p, '..'), { recursive: true });
    appendFileSync(p, JSON.stringify({
      at: new Date().toISOString(),
      run: run ? String(run) : null,
      evidence: (evidence || []).slice(0, 8).map(String),
      files: files.slice(0, 12).map(String),
      passed: Boolean(passed),
      critique: String(critique).slice(0, 160),
      task: String(task).slice(0, 180),
    }) + '\n');
  } catch { /* memory is best-effort */ }
}

// FORGET (the Muse retraction workflow, file-first): mark every claim from a
// run as retracted — the line stays (append-only ledger), its verdict stops
// counting. Derived memory regenerates from non-retracted lines only.
export function retractHandRun(runId) {
  const dir = join(process.env.CADRE_HOME || join(homedir(), '.cadre'), 'hands-memory');
  let touched = [];
  try { touched = readdirSync(dir).filter((f) => f.endsWith('.jsonl')); } catch { return []; }
  const retracted = [];
  for (const f of touched) {
    const lines = handLines(f.replace(/\.jsonl$/, ''));
    const out = lines.map((e) => {
      if (e.run === runId && !e.retracted) { retracted.push(`${f.replace(/\.jsonl$/, '')}:${e.at}`); return { ...e, retracted: true, retracted_at: new Date().toISOString() }; }
      return e;
    });
    if (retracted.length) writeFileSync(join(dir, f), out.map((e) => JSON.stringify(e)).join('\n') + '\n');
  }
  return retracted;
}

// split a command template honoring single/double quotes ({brief} may contain
// spaces, and a plain whitespace split would break any templated argument)
function splitTemplate(tpl) {
  const parts = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(tpl)) !== null) parts.push(m[1] ?? m[2] ?? m[3]);
  return parts;
}

// THE ARGV DRIVER. Everything terminal-shaped rides this one path: the ax
// binary, user command templates, agent CLIs, hand plan binaries.
async function invokeArgv(bin, args, { cwd, timeoutMs, allowWrites }) {
  if (allowWrites?.length) {
    const { runConfined } = await import('./sandbox.js');
    // the argv's own tokens (the script the lane asked to run) stay readable;
    // network and everything else stays denied unless the lane asked
    const read = [bin, ...args].filter((a) => /^\/.*\.(sh|py|js|mjs|cjs|ts)$/.test(String(a)) || String(a) === bin);
    const confined = await runConfined(bin, args, { allow: allowWrites, cwd, timeout: timeoutMs, read });
    if (confined.refused) {
      // sandbox fails closed: no sandbox-exec means the run does not happen
      return { ok: false, kind: 'command', error: String(confined.error || '').slice(0, 500), stdout: '' };
    }
    if (confined.kernel) {
      return confined.ok
        ? { ok: true, kind: 'command', stdout: confined.stdout || '' }
        : { ok: false, kind: 'command', error: String(confined.error || '').slice(0, 500), stdout: '' };
    }
  }
  try {
    const { stdout } = await run(bin, args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 * 16, cwd });
    return { ok: true, kind: 'command', stdout };
  } catch (e) {
    return { ok: false, kind: 'command', error: String(e.message).slice(0, 500), stdout: e.stdout || '' };
  }
}

export async function invokeLane(lane, task, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 1000 * 60 * 30;
  const kind = lane.invoke?.kind || (lane.talks === 'http' ? 'http' : 'terminal');

  // ---- driver 1: command argv ----------------------------------------------
  if (kind === 'ax') {
    // ax IS a command lane: one binary, one argv, no special protocol
    const axLane = lane.invoke.lane;
    const axArgs = ['build', task, '--impl', axLane];
    if (opts.override) axArgs.push('--override');
    if (opts.context) axArgs.push('-c', opts.context);
    return invokeArgv(AX, axArgs, { cwd: opts.cwd || process.cwd(), timeoutMs, allowWrites: opts.allowWrites });
  }
  if (kind === 'command') {
    // user lane with a command template: run it with {brief} substituted.
    // B2's local-builder path: any CLI on this machine becomes a builder lane.
    const tpl = String(lane.invoke.command || '');
    if (!tpl) return { ok: false, kind, error: 'invoke.command missing' };
    const parts = splitTemplate(tpl);
    let args = parts.slice(1).map((a) => a.replaceAll('{brief}', task));
    if (!tpl.includes('{brief}')) args = [...args, task]; // no placeholder: brief becomes the trailing arg
    return invokeArgv(parts[0], args, { cwd: opts.cwd || process.cwd(), timeoutMs, allowWrites: opts.allowWrites });
  }
  if (kind === 'hand') {
    // a named hand is its plan binary plus its skill text: still argv
    const { loadSkills } = await import('./skills.js');
    const skill = loadSkills().find((s) => s.name === lane.invoke.skill);
    const planBin = lane.invoke.bin || null;
    if (!planBin) {
      return { ok: false, kind, error: `hand ${lane.name} is on the roster (skill ${skill?.name || lane.invoke.skill || 'unset'}) but no CLI plan binary is bound` };
    }
    const prompt = [skill?.text || '', handPrompt(lane, task)].filter(Boolean).join('\n\n');
    const base = String(planBin).split('/').pop();
    const promptArgs = base === 'codex' ? ['exec', prompt] : ['-p', prompt];
    return invokeArgv(planBin, promptArgs, { cwd: opts.cwd || process.cwd(), timeoutMs, allowWrites: opts.allowWrites });
  }
  if (kind === 'agent') {
    const bin = lane.invoke.path || lane.invoke.bin;
    const promptArgs = lane.invoke.bin === 'codex' || String(bin).endsWith('/codex') ? ['exec', task] : ['-p', task];
    return invokeArgv(bin, promptArgs, { cwd: opts.cwd || process.cwd(), timeoutMs, allowWrites: opts.allowWrites });
  }

  // ---- driver 2: one chat POST ---------------------------------------------
  if (CHAT_KINDS.includes(kind)) {
    // any OpenAI-compatible endpoint lane — provider-agnostic driver
    const result = await chatLane(
      lane,
      [
        { role: 'system', content: 'You are the ' + (lane.identity || 'cadre lane') + ' working this task. Be precise. Cite or concede.' },
        { role: 'user', content: task },
      ],
    );
    return { ok: true, kind: 'chat', text: result.text, usage: result.usage };
  }

  // ---- everything else: honest refusal -------------------------------------
  if (kind === 'app' || kind === 'cli' || kind === 'key' || kind === 'ollama') {
    return { ok: false, kind, error: `lane ${lane.name}: presence-only (it is on this machine; no driver was described)` };
  }
  return { ok: false, kind, error: `lane ${lane.name}: no driver for invoke.kind=${kind} - cadre invokes lanes exactly two ways: a command argv, or one chat POST` };
}
