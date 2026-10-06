// recall - a DERIVED, rebuildable index over run records. Answers "what does
// the ledger know about X" (file, lane, status, brief keywords) without
// re-scanning every run.json. Derived data only: nothing here is a source of
// truth, so the index can be deleted and rebuilt at any time - no retraction
// propagation needed, rebuild-after-retract is the propagation.
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { listRuns, home } from './store.js';

const SETTLED_FOR_INDEX = ['passed', 'rejected', 'failed', 'retracted', 'stale', 'retired'];

// Build the index from the ledger. One row per settled run:
//   { id, status, brief, lanes, files, kind, started }
// files come from evidence refs + verdict diffs where present.
function extractFiles(r) {
  const files = new Set();
  for (const e of r.evidence || []) {
    for (const ref of [e.ref, e.path]) {
      if (typeof ref !== 'string') continue;
      if (ref.startsWith('runs/') || ref.startsWith('~')) continue; // self-citations prove nothing
      const clean = ref.split('#')[0].replace(/^\.\//, '');
      if (clean && !clean.startsWith('http')) files.add(clean);
    }
    if (Array.isArray(e.files)) e.files.forEach((f) => typeof f === 'string' && files.add(f));
  }
  const d = r.verdict?.diffs;
  if (Array.isArray(d)) d.forEach((f) => typeof f === 'string' && files.add(f));
  return [...files];
}

export function buildIndex(runs = null) {
  const rows = [];
  for (const r of runs || listRuns()) {
    if (!SETTLED_FOR_INDEX.includes(r.status)) continue;
    if (!r.brief && !r.roles) continue;
    rows.push({
      id: r.id,
      status: r.status,
      kind: r.kind || null,
      brief: r.brief || '',
      lanes: r.roles ? [...new Set(Object.values(r.roles))] : [],
      files: extractFiles(r),
      started: r.started || null,
    });
  }
  return rows;
}

export function indexPath() { return join(home(), 'recall-index.json'); }

// The cache is honest, not clever: loadIndex trusts it only until an explicit
// --rebuild (or a corrupt read) forces regeneration. Derivable data, so a
// stale cache can never lie about anything the ledger doesn't already say.

export function loadIndex({ rebuild = false } = {}) {
  const p = indexPath();
  if (!rebuild && existsSync(p)) {
    try {
      const idx = JSON.parse(readFileSync(p, 'utf-8'));
      if (idx.builtAt && Array.isArray(idx.rows)) return idx;
    } catch { /* corrupt cache: fall through to rebuild */ }
  }
  const rows = buildIndex();
  const idx = { builtAt: new Date().toISOString(), rows };
  mkdirSync(home(), { recursive: true });
  writeFileSync(p, JSON.stringify(idx, null, 2));
  return idx;
}

// Query: match a run if ANY criterion hits (OR across criteria, AND within a
// criterion's list). Deterministic: newest first.
export function queryIndex(idx, { file, lane, status, text, limit = 20 } = {}) {
  const wantFile = file ? file.replace(/^\.\//, '') : null;
  const out = [];
  for (const row of idx.rows) {
    let hit = false;
    if (wantFile && row.files.some((f) => f === wantFile || f.endsWith('/' + wantFile))) hit = true;
    if (lane && row.lanes.includes(lane)) hit = true;
    if (status && row.status === status) hit = true;
    if (text) {
      const t = text.toLowerCase();
      if (row.brief.toLowerCase().includes(t)) hit = true;
    }
    if (hit) out.push(row);
  }
  return out.sort((a, b) => (b.started || '').localeCompare(a.started || '')).slice(0, limit);
}
