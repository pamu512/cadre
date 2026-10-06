// retract + recall: retraction propagates through folds, consumers exclude
// retracted/stale, and the recall index is a pure derivation of the ledger.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const HOME = mkdtempSync(join(tmpdir(), 'cadre-retract-'));
process.env.CADRE_HOME = HOME;

const { createRun, updateRun, addEvidence, tryReadRun } = await import('../src/store.js');
const { retractRun, foldingDescendants } = await import('../src/retract.js');
const { buildIndex, queryIndex } = await import('../src/recall.js');
const { historyFor } = await import('../src/taskfit.js');

test.after(() => rmSync(HOME, { recursive: true, force: true }));

function seedRun({ status = 'passed', brief = 'fix src/auth.js login bug', lane = 'lane-a', foldedFrom = null } = {}) {
  const r = createRun({ brief, kind: 'go', roles: { builder: lane } });
  if (foldedFrom) {
    // evidence folded from another run carries foldedFrom
    const donor = tryReadRun(foldedFrom);
    for (const ev of donor.evidence || []) { /* donor has none; fold explicitly */ }
    updateRun(r.id, {
      evidence: [{ kind: 'citation', label: 'folded', ref: `runs/${r.id}/run.log`, foldedFrom }],
      status, ended: new Date().toISOString(),
    });
  } else {
    updateRun(r.id, {
      status, ended: new Date().toISOString(),
      evidence: [{ kind: 'command', label: 'npm test', ref: 'npm test' }],
    });
  }
  return tryReadRun(r.id);
}

test('retract marks the run, records prior status and reason', () => {
  const r = seedRun();
  const report = retractRun(r.id, 'evidence was fabricated');
  assert.equal(report.already, false);
  assert.equal(report.priorStatus, 'passed');
  const after = tryReadRun(r.id);
  assert.equal(after.status, 'retracted');
  assert.equal(after.retractReason, 'evidence was fabricated');
  // idempotent
  const again = retractRun(r.id, 'again');
  assert.equal(again.already, true);
});

test('retraction stains runs that folded the retracted run, cascading', () => {
  const base = seedRun({ brief: 'create fixture file' });
  const child = seedRun({ brief: 'continue work', lane: 'lane-b', foldedFrom: base.id });
  const grandchild = seedRun({ brief: 'continue more work', lane: 'lane-c', foldedFrom: child.id });
  const report = retractRun(base.id, 'pulled');
  assert.deepEqual(report.stained.sort(), [child.id, grandchild.id].sort());
  assert.equal(tryReadRun(child.id).status, 'stale');
  assert.equal(tryReadRun(grandchild.id).status, 'stale');
  assert.ok(tryReadRun(grandchild.id).staleBecause.includes(base.id));
  // descendants helper agrees
  assert.deepEqual(foldingDescendants(base.id).map((r) => r.id), [child.id]);
});

test('retracted/stale runs never count as bench history', () => {
  const clean = seedRun({ brief: 'fix the failing test in ui component', lane: 'lane-h' });
  const pulled = seedRun({ brief: 'fix the failing test in ui component', lane: 'lane-h' });
  retractRun(pulled.id, 'not evidence');
  const stats = historyFor([], ['tests']);
  const h = stats.get('lane-h::tests');
  assert.ok(h, 'lane-h must appear in bench history for the clean run');
  assert.equal(h.runs, 1); // only the clean run counts
  assert.equal(h.passed, 1);
});

test('recall index excludes nothing settled, is queryable by file/lane/status', () => {
  const r = seedRun({ brief: 'edit src/router.js scoring' });
  retractRun(r.id, 'pulled');
  const rows = buildIndex();
  const retracted = rows.filter((x) => x.id === r.id);
  assert.equal(retracted.length, 1);
  assert.equal(retracted[0].status, 'retracted');
  // query by status (other tests in this home may have retracted runs too)
  const byStatus = queryIndex({ rows }, { status: 'retracted' }).map((x) => x.id);
  assert.ok(byStatus.includes(r.id));
  assert.ok(byStatus.every((id) => tryReadRun(id).status === 'retracted'));
  // query by lane
  assert.ok(queryIndex({ rows }, { lane: 'lane-a' }).length >= 1);
});

test('recall rebuilds to identical rows from the ledger alone', () => {
  const a = buildIndex();
  const b = buildIndex();
  assert.deepEqual(a, b); // pure derivation: same ledger, same index
});
