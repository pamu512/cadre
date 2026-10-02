// plan - the spend planner. REAL routing (scan -> route) plus a cost model
// computed from lane cost classes, not invented numbers. When a chat lane is
// keyed it can draft the step list; otherwise the local scaffold plan is
// used and labeled as such.
import { buildRoster } from '../scan.js';
import { assignRoles, explainRouting } from '../router.js';
import { chatLaneAvailable, chatLane } from '../chatlane.js';

// rough per-role token estimates by task size (heuristic, labeled as such)
const ROLE_TOKENS = { planner: 900, builder: 12000, critic: 1500, verifier: 700 };

export async function cmdPlan(args, flags) {
  const task = args.join(' ').trim();
  if (!task) {
    console.error('cadre plan "<task>" - bench lanes before you build');
    return 2;
  }
  const roster = await buildRoster();
  // warm map hint (P0 #7): hot zones shown before routing
  try {
    const { loadMap, mapIsWarm } = await import('../map.js');
    const m = loadMap(process.cwd());
    if (m && mapIsWarm(m) && (m.hotZones || []).length) {
      console.log(`map · warm - hot zones: ${m.hotZones.slice(0, 3).map((h) => h.path).join(', ')}`);
    }
  } catch { /* hint only */ }
  const routing = assignRoles(roster, { brief: task });

  // bench ranking (PRD 6.4): accuracy-per-dollar from real gated history —
  // lanes that produced passing gated runs rank above untested lanes; among
  // tested, fewer metered tokens per pass wins. History is the bench, no synthetic numbers.
  // Task-class aware (the contract): FOR THIS TASK CLASS - runs whose brief
  // classifies the same way as this one count toward the ranking; other runs
  // are excluded so a lane great at scaffolds doesn't inherit a review rank.
  const { listRuns } = await import('../store.js');
  const { classifyTask } = await import('../taskclass.js');
  const myClass = classifyTask(task).class;
  const history = listRuns().filter((r) => r.status === 'passed' && r.roles);
  const stats = new Map();
  for (const r of history) {
    if (classifyTask(r.brief || '').class !== myClass) continue; // THIS task class only
    for (const lane of Object.values(r.roles || {})) {
      const cur = stats.get(lane) || { passed: 0, tokens: 0 };
      cur.passed += 1;
      cur.tokens += r.usage?.metered_tokens || 0;
      stats.set(lane, cur);
    }
  }
  const rankScore = (s) => (s ? s.passed / Math.max(1, s.tokens / 10000) : -1);
  const ranked = roster.lanes
    .map((l) => ({ lane: l, s: stats.get(l.name) }))
    .sort((a, b) => rankScore(b.s) - rankScore(a.s));


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

  // expected spend vs budget cap (PRD 6.4): routing shown before any spend
  const { loadPins } = await import('../store.js');
  const pins = loadPins();
  if (pins.budget) {
    const fits = meteredTokens <= pins.budget;
    console.log(`\nexpected metered ~${meteredTokens} tok vs budget cap ${pins.budget} tok: ${fits ? 'fits' : 'OVER CAP - router will downshift or park metered lanes'}`);
  }

  console.log(`\nbench (accuracy-per-dollar from real gated history · task class: ${myClass}${['deterministic', 'mixed'].includes(myClass) ? ' - same-class runs only' : ''}):`);
  for (const { lane, s } of ranked.slice(0, 8)) {
    if (s) console.log(`  ${lane.name.padEnd(16)} ${s.passed} passed run(s) · ${s.tokens} metered tok · ${(rankScore(s)).toFixed(1)} passes/10k-tok`);
    else console.log(`  ${lane.name.padEnd(16)} untested - no gated history yet`);
  }

  const draftLane = roster.lanes.find((l) => chatLaneAvailable(l));
  if (draftLane) {
    try {
      const res = await chatLane(draftLane, [
        { role: 'system', content: 'You are a planning assistant. Given a task brief, list at most 5 concrete, checkable steps. No preamble.' },
        { role: 'user', content: task },
      ], { max_tokens: 500 });
      console.log(`\n${draftLane.name} draft plan:`);
      console.log(res.text.replace(/^/gm, '  '));
      if (res.usage) console.log(`  (usage: ${res.usage.total_tokens ?? '?'} tokens)`);
    } catch (e) {
      console.log(`\n${draftLane.name} draft failed (${e.message.split('\n')[0]}) - local scaffold only`);
    }
  } else {
    console.log('\nno keyed chat lane - step drafting skipped (any OpenAI-compatible env-keyed lane enables it)');
  }

  console.log(`\nnext: cadre go "${task}"`);
  return 0;
}
