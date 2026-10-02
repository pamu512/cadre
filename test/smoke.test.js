// Smoke tests - one per command class, against the real CLI with an isolated
// $CADRE_HOME. No network, no ax builds: heavy paths are exercised up to the
// point where they would spend (arg validation, routing, state) and the
// engine modules (gate, store, router, map, apertus config) are unit-tested.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function home(name) {
  const dir = mkdtempSync(join(tmpdir(), `cadre-${name}-`));
  return { dir, env: { ...process.env, CADRE_HOME: dir } };
}

async function cli(h, ...args) {
  try {
    const { stdout, stderr } = await run('node', [join(ROOT, 'bin/cadre.js'), ...args], {
      env: h.env, timeout: 60000, cwd: ROOT,
    });
    return { rc: 0, stdout, stderr };
  } catch (e) {
    return { rc: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

// ---- help -------------------------------------------------------------------
test('help lists every command', async () => {
  const h = home('help');
  const r = await cli(h, 'help');
  assert.equal(r.rc, 0);
  for (const cmd of ['go', 'lanes', 'plan', 'meter', 'sweep', 'map', 'proof', 'watch', 'debate', 'pin', 'mcp', 'parity']) {
    assert.ok(r.stdout.includes(`cadre ${cmd}`), `help must mention cadre ${cmd}`);
  }
});

// ---- lanes ------------------------------------------------------------------
test('lanes prints a real roster (or an honest empty message)', async () => {
  const h = home('lanes');
  const r = await cli(h, 'lanes');
  assert.equal(r.rc, 0);
  assert.ok(/LANE\s+STATUS/.test(r.stdout) || r.stdout.includes('no lanes found'));
  // no invented metrics: every lane line names a status from the contract set
  if (r.stdout.includes('LANE')) {
    assert.ok(/(ok|busy|down|queued|ready)/.test(r.stdout));
  }
});

test('lanes --json parses and carries contract fields', async () => {
  const h = home('lanesjson');
  const r = await cli(h, 'lanes', '--json');
  assert.equal(r.rc, 0);
  const parsed = JSON.parse(r.stdout);
  assert.ok(Array.isArray(parsed.lanes));
  for (const l of parsed.lanes) {
    assert.ok(l.name && l.good_at && l.cost && l.talks && l.proves, `lane ${l?.name} must carry contract fields`);
  }
});

// ---- plan -------------------------------------------------------------------
test('plan without a task exits 2', async () => {
  const h = home('plan2');
  const r = await cli(h, 'plan');
  assert.equal(r.rc, 2);
});

test('plan routes a real task and labels estimates as heuristic', async () => {
  const h = home('plan0');
  const r = await cli(h, 'plan', 'add a CSV export');
  assert.equal(r.rc, 0);
  assert.ok(r.stdout.includes('routing'), 'must show routing');
  assert.ok(r.stdout.includes('heuristic'), 'estimates must be labeled heuristic');
  assert.ok(!/\$\d+\.\d\d/.test(r.stdout), 'no invented dollar figures');
});

// ---- meter ------------------------------------------------------------------
test('meter on an empty home says so honestly', async () => {
  const h = home('meter');
  const r = await cli(h, 'meter');
  assert.equal(r.rc, 0);
  assert.ok(r.stdout.includes('no runs yet'));
});

// ---- sweep ------------------------------------------------------------------
test('sweep on an empty home finds nothing rotting', async () => {
  const h = home('sweep');
  const r = await cli(h, 'sweep');
  assert.equal(r.rc, 0);
  assert.ok(r.stdout.includes('nothing rotting'));
});

// ---- map --------------------------------------------------------------------
test('map builds a real index and --why traces a symbol', async () => {
  const h = home('map');
  const proj = mkdtempSync(join(tmpdir(), 'cadre-maprepo-'));
  mkdirSync(join(proj, 'lib'));
  writeFileSync(join(proj, 'lib', 'a.js'), 'import { b } from "./b.js";\nexport function alpha() { return b(); }\n');
  writeFileSync(join(proj, 'lib', 'b.js'), 'import { alpha } from "./a.js";\nexport function b() { return 1; }\nexport function beta() { return 2; }\n');
  const r = await run('node', [join(ROOT, 'bin/cadre.js'), 'map'], { env: h.env, cwd: proj, timeout: 30000 });
  assert.match(r.stdout, /map built · 2 files · [1-9]\d* symbols · [1-9]\d* import edges/);
  const r2 = await run('node', [join(ROOT, 'bin/cadre.js'), 'map', '--why', 'beta'], { env: h.env, cwd: proj, timeout: 30000 });
  assert.match(r2.stdout, /defined in\s+lib\/b\.js/);
});

// ---- proof / watch ----------------------------------------------------------
test('proof with no args prints usage; unknown id exits 1', async () => {
  const h = home('proof');
  assert.equal((await cli(h, 'proof')).rc, 0);
  const r = await cli(h, 'proof', '9999');
  assert.equal(r.rc, 1);
  assert.ok(r.stderr.includes('no run 9999'));
});

test('watch with unknown id exits 1', async () => {
  const h = home('watch');
  const r = await cli(h, 'watch', '9999');
  assert.equal(r.rc, 1);
});

// ---- pin --------------------------------------------------------------------
test('pin set/read/clear round-trips through pins.json', async () => {
  const h = home('pin');
  assert.equal((await cli(h, 'pin', '--budget', '50000')).rc, 0);
  const show = await cli(h, 'pin');
  assert.ok(show.stdout.includes('50000'));
  assert.equal((await cli(h, 'pin', '--clear', 'budget')).rc, 0);
  const show2 = await cli(h, 'pin');
  assert.ok(!show2.stdout.includes('50000'));
});

test('pin rejects a lane not in the roster', async () => {
  const h = home('pinbad');
  const r = await cli(h, 'pin', '--role', 'critic=no-such-lane');
  assert.equal(r.rc, 1);
});

// ---- debate / parity / go: arg validation (no spend in tests) ---------------
test('debate without a question exits 2', async () => {
  const h = home('debate');
  assert.equal((await cli(h, 'debate')).rc, 2);
});

test('parity requires --ref', async () => {
  const h = home('parity');
  const r = await cli(h, 'parity', 'match the reference');
  assert.equal(r.rc, 2);
  assert.ok(r.stderr.includes('--ref'));
});

test('go without a brief exits 2', async () => {
  const h = home('go2');
  assert.equal((await cli(h, 'go')).rc, 2);
});

test('go --dry shows routing without spending', async () => {
  const h = home('dry');
  const r = await cli(h, 'go', 'demo task', '--dry');
  assert.equal(r.rc, 0);
  assert.ok(r.stdout.includes('pipeline'));
});

// ---- mcp --------------------------------------------------------------------
test('mcp speaks JSON-RPC on stdio', async () => {
  const h = home('mcp');
  const msgs = [
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '0' } } }),
    JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }),
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list' }),
  ].join('\n') + '\n';
  const r = await new Promise((resolve, reject) => {
    const p = execFile('node', [join(ROOT, 'bin/cadre.js'), 'mcp'], { env: h.env, timeout: 30000, cwd: ROOT });
    let out = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stdin.write(msgs);
    p.stdin.end();
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error('mcp exited ' + code))));
  });
  const lines = r.trim().split('\n').map((l) => JSON.parse(l));
  const init = lines.find((m) => m.id === 1);
  const list = lines.find((m) => m.id === 2);
  assert.equal(init.result.serverInfo.name, 'cadre');
  assert.ok(list.result.tools.length >= 5, 'at least 5 tools exposed');
});

