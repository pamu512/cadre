// watch - attach to a live run. LOCAL runs: tail $CADRE_HOME/runs/<id>/run.log
// until status settles. AX runs (run-YYYYMMDD-HHMMSS-nnnn): tail the real log
// under ~/.config/ax/runs. No invented event streams.
import { tryReadRun, runsDir, runLogPath, home } from '../store.js';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const AX_RUN_RE = /^run-\d{8}-\d{6}-\d+$/;
const AX_RUNS = join(homedir(), '.config/ax/runs');
const SETTLED = ['passed', 'rejected', 'failed', 'retired', 'resumed-brief'];

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

export async function cmdWatch(args, flags) {
  const runId = args[0];
  if (!runId) {
    console.log('cadre watch <run-id> - attach to a live run');
    console.log(`  local: an id under ${runsDir()} · ax: run-YYYYMMDD-HHMMSS-nnnn`);
    return 0;
  }

  if (AX_RUN_RE.test(runId)) {
    const p = join(AX_RUNS, runId + '.log');
    if (!existsSync(p)) { console.error(`no ax log at ${p}`); return 1; }
    console.log(`watching ax run ${runId} (log: ${p})`);
    const content = readFileSync(p, 'utf-8');
    // ax run logs are complete once written; print the tail
    const lines = content.split('\n');
    for (const l of lines.slice(-40)) console.log(l);
    console.log(`--- end of log (${lines.length} lines) - ax writes runs complete-once`);
    return 0;
  }

  const run = tryReadRun(runId);
  if (!run) { console.error(`no run ${runId} under ${runsDir()}`); return 1; }

  const log = runLogPath(runId);
  console.log(`watching run ${runId} (${log})`);
  let lastSize = existsSync(log) ? statSync(log).size : 0;
  // print what's already there
  if (lastSize > 0) process.stdout.write(readFileSync(log, 'utf-8').slice(Math.max(0, lastSize - 2000)));

  const deadline = Date.now() + (Number(flags.timeout) || 120) * 1000;
  while (Date.now() < deadline) {
    await sleep(1500);
    const cur = tryReadRun(runId);
    if (!cur) break;
    const size = existsSync(log) ? statSync(log).size : 0;
    if (size > lastSize) {
      const fd = readFileSync(log, 'utf-8');
      process.stdout.write(fd.slice(lastSize));
      lastSize = size;
    }
    if (SETTLED.includes(cur.status)) {
      console.log(`\n--- run ${runId} settled: ${cur.status} ---`);
      return 0;
    }
  }
  console.log(`\n--- still ${tryReadRun(runId)?.status || 'unknown'} after ${Number(flags.timeout) || 120}s (watch detached) ---`);
  return 0;
}
