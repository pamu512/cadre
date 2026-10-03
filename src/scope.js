// scope - the discipline layer (PRD 6.6). A brief becomes a manifest (allowed
// paths, exclusions, done-condition); the loop re-reads it; creep (diff outside
// the lock) is caught at the gate with the offending files named.
import { minimatch } from './minimatch-lite.js';
import { keywords } from './behaviorcheck.js';
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

// paths a brief NAMES are its declared intent: 'fix src/auth.js' intends
// src/auth.js even without --scope. Derived paths narrow an explicit lock
// never - they only rescue the '**' default from meaning 'anything goes'.
export function deriveIntent(brief) {
  const out = [];
  const re = /[\w./-]+\.(?:js|mjs|cjs|ts|tsx|py|sh|json|yaml|yml|toml|md|txt|rs|go|java|rb|css|html)\b/g;
  let m;
  while ((m = re.exec(String(brief || '')))) {
    const p = m[0].replace(/^[.(/]+/, '');
    if (p.length > 3 && !/^https?$/.test(p)) out.push(p);
  }
  return [...new Set(out)].slice(0, 12);
}

// "create <file> containing the single line: <text>" is an explicit done-condition
// pulled out of the brief. The file must contain that text. The run log does not count.
export function explicitDone(brief) {
  const m = /(?:create|write)\s+(\S+)\s+containing(?:\s+the\s+single\s+line)?:\s*(.+)$/i.exec(String(brief || '').trim());
  if (!m) return null;
  const file = m[1].replace(/^[.(/]+/, '');
  const text = m[2].trim();
  if (!file || !text) return null;
  return { file, text, statement: `${file} contains ${text}` };
}

export function filesFromPorcelain(lines) {
  const out = [];
  for (const line of lines || []) {
    if (!line) continue;
    let path = line.slice(3);
    if (path.includes(' -> ')) path = path.split(' -> ').pop();
    path = path.replace(/^"|"$/g, '').trim();
    if (path) out.push(path);
  }
  return out;
}

// Files this run actually changed: porcelain lines that appeared, plus numstat
// signatures that moved. Pre-existing dirt with an unchanged signature stays out.
export function runDeltaFiles(before, after) {
  if (!after) return [];
  const por = (s) => new Set(String(s?.porcelain || '').split('\n').filter(Boolean));
  const delta = [...por(after)].filter((l) => !por(before).has(l));
  const files = filesFromPorcelain(delta);
  const num = (s) => {
    const m = new Map();
    for (const l of String(s?.numstat || '').split('\n')) {
      if (!l) continue;
      const [p, mi, f] = l.split('\t');
      if (f) m.set(f, `${p}\t${mi}`);
    }
    return m;
  };
  const bn = num(before);
  for (const [f, sig] of num(after)) if (bn.get(f) !== sig) files.push(f);
  return [...new Set(files)];
}

export function writeScopeFile(path, manifest) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(manifest, null, 2));
  return path;
}

export function readScopeFile(path) {
  try { return JSON.parse(readFileSync(path, 'utf-8')); } catch { return null; }
}

export function whyCovers(why, files) {
  const text = String(why || '').toLowerCase();
  if (!text.trim()) return false;
  return (files || []).every((f) => text.includes(String(f).toLowerCase()));
}

function revertFile(cwd, file, prior) {
  const full = join(cwd, file);
  try {
    execFileSync('git', ['-C', cwd, 'checkout', '--', file], { stdio: 'pipe' });
    return 'restored';
  } catch { /* untracked, or not a git repo */ }
  if (prior instanceof Set && prior.has(file)) return 'left';
  try {
    if (existsSync(full) && statSync(full).isFile()) {
      unlinkSync(full);
      return 'removed';
    }
  } catch { /* leave it */ }
  return 'left';
}

// An out-of-scope write does not stay. A reason that names every file keeps them.
// prior is the set of relative paths that existed before the builder ran; those
// are never deleted when git cannot restore them.
export function settleCreep({ creep = [], why = '', cwd = '.', prior = null } = {}) {
  if (!creep.length) return { action: 'clear', reverted: [] };
  if (whyCovers(why, creep)) return { action: 'allow', reverted: [] };
  const reverted = creep.map((file) => ({ file, result: revertFile(cwd, file, prior) }));
  return { action: 'reject', reverted };
}

// Seatbelt specs. "**" is the working tree. A glob is a prefix. A named file
// is that file. Creating a new file is allowed by a literal rule on its path.
export function lockSpecs(manifest, cwd) {
  const lock = manifest?.lock || ['**'];
  if (lock.includes('**')) return [cwd];
  return lock.map((p) => {
    if (String(p).includes('*')) return { type: 'prefix', path: resolve(cwd, String(p).split('*')[0]) };
    return { type: 'file', path: resolve(cwd, p) };
  });
}