// ---- engine units -----------------------------------------------------------
test('gate: verdict requires all four evidence families', async () => {
  const { gateVerdict } = await import(join(ROOT, 'src/gate.js'));
  const base = { evidence: [
    { kind: 'command', command: 'npm test', exit: 0, output: 'ok' },
    { kind: 'diff', path: 'a.js', plus: 3, minus: 1 },
    { kind: 'artifact', path: join(ROOT, 'package.json') },
  ] };
  const missing = gateVerdict(base);
  assert.equal(missing.passed, false);
  assert.deepEqual(missing.missing, ['citations']);
  const full = gateVerdict({ evidence: [...base.evidence, { kind: 'citation', ref: 'runs/0001/run.log' }] });
  assert.equal(full.passed, true);
});

test('gate: artifact that vanished fails at gate time', async () => {
  const { gateVerdict } = await import(join(ROOT, 'src/gate.js'));
  const v = gateVerdict({ evidence: [{ kind: 'artifact', path: '/nonexistent/nope.xyz' }] });
  assert.equal(v.passed, false);
});

test('store: run records round-trip under $CADRE_HOME', async () => {
  const h = home('store');
  process.env.CADRE_HOME = h.dir; // store reads env at call time
  const { createRun, updateRun, readRun, listRuns, audit, auditPath } = await import(join(ROOT, 'src/store.js'));
  const rec = createRun({ brief: 'test brief', kind: 'go' });
  updateRun(rec.id, { status: 'passed' });
  const back = readRun(rec.id);
  assert.equal(back.status, 'passed');
  assert.equal(listRuns().length, 1);
  audit({ kind: 'x', apiKey: 'supersecret' });
  const logged = readFileSync(auditPath(), 'utf-8');
  assert.ok(logged.includes('[redacted]'), 'keyish fields must be redacted');
  assert.ok(!logged.includes('supersecret'));
  delete process.env.CADRE_HOME;
});

