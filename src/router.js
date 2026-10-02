// router - roles go to whoever fits, not whoever's loyal.
// Deterministic, explainable fit scoring over the roster + pins. No black box.
import { loadPins } from './store.js';

export const ROLES = ['planner', 'builder', 'critic', 'verifier'];

// good_at vocabulary → the role each tag feeds. Tags not listed still count
// toward general fit but don't claim a specific role.
const ROLE_TAGS = {
  planner:  ['planning', 'plans', 'research', 'long-ctx', 'reasoning', 'decisions'],
  builder:  ['edits', 'tests', 'backend', 'ui', 'ide-grade', 'scaffold', 'draft', 'drafting'],
  critic:   ['review', 'critique', 'prose', 'long-reasoning', 'classification', 'decisions'],
  verifier: ['verify', 'ui', 'backend', 'tests', 'summarize'],
};

// Prefer Apertus as the primary reasoning lane, per the approved direction:
// 8B cheap/draft, 70B decide - when the key is present.
const PREFERRED = new Map([
  ['planner',  ['apertus-8b', 'apertus-70b']],
  ['critic',   ['apertus-70b', 'apertus-8b']],
  ['builder',  ['ax-codex', 'ax-hermes', 'ax-cursor', 'ax-autoclaw']],
  ['verifier', ['ax-autoclaw', 'ax-codex']],
]);

const COST_RANK = { free: 0, plan: 1, rollover: 2, metered: 3, coffee: 4 };

// status from ax lanes: busy/down lanes lose to ok/ready ones
function availabilityPenalty(lane) {
  const st = lane.invoke?.status;
  if (!st) return 0;
  if (st === 'ok' || st === 'ready') return 0;
  if (st === 'queued') return 2;
  return 5; // busy / down
}

export function scoreLane(lane, role) {
  const tags = lane.good_at || [];
  const wanted = ROLE_TAGS[role] || [];
  let overlap = tags.filter((t) => wanted.includes(t)).length;
  if (overlap === 0) return { role, lane: lane.name, fit: 0, why: 'no overlap' };
  const preferred = (PREFERRED.get(role) || []).indexOf(lane.name);
  const prefBonus = preferred > -1 ? 3 - Math.min(preferred, 2) : 0;
  const costRank = COST_RANK[lane.cost] ?? 3;
  const penalty = availabilityPenalty(lane);
  const fit = overlap * 2 + prefBonus + (4 - costRank) - penalty;
  const why = [
    `good_at ∩ ${role}: ${overlap}`,
    preferred > -1 ? `preferred for ${role}` : null,
    `cost ${lane.cost}`,
    penalty ? `status ${lane.invoke?.status}` : null,
  ].filter(Boolean).join(' · ');
  return { role, lane: lane.name, fit, why };
}

// Assign every role from the roster. Pins override; remaining roles go by score.
export function assignRoles(roster, { brief = '' } = {}) {
  const pins = loadPins();
  const assignments = [];
  const used = new Set();

  for (const role of ROLES) {
    const pinned = pins.roles?.[role];
    if (pinned && roster.lanes.some((l) => l.name === pinned)) {
      assignments.push({ role, lane: pinned, why: 'pinned by you', fit: null });
      used.add(pinned);
    }
  }

  for (const role of ROLES) {
    if (assignments.some((a) => a.role === role)) continue;
    const scored = roster.lanes
      .filter((l) => !used.has(l.name))
      .map((l) => scoreLane(l, role))
      .filter((s) => s.fit > 0)
      .sort((a, b) => b.fit - a.fit);
    if (scored.length === 0) {
      assignments.push({ role, lane: null, why: 'no lane fits - roster too thin', fit: 0 });
      continue;
    }
    assignments.push(scored[0]);
    used.add(scored[0].lane);
  }

  // keep role order stable in output
  const order = Object.fromEntries(ROLES.map((r, i) => [r, i]));
  assignments.sort((a, b) => order[a.role] - order[b.role]);
  return { brief, assignments };
}

export function explainRouting(assignments) {
  return assignments.assignments.map((a) => {
    const tail = a.fit === null || a.fit === 0 ? '' : ` (fit ${a.fit}: ${a.why})`;
    return `${a.role.padEnd(9)} ${a.lane || '-'}${tail}`;
  }).join('\n');
}
