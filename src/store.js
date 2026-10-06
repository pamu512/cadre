// store - local state under $CADRE_HOME (default ~/.cadre).
// Everything cadre keeps lives here: run records, pins, audit log, map cache.
// No cloud, no telemetry. runs/*.json or it didn't happen.
import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync, renameSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { stampEvidence } from './gate.js';

export function home() {
  return process.env.CADRE_HOME || join(homedir(), '.cadre');
}
export function runsDir() { return join(home(), 'runs'); }
export function auditPath() { return join(home(), 'audit.log'); }
export function pinsPath() { return join(home(), 'pins.json'); }
export function lanesDir() { return join(home(), 'lanes'); }
export function mapsDir() { return join(home(), 'maps'); }

const RUN_RE = /^\d{4}$/;

export function listRunIds() {
  const dir = runsDir();
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((d) => RUN_RE.test(d)).map(Number).sort((a, b) => a - b);
}

export function nextRunId() {
  const ids = listRunIds();
  const n = ids.length ? ids[ids.length - 1] + 1 : 1;
  return String(n).padStart(4, '0');
}

export function runDir(id) { return join(runsDir(), id); }
export function runPath(id) { return join(runDir(id), 'run.json'); }
export function runLogPath(id) { return join(runDir(id), 'run.log'); }

export function createRun({ brief, kind, roles = {}, meta = {} }) {
  const id = nextRunId();
  const dir = runDir(id);
  mkdirSync(dir, { recursive: true });
  const record = {
    id, brief, kind, status: 'running', started: new Date().toISOString(),
    roles, steps: [], evidence: [], verdict: null, usage: {}, meta,
  };
  writeFileSync(runPath(id), JSON.stringify(record, null, 2));
  appendLog(id, `run ${id} started · ${kind} · ${brief}`);
  return record;
}

// read-modify-write with atomic rename so a Ctrl-C mid-write can't corrupt a record
export function updateRun(id, patch) {
  const p = runPath(id);
  const cur = readRun(id);
  const next = { ...cur, ...patch };
  const tmp = p + '.tmp';
  writeFileSync(tmp, JSON.stringify(next, null, 2));
  renameSync(tmp, p);
  return next;
}

export function readRun(id) {
  const p = runPath(id);
  if (!existsSync(p)) throw new Error(`no run record ${id} under ${runsDir()}`);
  return JSON.parse(readFileSync(p, 'utf-8'));
}

export function tryReadRun(id) {
  try { return readRun(id); } catch { return null; }
}

export function listRuns() {
  return listRunIds().map((n) => {
    const id = String(n).padStart(4, '0');
    const r = tryReadRun(id);
    return r || { id, status: 'unreadable' };
  });
}

export function appendLog(id, line) {
  mkdirSync(runDir(id), { recursive: true });
  appendFileSync(runLogPath(id), `${new Date().toISOString()} ${line}\n`);
}

export function addEvidence(id, item) {
  const cur = readRun(id);
  // the only door: everything filed as evidence is stamped cadre-produced
  // here (folds of prior-run evidence carry their original stamp through).
  cur.evidence.push(stampEvidence(item));
  return updateRun(id, { evidence: cur.evidence });
}

// Audit trail: one JSONL line per notable event, forever appendable.
// Sanitize anything key-shaped before it hits disk.
// numeric accounting fields are never secrets: metered_tokens, budget_tokens,
// total_tokens are COUNTS. Redact only key-shaped STRING values and
// credential-ish fields that are not usage counters.
const USAGE_COUNTERS = /^(metered_tokens|budget_tokens|total_tokens|prompt_tokens|completion_tokens|cached_tokens)$/i;
export function audit(event) {
  mkdirSync(home(), { recursive: true });
  const clean = JSON.parse(JSON.stringify(event, (k, v) => {
    if (USAGE_COUNTERS.test(k)) return v;                       // counts, not secrets
    if (/key|secret|authorization|api[-_]?key/i.test(k)) return '[redacted]';
    if (/token/i.test(k) && typeof v === 'string' && v.length >= 12) return '[redacted]'; // key-shaped strings only
    return v;
  }));
  clean.ts = new Date().toISOString();
  appendFileSync(auditPath(), JSON.stringify(clean) + '\n');
}