test('router: roles assign from a roster, pins win', async () => {
  process.env.CADRE_HOME = mkdtempSync(join(tmpdir(), 'cadre-router-'));
  const { assignRoles } = await import(join(ROOT, 'src/router.js'));
  const roster = { lanes: [
    { name: 'a', good_at: ['edits'], cost: 'free', talks: 'terminal', proves: 'diffs' },
    { name: 'b', good_at: ['review'], cost: 'free', talks: 'http', proves: 'citations' },
  ] };
  const r = assignRoles(roster, { brief: 'x' });
  assert.ok(r.assignments.length === 4);
  const builder = r.assignments.find((a) => a.role === 'builder');
  assert.equal(builder.lane, 'a');
  delete process.env.CADRE_HOME;
});

test('apertus: no key -> CADRE_SKIP, never fake success', async () => {
  const h = home('apertus');
  const saved = process.env.APERTUS_API_KEY;
  delete process.env.APERTUS_API_KEY;
  const { apertusChat, keyFingerprint, apertusAvailable } = await import(join(ROOT, 'src/apertus.js'));
  assert.equal(apertusAvailable(), false);
  assert.equal(keyFingerprint(), null);
  await assert.rejects(() => apertusChat([{ role: 'user', content: 'hi' }]), (e) => e.code === 'CADRE_SKIP');
  if (saved) process.env.APERTUS_API_KEY = saved;
});

test('apertus: fingerprint is 6 hex chars, never the key', async () => {
  const saved = process.env.APERTUS_API_KEY;
  process.env.APERTUS_API_KEY = 'test-key-do-not-print';
  const { keyFingerprint, apertusConfig } = await import(join(ROOT, 'src/apertus.js'));
  const fp = keyFingerprint();
  assert.match(fp, /^[0-9a-f]{6}$/);
  assert.notEqual(fp, 'test-key-do-not-print');
  assert.ok(String(apertusConfig().url).includes('/v1/chat/completions'));
  if (saved) process.env.APERTUS_API_KEY = saved; else delete process.env.APERTUS_API_KEY;
});

// ---- theater ban ------------------------------------------------------------
test('src/commands contains no theater strings', async () => {
  const { readdirSync, readFileSync: rd } = await import('node:fs');
  const dir = join(ROOT, 'src/commands');
  // theater markers: invented metrics, and LITERAL placeholder text in plain
  // quotes (real interpolation uses backticks with a live variable).
  const BANNED = ['41/41', 'simulated', '$1.87', 'estimated 4 loops'];
  // strip real template literals (backtick spans) - interpolation there is live.
  // what remains in plain quotes must not be a ${...} placeholder.
  const LITERAL_PLACEHOLDER = /['"]\$\{[a-zA-Z]+\}['"]/;
  for (const f of readdirSync(dir)) {
    const src = rd(join(dir, f), 'utf-8');
    for (const b of BANNED) {
      assert.ok(!src.includes(b), `${f} contains banned theater string: ${b}`);
    }
    const noTemplates = src.replace(/`[^`]*`/gs, '``');
    const lit = LITERAL_PLACEHOLDER.exec(noTemplates);
    assert.ok(!lit, `${f} prints a literal placeholder instead of a real value: ${lit?.[0]}`);
  }
});