export function buildScopeManifest({ brief, scope, cwd = '.', doneCondition = null }) {
  const patterns = String(scope || '')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  // DERIVED INTENT: no explicit --scope, but the brief names files -> lock to
  // those files (plus dirs mentioned as path-ish tokens). Explicit scope wins.
  const derived = deriveIntent(brief);
  const extracted = explicitDone(brief);
  let lock;
  let lockSource;
  if (patterns.length) {
    lock = patterns;
    lockSource = 'explicit --scope';
  } else if (derived.length) {
    lock = derived;
    lockSource = 'derived from the brief';
  } else {
    lock = ['**'];
    lockSource = 'default (brief named no files)';
  }
  return {
    brief,
    cwd,
    lock,
    lockSource,
    exclusions: ['node_modules/**', '.git/**', '.cadre/**', '.aimee/**'],
    done: doneCondition || extracted?.statement || brief,
    created: new Date().toISOString(),
  };
}

function isExcluded(path, manifest) {
  return (manifest.exclusions || []).some((p) => minimatch(path, p));
}

// diff-vs-lock: returns files changed outside the scope lock
export function scopeCreep(changedFiles, manifest) {
  const out = [];
  for (const f of changedFiles) {
    if (isExcluded(f, manifest)) continue;
    const inside = manifest.lock.some((p) => minimatch(f, p));
    if (!inside) out.push(f);
  }
  return out;
}

export function renderManifest(manifest) {
  return [
    `lock (${manifest.lockSource || 'explicit'}): ${manifest.lock.join(' ')}`,
    `exclusions: ${manifest.exclusions.join(' ')}`,
    `done: ${manifest.done}`,
  ].join('\n');
}

function splitCommand(line) {
  const parts = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(line)) !== null) parts.push(m[1] ?? m[2] ?? m[3]);
  return parts;
}

// the run log echoes the done statement (run 0067 false-PROVEN on that echo).
// ponytail: any path ending in run.log is excluded; a project file with that
// exact name is not evidence either.
function isEcho(file) {
  return String(file).endsWith('run.log');
}

// ---- done-condition check -------------------------------------------------------
// `cadre go --done` is a checkable statement, separate from the brief.
// (1) a command (known runner) — exit 0 = done, no shell.
// (2) otherwise distinctive keywords must co-occur on one line of a changed
// file. The run log is never evidence. Absent or generic = not checked
// (the four evidence families still apply).
export function checkDoneCondition(manifest, { changedFiles = [], cwd = '.' } = {}) {
  const done = String(manifest?.done || '').trim();
  const brief = String(manifest?.brief || '').trim();
  const spec = explicitDone(brief);
  if (spec && (!done || done === brief || done === spec.statement)) {
    const full = join(cwd, spec.file);
    if (!existsSync(full)) return { checked: true, ok: false, note: `${spec.file} is not on disk` };
    let text = '';
    try { text = readFileSync(full, 'utf-8'); } catch { return { checked: true, ok: false, note: `${spec.file} unreadable` }; }
    const ok = text.includes(spec.text);
    return { checked: true, ok, note: ok ? `${spec.file} contains the asked text` : `${spec.file} does not contain the asked text` };
  }
  if (!done || done === brief) {
    return { checked: false, ok: null, note: 'done-condition not set separately (defaults to brief; gate evidence applies)' };
  }
  if (/^(npm|npx|node|python3?|make|cargo|go|pytest|jest|vitest|bash|sh|git|echo)\b/.test(done)) {
    const parts = splitCommand(done);
    if (!parts.length) return { checked: false, ok: null, note: 'done-condition command was empty' };
    try {
      execFileSync(parts[0], parts.slice(1), { cwd, timeout: 60000, encoding: 'utf-8', stdio: 'pipe' });
      return { checked: true, ok: true, note: `command exited 0: ${done.slice(0, 80)}` };
    } catch (e) {
      return { checked: true, ok: false, note: `command failed (exit ${e.status ?? '?'}): ${done.slice(0, 80)}` };
    }
  }
  const kws = keywords(done);
  if (kws.length < 2) return { checked: false, ok: null, note: 'done-condition too generic to check' };
  for (const f of changedFiles) {
    if (isEcho(f)) continue;
    const full = String(f).startsWith('/') ? f : join(cwd, f);
    if (!existsSync(full)) continue;
    let text;
    try { text = readFileSync(full, 'utf-8'); } catch { continue; }
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const hits = kws.filter((k) => lines[i].toLowerCase().includes(k));
      if (hits.length >= Math.min(2, kws.length)) {
        return { checked: true, ok: true, note: `keywords co-occur in ${f}:${i + 1}: ${hits.join(', ')}` };
      }
    }
  }
  return { checked: true, ok: false, note: `no changed file co-locates the done-condition keywords [${kws.join(', ')}]` };
}