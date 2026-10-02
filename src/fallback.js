// fallback - the plan-router take: multi-tier fallback chains. A chain is an
// ordered list of (lane, tier) stops; when a stop is exhausted (meter says
// empty, or the lane errors), the work moves to the next stop and the job
// never stalls — and never surprise-bills (metered stops respect the budget).
import { loadMeters, pacing, usageFromAudit } from './meters.js';

// build a chain for a role from the roster: included tiers first
// (free/plan/rollover), metered stops last, each capped by budget.
export function buildChain(roster, role, { budgetTokens = Infinity } = {}) {
  const RANK = { free: 0, plan: 1, rollover: 2, metered: 3, coffee: 4 };
  // Role-fit aware: within each cost tier, lanes whose good_at tags overlap the
  // role's wanted tags come first - a downshift must land on a lane that can
  // actually do the job, not merely the cheapest drivable process.
  const { ROLE_TAGS } = { ROLE_TAGS: { builder: ['edits', 'tests', 'backend', 'ui', 'ide-grade', 'scaffold', 'draft', 'drafting', 'create', 'write', 'fixtures'] } };
  const wanted = (ROLE_TAGS[role] || []);
  const overlap = (l) => (l.good_at || []).filter((t) => wanted.includes(t)).length;
  // a lane with TAGS THAT DON'T MATCH the role is an explicit misfit - excluded.
  // A lane with NO tags at all is unjudged, not unfit - kept (generic fallback).
  const tagged = (l) => Array.isArray(l.good_at) && l.good_at.length > 0;
  const scored = [...(roster.lanes || [])]
    .filter((l) => l && l.name && (!tagged(l) || overlap(l) > 0))
    .sort((a, b) => (RANK[a.cost] ?? 9) - (RANK[b.cost] ?? 9) || overlap(b) - overlap(a));
  return scored.map((lane, i) => ({
    stop: i + 1,
    lane: lane.name,
    tier: lane.cost,
    metered: lane.cost === 'metered' || lane.cost === 'rollover',
    budget: lane.cost === 'metered' ? budgetTokens : Infinity,
  }));
}

// decide the current stop: skip stops the meter says are empty; stop at the
// first live one. Returns { stop, lane, rerouted, notes[] } — rerouted=true
// means the preferred stop was skipped and the job moved down the chain.
export function pickStop(chain, { meters = null, usage = null, health = {} } = {}) {
  const notes = [];
  const m = meters ?? loadMeters();
  const u = usage ?? usageFromAudit();
  for (const s of chain) {
    const healthState = health[s.lane];
    if (healthState && !['ok', 'ready'].includes(healthState)) {
      notes.push(`${s.lane}: ${healthState} - skipped`);
      continue;
    }
    const meter = m.find((x) => x.lane === s.lane);
    if (meter && meter.quota_tokens != null) {
      const p = pacing({ quota: meter.quota_tokens, resetAt: meter.reset_at, used: u.get(s.lane)?.tokens || 0 });
      if (p.state === 'empty') {
        notes.push(`${s.lane}: quota empty${meter.reset_at ? ` (resets ${meter.reset_at})` : ''} - skipped`);
        continue;
      }
      if (p.state === 'pacing') notes.push(`${s.lane}: pacing - ${p.note}`);
    }
    return { stop: s.stop, lane: s.lane, rerouted: s.stop > 1, notes };
  }
  return { stop: null, lane: null, rerouted: true, notes: [...notes, 'all stops exhausted - pause with resume plan'] };
}
