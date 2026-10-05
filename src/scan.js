// scan - the roster is this machine. CLIs on PATH, installed apps, local model
// servers that answer, env keys that are set, MCP servers in the usual config
// files, and ax's live registry. Status is who is online right now. Nothing
// here is enrolled and nothing is a per-product biography: good_at is the
// observed class (cli, app, model, key, mcp). ax workers share one class
// because the registry only reports a name and a status.
import { execFile } from 'node:child_process';
import { HUMAN_LANE } from './human.js';
import { promisify } from 'node:util';
import { accessSync, constants, existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';
import { validateLane } from './contract.js';
import { lanesDir } from './store.js';

const run = promisify(execFile);
const AX = process.env.CADRE_AX || join(homedir(), '.local/bin/ax');

// ax lanes are workers the registry is running. One shared class — the
// registry does not say what each is good at, so we don't invent it.
const AX_WORKER = ['planning', 'edits', 'review', 'verify'];

// Public endpoints for key NAMES we recognize. Any other *_API_KEY still
// becomes a lane; we just don't invent a URL for it. Anthropic keys ride
// the chat POST driver through any OpenAI-compatible gateway; cadre no
// longer ships a provider-specific driver.
const KEY_ENDPOINTS = {
  OPENAI_API_KEY: { kind: 'openai-compatible', base_url: 'https://api.openai.com', good_at: ['reasoning'] },
  GLM_API_KEY: { kind: 'openai-compatible', base_url: 'https://api.z.ai/api/paas/v4/chat/completions', good_at: ['reasoning'] },
};

const KEY_NAME = /^(?:[A-Z0-9]+_)+(?:API_KEY|API_TOKEN|ACCESS_TOKEN|SECRET_KEY)$/;

export function slug(s) {
  const x = String(s).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32);
  return x || 'x';
}

function laneName(prefix, raw) {
  const n = `${prefix}-${slug(raw)}`;
  return n.slice(0, 39);
}

// ---- ax registry (live status) ---------------------------------------------

export async function scanAxLanes() {
  if (!existsSync(AX)) return [];
  try {
    const { stdout } = await run(AX, ['lanes'], { timeout: 15000 });
    const lanes = [];
    for (const line of stdout.split('\n')) {
      const m = /^\s+(\w+)\s+(ok|busy|down|queued)\b/.exec(line);
      if (!m) continue;
      lanes.push({
        name: laneName('ax', m[1]),
        good_at: AX_WORKER,
        cost: 'plan',
        talks: 'terminal',
        proves: 'verdict',
        invoke: { kind: 'ax', lane: m[1], status: m[2] },
      });
    }
    return lanes;
  } catch {
    return [];
  }
}

// ---- CLIs: every executable on PATH, first hit wins -----------------------

export function scanCliLanes(pathEnv = process.env.PATH || '') {
  const lanes = [];
  const seen = new Set();
  for (const dir of String(pathEnv).split(':').filter(Boolean)) {
    let entries;
    try { entries = readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      if (!name || name.startsWith('.') || seen.has(name)) continue;
      const full = join(dir, name);
      try {
        if (!statSync(full).isFile()) continue;
        accessSync(full, constants.X_OK);
      } catch { continue; }
      seen.add(name);
      lanes.push({
        name: laneName('cli', name),
        good_at: ['cli'],
        cost: 'free',
        talks: 'terminal',
        proves: 'commands',
        invoke: { kind: 'cli', bin: name, path: full, status: 'ok' },
      });
    }
  }
  return lanes;
}

// ---- apps: *.app bundles on disk; ok when a process is running ------------

export function appDirs() {
  return [join('/Applications'), join(homedir(), 'Applications')];
}

export function probeAgentApps(dirs = appDirs(), runningText = '') {
  if (platform() !== 'darwin' && dirs === undefined) return [];
  const out = [];
  const seen = new Set();
  const running = String(runningText || '');
  for (const dir of dirs) {
    let entries;
    try { entries = readdirSync(dir); } catch { continue; }
    for (const name of entries) {
      if (!name.endsWith('.app')) continue;
      if (seen.has(name)) continue;
      seen.add(name);
      const base = name.slice(0, -4);
      const online = running.includes(base);
      out.push({
        name: laneName('app', base),
        good_at: ['app'],
        cost: 'free',
        talks: 'chat',
        proves: 'verdict',
        invoke: { kind: 'app', bundle: name, status: online ? 'ok' : 'ready' },
      });
    }
  }
  return out;
}

