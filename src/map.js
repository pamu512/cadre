// map - the living codebase graph. Symbols, edges, hot zones; kept warm across
// runs so lanes navigate instead of re-reading. Index = one JSON per repo under
// $CADRE_HOME/maps/, keyed by absolute path hash. learnFromRun folds each run's
// files into the hot zones, so the next run is pointed at code that already mattered.
import { createHash } from 'node:crypto';
import {
  existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync,
} from 'node:fs';
import { join, relative, extname } from 'node:path';
import { mapsDir } from './store.js';

const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.py', '.rs', '.go', '.java', '.rb', '.sh']);
const SKIP_DIRS = new Set(['node_modules', '.git', 'dist', 'build', '.aimee', 'coverage', '__pycache__', '.venv', 'vendor']);
const MAX_BYTES = 512 * 1024;

export function repoKey(root) {
  return createHash('sha256').update(root).digest('hex').slice(0, 16);
}
function mapPath(root) {
  return join(mapsDir(), `${repoKey(root)}.json`);
}

export function mapsDirAbs() { return mapsDir(); }

// symbol extraction per language: [regex, group for name]
const SYMBOL_RULES = {
  '.js':  [/(?:^|\n)\s*(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)|const\s+(\w+)\s*=\s*(?:async\s*)?\(|class\s+(\w+))/g, null],
  '.mjs': [/(?:^|\n)\s*(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)|const\s+(\w+)\s*=\s*(?:async\s*)?\(|class\s+(\w+))/g, null],
  '.cjs': [/(?:^|\n)\s*(?:export\s+)?(?:async\s+)?(?:function\s+(\w+)|const\s+(\w+)\s*=\s*(?:async\s*)?\(|class\s+(\w+))/g, null],
  '.py':  [/(?:^|\n)\s*(?:def\s+(\w+)|class\s+(\w+))/g, null],
  '.rs':  [/(?:^|\n)\s*(?:pub\s+)?(?:async\s+)?fn\s+(\w+)|(?:^|\n)\s*(?:pub\s+)?struct\s+(\w+)/g, null],
  '.go':  [/(?:^|\n)\s*func\s+(?:\([^)]*\)\s*)?(\w+)/g, null],
};

export function extractSymbols(source, ext) {
  const rule = SYMBOL_RULES[ext];
  if (!rule) return [];
  const [re] = rule;
  const names = new Set();
  re.lastIndex = 0;
  let m;
  while ((m = re.exec(source)) !== null) {
    const name = m[1] || m[2] || m[3];
    if (name) names.add(name);
  }
  return [...names];
}

export function buildIndex(root, { maxFiles = 5000 } = {}) {
  const files = [];
  const symbols = [];   // { name, file }
  const imports = [];   // { from, to, symbol }

  (function walk(dir, depth) {
    if (files.length >= maxFiles || depth > 12) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (files.length >= maxFiles) return;
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name) || ent.name.startsWith('.')) continue;
        walk(full, depth + 1);
      } else if (CODE_EXT.has(extname(ent.name))) {
        let st;
        try { st = statSync(full); } catch { continue; }
        if (st.size > MAX_BYTES) continue;
        let src;
        try { src = readFileSync(full, 'utf-8'); } catch { continue; }
        const rel = relative(root, full);
        files.push({ path: rel, bytes: st.size });
        for (const name of extractSymbols(src, extname(ent.name))) {
          symbols.push({ name, file: rel });
        }
        // import edges (js-family heuristic)
        if (['.js', '.mjs', '.cjs'].includes(extname(ent.name))) {
          const re = /(?:import[\s\S]*?from\s+|require\()\s*['"]([^'"]+)['"]/g;
          let m;
          while ((m = re.exec(src)) !== null) imports.push({ from: rel, spec: m[1] });
        }
      }
    }
  })(root, 0);

  const symbolIndex = new Map();
  for (const s of symbols) {
    if (!symbolIndex.has(s.name)) symbolIndex.set(s.name, []);
    symbolIndex.get(s.name).push(s.file);
  }

  const map = {
    root, v: 1, indexedAt: new Date().toISOString(),
    files: files.length, symbols: symbolIndex.size, edges: imports.length,
    bySymbol: [...symbolIndex.entries()].slice(0, 20000).map(([name, files_]) => ({ name, files: files_ })),
    imports,
    hotZones: computeHotZones(files, imports),
  };
  return map;
}

