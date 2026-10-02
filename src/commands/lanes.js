// lanes - who's here, what they're good at, what they cost.
// Real roster: live ax registry (exec), env-keyed API lanes, local model
// servers, user-declared lanes in $CADRE_HOME/lanes - all validated against
// the contract. Nothing here is hardcoded.
import { buildRoster } from '../scan.js';

export async function cmdLanes(flags) {
  const roster = await buildRoster();
  const lanes = roster.lanes;

  // C8: history made visible - per-lane settled/pass counts from the ledger
  const { listRuns } = await import('../store.js');
  const stats = new Map();
  for (const r of listRuns()) {
    if (!r.roles || !['passed', 'rejected', 'failed'].includes(r.status)) continue;
    for (const lane of Object.values(r.roles)) {
      const cur = stats.get(lane) || { runs: 0, passed: 0 };
      cur.runs += 1;
      if (r.status === 'passed') cur.passed += 1;
      stats.set(lane, cur);
    }
  }
  for (const l of lanes) {
    const st = stats.get(l.name);
    if (st) l.history = `${st.passed}/${st.runs} passed`;
  }

  if (flags.json) {
    console.log(JSON.stringify({
      lanes,
      clis: roster.clis.map((c) => c.label),
      platform: roster.platform,
    }, null, 2));
    return 0;
  }

  if (lanes.length === 0) {
    console.log('no lanes found. ax not present and $CADRE_HOME/lanes is empty.');
    console.log('declare one: $CADRE_HOME/lanes/mine.json - see schemas/lane.schema.json');
    return 0;
  }

  const w = (s, n) => String(s).padEnd(n);
  console.log(`${w('LANE', 14)}${w('STATUS', 9)}${w('GOOD AT', 30)}${w('COST', 9)}${w('TALKS', 10)}PROVES`);
  for (const l of lanes) {
    const status = l.invoke?.status || 'ready';
    console.log(
      `${w(l.name, 14)}${w(status, 9)}${w(l.good_at.join(', '), 30)}${w(l.cost, 9)}${w(l.talks, 10)}${w(l.proves, 14)}${l.history || '—'}`
    );
  }
  const clis = roster.clis.map((c) => c.label).join(', ');
  console.log(`\n${lanes.length} lane${lanes.length === 1 ? '' : 's'} · clis: ${clis || 'none'} · ${roster.platform}`);
  console.log('contract: schemas/lane.schema.json · declare lanes in $CADRE_HOME/lanes/*.json');
  return 0;
}
