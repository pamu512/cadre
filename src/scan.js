// scan - read the room. Detect what is actually installed on this machine
// (CLIs, ax lanes, env-keyed API lanes, local model servers) and project
// everything onto the lane contract. The roster is your setup; nothing to enroll.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';
import { validateLane } from './contract.js';
import { lanesDir } from './store.js';

const run = promisify(execFile);
const AX = join(homedir(), '.local/bin/ax');

// bin presence probes - name -> executable to look for on PATH
const CLI_PROBES = [
  { bin: 'claude', label: 'Claude Code' },
  { bin: 'cursor', label: 'Cursor Agent CLI' },
  { bin: 'codex', label: 'Codex CLI' },
  { bin: 'gh', label: 'GitHub CLI' },
  { bin: 'docker', label: 'Docker' },
];

// env-keyed API lanes. Key NAMES only - values are never read, logged, or stored.
const API_LANES = [
  { lane: 'apertus-8b',  env: 'APERTUS_API_KEY',      endpoint: 'https://api.apertus.ai/v1/chat/completions', model: 'Apertus-8B',  good_at: ['reasoning', 'drafting', 'classification'], cost: 'metered', identity: 'apertus-class' },
  { lane: 'apertus-70b', env: 'APERTUS_API_KEY',      endpoint: 'https://api.apertus.ai/v1/chat/completions', model: 'Apertus-70B', good_at: ['decisions', 'review', 'long-reasoning'], cost: 'metered', identity: 'apertus-class' },
  { lane: 'openai',      env: 'OPENAI_API_KEY',       endpoint: 'https://api.openai.com/v1/chat/completions',  model: 'gpt-4o-mini', good_at: ['general', 'critique'],   cost: 'metered' },
  { lane: 'anthropic',   env: 'ANTHROPIC_API_KEY',    endpoint: 'https://api.anthropic.com/v1/messages',       model: 'claude-sonnet-4', good_at: ['review', 'prose'], cost: 'metered' },
  { lane: 'glm',         env: 'GLM_API_KEY',          endpoint: 'https://api.z.ai/api/paas/v4/chat/completions', model: 'glm-4.7', good_at: ['reasoning', 'prose'], cost: 'metered' },
];

async function execOk(bin, args = ['--version'], timeout = 4000) {
  try { await run(bin, args, { timeout }); return true; } catch (e) {
    // nonzero exit (e.g. --version unsupported) still proves the binary exists
    return e.code !== undefined && !/ENOENT|not found/i.test(String(e.message));
  }
}

// ---- ax registry -----------------------------------------------------------

export async function scanAxLanes() {
  if (!existsSync(AX)) return [];
  try {
    const { stdout } = await run(AX, ['lanes'], { timeout: 15000 });
    const proj = {
      grok:     { good_at: ['planning', 'research'], proves: 'citations' },
      glm:      { good_at: ['reasoning', 'prose'],   proves: 'verdict' },
      hermes:   { good_at: ['backend', 'long-ctx'],  proves: 'diffs' },
      codex:    { good_at: ['edits', 'tests'],       proves: 'test-output' },
      cursor:   { good_at: ['ide-grade', 'non-ui'],  proves: 'diffs' },
      autoclaw: { good_at: ['ui', 'verify'],         proves: 'artifacts', talks: 'http' },
      grokbot:  { good_at: ['plans', 'gui'],         proves: 'verdict',   talks: 'chat' },
    };
    const lanes = [];
    for (const line of stdout.split('\n')) {
      const m = /^\s+(\w+)\s+(ok|busy|down|queued)\b/.exec(line);
      if (!m) continue;
      const base = proj[m[1]] || { good_at: ['general'], proves: 'verdict' };
      lanes.push({
        name: `ax-${m[1]}`,
        good_at: base.good_at,
        cost: 'plan',
        talks: base.talks || 'terminal',
        proves: base.proves,
        invoke: { kind: 'ax', lane: m[1], status: m[2] },
      });
    }
    return lanes;
  } catch {
    return []; // ax present but failed - roster still shows local lanes
  }
}

// ---- machine scan ----------------------------------------------------------

export async function scanMachine() {
  const [axLanes, clis] = await Promise.all([
    scanAxLanes(),
    Promise.all(CLI_PROBES.map(async (p) => ({ ...p, found: await execOk(p.bin) }))),
  ]);

  const apiLanes = API_LANES.filter((l) => {
    // multiple lanes may share one key name; presence once is enough
    if (l.env && !process.env[l.env]) return false;
    return true;
  }).map((l) => ({
    name: l.lane,
    good_at: l.good_at,
    cost: l.cost,
    talks: 'http',
    proves: 'citations',
    identity: l.identity,
    invoke: { kind: 'http', env: l.env, endpoint: l.endpoint, model: l.model },
  }));

  const local = await probeLocalServers();

  const detected = [...axLanes, ...apiLanes, ...local];
  const clisFound = clis.filter((c) => c.found);

  return { lanes: detected, clis: clisFound, platform: platform() };
}

async function probeLocalServers() {
  const lanes = [];
  // Ollama: default port + env override, both http-callable model servers
  const ollamaUrl = process.env.OLLAMA_HOST
    ? `http://${process.env.OLLAMA_HOST.replace(/^http:\/\//, '')}`
    : 'http://127.0.0.1:11434';
  if (await httpOk(`${ollamaUrl}/api/tags`, 1200)) {
    lanes.push({
      name: 'ollama-local',
      good_at: ['scaffold', 'draft', 'summarize'],
      cost: 'free',
      talks: 'http',
      proves: 'diffs',
      invoke: { kind: 'ollama', endpoint: ollamaUrl },
    });
  }
  return lanes;
}

function httpOk(url, timeoutMs) {
  const urlObj = new URL(url);
  return new Promise((resolve) => {
    const req = http.request(
      { hostname: urlObj.hostname, port: urlObj.port, path: urlObj.pathname, method: 'GET', timeout: timeoutMs },
      (res) => { res.resume(); resolve(res.statusCode > 0 && res.statusCode < 500); },
    );
    req.on('timeout', () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
    req.end();
  });
}

// ---- user-declared lanes ---------------------------------------------------

export function loadUserLanes() {
  const dir = lanesDir();
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const lane = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
      const v = validateLane(lane);
      if (v.valid) out.push(lane);
      else console.error(`cadre: skipping invalid lane ${f}: ${v.errors[0]}`);
    } catch (e) {
      console.error(`cadre: skipping unreadable lane ${f}: ${e.message}`);
    }
  }
  return out;
}

// Full roster: machine scan + user-declared, deduped by name (user lanes win).
export async function buildRoster() {
  const machine = await scanMachine();
  const user = loadUserLanes();
  const byName = new Map();
  for (const l of machine.lanes) byName.set(l.name, { ...l, source: 'scan' });
  for (const l of user) byName.set(l.name, { ...l, source: 'declared' });
  return { lanes: [...byName.values()], clis: machine.clis, platform: machine.platform };
}
