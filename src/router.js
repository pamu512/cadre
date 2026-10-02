// router - roles go to whoever fits, not whoever's loyal.
// Deterministic, explainable fit scoring over the roster + pins. No black box.
// Scoring order (deliberate): demonstrated failure > capability > (economics
//   as tiebreak only). Free is not better: a small local model that fails the
//   gate costs more than a plan lane that passes. Cost never adds capability
//   points; it only breaks ties between equally-fit lanes (spend policy lives
//   in the fallback chains, not here).
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { loadPins, listRuns } from './store.js';

export const ROLES = ['planner', 'builder', 'critic', 'verifier'];

// good_at vocabulary → the role each tag feeds. Tags not listed still count
// toward general fit but don't claim a specific role.
const ROLE_TAGS = {
  planner:  ['planning', 'plans', 'research', 'long-ctx', 'reasoning', 'decisions'],
  builder:  ['edits', 'tests', 'backend', 'ui', 'ide-grade', 'scaffold', 'draft', 'drafting'],
  critic:   ['review', 'critique', 'prose', 'long-reasoning', 'classification', 'decisions'],
  verifier: ['verify', 'ui', 'backend', 'tests', 'summarize'],
};

// Reasoning-lane preference is DATA, not code: role preference order comes from
// $CADRE_HOME/reasoning.json (or sensible tag-based fallback), never hardcoded
// provider names. Cadre is model-agnostic; any keyed chat lane can serve any role.
//   {"planner": ["my-8b-lane", "glm"], "critic": ["my-70b-lane"]}
const PREFERRED = loadPreferred();
function loadPreferred() {
  const p = process.env.CADRE_REASONING_PREFS || join(process.env.CADRE_HOME || join(homedir(), '.cadre'), 'reasoning.json');
  try { return new Map(Object.entries(JSON.parse(readFileSync(p, 'utf-8')))); } catch { return new Map(); }
}

const COST_RANK = { free: 0, plan: 1, rollover: 2, metered: 3, coffee: 4 };

// status from ax lanes: busy/down lanes lose to ok/ready ones
function availabilityPenalty(lane) {
  const st = lane.invoke?.status;
  if (!st) return 0;
  if (st === 'ok' || st === 'ready') return 0;
  if (st === 'queued') return 2;
  return 5; // busy / down
}

// ---- history signal: a lane's recent pass rate from the ledger ----------------
// Cached per process. Lanes with only failures get a heavy penalty; thin
// history (< 2 settled runs) gives no signal either way.
let _histCache = null;
function laneHistory() {
  if (_histCache) return _histCache;
  const stats = new Map(); // lane -> { runs, passed }
  try {
    for (const r of listRuns()) {
      if (!r.roles) continue;
      if (!['passed', 'rejected', 'failed'].includes(r.status)) continue;
      for (const lane of Object.values(r.roles)) {
        const cur = stats.get(lane) || { runs: 0, passed: 0 };
        cur.runs += 1;
        if (r.status === 'passed') cur.passed += 1;
        stats.set(lane, cur);
      }
    }
  } catch { /* no ledger yet */ }
  _histCache = stats;
  return stats;
}

export function historyPenalty(lane) {
  const h = laneHistory().get(lane.name);
  if (!h || h.runs < 2) return 0; // not enough evidence
  const passRate = h.passed / h.runs;
  if (passRate >= 0.5) return 0;
  if (passRate === 0) return 8; // demonstrated failure: free loses to working plan lanes
  return 4; // struggling
}

export function scoreLane(lane, role) {
  const tags = lane.good_at || [];
  const wanted = ROLE_TAGS[role] || [];
  let overlap = tags.filter((t) => wanted.includes(t)).length;
  if (overlap === 0) return { role, lane: lane.name, fit: 0, why: 'no overlap' };
  const preferred = (PREFERRED.get(role) || []).indexOf(lane.name);
  const prefBonus = preferred > -1 ? 3 - Math.min(preferred, 2) : 0;
  const penalty = availabilityPenalty(lane);
  const histPenalty = historyPenalty(lane);
  const fit = overlap * 2 + prefBonus - penalty - histPenalty;
  const h = laneHistory().get(lane.name);
  const why = [
    `good_at ∩ ${role}: ${overlap}`,
    preferred > -1 ? `preferred for ${role}` : null,
    `cost ${lane.cost}`,
    penalty ? `status ${lane.invoke?.status}` : null,
    histPenalty ? `history ${h.passed}/${h.runs} passed` : null,
  ].filter(Boolean).join(' · ');
  return { role, lane: lane.name, fit, costRank: COST_RANK[lane.cost] ?? 3, why };
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
      .sort((a, b) => b.fit - a.fit || a.costRank - b.costRank); // fit first, cost only breaks ties
    if (scored.length === 0) {
      // last resort: everyone capable is failing on history. Take the best
      // history-penalized lane anyway (capability > nothing) and WARN.
      const capable = roster.lanes
        .filter((l) => !used.has(l.name) && (l.good_at || []).some((t) => (ROLE_TAGS[role] || []).includes(t)))
        .sort((a, b) => historyPenalty(a) - historyPenalty(b) || (COST_RANK[a.cost] ?? 3) - (COST_RANK[b.cost] ?? 3));
      if (capable.length === 0) {
        assignments.push({ role, lane: null, why: 'no lane fits - roster too thin', fit: 0 });
        continue;
      }
      assignments.push({ role, lane: capable[0].name, why: 'ALL capable lanes failing on history - best available, expect gate scrutiny', fit: 0 });
      used.add(capable[0].name);
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
