// retract - claim retraction with propagation (operator-facing).
// Retracting a run marks it, stains runs that folded its evidence, and
// rebuilds the derived recall index so derived memory can't re-assert
// what the ledger just pulled.
import { retractRun } from '../retract.js';

export async function cmdRetract(args, flags) {
  const id = args[0];
  if (!id || flags.help) {
    console.log('cadre retract <run-id> --why "<reason>"');
    console.log('  the one retraction engine: marks the run, stains runs that folded its');
    console.log('  evidence, pulls parity claims / preference events / hand-memory verdicts');
    console.log('  citing it, and rebuilds every derived cache (recall index, hand cards).');
    console.log('  Retracted/stale runs never count as routing history, bench history, or metrics.');
    return flags.help ? 0 : 1;
  }
  const reason = typeof flags.why === 'string' && flags.why ? flags.why : 'retracted by operator';
  const report = await retractRun(id, reason);
  if (report.already) {
    console.log(`run ${id} already retracted (${report.reason}) - nothing to do`);
    return 0;
  }
  console.log(`run ${id} retracted (was ${report.priorStatus}) · reason: ${reason}`);
  if (report.stained.length) {
    console.log(`  stained (evidence base pulled): ${report.stained.join(', ')}`);
  } else {
    console.log('  no runs folded this evidence - nothing stained');
  }
  const c = report.cascades || {};
  const parts = [];
  if (c.parityClaims) parts.push(`${c.parityClaims} parity claim(s)`);
  if (c.preferences) parts.push(`${c.preferences} preference event(s)`);
  if (c.handMemory) parts.push(`${c.handMemory} hand-memory verdict(s)`);
  console.log(parts.length ? `  cascades pulled: ${parts.join(', ')}` : '  no derived claims cited this run');
  if (c.recallIndex) console.log('  recall index rebuilt');
  if (c.handStats) console.log(`  ${c.handStats} capability stat block(s) recomputed`);
  return 0;
}
