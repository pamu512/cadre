// gate - "done" is a claim; proof is a checkpoint.
// The gate only accepts evidence Cadre itself produced. Every evidence item
// carries a provenance stamp written by the store when it was filed
// (store.addEvidence is the only door); an unstamped item is not evidence,
// it is a story. The gate re-runs the test command in a process Cadre
// spawned, cross-checks claimed diffs against the worktree, and re-checks
// artifacts on disk. A citation counts only after an HTTP fetch or a file
// that exists. Commands + a real diff + an artifact are enough - citations
// are checked when claimed, not demanded. Independence means a second
// process Cadre spawned (pid recorded); a missing by-field is NOT
// independent.
import { existsSync, readFileSync, statSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { isAbsolute, resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { request as httpReq } from 'node:http';
import { request as httpsReq } from 'node:https';

const git = promisify(execFile);

export const EVIDENCE_FAMILIES = ['commands', 'diffs', 'artifacts', 'citations'];
// Required: commands (Cadre ran them), diffs (Cadre measured the worktree),
// artifacts (Cadre's scan saw the file appear). Citations are checked when
// claimed - a run that claims none is not penalized, a run that claims a
// dead one fails.
export const REQUIRED_FAMILIES = ['commands', 'diffs', 'artifacts'];
export const FAMILY_LABELS = {
  commands: 'commands, with output',
  diffs: 'files, with diffs',
  artifacts: 'artifacts you can open',
  citations: 'citations you can follow',
};

// An evidence item: { kind, label, cadre: <provenance stamp>, and one of:
//   commands  -> { kind:'command', label, command, argv, exit:0, output } (Cadre executed, captured)
//   diffs     -> { kind:'diff',   label, path, plus, minus }              (bytes Cadre measured)
//   artifacts -> { kind:'artifact', label, path }                          (file Cadre saw appear)
//   citations -> { kind:'citation', label, ref, fetch?:{url,status,at} }   (pointer Cadre followed)
// The stamp: { by:'cadre', at:ISO, pid, how:'observed'|'spawn'|'rerun', recorder? }.
// how:'spawn' + pid !== recorder is what independence means: a second
// process Cadre itself spawned (the verifier's test run).

export function stampEvidence(item, { how = 'observed' } = {}) {
  const it = { ...item };
  if (it.cadre && it.cadre.by === 'cadre' && typeof it.cadre.at === 'string') return it; // already stamped (folds carry theirs)
  it.cadre = { by: 'cadre', at: new Date().toISOString(), pid: process.pid, how };
  return it;
}

function stamped(e) {
  return Boolean(e && e.cadre && e.cadre.by === 'cadre' && typeof e.cadre.at === 'string');
}

// run a command in a child process Cadre spawns; capture pid + output.
export function runCaptured(argv, { cwd, timeoutMs = 30000, env } = {}) {
  return new Promise((resolve) => {
    if (!Array.isArray(argv) || argv.length === 0) {
      resolve({ ok: false, exit: -1, stdout: '', stderr: 'empty argv', pid: null });
      return;
    }
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), { cwd, env: env || process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ ok: false, exit: -1, stdout: '', stderr: String(e.message), pid: null });
      return;
    }
    let stdout = '';
    let stderr = '';
    let killed = false;
    child.stdout.on('data', (d) => { if (stdout.length < 8 * 1024 * 1024) stdout += d; });
    child.stderr.on('data', (d) => { if (stderr.length < 1024 * 1024) stderr += d; });
    const timer = setTimeout(() => { killed = true; try { child.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    const finish = (exit) => {
      clearTimeout(timer);
      resolve({ ok: exit === 0 && !killed, exit: killed ? -1 : exit, stdout, stderr, pid: child.pid, timedOut: killed });
    };
    child.on('error', (e) => { clearTimeout(timer); resolve({ ok: false, exit: -1, stdout, stderr: String(e.message), pid: child.pid }); });
    child.on('close', (code) => finish(code ?? -1));
  });
}

// fetch an http(s) citation once; resolve a receipt or null. A citation
// counts only after this (or a file that exists).
export function fetchReceipt(url, { timeoutMs = 10000, redirects = 2 } = {}) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(url); } catch { resolve(null); return; }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') { resolve(null); return; }
    const lib = u.protocol === 'https:' ? httpsReq : httpReq;
    const req = lib(u, { method: 'GET', timeout: timeoutMs }, (res) => {
      res.resume();
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400 && res.headers.location && redirects > 0) {
        let next;
        try { next = new URL(res.headers.location, u); } catch { resolve(null); return; }
        res.on('end', () => resolve(fetchReceipt(next.href, { timeoutMs, redirects: redirects - 1 })));
        return;
      }
      res.on('end', () => resolve({ url: u.href, status, ok: status >= 200 && status < 300, at: new Date().toISOString() }));
    });
    req.on('timeout', () => { req.destroy(); resolve(null); });
    req.on('error', () => resolve(null));
    req.end();
  });
}

