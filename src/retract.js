// retract - retraction with propagation. A run whose evidence is retracted
// must not keep influencing routing, benches, or metrics: retracting marks the
// run itself, stains every run that FOLDED its evidence, and rebuilds the
// derived recall index. Corrections are visible in the ledger, never silent.
import { listRuns, tryReadRun, updateRun, audit, appendLog, retractParityClaimsForRun } from './store.js';

export const RETRACTED = 'retracted';
export const STALE = 'stale';

// Direct descendants: runs that folded this run's evidence into themselves.
export function foldingDescendants(id) {
  return listRuns().filter((r) =>
    (r.evidence || []).some((e) => e.foldedFrom === id));
}

// ONE retraction engine, many doors (cadre retract, sweep --forget): the run
// is marked, fold descendants stained, and EVERY derived surface that cites it
// is pulled - parity claims, preference events, hand-memory verdicts - then
// both derived caches (recall index, capability cards) regenerate. Retracted
// claims stop counting everywhere; the ledger itself stays append-only.
export async function retractRun(id, reason = 'retracted by operator') {
  const target = tryReadRun(id);
  if (!target) throw new Error(`no run record ${id}`);
  if (target.status === RETRACTED) {
    return { id, already: true, stained: [], reason: target.retractReason || reason };
  }
  const priorStatus = target.status;
  updateRun(id, {
    status: RETRACTED,
    ended: new Date().toISOString(),
    retractedAt: new Date().toISOString(),
    retractReason: reason,
    priorStatus,
  });
  appendLog(id, `RETRACTED (${reason}); prior status ${priorStatus}`);
  audit({ kind: 'run-retract', run: id, reason, priorStatus });

  // derived claim cascades: everything that cites this run is pulled with it.
  // Each surface is best-effort (a missing ledger must not kill retraction)
  // but every non-zero cascade is reported - silence here would be a lie.
  const cascades = {};
  try {
    const { retractEventsForRun } = await import('./preferences.js');
    cascades.preferences = retractEventsForRun(id, reason);
  } catch { /* no preference ledger */ }
  try {
    const { retractHandRun } = await import('./invoke.js');
    if (typeof retractHandRun === 'function') cascades.handMemory = retractHandRun(id);
  } catch { /* no hand memory */ }
  try {
    cascades.parityClaims = retractParityClaimsForRun(id, reason);
  } catch { /* no parity ledger */ }

  // propagate: every run that folded this one's evidence is now built on a
  // retracted base - mark it stale (kept, never deleted: the ledger is
  // append-honest) with the cause recorded. Stale runs stop counting as
  // history the moment consumers exclude RETRACTED/STALE (router already
  // filters by explicit status list; taskfit/metrics get guards too).
  const stained = [];
  const queue = [id];
  const seen = new Set();
  while (queue.length) {
    const cur = queue.shift();
    for (const child of foldingDescendants(cur)) {
      if (seen.has(child.id) || child.id === id) continue;
      seen.add(child.id);
      const causes = new Set([...(child.staleBecause || []), id]);
      updateRun(child.id, { status: STALE, staleBecause: [...causes] });
      appendLog(child.id, `STALE: evidence base retracted (run ${cur})`);
      audit({ kind: 'run-stale', run: child.id, because: cur });
      stained.push(child.id);
      queue.push(child.id); // retraction cascades through fold chains
    }
  }
  // derived caches regenerate from the surviving ledger: rebuild IS the
  // propagation for anything derived (it can never outlive its evidence).
  try {
    const { loadIndex } = await import('./recall.js');
    loadIndex({ rebuild: true });
    cascades.recallIndex = 'rebuilt';
  } catch { /* index rebuild is best-effort */ }
  try {
    const { allHandStats } = await import('./derive.js');
    cascades.handStats = allHandStats().length;
  } catch { /* no hand ledgers */ }
  return { id, already: false, priorStatus, stained, cascades, reason };
}
