// derive - hand-memory stats computed straight from the ledger (TRUTH).
// No cached "capability cards": the only consumer is display/routing, and a
// recompute is cheaper than a file that can drift. Retracted claims never
// count. Recency-weighted (14-day half-life) so a stale win cannot outvote
// a fresh failure.
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

const HALF_LIFE_DAYS = 14;

function handsDir() {
  return join(process.env.CADRE_HOME || join(homedir(), '.cadre'), 'hands-memory');
}

function readLedger(name) {
  try {
    return readFileSync(join(handsDir(), `${name}.jsonl`), 'utf-8').trim().split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean)
      .filter((e) => !e.retracted);
  } catch { return []; }
}

function ageWeight(at, now = Date.now()) {
  const t = Date.parse(at);
  if (!Number.isFinite(t)) return 1;
  return Math.pow(0.5, Math.max(0, now - t) / (HALF_LIFE_DAYS * 24 * 60 * 60 * 1000));
}

// per-hand stats for display: verdict counts, recency-weighted pass rate,
// last-seen, and provenance (distinct run ids) so a number can be traced.
export function handStats(name) {
  const entries = readLedger(name);
  const now = Date.now();
  let passed = 0, wSeen = 0, wPassed = 0;
  const runs = new Set();
  for (const e of entries) {
    const w = ageWeight(e.at, now);
    wSeen += w;
    if (e.passed) { passed += 1; wPassed += w; }
    if (e.run) runs.add(e.run);
  }
  return {
    hand: name,
    claims: entries.length,
    passed,
    failed: entries.length - passed,
    weighted_pass_rate: wSeen > 0 ? Number((wPassed / wSeen).toFixed(3)) : null,
    last_seen: entries.length ? entries[entries.length - 1].at : null,
    runs: [...runs],
  };
}

export function allHandStats() {
  let names = [];
  try { names = readdirSync(handsDir()).filter((f) => f.endsWith('.jsonl')).map((f) => f.replace(/\.jsonl$/, '')); } catch { return []; }
  return names.map(handStats).filter((s) => s.claims > 0);
}

// inspect one claim: trace a verdict back to its run + evidence.
export function explainClaim(name, at) {
  const hit = readLedger(name).find((e) => e.at === at);
  if (!hit) return null;
  return {
    hand: name, at: hit.at, passed: hit.passed, critique: hit.critique,
    run: hit.run || null, evidence: hit.evidence || [], files: hit.files || [],
    retracted: Boolean(hit.retracted),
  };
}
