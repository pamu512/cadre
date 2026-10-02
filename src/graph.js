// graph - the repo as a queryable slice-graph. On top of the map index:
//   - impactOf(files): what breaks/touches when these files change (transitive dependents)
//   - sliceFor(brief): which files a brief likely concerns (symbol mentions + roles)
//   - blastRadius: numeric risk score for a change set
// This is the "retrieve the slice + its interactions" organ the PRD promised.
import { loadMap, repoKey } from './map.js';

function norm(spec, fromFile) {
  // resolve relative import specs against the importing file's DIRECTORY
  if (!spec.startsWith('.')) return null; // bare/URL imports: skip
  const stack = fromFile.split('/');
  stack.pop(); // drop the filename first — ../ is relative to the dir
  for (const part of spec.split('/')) {
    if (part === '.' || part === '') continue;
    else if (part === '..') stack.pop();
    else stack.push(part);
  }
  let p = stack.join('/');
  if (!/\.[a-z]+$/.test(p)) p += '.js'; // extension-less spec
  return p;
}

function buildReverse(map) {
  const rev = new Map(); // file -> [files that import it]
  for (const imp of map.imports || []) {
    const t = norm(imp.spec, imp.from);
    if (!t) continue;
    if (!rev.has(t)) rev.set(t, []);
    rev.get(t).push(imp.from);
  }
  return rev;
}

// transitive dependents of a set of files (what the change touches)
export function impactOf(map, files) {
  const rev = buildReverse(map);
  const seen = new Set();
  const frontier = [...files];
  const impacted = [];
  while (frontier.length) {
    const f = frontier.pop();
    for (const dep of rev.get(f) || []) {
      if (seen.has(dep)) continue;
      seen.add(dep);
      impacted.push(dep);
      frontier.push(dep);
    }
  }
  return { direct: [...new Set(files)], impacted: impacted.sort(), reverseEdges: rev };
}

// which files does this brief concern? Symbol names mentioned in the brief win;
// path fragments next; role keywords (test/config/docs) after that.
export function sliceFor(map, brief) {
  const text = String(brief).toLowerCase();
  const hits = [];
  for (const s of map.bySymbol || []) {
    if (s.name.length >= 4 && text.includes(s.name.toLowerCase())) {
      hits.push(...s.files.map((f) => ({ file: f, why: `mentions symbol ${s.name}` })));
    }
  }
  for (const f of map.files ? [] : []) { /* files is a count; use imports for paths */ }
  for (const imp of map.imports || []) {
    if (imp.from.toLowerCase().includes(text.slice(0, 24)) && text.length >= 8) {
      hits.push({ file: imp.from, why: 'path fragment in brief' });
    }
  }
  // dedupe by file, keep first why
  const byFile = new Map();
  for (const h of hits) if (!byFile.has(h.file)) byFile.set(h.file, h.why);
  return [...byFile.entries()].map(([file, why]) => ({ file, why }));
}

export function blastRadius(map, files) {
  const { impacted } = impactOf(map, files);
  const total = map.files || 1;
  const share = impacted.length / total;
  return {
    changed: files.length,
    impacted: impacted.length,
    share,
    risk: share > 0.3 ? 'high' : share > 0.1 ? 'medium' : 'low',
  };
}

export function loadMapFor(root) {
  return loadMap(root || process.cwd());
}
