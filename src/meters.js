// meters - the multi-provider entitlement ledger (PRD 6.4).
// Sources, in trust order:
//   1. user-declared entitlements in $CADRE_HOME/meters.json (the official rails:
//      plan names, window resets, quotas the user reads off their own dashboards)
//   2. real usage from audit.log receipts (what cadre actually burned)
// NO header telemetry, NO invented quotas: unknown values render as "—".
import { existsSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { home, auditPath, listRuns } from './store.js';

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

// ---- harness-wide aggregation -------------------------------------------------
// Per-lane burn from every observed source, with an overall aggregate.
// FREE/LOCAL lanes (cost free, or known-local runtimes) are EXCLUDED from both
// the split and the aggregate - they are not spend.
const FREE_LANE_HINTS = /^(ollama|local|human|file-writer|generic|echo|free)/i;
export function isFreeLane(name) {
  return FREE_LANE_HINTS.test(String(name || ''));
}

export function harnessUsage() {
  const perLane = usageFromAudit();           // chat receipts (cadre-made calls)
  const axPerLane = new Map();                // ax run logs, attributed by section markers
  const AX_RUNS = join(homedir(), '.config/ax/runs');
  let axUnattributed = 0;
  let axRuns = 0;
  try {
    for (const f of readdirSync(AX_RUNS)) {
      if (!f.endsWith('.log')) continue;
      let text;
      try { text = readFileSync(join(AX_RUNS, f), 'utf-8'); } catch { continue; }
      // walk line-by-line: the last "== [lane] ..." marker attributes token lines after it
      let currentLane = null;
      let found = false;
      let pending = false; // "tokens used" seen; the number arrives on a LATER line
      // raw CLI session logs (no ax sections) carry a 'model:'/'codex' header instead
      const modelHeader = /^model:\s+(\S+)/m.exec(text);
      const isRawCodex = /OpenAI Codex v\d/.test(text);
      if (!currentLane && isRawCodex) currentLane = 'codex';
      else if (!currentLane && modelHeader) {
        const mh = modelHeader[1].split(':')[0].toLowerCase();
        if (mh && !isFreeLane(mh) && mh !== 'gemma4') currentLane = null; // unknown model: leave unattributed
      }
      for (const line of text.split('\n')) {
        const sec = /^==\s*\[([a-z-]+)\]/i.exec(line);
        if (sec) { currentLane = sec[1].toLowerCase(); pending = false; continue; }
        const inline = /(?:total_tokens|prompt_tokens)["']?\s*[:=]?\s*(\d[\d,]{3,})/.exec(line);
        if (inline) { addTokens(Number(inline[1].replace(/,/g, ''))); continue; }
        if (/tokens? used/i.test(line)) { pending = true; continue; }
        if (pending) {
          const bare = /^\s*(\d[\d,]{3,})\s*$/.exec(line);
          if (bare) { addTokens(Number(bare[1].replace(/,/g, ''))); pending = false; }
          else if (/\S/.test(line)) pending = false; // a non-number line cancels
        }
      }
      function addTokens(n) {
        if (!Number.isFinite(n) || n <= 0) return;
        found = true;
        if (currentLane && !isFreeLane(currentLane)) {
          axPerLane.set(currentLane, (axPerLane.get(currentLane) || 0) + n);
        } else if (!currentLane || isFreeLane(currentLane)) {
          // free lane burn is excluded from spend math; no-lane stays unattributed
          if (!currentLane) axUnattributed += n;
        }
      }
      if (found) axRuns += 1;
    }
  } catch { /* no ax dir */ }

  // merge chat receipts into the same per-lane table (excluding free lanes)
  const merged = new Map(axPerLane);
  for (const [lane, v] of perLane) {
    if (isFreeLane(lane)) continue;
    merged.set(lane, (merged.get(lane) || 0) + v.tokens);
  }

  const paid = [...merged.entries()].map(([lane, tokens]) => ({ lane, tokens }));
  const aggregate = paid.reduce((sum, x) => sum + x.tokens, 0) + axUnattributed;

  return { perLane: paid, axUnattributed, axRuns, aggregate };
}