async function runningProcessText() {
  try {
    const { stdout } = await run('ps', ['-ax', '-o', 'comm='], { timeout: 4000, maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  } catch {
    return '';
  }
}

// ---- local models: only servers that answer, one lane per model -----------

export function modelsFromOllama(body) {
  const names = [];
  for (const m of body?.models || []) if (m?.name) names.push(String(m.name));
  return names;
}

export function modelsFromOpenAIList(body) {
  const names = [];
  for (const m of body?.data || []) if (m?.id) names.push(String(m.id));
  return names;
}

function httpGetJson(url, timeoutMs) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { resolve(null); return; }
    if (u.protocol !== 'http:') { resolve(null); return; }
    const req = http.request(
      { hostname: u.hostname, port: u.port, path: u.pathname + u.search, method: 'GET', timeout: timeoutMs },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          if (!(res.statusCode > 0 && res.statusCode < 500)) return resolve(null);
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf-8'))); } catch { resolve(null); }
        });
      },
    );
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

async function probeLocalServers() {
  const ollamaUrl = process.env.OLLAMA_HOST
    ? `http://${String(process.env.OLLAMA_HOST).replace(/^https?:\/\//, '')}`
    : 'http://127.0.0.1:11434';
  const targets = [
    { prefix: 'ollama', url: `${ollamaUrl}/api/tags`, parse: modelsFromOllama, kind: 'ollama', endpoint: ollamaUrl },
    { prefix: 'lmstudio', url: 'http://127.0.0.1:1234/v1/models', parse: modelsFromOpenAIList, kind: 'http', endpoint: 'http://127.0.0.1:1234/v1' },
    { prefix: 'llamacpp', url: 'http://127.0.0.1:8080/v1/models', parse: modelsFromOpenAIList, kind: 'http', endpoint: 'http://127.0.0.1:8080/v1' },
  ];
  const lanes = [];
  const bodies = await Promise.all(targets.map((t) => httpGetJson(t.url, 400)));
  targets.forEach((t, i) => {
    const body = bodies[i];
    if (!body) return;
    const models = t.parse(body);
    if (t.prefix === 'ollama') {
      lanes.push({
        name: 'ollama-local',
        good_at: ['model'],
        cost: 'free',
        talks: 'http',
        proves: 'diffs',
        invoke: { kind: 'ollama', endpoint: t.endpoint, status: 'ok' },
      });
    }
    for (const model of models) {
      lanes.push({
        name: laneName(t.prefix, model),
        good_at: ['model'],
        cost: 'free',
        talks: 'http',
        proves: 'diffs',
        invoke: {
          kind: 'openai-compatible',
          base_url: t.endpoint,
          endpoint: t.endpoint,
          model,
          status: 'ok',
        },
      });
    }
    if (t.prefix !== 'ollama' && models.length === 0) {
      lanes.push({
        name: t.prefix,
        good_at: ['model'],
        cost: 'free',
        talks: 'http',
        proves: 'diffs',
        invoke: { kind: t.kind, endpoint: t.endpoint, status: 'ok' },
      });
    }
  });
  return lanes;
}

// ---- keys: names set in the environment, values never copied --------------

export function scanKeyLanes(env = process.env) {
  const lanes = [];
  for (const name of Object.keys(env)) {
    if (!KEY_NAME.test(name)) continue;
    const value = env[name];
    if (typeof value !== 'string' || value.trim() === '') continue;
    const known = KEY_ENDPOINTS[name];
    lanes.push({
      name: laneName('key', name),
      good_at: known?.good_at || ['key'],
      cost: 'metered',
      talks: 'http',
      proves: 'citations',
      invoke: known
        ? { kind: known.kind, env: name, base_url: known.base_url, status: 'ok' }
        : { kind: 'key', env: name, endpoint: null, status: 'ok' },
    });
  }
  return lanes;
}

// ---- MCP configs -----------------------------------------------------------

