// approach - figure out the best way to implement the ask. One command that
// answers: what kind of job is this (classify), which model for it (rank),
// which files it touches (slice + impact), what the blast radius is, and the
// recommended step order — all as a reviewable artifact before any spend.
import { buildRoster } from '../scan.js';
import { classifyTask, rankForTask } from '../taskfit.js';
import { buildIndex, loadMap, mapIsWarm } from '../map.js';
import { sliceFor, impactOf, blastRadius } from '../graph.js';
import { buildScopeManifest, renderManifest } from '../scope.js';
import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { home } from '../store.js';

export async function cmdApproach(args, flags) {
  const brief = args.join(' ').trim();
  if (!brief) {
    console.error('cadre approach "<ask>" - plan the implementation before any spend');
    return 2;
  }
  const cwd = flags.root || process.cwd();

  // 1. what kind of job
  const classes = classifyTask(brief);

  // 2. which model (per-task ranking, history-aware, model-agnostic)
  const roster = await buildRoster();
  const ranked = rankForTask(roster, brief);
  const best = ranked[0];

  // 3. the slice: files + interactions (map index, built warm if needed)
  let map = loadMap(cwd);
  if (!map || !mapIsWarm(map)) {
    map = buildIndex(cwd);
    try { const { saveMap } = await import('../map.js'); saveMap(map); } catch { /* cache best-effort */ }
  }
  const slice = sliceFor(map, brief);
  const sliceFiles = slice.map((s) => s.file);
  const impact = sliceFiles.length ? impactOf(map, sliceFiles) : { impacted: [] };
  const radius = sliceFiles.length ? blastRadius(map, sliceFiles) : null;

  // 4. scope manifest (the discipline artifact for the run that follows)
  const manifest = buildScopeManifest({
    brief,
    scope: sliceFiles.length ? sliceFiles.map((f) => f + '*').join(' ') : '**',
    cwd,
  });

  // 5. step order
  const steps = [
    '1. lock scope from the slice below (creep rejects at the gate)',
    `2. route: ${best ? best.lane : 'no lane'} ${best ? `(${best.why})` : ''}`,
    sliceFiles.length ? `3. work the slice: ${sliceFiles.slice(0, 5).join(', ')}` : '3. no slice matched - treat as greenfield',
    impact.impacted.length ? `4. watch the blast: ${impact.impacted.length} file(s) import the slice (${impact.impacted.slice(0, 4).join(', ')})` : '4. nothing imports the slice - isolated change',
    '5. verify with the project test command; gate on evidence',
  ];

  const out = {
    brief, classes, generated: new Date().toISOString(),
    bestLane: best ? { lane: best.lane, why: best.why, passRate: best.passRate, runs: best.runs } : null,
    ranking: ranked.slice(0, 5),
    slice, blastRadius: radius,
    impacted: impact.impacted.slice(0, 20),
    scope: manifest, steps,
  };

  if (flags.json) { console.log(JSON.stringify(out, null, 2)); return 0; }

  console.log(`cadre approach - "${brief}"`);
  console.log(`job class      : ${classes.join(', ')}`);
  console.log(`best lane      : ${best ? `${best.lane} - ${best.why}` : '(roster empty)'}`);
  console.log('\ntop lanes for this task:');
  for (const r of ranked.slice(0, 5)) console.log(`  ${r.lane.padEnd(16)} score ${r.score} · ${r.why}`);
  console.log('\nslice (files this ask concerns):');
  if (slice.length) for (const s of slice.slice(0, 8)) console.log(`  ${s.file} - ${s.why}`);
  else console.log('  (no symbols matched - greenfield or brief too abstract)');
  if (radius) console.log(`\nblast radius   : ${radius.impacted} impacted file(s) · risk ${radius.risk} (${(radius.share * 100).toFixed(1)}% of repo)`);
  if (impact.impacted.length) console.log(`impacted by    : ${impact.impacted.slice(0, 6).join(', ')}${impact.impacted.length > 6 ? ', …' : ''}`);
  console.log('\nscope lock:');
  console.log(renderManifest(manifest).replace(/^/gm, '  '));
  console.log('\nsteps:');
  for (const s of steps) console.log(`  ${s}`);
  console.log(`\nnext: cadre go "${brief}" --scope '<lock from above>'`);

  if (flags.save) {
    const dir = join(home(), 'approaches');
    mkdirSync(dir, { recursive: true });
    const f = join(dir, `${Date.now()}.json`);
    appendFileSync(f, JSON.stringify(out, null, 2));
    console.log(`saved: ${f}`);
  }
  return 0;
}
