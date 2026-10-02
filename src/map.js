// map - the living codebase graph. Symbols, edges, hot zones; kept warm across
// runs so lanes navigate instead of re-reading. Index = one JSON per repo under
// $CADRE_HOME/maps/, keyed by absolute path hash. Learning-from-outcomes is a
// noted opportunity (not claimed).
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
