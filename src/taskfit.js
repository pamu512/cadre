// taskfit - which model is best for THIS job. Model-agnostic by construction:
//   1. history bench: from the ledger, per (lane × task-class) pass-rate and
//      metered burn — real outcomes, no synthetic benchmarks
//   2. capability match: lane good_at vs the task's class
//   3. economics: included (plan/free) before metered at equal fit
// Verdict is per-TASK, not per-lane: the same lane can be best for prose and
// worst for tests.
import { listRuns } from './store.js';

export function classifyTask(brief) {
  const t = String(brief).toLowerCase();
  const classes = [];
  if (/\b(ui|component|css|layout|frontend|react|flutter|page)\b/.test(t)) classes.push('ui');
  if (/\b(test|spec|coverage|flaky)\b/.test(t)) classes.push('tests');
  if (/\b(refactor|rename|extract|cleanup|lint)\b/.test(t)) classes.push('refactor');
  if (/\b(api|endpoint|backend|service|queue|db|database|schema)\b/.test(t)) classes.push('backend');
  if (/\b(review|audit|critique|security)\b/.test(t)) classes.push('review');
  if (/\b(plan|design|architect|decide|choose)\b/.test(t)) classes.push('planning');
  if (/\b(doc|readme|prose|write-up|explainer)\b/.test(t)) classes.push('prose');
  if (/\b(fix|bug|error|crash|regression)\b/.test(t)) classes.push('debug');
  if (/\b(research|survey|compare|market)\b/.test(t)) classes.push('research');
  return classes.length ? classes : ['general'];
}

// history: lane -> { runs, passed, tokens } filtered to runs whose brief
// matched the given task classes
export function historyFor(lanes, taskClasses) {
  const key = (lane, cl) => `${lane}::${cl}`;
  const stats = new Map();
  for (const r of listRuns()) {
    if (!r.roles || !r.brief) continue;
    const classes = classifyTask(r.brief);
    if (!classes.some((c) => taskClasses.includes(c))) continue;
    const passed = r.status === 'passed';
    for (const lane of Object.values(r.roles)) {
      for (const cl of classes) {
        const k = key(lane, cl);
        const cur = stats.get(k) || { runs: 0, passed: 0, tokens: 0 };
        cur.runs += 1;
        if (passed) cur.passed += 1;
        cur.tokens += r.usage?.metered_tokens || 0;
        stats.set(k, cur);
      }
    }
  }
  return stats;
}

const CLASS_TAGS = {
  ui: ['ui', 'frontend', 'design'], tests: ['tests', 'edits'], refactor: ['edits', 'ide-grade'],
  backend: ['backend', 'reasoning'], review: ['review', 'critique'], planning: ['planning', 'plans'],
  prose: ['prose', 'drafting'], debug: ['edits', 'verify'], research: ['research'], general: ['general'],
};

// rank lanes for a brief. Returns [{lane, score, passRate, runs, why}]
export function rankForTask(roster, brief) {
  const classes = classifyTask(brief);
  const hist = historyFor(roster.lanes, classes);
  const wanted = new Set(classes.flatMap((c) => CLASS_TAGS[c] || []));
  const COST = { free: 0, plan: 1, rollover: 2, metered: 3, coffee: 4 };

  return roster.lanes.map((lane) => {
    const overlap = (lane.good_at || []).filter((g) => wanted.has(g)).length;
    let h = null;
    for (const c of classes) {
      const s = hist.get(`${lane.name}::${c}`);
      if (s) h = h ? { runs: h.runs + s.runs, passed: h.passed + s.passed, tokens: h.tokens + s.tokens } : s;
    }
    const passRate = h && h.runs ? h.passed / h.runs : null;
    // cost is a tiebreak, not a capability: free ≠ better
    const score =
      overlap * 2 +
      (passRate == null ? 0 : passRate * 6) -
      (lane.invoke?.status && !['ok', 'ready'].includes(lane.invoke.status) ? 5 : 0);
    const why = [
      overlap ? `capability match ${overlap}` : 'no capability overlap',
      passRate == null ? 'untested for this class' : `history ${Math.round(passRate * 100)}% over ${h.runs} run(s)`,
      `cost ${lane.cost}`,
    ].join(' · ');
    return { lane: lane.name, cost: lane.cost, costRank: COST[lane.cost] ?? 3, score, passRate, runs: h?.runs || 0, why };
  }).sort((a, b) => b.score - a.score || a.costRank - b.costRank);
}