export function loadPins() {
  const p = pinsPath();
  if (!existsSync(p)) return { roles: {}, budget: null, quiet_hours: null };
  try {
    const pins = JSON.parse(readFileSync(p, 'utf-8'));
    return { roles: {}, budget: null, quiet_hours: null, ...pins };
  } catch {
    return { roles: {}, budget: null, quiet_hours: null };
  }
}
export function savePins(pins) {
  mkdirSync(home(), { recursive: true });
  writeFileSync(pinsPath(), JSON.stringify({ roles: {}, budget: null, quiet_hours: null, ...pins }, null, 2));
}

export function lockPath(id) { return join(runDir(id), 'lock'); }

// Lock-before-work-breathes: acquire at run start, release on settle.
// A lock outliving its run (crash/kill) is what sweep triages.
export function acquireLock(id, { pid = process.pid, brief = '' } = {}) {
  mkdirSync(runDir(id), { recursive: true });
  const lock = { id, pid, brief, acquired: new Date().toISOString() };
  writeFileSync(lockPath(id), JSON.stringify(lock, null, 2));
  return lock;
}

export function releaseLock(id, reason = 'settled') {
  const p = lockPath(id);
  if (existsSync(p)) {
    appendLog(id, `lock released (${reason})`);
    try { renameSync(p, p + '.released'); } catch { /* best effort */ }
  }
}

export function hasLock(id) { return existsSync(lockPath(id)); }

export function listLockedRuns() {
  return listRunIds()
    .map((n) => String(n).padStart(4, '0'))
    .filter((id) => hasLock(id))
    .map((id) => ({ id, lock: (() => { try { return JSON.parse(readFileSync(lockPath(id), 'utf-8')); } catch { return null; } })() }));
}

export function loadMeters() {
  const p = join(home(), 'meters.json');
  if (!existsSync(p)) return [];
  try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return []; }
}

// ---- parity ledger with a supersede chain ------------------------------------
// Each row is a claim: "behavior B against ref R was closed/open, cited by C."
// When a later claim arrives for the same target+ref, it carries
// `supersedes: <claim id>` pointing at the newest prior claim. Nothing is
// rewritten (append-only); the chain is read forward through the ids, so
// `cadre proof`/`metrics` can always answer "does this closure still stand,
// or did a later verdict replace it?" instead of replaying every row.
export function parityLedgerPath() { return join(home(), 'parity-ledger.jsonl'); }

export function readParityLedger() {
  const p = parityLedgerPath();
  if (!existsSync(p)) return [];
  return readFileSync(p, 'utf-8').split('\n').filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

export function appendParityClaim(entry) {
  const rows = readParityLedger();
  const target = String(entry.target || '').trim();
  const ref = String(entry.ref || '');
  // superseded ids are knowable only by scanning (the ledger is append-only;
  // prior rows are never rewritten with a back-pointer)
  const superseded = new Set(rows.filter((r) => r.supersedes).map((r) => r.supersedes));
  const prior = [...rows].reverse().find((r) =>
    r.id && String(r.target || '').trim() === target && String(r.ref || '') === ref && !superseded.has(r.id));
  const id = 'c' + createHash('sha256').update(`${Date.now()}|${target}|${entry.verdict}|${process.pid}`).digest('hex').slice(0, 10);
  const row = {
    ...entry,
    target,
    ref,
    id,
    supersedes: prior && prior.id !== id ? prior.id : undefined,
    ts: entry.ts || new Date().toISOString(),
  };
  mkdirSync(home(), { recursive: true });
  appendFileSync(parityLedgerPath(), JSON.stringify(row) + '\n');
  return row;
}

// Current standing claims: the newest claim per target+ref (chain heads).
export function standingParityClaims() {
  const superseded = new Set();
  const rows = readParityLedger();
  for (const r of rows) if (r.supersedes) superseded.add(r.supersedes);
  return rows.filter((r) => !superseded.has(r.id));
}

// Retract every standing claim produced by a given run (sweep cascade).
// Append-only: retraction files a new claim per target+ref carrying
// verdict 'retracted' + superseding the run's prior claim, so the chain
// records both the original verdict and its withdrawal.
export function retractParityClaimsForRun(runId, why = 'run retired') {
  const rows = readParityLedger();
  const superseded = new Set(rows.filter((r) => r.supersedes).map((r) => r.supersedes));
  const heads = rows.filter((r) => r.id && !superseded.has(r.id) && r.run === runId && r.verdict !== 'retracted');
  let n = 0;
  for (const h of heads) {
    appendParityClaim({
      run: 'sweep',
      target: h.target,
      ref: h.ref,
      verdict: 'retracted',
      evidence_count: 0,
      citation: '',
      reason: `${why}: claim withdrawn (was: ${String(h.verdict).slice(0, 120)})`,
    });
    n += 1;
  }
  return n;
}