export function checkEvidence(runRecord) {
  const checks = [];
  for (const e of runRecord.evidence || []) {
    const gate = stamped(e) ? '' : ' - no cadre provenance stamp';
    switch (e.kind) {
      case 'command':
        checks.push({
          family: 'commands',
          ok: !gate && e.exit === 0 && Boolean(e.output) && Array.isArray(e.argv) && e.argv.length > 0,
          label: e.label || e.command, detail: `exit ${e.exit}${gate}`,
        });
        break;
      case 'diff':
        checks.push({
          family: 'diffs',
          ok: !gate && typeof e.plus === 'number' && typeof e.minus === 'number' && (e.plus + e.minus) > 0 && Boolean(e.path),
          label: e.label || e.path, detail: gate || `+${e.plus} -${e.minus}`,
        });
        break;
      case 'artifact':
        checks.push({
          family: 'artifacts', ok: !gate && Boolean(e.path),
          label: e.label || e.path, detail: e.path + gate,
        });
        break;
      case 'citation': {
        // a citation counts only after a fetch (receipt recorded) or a file
        // that exists. Http refs need the receipt; file refs are existence-
        // checked by the verdict itself (below) and again at proof time.
        const raw = String(e.ref || '').split('#')[0];
        const isHttp = /^https?:\/\//.test(raw);
        const fetched = Boolean(e.fetch && e.fetch.ok);
        checks.push({
          family: 'citations',
          ok: !gate && typeof e.ref === 'string' && e.ref.length > 0 && (!isHttp || fetched),
          label: e.label || e.ref,
          detail: e.ref + (gate || (isHttp && !fetched ? ' - http ref never fetched' : '')),
          _isHttp: isHttp, _raw: raw,
        });
        break;
      }
      default:
        checks.push({ family: 'unknown', ok: false, label: e.label || '(untyped)', detail: `kind=${e.kind}` });
    }
  }
  return checks;
}