// hot zones: files most imported by other files (fan-in), naive but real.
function computeHotZones(files, imports) {
  const fanIn = new Map();
  for (const imp of imports) {
    const target = imp.spec.replace(/^\.\//, '').replace(/^\.\.\//, '');
    fanIn.set(target, (fanIn.get(target) || 0) + 1);
  }
  return [...fanIn.entries()]
    .filter(([p, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([path, fanIn]) => ({ path, fanIn }));
}

export function saveMap(map) {
  mkdirSync(mapsDir(), { recursive: true });
  writeFileSync(mapPath(map.root), JSON.stringify(map));
  return mapPath(map.root);
}

export function loadMap(root) {
  const p = mapPath(root);
  if (!existsSync(p)) return null;
  try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return null; }
}

// Walk source files. The stored map only keeps a file count, so freshness
// is the first source mtime newer than indexedAt.
function sourceNewer(root, indexedAt) {
  const cutoff = Date.parse(indexedAt);
  if (!Number.isFinite(cutoff)) return true;
  let newer = false;
  (function walk(dir, depth) {
    if (newer || depth > 12) return;
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (newer) return;
      const full = join(dir, ent.name);
      if (ent.isDirectory()) {
        if (SKIP_DIRS.has(ent.name) || ent.name.startsWith('.')) continue;
        walk(full, depth + 1);
      } else if (CODE_EXT.has(extname(ent.name))) {
        try { if (statSync(full).mtimeMs > cutoff) newer = true; } catch { /* raced */ }
      }
    }
  })(root, 0);
  return newer;
}

export function ensureMap(root) {
  const prev = loadMap(root);
  if (prev && mapIsWarm(prev) && Array.isArray(prev.bySymbol) && !sourceNewer(root, prev.indexedAt)) return prev;
  const fresh = buildIndex(root);
  if (prev?.outcomes) fresh.outcomes = prev.outcomes;
  if (prev?.hotZones?.some((h) => h.learned)) {
    const learned = prev.hotZones.filter((h) => h.learned);
    const rest = fresh.hotZones.filter((h) => !learned.some((l) => l.path === h.path));
    fresh.hotZones = [...learned, ...rest].slice(0, 10);
  }
  saveMap(fresh);
  return fresh;
}

// The slice a lane gets instead of the repo: hot zones, symbols, callers
// for the files this brief named. Short on purpose.
export function sliceFor(map, { brief = '', lock = [] } = {}) {
  if (!map) return 'MAP (empty index)';
  const named = new Set([...(lock || [])].filter((p) => !String(p).includes('*')));
  const re = /[\w./-]+\.(?:js|mjs|cjs|ts|tsx|py|sh|json|md|txt)\b/g;
  let m;
  while ((m = re.exec(String(brief)))) named.add(m[0].replace(/^[.(/]+/, ''));
  const failed = new Set();
  for (const o of map.outcomes || []) {
    if (o.passed) continue;
    for (const f of o.files || []) failed.add(String(f));
  }
  const failedHit = (files) => (files || []).some((f) => failed.has(f));
  const symbols = (map.bySymbol || [])
    .filter((s) => (s.files || []).some((f) => named.has(f)))
    .sort((a, b) => Number(failedHit(b.files)) - Number(failedHit(a.files)))
    .slice(0, 12);
  const callers = (map.imports || []).filter((i) => named.has(i.spec) || named.has(i.from) || [...named].some((n) => String(i.spec || '').endsWith(n))).slice(0, 12);
  const hot = (map.hotZones || []).slice(0, 5).map((h) => h.path);
  const lines = ['MAP'];
  const failedNamed = [...failed].filter((f) => named.has(f) || [...named].some((n) => f === n || f.endsWith(`/${n}`)));
  if (failedNamed.length) lines.push(`failed: ${failedNamed.slice(0, 8).join(', ')}`);
  if (hot.length) lines.push(`hot: ${hot.join(', ')}`);
  for (const s of symbols) lines.push(`symbol ${s.name} in ${(s.files || []).join(', ')}`);
  for (const c of callers) lines.push(`calls ${c.from} -> ${c.spec}`);
  if (lines.length === 1) lines.push('(no symbols in the locked files)');
  return lines.join('\n');
}

export function learnFromRun(root, { files = [], passed = false, lane = null } = {}) {
  const map = loadMap(root) || {
    root, indexedAt: new Date().toISOString(), files: [], imports: [], bySymbol: [], hotZones: [], outcomes: [],
  };
  map.outcomes = Array.isArray(map.outcomes) ? map.outcomes : [];
  map.outcomes.push({ at: new Date().toISOString(), passed: Boolean(passed), lane: lane || null, files: files.slice(0, 20) });
  map.outcomes = map.outcomes.slice(-40);
  const scores = new Map();
  for (const o of map.outcomes) {
    for (const f of o.files || []) scores.set(f, (scores.get(f) || 0) + (o.passed ? 2 : 1));
  }
  const learned = [...scores.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([path, fanIn]) => ({ path, fanIn, learned: true }));
  const prior = (map.hotZones || []).filter((h) => !learned.some((l) => l.path === h.path));
  map.hotZones = [...learned, ...prior].slice(0, 10);
  map.indexedAt = new Date().toISOString();
  saveMap(map);
  return map;
}

export function mapIsWarm(map, maxAgeMs = 1000 * 60 * 10) {
  return map && Date.now() - Date.parse(map.indexedAt) < maxAgeMs;
}

// --why symbol: which files define it, who imports those files
export function whySymbol(map, name) {
  const defs = map.bySymbol.filter((s) => s.name === name || s.name.includes(name));
  const defFiles = new Set(defs.flatMap((d) => d.files));
  // an importer is a file whose import spec resolves to a defining file
  // (relative spec './b.js' from 'lib/a.js' -> target 'lib/b.js'); a file's
  // own outgoing imports never make it an importer.
  const resolvesToDef = (imp, def) => {
    if (!imp.spec.startsWith('.')) return false;
    const base = imp.from.split('/').slice(0, -1);
    for (const part of imp.spec.split('/').slice(0, -1)) {
      if (part === '.') continue;
      else if (part === '..') base.pop();
      else base.push(part);
    }
    return base.join('/') + '/' + imp.spec.split('/').pop() === def;
  };
  const importers = map.imports.filter((i) => !defFiles.has(i.from) && [...defFiles].some((f) => resolvesToDef(i, f)));
  const definedIn = [...new Set(defs.flatMap((d) => d.files))];
  const importedBy = [...new Set(importers.map((i) => i.from))].slice(0, 20);
  return { symbol: name, definedIn, importedBy };
}
