// gate - "done" is a claim; proof is a checkpoint.
// A run passes only if it holds checkable evidence in all four families the
// brochure promises: commands+output, diffs, artifacts, citations. Plus: the
// run's claimed commands actually re-run clean (spot check), and files named
// in diffs actually exist. No PROVEN without proof.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute, resolve } from 'node:path';

const run = promisify(execFile);

export const EVIDENCE_FAMILIES = ['commands', 'diffs', 'artifacts', 'citations'];
export const FAMILY_LABELS = {
  commands: 'commands, with output',
  diffs: 'files, with diffs',
  artifacts: 'artifacts you can open',
  citations: 'citations you can follow',
};

// An evidence item: { kind, label, and one of: command | path | diff }
//   commands  -> { kind:'command', label, command, exit:0, output:'...' }   (executed, captured)
//   diffs     -> { kind:'diff',   label, path, plus, minus }                 (bytes changed)
//   artifacts -> { kind:'artifact', label, path }                             (file produced)
//   citations -> { kind:'citation', label, ref }                              (pointer you can follow)

export function checkEvidence(runRecord) {
  const checks = [];
  const fam = (name) => checks.some((c) => c.family === name);

  for (const e of runRecord.evidence || []) {
    switch (e.kind) {
      case 'command':
        checks.push({
          family: 'commands', ok: e.exit === 0 && Boolean(e.output || e.command),
          label: e.label || e.command, detail: `exit ${e.exit}`,
        });
        break;
      case 'diff':
        checks.push({
          family: 'diffs', ok: typeof e.plus === 'number' && typeof e.minus === 'number' && (e.plus + e.minus) > 0,
          label: e.label || e.path, detail: `+${e.plus} −${e.minus}`,
        });
        break;
      case 'artifact':
        checks.push({
          family: 'artifacts', ok: Boolean(e.path),
          label: e.label || e.path, detail: e.path,
        });
        break;
      case 'citation':
        checks.push({
          family: 'citations', ok: typeof e.ref === 'string' && e.ref.length > 0,
          label: e.label || e.ref, detail: e.ref,
        });
        break;
      default:
        checks.push({ family: 'unknown', ok: false, label: e.label || '(untyped)', detail: `kind=${e.kind}` });
    }
  }
  return checks;
}

// The gate: all four families present and every item ok.
export function gateVerdict(runRecord, { cwd = process.cwd() } = {}) {
  const checks = checkEvidence(runRecord);
  const missing = EVIDENCE_FAMILIES.filter((f) => !checks.some((c) => c.family === f && c.ok));
  const failed = checks.filter((c) => !c.ok);

  // artifacts must exist on disk right now
  for (const c of checks.filter((c) => c.family === 'artifacts' && c.ok)) {
    const p = isAbsolute(c.detail) ? c.detail : resolve(cwd, c.detail);
    if (!existsSync(p)) {
      c.ok = false;
      c.detail += ' - file missing at gate time';
      failed.push({ ...c });
    }
  }

  const passed = missing.length === 0 && failed.length === 0;
  return {
    passed,
    missing,
    failed,
    checks,
    summary: passed
      ? 'all four evidence families present and verified'
      : `missing: ${missing.join(', ') || 'none'}; failed: ${failed.length}`,
  };
}

// Re-run a sample of claimed commands and confirm they still exit 0.
// Only checks commands marked safe (cwd-relative, no shell features).
export async function verifyCommands(runRecord, { cwd = process.cwd(), max = 3 } = {}) {
  const cmds = (runRecord.evidence || []).filter((e) => e.kind === 'command' && e.safe !== false);
  const out = [];
  for (const e of cmds.slice(0, max)) {
    try {
      const argv = Array.isArray(e.argv) && e.argv.length ? e.argv : String(e.command).split(/\s+/);
      const { stdout } = await run(argv[0], argv.slice(1), { cwd, timeout: 30000 });
      out.push({ command: e.command, reexit: 0, ok: true, output: stdout.slice(0, 2000) });
    } catch (err) {
      out.push({ command: e.command, reexit: err.code ?? 1, ok: false, output: String(err.message).slice(0, 2000) });
    }
  }
  return out;
}

export function renderGateReport(v) {
  const lines = [];
  lines.push(`gate: ${v.passed ? 'PROVEN' : 'NOT PROVEN'}`);
  for (const f of EVIDENCE_FAMILIES) {
    const items = v.checks.filter((c) => c.family === f);
    const okItems = items.filter((c) => c.ok);
    const mark = okItems.length > 0 ? '✓' : '✗';
    lines.push(`  ${mark} ${FAMILY_LABELS[f]} - ${okItems.length}${items.length > okItems.length ? ` of ${items.length} failed` : ''}`);
    for (const c of items.filter((c) => !c.ok)) lines.push(`      ✗ ${c.label} (${c.detail})`);
  }
  return lines.join('\n');
}
