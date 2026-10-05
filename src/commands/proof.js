// proof - the evidence bundle. Accepts a LOCAL run id (under $CADRE_HOME/runs)
// or a full ax run id (run-YYYYMMDD-HHMMSS-xxxx; reads ~/.config/ax/runs when
// present). Every artifact path printed exists on disk at print time.
import { tryReadRun, home, runsDir, runLogPath, runDir } from '../store.js';
import { existsSync, readFileSync, statSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { gateVerdict, renderGateReport, verifyCommands, EVIDENCE_FAMILIES } from '../gate.js';

const AX_RUN_RE = /^run-\d{8}-\d{6}-\d+$/;
const AX_RUNS = join(homedir(), '.config/ax/runs');

function fmtBytes(n) {
  if (n > 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n > 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}

export async function cmdProof(args, flags) {
  const runId = args[0];
  if (!runId) {
    console.log('cadre proof <run-id> - evidence bundle of a run');
    console.log(`  local run ids: 0001.. under ${runsDir()}`);
    if (existsSync(AX_RUNS)) console.log(`  ax run ids: run-YYYYMMDD-HHMMSS-nnnn under ${AX_RUNS}`);
    return 0;
  }

  if (AX_RUN_RE.test(runId)) {
    const candidates = [runId + '.log', runId, runId + '.gate.txt'];
    let found = null;
    for (const c of candidates) {
      const p = join(AX_RUNS, c);
      if (existsSync(p)) { found = p; break; }
    }
    if (!found) {
      console.error(`no ax run ${runId} under ${AX_RUNS}`);
      const avail = existsSync(AX_RUNS)
        ? readdirSync(AX_RUNS).filter((f) => f.startsWith('run-')).slice(-3).join(', ')
        : '';
      console.error(`recent: ${avail || '(ax runs dir absent)'}`);
      return 1;
    }
    const st = statSync(found);
    const content = readFileSync(found, 'utf-8');
    const verdict = /## CONSENSUS: (APPROVE|REJECT)/.exec(content);
    console.log(`ax run ${runId}`);
    console.log(`  log: ${found} (${fmtBytes(st.size)})`);
    if (verdict) console.log(`  consensus: ${verdict[1]}`);
    console.log(`  --- head ---`);
    for (const l of content.split('\n').slice(0, 15)) console.log('  ' + l);
    console.log(`  (${content.split('\n').length} lines total - open the log for the full trail)`);
    return 0;
  }

  const run = tryReadRun(runId);
  if (!run) {
    console.error(`no run ${runId} under ${runsDir()}`);
    console.error('cadre proof (no arg) lists what exists');
    return 1;
  }

  console.log(`run ${run.id} · ${run.brief}`);
  console.log(`  status: ${run.status} · started ${run.started}`);
  if (run.roles && Object.keys(run.roles).length) {
    console.log(`  roles: ${Object.entries(run.roles).map(([r, l]) => `${r}=${l}`).join(' ')}`);
  }

  const log = runLogPath(run.id);
  if (existsSync(log)) console.log(`  log: ${log} (${fmtBytes(statSync(log).size)})`);

  if (Array.isArray(run.evidence)) {
    console.log(`  evidence: ${run.evidence.length} item(s)`);
    for (const e of run.evidence) {
      const parts = [`    ${e.kind.padEnd(9)}`];
      if (e.kind === 'command') parts.push(`exit ${e.exit} · ${e.command}`);
      else if (e.kind === 'diff') parts.push(`+${e.plus} -${e.minus} · ${e.path}`);
      else if (e.kind === 'artifact') {
        const ok = existsSync(e.path);
        parts.push(`${ok ? 'exists' : 'MISSING'} · ${e.path}`);
      } else if (e.kind === 'citation') parts.push(e.ref);
      console.log(parts.join(' '));
    }
  }

  // re-verify against the run's OWN cwd (recorded at creation) - a proof must
  // be checkable from the record alone, not from wherever proof happens to run
  const runCwd = run?.meta?.cwd || process.cwd();
  const gate = gateVerdict(run, { cwd: runCwd });
  console.log(renderGateReport(gate).replace(/^/gm, '  '));

  // --verify (PRD 6.3): cross-check the bundle against reality — artifacts on
  // disk, commands actually re-run. This is the false-DONE audit.
  if (flags.verify) {
    console.log('  verify (re-checking against reality):');
    let fails = 0;
    for (const e of run.evidence || []) {
      if (e.kind === 'artifact') {
        const ok = existsSync(e.path);
        if (!ok) { fails += 1; console.log(`    ✗ artifact missing: ${e.path}`); }
      }
    }
    // --verify re-runs the claimed commands against reality regardless of
    // the recorded verdict - the audit does not trust the record's own grade
    {
      const reverified = await verifyCommands(run, { cwd: run?.meta?.cwd || process.cwd(), max: 3 });
      for (const rv of reverified) {
        if (!rv.ok) { fails += 1; console.log(`    ✗ re-run failed (exit ${rv.reexit}): ${rv.command}`); }
        else console.log(`    ✓ re-run clean: ${rv.command}`);
      }
    }
    console.log(fails === 0 ? '    ✓ bundle verified against reality' : `    ✗ ${fails} verification failure(s)`);
    return fails === 0 ? 0 : 3; // 3 = bundle failed reality checks (distinct from 1 = run not passed)
  }

  if (run.usage && Object.keys(run.usage).length) {
    console.log(`  usage: ${JSON.stringify(run.usage)}`);
  }
  return run.status === 'passed' ? 0 : (run.status === 'retired' || run.status === 'failed' ? 1 : 0);
}
