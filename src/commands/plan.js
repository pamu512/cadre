// plan - the spend planner. REAL routing (scan -> route) plus a cost model
// computed from lane cost classes, not invented numbers. When Apertus is
// keyed it can draft the step list; otherwise the local scaffold plan is
// used and labeled as such.
import { buildRoster } from '../scan.js';
import { assignRoles, explainRouting } from '../router.js';
import { apertusAvailable, apertusChat } from '../apertus.js';

// rough per-role token estimates by task size (heuristic, labeled as such)
const ROLE_TOKENS = { planner: 900, builder: 12000, critic: 1500, verifier: 700 };

export async function cmdPlan(args, flags) {
  const task = args.join(' ').trim();
  if (!task) {
    console.error('cadre plan "<task>" - bench lanes before you build');
    return 2;
  }
  const roster = await buildRoster();
  const routing = assignRoles(roster, { brief: task });

  console.log(`cadre plan - ${task}`);
  console.log(`roster · ${roster.lanes.length} lane(s) on this machine (${roster.platform})`);
  console.log('routing (roles by fit, pins override):');
  console.log(explainRouting(routing).replace(/^/gm, '  '));

  // spend estimate from cost classes: plan/free roles cost $0 metered;
  // metered roles estimate tokens (heuristic sizes, printed as estimates).
  let meteredTokens = 0;
  const lines = [];
  for (const a of routing.assignments) {
    if (!a.lane) continue;
    const lane = roster.lanes.find((l) => l.name === a.lane);
    if (!lane) continue;
    const tokens = ROLE_TOKENS[a.role] || 1000;
    if (lane.cost === 'metered') meteredTokens += tokens;
    lines.push(`  ${a.role.padEnd(9)} ${lane.name.padEnd(14)} ${lane.cost.padEnd(8)} ~${tokens} tok`);
  }
  console.log('estimated spend (heuristic):');
  console.log(lines.join('\n'));
  console.log(`metered lanes: ~${meteredTokens} tokens across the loop (plan lanes ride subscriptions you own)`);

  if (apertusAvailable()) {
    try {
      const res = await apertusChat([
        { role: 'system', content: 'You are a planning assistant. Given a task brief, list at most 5 concrete, checkable steps. No preamble.' },
        { role: 'user', content: task },
      ], { model: 'Apertus-8B', max_tokens: 500 });
      console.log('\napertus-8b draft plan:');
      console.log(res.text.replace(/^/gm, '  '));
      if (res.usage) console.log(`  (usage: ${res.usage.total_tokens ?? '?'} tokens)`);
    } catch (e) {
      console.log(`\napertus draft failed (${e.message.split('\n')[0]}) - local scaffold only`);
    }
  } else {
    console.log('\napertus: not keyed - step drafting skipped (export APERTUS_API_KEY to enable)');
  }
  console.log(`\nnext: cadre go "${task}"`);
  return 0;
}
