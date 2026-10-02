// store - local state under $CADRE_HOME (default ~/.cadre).
// Everything cadre keeps lives here: run records, pins, audit log, map cache.
// No cloud, no telemetry. runs/*.json or it didn't happen.
import {
  existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync, appendFileSync, renameSync,
} from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

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
  cur.evidence.push(item);
  return updateRun(id, { evidence: cur.evidence });
}

// Audit trail: one JSONL line per notable event, forever appendable.
// Sanitize anything key-shaped before it hits disk.
export function audit(event) {
  mkdirSync(home(), { recursive: true });
  const clean = JSON.parse(JSON.stringify(event, (k, v) =>
    /key|token|secret|authorization/i.test(k) ? '[redacted]' : v));
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
  writeFileSync(pinsPath(), JSON.stringify(pins, null, 2));
}

export function loadMeters() {
  const p = join(home(), 'meters.json');
  if (!existsSync(p)) return [];
  try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return []; }
}
