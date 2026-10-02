// map - the living codebase graph. REAL symbol/import extraction (ported
// engine in src/map.js), index persisted under $CADRE_HOME/maps, --why traces
// a symbol to its files and importers. Numbers printed are counted from the
// walk, never invented.
import { buildIndex, saveMap, loadMap, mapIsWarm, whySymbol, repoKey } from '../map.js';
import { mapsDir } from '../store.js';
import { join } from 'node:path';

export async function cmdMap(args, flags) {
  const root = process.cwd();
  if (flags.why) {
    const m = loadMap(root);
    if (!m) {
      console.error(`no warm map for this repo - run cadre map first (index: ${join(mapsDir(), repoKey(root) + '.json')})`);
      return 2;
    }
    const r = whySymbol(m, String(flags.why));
    console.log(`symbol "${r.symbol}" (from ${m.files} indexed files):`);
    if (r.definedIn.length === 0) { console.log('  not found in this index'); return 0; }
    for (const f of r.definedIn) console.log(`  defined in  ${f}`);
    for (const imp of r.importedBy) console.log(`  imported by ${imp}`);
    return 0;
  }

  const warm = loadMap(root);
  if (warm && mapIsWarm(warm) && !flags.rebuild) {
    console.log(`map warm · ${warm.files} files · ${warm.symbols} symbols · ${warm.edges} import edges (indexed ${warm.indexedAt.slice(11, 19)})`);
    console.log(`hot zones (fan-in ≥2): ${warm.hotZones.map((h) => `${h.path} (${h.fanIn})`).join(', ') || 'none'}`);
    console.log('cadre map --rebuild to re-index');
    return 0;
  }

  console.log(`indexing ${root} ...`);
  const m = buildIndex(root);
  const p = saveMap(m);
  console.log(`map built · ${m.files} files · ${m.symbols} symbols · ${m.edges} import edges`);
  console.log(`hot zones (fan-in ≥2): ${m.hotZones.map((h) => `${h.path} (${h.fanIn})`).join(', ') || 'none'}`);
  console.log(`index: ${p}`);
  if (flags.why !== undefined) console.log(`cadre map --why <symbol> to trace`);
  return 0;
}
