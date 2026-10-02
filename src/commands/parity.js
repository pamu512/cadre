// parity - build to parity against a cited reference. This command runs a
// REAL ax build whose completion check cites the reference (--ref). The loop
// count and pass state come from the ax run itself, not from a script.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { existsSync, appendFileSync, mkdirSync } from 'node:fs';
import { createRun, updateRun, appendLog, addEvidence, audit, home } from '../store.js';

const run = promisify(execFile);
const AX = process.env.CADRE_AX || join(homedir(), '.local/bin/ax');

export async function cmdParity(args, flags) {
  // B6: cadre parity --ledger renders the parity ledger (no build)
  if (flags.ledger) {
    const { readFileSync } = await import('node:fs');
    const p = join(home(), 'parity-ledger.jsonl');
    if (!existsSync(p)) { console.log(`no parity ledger yet (${p})`); return 0; }
    const lines = readFileSync(p, 'utf-8').split('\n').filter(Boolean);
    console.log(`parity ledger · ${lines.length} entr${lines.length === 1 ? 'y' : 'ies'} (${p})`);
    for (const l of lines) {
      try {
        const e = JSON.parse(l);
        console.log(`  ${e.ts}  run ${e.run}  ${String(e.verdict).padEnd(8)} ref ${(e.ref || '—').padEnd(24)} ${e.evidence_count} ev ${e.citation || ''}`);
      } catch { console.log(`  (unparseable line: ${l.slice(0, 60)})`); }
    }
    return 0;
  }
  const target = args.join(' ').trim();
  if (!target) {
    console.error('cadre parity "<outcome>" --ref <reference>');
    return 2;
  }
  if (!flags.ref) {
    console.error('missing --ref: parity requires a reference to build against');
    return 2;
  }
  if (!existsSync(AX)) {
    console.error(`cadre: ax not found at ${AX} - parity drives a real build`);
    return 1;
  }
  const ref = String(flags.ref);
  const refExists = existsSync(ref);
  if (!refExists && !/^[\w./-]+$/.test(ref)) {
    console.error(`--ref "${ref}" is neither a file on disk nor a reference id`);
    return 1;
  }

  const record = createRun({ brief: `parity: ${target} (ref ${ref})`, kind: 'parity', roles: {} });
  console.log(`cadre parity - run ${record.id} · target: ${target}`);
  console.log(`ref: ${ref}${refExists ? ' (file on disk)' : ' (reference id)'}`);

  const task = [
    `Build to parity: ${target}.`,
    refExists
      ? `Reference (read it first): ${ref}. Match its observable behavior; cite the lines you matched.`
      : `Reference id: ${ref}. Cite it in the completion notes.`,
    'The run is done only when the evidence gate passes.',
  ].join('\n');

  appendLog(record.id, `PARITY ref=${ref}`);
  audit({ kind: 'parity-start', run: record.id, ref });
  // B6 parity ledger: this run's outcome gets appended to parity-ledger.jsonl
  const appendLedger = (verdict) => {
    const ledgerPath = join(home(), 'parity-ledger.jsonl');
    mkdirSync(home(), { recursive: true });
    appendFileSync(ledgerPath, JSON.stringify({
      ts: new Date().toISOString(),
      run: record.id,
      target: target.slice(0, 200),
      ref,
      verdict,
      evidence_count: (record.evidence || []).length,
      citation: axRunOfVerdict,
    }) + '\n');
  };
  let axRunOfVerdict = null;

  try {
    const axArgs = ['build', task];
    if (flags.override) axArgs.push('--override');
    const { stdout } = await run(AX, axArgs, { timeout: 1000 * 60 * 30, maxBuffer: 1024 * 1024 * 32 });
    process.stdout.write(stdout.split('\n').slice(-25).join('\n').replace(/^/gm, '  ') + '\n');
    const axRun = /run-\d{8}-\d{6}-\d+/.exec(stdout);
    axRunOfVerdict = axRun ? axRun[0] : null;
    await addEvidence(record.id, { kind: 'citation', label: 'ax build log', ref: axRun ? `~/.config/ax/runs/${axRun[0]}` : 'ax build stdout (filed in run.log)' });
    appendLog(record.id, `BUILD:\n${stdout.slice(0, 20000)}`);
    // Verdict: the FINAL evidence-gate block decides — an upstream APPROVE line
    // (e.g. "pre-approved by debate") is not the verdict. UNEVIDENCED always rejects.
    const gateBlocks = stdout.split(/evidence gate/);
    const lastGate = gateBlocks.length > 1 ? gateBlocks[gateBlocks.length - 1] : '';
    const unevidenced = /UNEVIDENCED|VERDICT: (INCOMPLETE|REJECT)/i.test(lastGate);
    const approved = !unevidenced && /CONSENSUS: APPROVE/.test(lastGate);
    if (unevidenced && /CONSENSUS: APPROVE/.test(stdout)) {
      appendLog(record.id, 'GATE NOTE: upstream APPROVE line ignored - final evidence gate says UNEVIDENCED, rejecting');
    }
    updateRun(record.id, {
      status: approved ? 'passed' : 'rejected',
      verdict: { passed: approved, summary: approved ? 'ax build approved with citations' : 'ax build did not approve' },
      ended: new Date().toISOString(),
    });
    console.log(approved ? `\n✓ parity run ${record.id} - build approved; citation filed (${axRun ? axRun[0] : 'stdout'})` : `\n✗ parity run ${record.id} - build not approved`);
    appendLedger(approved ? 'approved' : 'rejected');
    return approved ? 0 : 1;
  } catch (e) {
    const out = String(e.stdout || '');
    appendLog(record.id, `BUILD FAILED: ${String(e.message).slice(0, 2000)}`);
    updateRun(record.id, { status: 'failed', ended: new Date().toISOString() });
    process.stderr.write(out.split('\n').slice(-10).join('\n') + '\n');
    console.error(`cadre: ax build failed (exit ${e.code})`);
    appendLedger('failed');
    return e.code || 1;
  }
}