const MCP_CONFIG_PATHS = () => {
  const h = homedir();
  return [
    join(process.cwd(), '.mcp.json'),
    join(process.cwd(), '.cursor', 'mcp.json'),
    join(h, '.claude', 'mcp.json'),
    join(h, '.cursor', 'mcp.json'),
    join(h, '.config', 'mcp', 'mcp.json'),
    join(h, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json'),
  ];
};

function probeMcpServers() {
  const found = [];
  const seen = new Set();
  for (const cfgPath of MCP_CONFIG_PATHS()) {
    if (!existsSync(cfgPath)) continue;
    let cfg;
    try { cfg = JSON.parse(readFileSync(cfgPath, 'utf-8')); } catch { continue; }
    const servers = cfg.mcpServers || {};
    for (const [name, def] of Object.entries(servers)) {
      if (seen.has(name)) continue;
      if (!def || (!def.command && !def.url)) continue;
      seen.add(name);
      const isHttp = Boolean(def.url);
      const binOk = isHttp || existsSync(def.command);
      let status = binOk ? 'ready' : 'down';
      if (isHttp && /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(def.url)) {
        status = 'ready';
      }
      found.push({
        name: laneName('mcp', name),
        good_at: ['mcp'],
        cost: 'free',
        talks: isHttp ? 'http' : 'stdin',
        proves: 'artifacts',
        invoke: {
          kind: 'mcp',
          command: def.command || null,
          args: def.args || [],
          url: def.url || null,
          envNames: def.env ? Object.keys(def.env) : [],
          source: cfgPath,
          status,
        },
      });
    }
  }
  return found;
}

// CLI agents that can actually be talked to. The presence lane (cli-*) stays.
// This lane is the talk path: name, fit, cost, and the binary.
const AGENT_BINS = new Set(['claude', 'codex', 'gemini', 'cursor-agent', 'aider']);

export function scanAgentLanes(cliLanes) {
  return cliLanes
    .filter((l) => AGENT_BINS.has(l.invoke?.bin))
    .map((l) => ({
      name: laneName('agent', l.invoke.bin),
      identity: `${l.invoke.bin} speaks`,
      good_at: ['edits'],
      cost: 'plan',
      talks: 'terminal',
      proves: 'diffs',
      invoke: { kind: 'agent', bin: l.invoke.bin, path: l.invoke.path, status: 'ok' },
    }));
}

// Slack teammate: only when a webhook env var is set. The URL stays in the
// environment; the lane records the variable name.
export function bindAppTwins(apps, clis) {
  return apps.map((app) => {
    const base = String(app.invoke?.bundle || '').replace(/\.app$/i, '').toLowerCase();
    const twin = clis.find((c) => {
      const bin = String(c.invoke?.bin || '').toLowerCase();
      return bin === base || bin === `${base}-agent`;
    });
    if (!twin || app.invoke?.status !== 'ok') return app;
    return {
      ...app,
      invoke: { kind: 'agent', bin: twin.invoke.bin, path: twin.invoke.path, status: app.invoke.status, via: 'app' },
    };
  });
}

export async function scanMachine() {
  const [axLanes, clis, local, running] = await Promise.all([
    scanAxLanes(),
    Promise.resolve(scanCliLanes()),
    probeLocalServers(),
    runningProcessText(),
  ]);
  const keys = scanKeyLanes();
  const mcpLanes = probeMcpServers();
  const appLanes = bindAppTwins(platform() === 'darwin' ? probeAgentApps(appDirs(), running) : [], clis);
  const agents = scanAgentLanes(clis);
  return {
    lanes: [...axLanes, ...agents, ...clis, ...keys, ...local, ...mcpLanes, ...appLanes, HUMAN_LANE],
    clis: clis.map((l) => ({ label: l.invoke.bin, path: l.invoke.path })),
    platform: platform(),
  };
}

// Optional command templates in $CADRE_HOME/lanes. A file with invoke.example
// is the init scaffold, not a worker. Real files overlay a scanned name.
export function loadUserLanes() {
  const dir = lanesDir();
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const lane = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
      if (lane?.invoke?.example === true) continue;
      const v = validateLane(lane);
      if (v.valid) out.push(lane);
      else console.error(`cadre: skipping invalid lane ${f}: ${v.errors[0]}`);
    } catch (e) {
      console.error(`cadre: skipping unreadable lane ${f}: ${e.message}`);
    }
  }
  return out;
}

function loadShippedHands() {
  const dir = join(dirname(fileURLToPath(import.meta.url)), '..', 'hands');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const lane = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
      const v = validateLane(lane);
      if (v.valid) out.push(lane);
    } catch { /* a broken shipped hand is skipped, not invented */ }
  }
  return out;
}

const PLAN_BINS = ['claude', 'codex', 'gemini'];

function bindHandPlan(hand, lanes) {
  if (hand.invoke?.kind !== 'hand' || hand.invoke.bin) return hand;
  const plan = lanes.find((l) => l.invoke?.kind === 'agent' && PLAN_BINS.includes(l.invoke.bin))
    || lanes.find((l) => l.invoke?.kind === 'cli' && PLAN_BINS.includes(l.invoke.bin));
  if (!plan) return hand;
  return { ...hand, invoke: { ...hand.invoke, bin: plan.invoke.path } };
}

export async function buildRoster() {
  const machine = await scanMachine();
  const user = loadUserLanes();
  const byName = new Map();
  for (const l of machine.lanes) byName.set(l.name, { ...l, source: 'scan' });
  for (const l of loadShippedHands()) {
    if (byName.has(l.name)) continue;
    byName.set(l.name, { ...bindHandPlan(l, machine.lanes), source: 'shipped' });
  }
  for (const l of user) byName.set(l.name, { ...l, source: 'declared' });
  return { lanes: [...byName.values()], clis: machine.clis, platform: machine.platform };
}
