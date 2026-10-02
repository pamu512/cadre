// reuse - the laziest-senior-dev step. Before writing new code, look for
// something that already does the job: symbols in this repo, npm registry,
// and the map's fan-in (heavily-imported code is battle-tested code).
// Returns concrete reuse candidates with sources; empty list = build new.
import { buildIndex, loadMap, mapIsWarm } from './map.js';

export async function findReuse({ brief, root = process.cwd() } = {}) {
  const out = [];
  let map = loadMap(root);
  if (!map || !mapIsWarm(map)) { map = buildIndex(root); }

  // 1. symbols in this repo whose name matches concepts in the brief
  const words = String(brief).toLowerCase().match(/[a-z][a-z0-9]{3,}/g) || [];
  const uniq = [...new Set(words)];
  for (const s of map.bySymbol || []) {
    if (uniq.includes(s.name.toLowerCase())) {
      out.push({ source: 'repo', what: s.name, where: s.files.join(', '), why: 'symbol already exists with this name' });
    }
  }

  // 2. fan-in hubs near the topic: heavily imported modules are the reuse hot spots
  const briefTopics = uniq.filter((w) => w.length >= 5).slice(0, 4);
  for (const h of map.hotZones || []) {
    const base = h.path.split('/').pop().replace(/\.\w+$/, '').toLowerCase();
    if (briefTopics.some((t) => base.includes(t.slice(0, 5)) || t.includes(base.slice(0, 5)))) {
      out.push({ source: 'repo', what: h.path, where: `${h.fanIn} importers`, why: 'battle-tested hub on this topic' });
    }
  }

  // 3. npm: one registry query per distinctive keyword (network optional)
  try {
    const kw = uniq.find((w) => ['auth', 'cache', 'router', 'queue', 'hash', 'csv', 'json', 'logger', 'validate', 'parse'].includes(w));
    if (kw) {
      const res = await fetch(`https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(kw)}&size=3`, { signal: AbortSignal.timeout(4000) });
      const j = await res.json();
      for (const o of (j.objects || []).slice(0, 3)) {
        out.push({ source: 'npm', what: `${o.package.name}@${o.package.version}`, where: o.package.links?.npm || 'npm', why: `published package for "${kw}"` });
      }
    }
  } catch { /* offline: repo reuse only */ }

  return out.slice(0, 8);
}
