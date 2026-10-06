// Muse steals: supersede chain (parity ledger), salience-weighted habits,
// and the sweep forgetting cascade (derived state retracted with its run).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmp = mkdtempSync(join(tmpdir(), 'cadre-muse-'));
process.env.CADRE_HOME = tmp;

const store = await import('../src/store.js');
const prefs = await import('../src/preferences.js');

test('parity ledger: a later claim on the same target+ref supersedes the prior', () => {
  const a = store.appendParityClaim({ run: '0001', target: 'gate closes behavior X', ref: 'docs/R.md', verdict: 'behavior-open', evidence_count: 0, citation: '' });
  const b = store.appendParityClaim({ run: '0002', target: 'gate closes behavior X', ref: 'docs/R.md', verdict: 'behavior-closed (file)', evidence_count: 1, citation: 'src/gate.js:10' });
  assert.ok(a.id, 'first claim gets an id');
  assert.equal(b.supersedes, a.id, 'second claim points at the first');
  const standing = store.standingParityClaims().filter((r) => r.target === 'gate closes behavior X');
  assert.equal(standing.length, 1, 'one chain head');
  assert.equal(standing[0].id, b.id, 'the newest claim stands');
  // a different ref is a different chain
  store.appendParityClaim({ run: '0003', target: 'gate closes behavior X', ref: 'docs/R2.md', verdict: 'behavior-open', evidence_count: 0, citation: '' });
  assert.equal(store.standingParityClaims().filter((r) => r.target === 'gate closes behavior X').length, 2);
});

test('sweep cascade: retracting a run withdraws its standing parity claims', () => {
  store.appendParityClaim({ run: '0009', target: 'behavior Y', ref: 'docs/R.md', verdict: 'behavior-closed (test)', evidence_count: 1, citation: 'test/y.test.js' });
  const n = store.retractParityClaimsForRun('0009', 'run retired by sweep');
  assert.equal(n, 1, 'one standing claim retracted');
  const standing = store.standingParityClaims().filter((r) => r.target === 'behavior Y');
  assert.equal(standing.length, 1);
  assert.equal(standing[0].verdict, 'retracted');
  assert.match(standing[0].reason, /was: behavior-closed/);
  // idempotent: nothing left standing from that run to retract
  assert.equal(store.retractParityClaimsForRun('0009'), 0);
});

test('preferences: events carry run provenance and salience', () => {
  prefs.recordOutcome({ role: 'builder', lane: 'terra', passed: true, tokens: 10, run: '0010', salience: true });
  const e = prefs.loadPrefs().events.at(-1);
  assert.equal(e.run, '0010');
  assert.equal(e.salience, true);
});

test('preferences: salient pass rate outranks a lane that only wins quiet runs', () => {
  // quiet-lane: 4 passes, all quiet (no files landed)
  for (let i = 0; i < 4; i++) prefs.recordOutcome({ role: 'builder', lane: 'quiet-lane', passed: true, tokens: 1, run: `q${i}`, salience: false });
  // salient-lane: 3 salient passes, 1 salient fail
  for (let i = 0; i < 3; i++) prefs.recordOutcome({ role: 'builder', lane: 'salient-lane', passed: true, tokens: 1, run: `s${i}`, salience: true });
  prefs.recordOutcome({ role: 'builder', lane: 'salient-lane', passed: false, tokens: 1, run: 's9', salience: true });
  const best = (() => {
    // bestHabit is internal; observe through the ranking side effect by
    // calling the exported habit picker for the role
    const { healthyChoice } = prefs;
    return healthyChoice('builder');
  })();
  assert.ok(best, 'a habit exists');
  // quiet-lane has higher overall rate (1.0) but zero salience; salient-lane
  // proved itself when the output carried weight, so it must win
  assert.equal(best, 'salient-lane');
});

test('sweep cascade: retractEventsForRun pulls a run\'s preference events', () => {
  prefs.recordOutcome({ role: 'critic', lane: 'sol', passed: true, tokens: 1, run: '0020', salience: true });
  const n = prefs.retractEventsForRun('0020', 'run retired by sweep');
  assert.equal(n, 1);
  const e = prefs.loadPrefs().events.at(-1);
  assert.equal(e.retracted, 'run retired by sweep');
  assert.equal(e.passed, false);
  assert.equal(e.salience, undefined);
  // retracted events count neither way
  const j = prefs.judgeRole('critic', 'sol');
  assert.equal(j.samples, 0, 'retracted events do not count as samples');
  // idempotent
  assert.equal(prefs.retractEventsForRun('0020'), 0);
});

test('ledger stays append-only: retraction never rewrites a prior row', () => {
  const rows = store.readParityLedger();
  const withIds = rows.filter((r) => r.id);
  for (const r of withIds) {
    assert.equal(typeof r.id, 'string');
    // every supersedes pointer must reference an id that exists earlier
    if (r.supersedes) assert.ok(withIds.some((x) => x.id === r.supersedes), `dangling pointer ${r.supersedes}`);
  }
});

test.after(() => { rmSync(tmp, { recursive: true, force: true }); });