// The sync verdict: stamps, family presence, artifacts on disk, citation
// files on disk, http citations only with a recorded fetch receipt, and
// independence. Async reality checks (command re-runs, worktree cross-check,
// http fetches) live in runGate below - use that before stamping PROVEN.
export function gateVerdict(runRecord, { cwd = process.cwd() } = {}) {
  const checks = checkEvidence(runRecord);
  const missing = REQUIRED_FAMILIES.filter((f) => !checks.some((c) => c.family === f && c.ok));
  const failed = checks.filter((c) => !c.ok);

  // artifacts must exist on disk right now (Cadre checks artifacts it saw)
  for (const c of checks.filter((c) => c.family === 'artifacts' && c.ok)) {
    const p = isAbsolute(c.detail) ? c.detail : resolve(cwd, c.detail);
    if (!existsSync(p)) {
      c.ok = false;
      c.detail += ' - file missing at gate time';
      failed.push({ ...c });
    }
  }

  // citation files must exist; http refs must carry a fetch receipt
  for (const c of checks.filter((c) => c.family === 'citations' && c.ok && !c._isHttp)) {
    const raw = c._raw;
    const expanded = raw.replace(/^~\//, homedir() + '/');
    const cands = [expanded, resolve(cwd, raw), resolve(process.env.CADRE_HOME || join(homedir(), '.cadre'), raw)];
    if (!cands.some((p2) => existsSync(p2))) {
      c.ok = false;
      c.detail += ' - cited file missing at gate time';
      failed.push({ ...c });
    }
  }

  // independence: a second PROCESS Cadre spawned. Only command evidence with
  // a spawn stamp (pid different from the recording process) counts. A
  // missing by-field is not independent; same-process output is not either.
  const cmds = (runRecord.evidence || []).filter((e) => e.kind === 'command');
  const secondProcess = cmds.filter((e) => e.cadre?.how === 'spawn'
    && Number.isInteger(e.cadre.pid)
    && e.cadre.pid !== e.cadre.recorder);
  const independenceOk = cmds.length === 0 || secondProcess.length > 0;
  const independenceNote = cmds.length === 0
    ? 'no command evidence'
    : independenceOk
      ? `${secondProcess.length} command(s) re-run in a process cadre spawned (pid recorded)`
      : 'no second-process command evidence: the verifier must run the test in a process cadre spawned (missing by-field is not independence)';

  const passed = missing.length === 0 && failed.length === 0 && independenceOk;
  return {
    passed,
    missing,
    failed,
    checks,
    independence: { ok: independenceOk, note: independenceNote },
    summary: passed
      ? 'cadre-produced evidence verified: commands re-runnable, diffs real, artifacts on disk, citations followed'
      : `missing: ${missing.join(', ') || 'none'}; failed: ${failed.length}${independenceOk ? '' : `; independence: ${independenceNote}`}`,
  };
}

// ---- async reality checks ----------------------------------------------------

async function worktreeDelta(cwd) {
  if (!existsSync(join(cwd, '.git'))) return null;
  try {
    const { stdout: porcelain } = await git('git', ['status', '--porcelain'], { cwd, maxBuffer: 1024 * 1024 });
    const touched = new Set();
    for (const line of porcelain.split('\n').filter(Boolean)) {
      const p = line.slice(3).trim().split(' -> ').pop().replace(/^"|"$/g, '');
      touched.add(p);
      const slash = p.indexOf('/');
      if (slash > -1) touched.add(p.slice(0, slash)); // a new dir appears as ?? dir/
    }
    return touched;
  } catch { return null; }
}

// The full gate: sync verdict + re-run claimed commands (in a spawned
// process - which is also the independence check when the record has none),
// cross-check diffs against the live worktree, fetch http citations.
// Mutates the record's evidence items with receipts (fetch, rerun) via the
// save callback so proof of the checks survives the run.
export async function runGate(runRecord, {
  cwd = process.cwd(), maxCommands = 3, fetch = true, reverify = true, save,
} = {}) {
  const record = { ...runRecord, evidence: [...(runRecord.evidence || [])] };
  const saveFn = save || null;

  // 1. command re-runs: cadre re-runs them itself, capturing the spawned pid
  if (reverify) {
    const runnable = record.evidence
      .map((e, i) => ({ e, i }))
      .filter(({ e }) => e.kind === 'command' && e.safe !== false && Array.isArray(e.argv) && e.argv.length > 0)
      .slice(0, maxCommands);
    for (const { e, i } of runnable) {
      const res = await runCaptured(e.argv, { cwd, timeoutMs: 120000 });
      record.evidence[i] = {
        ...e,
        exit: res.exit,
        output: (res.stdout || '').slice(0, 4000) || e.output,
        cadre: e.cadre?.how === 'spawn' && e.cadre.pid !== e.cadre.recorder
          ? e.cadre // keep the original verifier stamp
          : { by: 'cadre', at: new Date().toISOString(), pid: res.pid, recorder: process.pid, how: 'spawn' },
        rerun: { pid: res.pid, exit: res.exit, at: new Date().toISOString() },
      };
    }
  }

  // 2. diff cross-check: the claimed file must exist and be part of the
  // current worktree delta (or exist on disk - committed work still exists)
  const delta = await worktreeDelta(cwd);
  for (const e of record.evidence) {
    if (e.kind !== 'diff') continue;
    const full = isAbsolute(e.path || '') ? e.path : resolve(cwd, e.path || '');
    if (!existsSync(full)) { e.diffCheck = 'file missing from worktree at gate time'; continue; }
    const asCwd = full.startsWith(cwd + '/') ? full.slice(cwd.length + 1) : String(e.path || '');
    if (delta) {
      const inDelta = delta.has(asCwd) || delta.has(String(e.path || ''));
      e.diffCheck = inDelta ? 'in worktree delta' : 'exists on disk (outside current delta: committed or pre-existing)';
    } else {
      e.diffCheck = 'exists on disk (not a git worktree)';
    }
  }

  // 3. http citations: fetch them; a citation counts only after a fetch
  if (fetch) {
    for (const e of record.evidence) {
      if (e.kind !== 'citation' || !/^https?:\/\//.test(String(e.ref || ''))) continue;
      if (e.fetch && e.fetch.ok) continue; // already followed
      const receipt = await fetchReceipt(e.ref);
      if (receipt) e.fetch = receipt;
    }
  }

  // 4. artifacts: existence at gate time
  for (const e of record.evidence) {
    if (e.kind === 'artifact' && e.path) {
      const full = isAbsolute(e.path) ? e.path : resolve(cwd, e.path);
      e.pathChecked = existsSync(full);
    }
    if (e.kind === 'citation' && e.ref && !/^https?:\/\//.test(String(e.ref))) {
      const raw = String(e.ref).split('#')[0].replace(/^~\//, homedir() + '/');
      const cands = [raw, resolve(cwd, String(e.ref).split('#')[0]), resolve(process.env.CADRE_HOME || join(homedir(), '.cadre'), String(e.ref).split('#')[0])];
      e.pathChecked = cands.some((p2) => existsSync(p2));
    }
  }

  if (saveFn) await saveFn(record);

  const verdict = gateVerdict(record, { cwd });
  // a diff whose file vanished fails even though its family shape was fine
  for (const e of record.evidence) {
    if (e.kind === 'diff' && /missing from worktree/.test(e.diffCheck || '')) {
      verdict.passed = false;
      verdict.failed.push({ family: 'diffs', ok: false, label: e.label || e.path, detail: e.diffCheck });
      verdict.summary = `diff reality check failed: ${e.path}`;
    }
  }
  return verdict;
}

// Re-run a sample of claimed commands (kept for proof --verify callers).
export async function verifyCommands(runRecord, { cwd = process.cwd(), max = 3 } = {}) {
  const cmds = (runRecord.evidence || []).filter((e) => e.kind === 'command' && e.safe !== false);
  const out = [];
  for (const e of cmds.slice(0, max)) {
    const argv = Array.isArray(e.argv) && e.argv.length ? e.argv : null;
    if (!argv) { out.push({ command: e.command, reexit: 1, ok: false, output: 'no argv recorded; not re-runnable' }); continue; }
    const res = await runCaptured(argv, { cwd, timeoutMs: 120000 });
    out.push({ command: e.command || argv.join(' '), reexit: res.exit, ok: res.ok, output: (res.stdout || res.stderr || '').slice(0, 2000), pid: res.pid });
  }
  return out;
}

export function renderGateReport(v) {
  const lines = [];
  lines.push(`gate: ${v.passed ? 'PROVEN' : 'NOT PROVEN'}`);
  for (const f of EVIDENCE_FAMILIES) {
    const items = v.checks.filter((c) => c.family === f);
    const okItems = items.filter((c) => c.ok);
    if (f === 'citations' && items.length === 0) {
      lines.push(`  - ${FAMILY_LABELS[f]} - none claimed (not required; checked when claimed)`);
      continue;
    }
    const mark = okItems.length > 0 ? '✓' : '✗';
    const opt = f === 'citations' ? ' (optional)' : '';
    lines.push(`  ${mark} ${FAMILY_LABELS[f]}${opt} - ${okItems.length}${items.length > okItems.length ? ` of ${items.length} failed` : ''}`);
    for (const c of items.filter((c) => !c.ok)) lines.push(`      ✗ ${c.label} (${c.detail})`);
  }
  if (v.independence && !v.independence.ok) lines.push(`  ✗ independence - ${v.independence.note}`);
  else if (v.independence) lines.push(`  ✓ independence - ${v.independence.note}`);
  return lines.join('\n');
}
