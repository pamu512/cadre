// recall - query the derived index over the ledger: "what do I know about X".
// Deterministic keyword/file/lane/status lookups, newest first. Derived data
// only: --rebuild regenerates everything from run records alone.
import { loadIndex, queryIndex } from '../recall.js';

export async function cmdRecall(args, flags) {
  const idx = loadIndex({ rebuild: !!flags.rebuild });
  if (flags.rebuild) console.log(`recall index rebuilt: ${idx.rows.length} settled run(s) indexed`);

  const q = {
    file: typeof flags.file === 'string' ? flags.file : null,
    lane: typeof flags.lane === 'string' ? flags.lane : null,
    status: typeof flags.status === 'string' ? flags.status : null,
    text: args.length ? args.join(' ') : null,
    limit: typeof flags.limit === 'number' ? flags.limit : (parseInt(flags.limit, 10) || 20),
  };
  if (!q.file && !q.lane && !q.status && !q.text) {
    console.log('cadre recall [text] [--file f] [--lane l] [--status s] [--limit n] [--rebuild]');
    console.log(`  index: ${idx.rows.length} settled run(s) (built ${idx.builtAt})`);
    return 0;
  }
  const rows = queryIndex(idx, q);
  if (!rows.length) {
    console.log('no runs match');
    return 0;
  }
  for (const r of rows) {
    const lanes = r.lanes.length ? r.lanes.join(',') : '—';
    const files = r.files.length ? ` · ${r.files.slice(0, 3).join(', ')}${r.files.length > 3 ? ` +${r.files.length - 3}` : ''}` : '';
    console.log(`  ${r.id} [${r.status}] (${lanes}) ${(r.brief || '').slice(0, 70)}${files}`);
  }
  console.log(`${rows.length} run(s)`);
  return 0;
}
