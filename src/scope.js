// scope - the discipline layer (PRD 6.6). A brief becomes a manifest (allowed
// paths, exclusions, done-condition); the loop re-reads it; creep (diff outside
// the lock) is caught at the gate with the offending files named.
import { minimatch } from './minimatch-lite.js';

export function buildScopeManifest({ brief, scope, cwd = '.', doneCondition = null }) {
  const patterns = String(scope || '**')
    .split(/[,\s]+/)
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    brief,
    cwd,
    lock: patterns.length ? patterns : ['**'],
    exclusions: ['node_modules/**', '.git/**', '.cadre/**', '.aimee/**'],
    done: doneCondition || brief,
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
    `lock: ${manifest.lock.join(' ')}`,
    `exclusions: ${manifest.exclusions.join(' ')}`,
    `done: ${manifest.done}`,
  ].join('\n');
}
