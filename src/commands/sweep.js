// sweep - triage leftover runs. Reads REAL run records; a leftover is any
// run still in running/interrupted/gating. --all includes settled ones.
// --retire <id> marks a leftover retired (settled, verdict recorded as such);
// --resume <id> just marks it back running so `go` continues fresh (cadre
// runs are not resumable mid-pipeline; resume = re-brief).
import { listRuns, updateRun, home } from '../store.js';
import { audit } from '../store.js';

const LEFTOVER = ['running', 'interrupted', 'gating'];

export async function cmdSweep(args, flags) {
  if (flags.retire) {
    const id = String(flags.retire);
    const run = listRuns().find((r) => r.id === id);
    if (!run) { console.error(`no run ${id} under ${home()}`); return 1; }
    if (!LEFTOVER.includes(run.status)) { console.log(`run ${id} is ${run.status} - nothing to sweep`); return 0; }
    updateRun(id, { status: 'retired', ended: new Date().toISOString(), verdict: { passed: false, summary: 'retired by sweep' } });
    audit({ kind: 'sweep-retire', run: id });
    console.log(`run ${id} retired (was ${run.status})`);
    return 0;
  }
  if (flags.resume) {
    const id = String(flags.resume);
    const run = listRuns().find((r) => r.id === id);
    if (!run) { console.error(`no run ${id} under ${home()}`); return 1; }
    updateRun(id, { status: 'resumed-brief', ended: new Date().toISOString() });
    audit({ kind: 'sweep-resume', run: id });
    console.log(`run ${id} marked for re-brief: cadre go "${run.brief}"`);
    return 0;
  }

  const runs = listRuns();
  const show = flags.all ? runs : runs.filter((r) => LEFTOVER.includes(r.status) || r.status === 'resumed-brief');
  if (show.length === 0) {
    console.log(`nothing rotting · ${runs.length} run(s) recorded, all settled`);
    console.log('cadre sweep --all to list every run');
    return 0;
  }
  console.log(`${show.length} run(s) needing attention:`);
  for (const r of show) {
    const dur = r.started ? `· started ${r.started.slice(0, 19).replace('T', ' ')}` : '';
    console.log(`  ${r.id}  ${String(r.status).padEnd(12)} ${dur} · ${r.brief?.slice(0, 60)}`);
    if (LEFTOVER.includes(r.status)) {
      console.log(`      -> cadre sweep --retire ${r.id}   or   cadre sweep --resume ${r.id}`);
    }
  }
  return 0;
}
