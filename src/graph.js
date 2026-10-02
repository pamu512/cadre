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

// ---- code-graph takes ----------------------------------------------------------
// EXTRACTED vs INFERRED edges (donor: code-graph-Labs/code-graph): every connection
// carries a confidence tag so readers can tell what was read directly from
// source (import statements) vs inferred by resolution (extension guesses).
export function taggedEdges(map) {
  const out = [];
  for (const imp of map.imports || []) {
    const target = norm(imp.spec, imp.from);
    if (!target) continue;
    const extracted = /\.[a-z]+$/.test(imp.spec);
    out.push({ from: imp.from, to: target, spec: imp.spec, tag: extracted ? 'EXTRACTED' : 'INFERRED' });
  }
  return out;
}

// path query (donor: code-graph `path A B`): shortest hop chain between two files
// over the import graph, BFS, direction-agnostic.
export function pathBetween(map, aRaw, bRaw) {
  const edges = taggedEdges(map);
  const a = aRaw.replace(/^\.\//, ''), b = bRaw.replace(/^\.\//, '');
  const adj = new Map();
  for (const e of edges) {
    if (!adj.has(e.from)) adj.set(e.from, []);
    if (!adj.has(e.to)) adj.set(e.to, []);
    adj.get(e.from).push(e.to);
    adj.get(e.to).push(e.from);
  }
  if (!adj.has(a) || !adj.has(b)) return { found: false, hops: [], note: 'one or both files have no import edges' };
  const prev = new Map([[a, null]]);
  const queue = [a];
  while (queue.length) {
    const cur = queue.shift();
    if (cur === b) break;
    for (const next of adj.get(cur) || []) {
      if (!prev.has(next)) { prev.set(next, cur); queue.push(next); }
    }
  }
  if (!prev.has(b)) return { found: false, hops: [], note: 'no path' };
  const hops = [];
  for (let cur = b; cur !== null; cur = prev.get(cur)) hops.unshift(cur);
  return { found: true, hops, note: `${hops.length - 1} hop(s)` };
}
