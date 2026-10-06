// retract - claim retraction with propagation (operator-facing).
// Retracting a run marks it, stains runs that folded its evidence, and
// rebuilds the derived recall index so derived memory can't re-assert
// what the ledger just pulled.
import { retractRun } from '../retract.js';
import { loadIndex } from '../recall.js';

export async function cmdRetract(args, flags) {
  const id = args[0];
  if (!id || flags.help) {
    console.log('cadre retract <run-id> --why "<reason>"');
    console.log('  marks the run retracted, stains runs that folded its evidence,');
    console.log('  rebuilds the recall index. Retracted/stale runs never count as');
    console.log('  routing history, bench history, or metrics.');
    return flags.help ? 0 : 1;
  }
  const reason = typeof flags.why === 'string' && flags.why ? flags.why : 'retracted by operator';
  const report = retractRun(id, reason);
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
  // derived memory: rebuild so the index reflects the retraction immediately
  loadIndex({ rebuild: true });
  console.log('  recall index rebuilt');
  return 0;
}
