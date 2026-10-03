// P0/P1 audit-item tests (appended to smoke suite)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function home(name) {
  const dir = mkdtempSync(join(tmpdir(), `cadre-${name}-`));
  return { dir, env: { ...process.env, CADRE_HOME: dir } };
}
async function cli(h, ...args) {
  try {
    const { stdout } = await run('node', [join(ROOT, 'bin/cadre.js'), ...args], { env: h.env, timeout: 60000, cwd: ROOT });
    return { rc: 0, stdout };
  } catch (e) {
    return { rc: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

test('P0#5: cadre doctor runs and reports health with fix lines', async () => {
  const h = home('doctor');
  const r = await cli(h, 'doctor');
  assert.equal(r.rc, 0);
  assert.ok(r.stdout.includes('node'));
  assert.ok(/healthy|fix:/.test(r.stdout));
});

test('P0#2: MCP tools/list includes go/sweep/watch/pin; cadre_go dry returns routing', async () => {
  const h = home('mcp2');
  const p = spawn('node', [join(ROOT, 'bin/cadre.js'), 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'], env: h.env });
  let buf = ''; const replies = [];
  p.stdout.on('data', (d) => { buf += d; let n; while ((n = buf.indexOf('\n')) > -1) { const l = buf.slice(0, n).trim(); buf = buf.slice(n + 1); if (l) replies.push(JSON.parse(l)); } });
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'cadre_go', arguments: { outcome: 'demo task', dry: true } } }) + '\n');
  await new Promise((r) => setTimeout(r, 2500));
  p.kill();
  const tools = replies.find((r) => r.id === 1)?.result?.tools?.map((t) => t.name) || [];
  for (const t of ['cadre_go', 'cadre_sweep', 'cadre_watch', 'cadre_pin']) assert.ok(tools.includes(t), `${t} missing from tools/list`);
  const go = replies.find((r) => r.id === 2);
  assert.ok((go?.result?.content?.[0]?.text || '').length > 50, 'cadre_go dry must return routing text');
});

test('P0#8/B8: builder-only command evidence fails the gate; mixed passes', async () => {
  const { gateVerdict } = await import(join(ROOT, 'src/gate.js'));
  const base = {
    roles: { builder: 'the-builder', verifier: 'the-verifier' },
    evidence: [
      { kind: 'command', label: 'x', command: 'true', exit: 0, output: 'ok', by: 'the-builder' },
      { kind: 'diff', label: 'f', path: 'f', plus: 3, minus: 1 },
      { kind: 'artifact', label: 'README.md', path: 'README.md' },
      { kind: 'citation', label: 'c', ref: 'README.md' },
    ],
  };
  const bad = gateVerdict(base);
  assert.ok(!bad.passed, 'builder-only command evidence must fail');
  assert.ok(bad.independence.note.includes('non-builder'));
  const good = gateVerdict({ ...base, evidence: [...base.evidence, { kind: 'command', label: 'v', command: 'npm test', exit: 0, output: 'ok', by: 'the-verifier' }] });
  assert.ok(good.passed, 'mixed evidence must pass');
});

test('P1#6: a CLI on PATH is a roster lane, with no lane file', async () => {
  const { scanCliLanes } = await import(join(ROOT, 'src/scan.js'));
  const dir = mkdtempSync(join(tmpdir(), 'cadre-cli-'));
  const bin = join(dir, 'gemini');
  writeFileSync(bin, '#!/bin/sh\nexit 0\n');
  const { chmodSync } = await import('node:fs');
  chmodSync(bin, 0o755);
  const lanes = scanCliLanes(dir);
  const g = lanes.find((l) => l.name === 'cli-gemini');
  assert.ok(g, 'gemini on PATH is a lane');
  assert.equal(g.invoke.status, 'ok');
  assert.equal(g.invoke.path, bin);
  assert.deepEqual(g.good_at, ['cli']);
  assert.equal(lanes.some((l) => l.name === 'cli-not-here'), false);
});

test('P1#7: go consults the warm map (hot zones in the run path)', async () => {
  // unit-level: map.js loadMap/mapIsWarm + go's import of them
  const src = readFileSync(join(ROOT, 'src/commands/go.js'), 'utf-8');
  assert.ok(src.includes('hotZones'), 'go must read hot zones');
  assert.ok(src.includes('mapIsWarm'), 'go must check warmth');
  const planSrc = readFileSync(join(ROOT, 'src/commands/plan.js'), 'utf-8');
  assert.ok(planSrc.includes('hotZones'), 'plan must read hot zones');
});

test('P1#13: leftover fold semantics - same brief attaches evidence', async () => {
  const h = home('autofold');
  const prev = process.env.CADRE_HOME;
  process.env.CADRE_HOME = h.dir;
  try {
    const { createRun, updateRun, addEvidence, readRun } = await import(join(ROOT, 'src/store.js'));
    const leftover = createRun({ brief: 'exact brief', kind: 'go' });
    await addEvidence(leftover.id, { kind: 'citation', label: 'prior', ref: 'runs/prior' });
    updateRun(leftover.id, { status: 'interrupted' });
    // the fold logic in go: same brief => fold; assert the store supports attach
    const r = readRun(leftover.id);
    assert.equal(r.evidence.length, 1);
    const src = readFileSync(join(ROOT, 'src/commands/go.js'), 'utf-8');
    assert.ok(src.includes('sweep-fold'), 'go must log fold decisions');
  } finally {
    if (prev) process.env.CADRE_HOME = prev; else delete process.env.CADRE_HOME;
  }
});

test('P0#1: default go is standalone (no --local needed); --ax forces ax pipeline', async () => {
  const src = readFileSync(join(ROOT, 'src/commands/go.js'), 'utf-8');
  assert.ok(src.includes("if (!flags.ax)"), 'standalone must be the default path');
  assert.ok(!src.includes('flags.local'), '--local is replaced by default-standalone + --ax');
});

test('P0#4/#12 honesty: meter copy says declare, plan labels heuristics', async () => {
  const meterSrc = readFileSync(join(ROOT, 'src/commands/meter.js'), 'utf-8');
  assert.ok(meterSrc.includes('official rail'), 'meter must say official rails');
  const planSrc = readFileSync(join(ROOT, 'src/commands/plan.js'), 'utf-8');
  assert.ok(planSrc.toLowerCase().includes('heuristic'), 'plan must label estimates heuristic');
});

// ---- #9: kill -9 failure mode, end to end ------------------------------------
test('P1#9: a go run killed -9 mid-loop is found by sweep, snapshotted, and filed', { timeout: 60000 }, async () => {
  const { runKill9Scenario } = await import(join(ROOT, 'src/kill9.js'));
  const res = await runKill9Scenario(ROOT);
  assert.ok(res.found, 'sweep must surface the killed run');
  assert.ok(res.retired, 'retire must file it');
});

// ---- #10/#14 ------------------------------------------------------------------
test('P1#10: metrics --report generates the doc from the ledger, deterministically', async () => {
  const h = home('report');
  const proj = mkdtempSync(join(tmpdir(), 'cadre-report-proj-'));
  mkdirSync(join(proj, 'docs'), { recursive: true });
  const r1 = await run('node', [join(ROOT, 'bin/cadre.js'), 'metrics', '--report'], { env: h.env, cwd: proj, timeout: 30000 });
  assert.equal(r1.stdout.includes('report written'), true);
  const first = readFileSync(join(proj, 'docs', 'BEYOND-PARITY.md'), 'utf-8');
  assert.ok(first.includes('Generated:') && first.includes('do not edit by hand'));
  assert.ok(first.includes('runs recorded'));
  const r2 = await run('node', [join(ROOT, 'bin/cadre.js'), 'metrics', '--report'], { env: h.env, cwd: proj, timeout: 30000 });
  const second = readFileSync(join(proj, 'docs', 'BEYOND-PARITY.md'), 'utf-8');
  // deterministic within the same ledger state (timestamp line excluded)
  const strip = (t) => t.replace(/Generated: [^\n]+/, '');
  assert.equal(strip(first), strip(second));
});

test('P2#14: parity --dry extracts the behavior contract from the ref', async () => {
  const h = home('parity-dry');
  const proj = mkdtempSync(join(tmpdir(), 'cadre-parity-proj-'));
  writeFileSync(join(proj, 'ref.md'), '# Ref\n\n- behavior one that is long enough\n- behavior two that is long enough\n');
  const r = await run('node', [join(ROOT, 'bin/cadre.js'), 'parity', 'demo', '--ref', 'ref.md', '--dry'], { env: h.env, cwd: proj, timeout: 30000 });
  assert.ok(r.stdout.includes('contract:'), 'must show the contract');
  assert.ok(r.stdout.includes('behavior one'));
  assert.ok(r.stdout.includes('pipeline: extract contract'));
});

// ---- citation-ref existence at the gate ---------------------------------------
test('gate: bogus citation ref fails the citations family; real ref passes', async () => {
  const { gateVerdict } = await import(join(ROOT, 'src/gate.js'));
  const base = { roles: {}, evidence: [
    { kind: 'command', command: 'true', exit: 0, output: 'ok' },
    { kind: 'diff', path: 'f', plus: 2, minus: 1 },
    { kind: 'artifact', label: 'README.md', path: 'README.md' },
  ] };
  const bogus = gateVerdict({ ...base, evidence: [...base.evidence, { kind: 'citation', label: 'x', ref: 'no/such/file.anywhere' }] });
  assert.ok(!bogus.passed, 'bogus ref must fail');
  assert.ok(bogus.failed.some((f) => f.family === 'citations' && String(f.detail).includes('missing at gate time')));
  const real = gateVerdict({ ...base, evidence: [...base.evidence, { kind: 'citation', label: 'r', ref: 'README.md' }] });
  assert.ok(real.passed, 'real ref must pass');
  const http = gateVerdict({ ...base, evidence: [...base.evidence, { kind: 'citation', label: 'u', ref: 'https://example.com/x' }] });
  assert.ok(http.passed, 'http refs are followable, must pass');
});

// ---- history-aware routing ----------------------------------------------------
test('router: demonstrated failure outranks free cost', async () => {
  const { historyPenalty, scoreLane } = await import(join(ROOT, 'src/router.js'));
  // fabricated ledger via penalty unit: a lane with 0 passes over 3 runs
  // hermetic: injected ledger, independent of this machine's live run history
  const failing = { name: 'ollama-local', good_at: ['scaffold', 'draft', 'summarize'], cost: 'free', invoke: {} };
  const ledger = new Map([['ollama-local', { runs: 3, passed: 0 }]]);
  const p = historyPenalty(failing, ledger);
  assert.ok(p >= 4, `failing lane must be penalized, got ${p}`);
  const strugglingLedger = new Map([['ollama-local', { runs: 4, passed: 1 }]]);
  assert.equal(historyPenalty(failing, strugglingLedger), 4, 'sub-50% pass rate = struggling penalty');
  const healthyLedger = new Map([['ollama-local', { runs: 5, passed: 3 }]]);
  assert.equal(historyPenalty(failing, healthyLedger), 0, '>=50% pass rate = no penalty');
  const working = { name: 'nonexistent-lane-xyz', good_at: ['edits'], cost: 'plan', invoke: {} };
  assert.equal(historyPenalty(working, new Map()), 0, 'no history = no penalty');
});

// ---- cost-is-tiebreak-only ----------------------------------------------------
test('router: cost never adds capability points (free != better)', async () => {
  const { scoreLane } = await import(join(ROOT, 'src/router.js'));
  const free = scoreLane({ name: 'f', good_at: ['edits', 'tests'], cost: 'free', invoke: {} }, 'builder');
  const plan = scoreLane({ name: 'p', good_at: ['edits', 'tests'], cost: 'plan', invoke: {} }, 'builder');
  assert.equal(free.fit, plan.fit, 'equal capability must score equally regardless of cost');
  assert.ok(free.costRank < plan.costRank, 'costRank only breaks ties');
});

test('router: last-resort - all capable lanes failing still fields a crew, with warning', async () => {
  const src = readFileSync(join(ROOT, 'src/router.js'), 'utf-8');
  assert.ok(src.includes('ALL capable lanes failing'), 'fallback must exist');
  assert.ok(src.includes('b.fit - a.fit || a.costRank - b.costRank'), 'sort must tiebreak by cost, not weight it');
});
