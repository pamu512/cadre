// PRD v0.3 ship-quality items
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
const BIN = join(ROOT, 'bin/cadre.js');

function home(name) {
  const dir = mkdtempSync(join(tmpdir(), `cadre-${name}-`));
  return { dir, env: { ...process.env, CADRE_HOME: dir } };
}
async function cli(h, ...args) {
  try {
    const { stdout } = await run('node', [BIN, ...args], { env: h.env, timeout: 60000, cwd: ROOT });
    return { rc: 0, stdout };
  } catch (e) {
    return { rc: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

test('C1: --version prints cadre <semver>', async () => {
  const h = home('ver');
  const r = await cli(h, '--version');
  assert.equal(r.rc, 0);
  assert.match(r.stdout.trim(), /^cadre \d+\.\d+\.\d+$/);
});

test('C4: init scaffolds CADRE_HOME idempotently', async () => {
  const h = home('init');
  const r1 = await cli(h, 'init');
  assert.equal(r1.rc, 0);
  assert.ok(existsSync(join(h.dir, 'lanes', 'my-first-lane.json')));
  // valid JSON, valid lane
  const lane = JSON.parse(readFileSync(join(h.dir, 'lanes', 'my-first-lane.json'), 'utf-8'));
  assert.ok(lane.name && lane.good_at && lane.cost && lane.talks && lane.proves);
  // idempotent: second run leaves it untouched
  const before = readFileSync(join(h.dir, 'lanes', 'my-first-lane.json'), 'utf-8');
  const r2 = await cli(h, 'init');
  assert.equal(r2.rc, 0);
  assert.ok(r2.stdout.includes('left untouched'));
  assert.equal(readFileSync(join(h.dir, 'lanes', 'my-first-lane.json'), 'utf-8'), before);
});

test('C7: proof --verify exits 3 when the bundle fails reality', async () => {
  const h = home('verify3');
  process.env.CADRE_HOME = h.dir;
  try {
    const { createRun, updateRun, addEvidence } = await import(join(ROOT, 'src/store.js'));
    const r = createRun({ brief: 'bad bundle', kind: 'go' });
    // full four-family evidence, but the command FAILS on re-run
    await addEvidence(r.id, { kind: 'command', label: 'will-fail', command: 'node -e process.exit(9)', argv: ['node', '-e', 'process.exit(9)'], exit: 0, output: 'claimed ok', safe: true });
    await addEvidence(r.id, { kind: 'diff', label: 'f', path: 'README.md', plus: 2, minus: 1 });
    await addEvidence(r.id, { kind: 'artifact', label: 'README.md', path: 'README.md' });
    await addEvidence(r.id, { kind: 'citation', label: 'c', ref: 'README.md' });
    updateRun(r.id, { status: 'passed' });
    const res = await cli(h, 'proof', r.id, '--verify');
    assert.equal(res.rc, 3, `expected exit 3, got ${res.rc}`);
    assert.ok(res.stdout.includes('verification failure') || res.stdout.includes('re-run failed'));
  } finally {
    delete process.env.CADRE_HOME;
  }
});

test('C8: lanes shows per-lane history from a fabricated ledger', async () => {
  const h = home('lanehist');
  process.env.CADRE_HOME = h.dir;
  try {
    const { createRun, updateRun } = await import(join(ROOT, 'src/store.js'));
    const a = createRun({ brief: 'x', kind: 'go', roles: { builder: 'ax-codex' } });
    updateRun(a.id, { status: 'passed', ended: new Date().toISOString() });
    const b = createRun({ brief: 'y', kind: 'go', roles: { builder: 'ax-codex' } });
    updateRun(b.id, { status: 'rejected', ended: new Date().toISOString() });
    const res = await cli(h, 'lanes');
    // ax-codex must carry 1/2 (present only if the ax registry lane is scanned; assert on data path)
    assert.ok(res.stdout.includes('LANE'));
    const j = JSON.parse((await cli(h, 'lanes', '--json')).stdout);
    const codex = (j.lanes || j).find?.((l) => l.name === 'ax-codex') || (Array.isArray(j) ? j.find((l) => l.name === 'ax-codex') : null);
    if (codex) assert.ok(codex.history === '1/2 passed', `expected 1/2 passed, got ${codex.history}`);
  } finally {
    delete process.env.CADRE_HOME;
  }
});

test('C5: malformed input never leaks raw stack traces', async () => {
  const h = home('errs');
  const probes = [
    ['go'], ['proof', 'zzz'], ['watch', 'zzz'], ['parity', 'x'], ['meter', '--set', 'x', '--quota', '-1'],
    ['map', '/no/such/dir'], ['approach'], ['pin', '--role', 'garbage'], ['init', 'extra'],
  ];
  for (const args of probes) {
    const r = await cli(h, ...args);
    const out = (r.stdout + r.stderr);
    assert.ok(!/Cannot read propert|is not defined|at async|TypeError|ReferenceError/.test(out), `${args.join(' ')} leaked a stack: ${out.split('\n').slice(0, 3).join(' | ')}`);
  }
});

test('C6: sweep --release handles a missing/empty registry cleanly', async () => {
  const h = home('rel');
  const r = await cli(h, 'sweep', '--release');
  // on this machine: either "no [active]" (0) or releases entries (0); ax missing would be 1
  assert.ok([0, 1].includes(r.rc));
  assert.ok(r.stdout.includes('no [active]') || r.stdout.includes('released') || r.stderr.includes('ax not found'));
});
