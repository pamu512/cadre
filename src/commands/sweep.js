// sweep - triage leftover runs. Reads REAL run records; a leftover is any
// run still in running/interrupted/gating. --all includes settled ones.
// --retire <id> marks a leftover retired (settled, verdict recorded as such);
// --resume <id> just marks it back running so `go` continues fresh (cadre
// runs are not resumable mid-pipeline; resume = re-brief).
import { listRuns, updateRun, home, tryReadRun, runDir, lockPath, hasLock, readRun } from '../store.js';
import { audit } from '../store.js';
import { writeFileSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const LEFTOVER = ['running', 'interrupted', 'gating'];

function pidAlive(pid) {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

// evidence snapshot (PRD 6.5): what the run had when it stalled — lock info,
// git HEAD at the time (if recorded), log tail, evidence count. Filed into the
// run dir so a triage decision is never made blind.
function snapshot(id) {
  const r = tryReadRun(id);
  if (!r) return null;
  const snap = {
    id,
    status: r.status,
    started: r.started,
    brief: r.brief,
    roles: r.roles,
    evidence_count: (r.evidence || []).length,
    usage: r.usage,
    lock_present: hasLock(id),
    log_tail: (() => {
      const p = join(runDir(id), 'run.log');
      try { return readFileSync(p, 'utf-8').split('\n').slice(-8).join('\n'); } catch { return '(none)'; }
    })(),
    taken: new Date().toISOString(),
  };
  writeFileSync(join(runDir(id), 'sweep-snapshot.json'), JSON.stringify(snap, null, 2));
  return snap;
}

export async function cmdSweep(args, flags) {
  // C6: --release frees stale ax registry claims (killed builds leave
  // auto-claimed orphans that block re-runs until released)
  if (flags.release) {
    const AX = process.env.CADRE_AX || join(homedir(), '.local/bin/ax');
    if (!existsSync(AX)) { console.error('cadre: ax not found - nothing to release'); return 1; }
    try {
      const { stdout } = await run(AX, ['work', 'list'], { timeout: 15000 });
      const active = stdout.split('\n').filter((l) => /\[active\]/.test(l));
      if (active.length === 0) { console.log('no [active] registry entries - nothing to release'); return 0; }
      let n = 0;
      for (const line of active) {
        const m = /\s(w-\S+)\s/.exec(line);
        if (!m) continue;
        try { await run(AX, ['work', 'release', '--id', m[1]], { timeout: 15000 }); console.log(`released ${m[1]}`); n++; }
        catch (e) { console.log(`could not release ${m[1]}: ${String(e.message).split('\n')[0]}`); }
      }
      audit({ kind: 'sweep-release', count: n });
      return n === active.length ? 0 : 1;
    } catch (e) {
      console.error(`cadre: ax work list failed: ${String(e.message).split('\n')[0]}`);
      return 1;
    }
  }

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
    // B7 resume honesty: emit a resume-plan artifact — evidence kept, steps not
    // yet logged, the exact re-brief command. No magic mid-pipeline resume.
    const logged = (() => {
      try { return readFileSync(join(runDir(id), 'run.log'), 'utf-8'); } catch { return ''; }
    })();
    const stepsLogged = ['PLAN', 'BUILD', 'CRITIQUE', 'VERIFY', 'GATE'].filter((s) => logged.includes(s));
    const stepsRemaining = ['PLAN', 'BUILD', 'CRITIQUE', 'VERIFY', 'GATE'].filter((s) => !stepsLogged.includes(s));
    const plan = {
      id,
      brief: run.brief,
      evidence_kept: (run.evidence || []).map((e) => ({ kind: e.kind, label: e.label || e.path || e.ref || e.command })),
      steps_logged: stepsLogged,
      steps_remaining: stepsRemaining,
      rebrief_command: `cadre go "${String(run.brief).replace(/"/g, '\\"')}"`,
      honest_note: 'cadre runs are not resumable mid-pipeline; resume = re-brief with prior evidence attached',
      generated: new Date().toISOString(),
    };
    writeFileSync(join(runDir(id), 'resume-plan.json'), JSON.stringify(plan, null, 2));
    updateRun(id, { status: 'resumed-brief', ended: new Date().toISOString() });
    audit({ kind: 'sweep-resume', run: id });
    console.log(`run ${id} marked for re-brief: ${plan.rebrief_command}`);
    console.log(`  resume plan: ${join(runDir(id), 'resume-plan.json')} (${plan.evidence_kept.length} evidence kept, ${plan.steps_remaining.length} step(s) remaining)`);
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
    const lock = hasLock(r.id) ? ' · lock held' : '';
    const dead = hasLock(r.id) && !pidAlive(tryReadRun(r.id)?.meta?.pid) ? ' (pid gone - crashed or killed)' : '';
    console.log(`  ${r.id}  ${String(r.status).padEnd(12)} ${dur}${lock}${dead} · ${r.brief?.slice(0, 60)}`);
    if (LEFTOVER.includes(r.status)) {
      const snap = snapshot(r.id);
      if (snap) console.log(`      snapshot filed: ${join(runDir(r.id), 'sweep-snapshot.json')} (${snap.evidence_count} evidence items kept)`);
      console.log(`      -> cadre sweep --retire ${r.id}   or   cadre sweep --resume ${r.id}`);
    }
  }
  return 0;
}
