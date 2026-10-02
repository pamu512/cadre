// lanes - who's here, what they're good at, what they cost.
// Real roster: live ax registry (exec), env-keyed API lanes, local model
// servers, user-declared lanes in $CADRE_HOME/lanes - all validated against
// the contract. Nothing here is hardcoded.
import { buildRoster } from '../scan.js';
import { apertusAvailable } from '../apertus.js';

export async function cmdLanes(flags) {
  const roster = await buildRoster();
  const lanes = roster.lanes;

  if (flags.json) {
    console.log(JSON.stringify({
      lanes,
      clis: roster.clis.map((c) => c.label),
      platform: roster.platform,
      apertus: apertusAvailable() ? 'keyed' : 'not-keyed',
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
      `${w(l.name, 14)}${w(status, 9)}${w(l.good_at.join(', '), 30)}${w(l.cost, 9)}${w(l.talks, 10)}${l.proves}`
    );
  }
  const clis = roster.clis.map((c) => c.label).join(', ');
  console.log(`\n${lanes.length} lane${lanes.length === 1 ? '' : 's'} · clis: ${clis || 'none'} · ${roster.platform} · apertus: ${apertusAvailable() ? 'keyed (APERTUS_API_KEY set)' : 'not keyed'}`);
  console.log('contract: schemas/lane.schema.json · declare lanes in $CADRE_HOME/lanes/*.json');
  return 0;
}
