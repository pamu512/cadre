// meters - the multi-provider entitlement ledger (PRD 6.4).
// Sources, in trust order:
//   1. user-declared entitlements in $CADRE_HOME/meters.json (the official rails:
//      plan names, window resets, quotas the user reads off their own dashboards)
//   2. real usage from audit.log receipts (what cadre actually burned)
// NO header telemetry, NO invented quotas: unknown values render as "—".
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { home, auditPath } from './store.js';

export function loadMeters() {
  const p = join(home(), 'meters.json');
  if (!existsSync(p)) return [];
  try { return JSON.parse(readFileSync(p, 'utf-8')); } catch { return []; }
}

export function saveMeters(meters) {
  writeFileSync(join(home(), 'meters.json'), JSON.stringify(meters, null, 2));
}

// usage per lane from audit receipts (lane-call events carry usage)
export function usageFromAudit() {
  const per = new Map();
  if (!existsSync(auditPath())) return per;
  for (const line of readFileSync(auditPath(), 'utf-8').split('\n')) {
    if (!line.trim()) continue;
    let ev; try { ev = JSON.parse(line); } catch { continue; }
    if ((ev.kind === 'lane-call') && ev.usage) {
      const cur = per.get(ev.lane) || { calls: 0, tokens: 0 };
      cur.calls += 1;
      cur.tokens += ev.usage.total_tokens || 0;
      per.set(ev.lane, cur);
    }
  }
  return per;
}

// pacing: given quota Q, window reset R (Date), usage U so far -> verdict
export function pacing({ quota, resetAt, used }) {
  if (quota == null || resetAt == null) return { state: 'unknown', note: 'quota or reset unknown — "—"' };
  const now = Date.now();
  const reset = new Date(resetAt).getTime();
  if (Number.isNaN(reset)) return { state: 'unknown', note: 'bad reset date' };
  const left = quota - (used || 0);
  if (left <= 0) return { state: 'empty', note: 'exhausted — downshift or park metered behind the budget gate' };
  const hoursLeft = Math.max(0.1, (reset - now) / 3.6e6);
  const pct = left / quota;
  if (pct < 0.1) return { state: 'pacing', note: `${pct.toLocaleString(undefined, { style: 'percent' })} left, ${hoursLeft.toFixed(1)}h to reset — pace it` };
  return { state: 'ok', note: `${pct.toLocaleString(undefined, { style: 'percent' })} of quota left` };
}

// included-first ordering (PRD 6.4): plan/free lanes before metered
export function economicOrder(lanes) {
  const RANK = { free: 0, plan: 1, rollover: 2, metered: 3, coffee: 4 };
  return [...lanes].sort((a, b) => (RANK[a.cost] ?? 9) - (RANK[b.cost] ?? 9));
}

export function renderMeters({ meters, usage }) {
  const lines = [];
  for (const m of meters) {
    const used = usage.get(m.lane)?.tokens || 0;
    const p = pacing({ quota: m.quota_tokens, resetAt: m.reset_at, used });
    lines.push(
      `${m.lane.padEnd(16)} ${String(m.provider || '—').padEnd(12)} ${String(m.quota_tokens ?? '—').padStart(9)} tok  reset ${m.reset_at || '—'}  ${m.rail === 'header' ? '[fallback: header estimate — flagged]' : m.rail || '—'}  ${p.state}: ${p.note}`
    );
  }
  return lines;
}
