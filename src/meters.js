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

// pacing: quota Q, window reset R, usage U -> verdict. Entitlement-aware:
//   - rollover credits burn AFTER the window quota (metered cents wait longer)
//   - recurring windows (window_hours) roll the reset forward while it's past
//   - the effective denominator includes rollover so % is honest
export function pacing({ quota, resetAt, used, rollover = 0, windowHours = null }) {
  if (quota == null && !rollover) return { state: 'unknown', note: 'quota or reset unknown — "—"' };
  const now = Date.now();
  let reset = resetAt ? new Date(resetAt).getTime() : NaN;
  if (Number.isNaN(reset) && !windowHours) return { state: 'unknown', note: 'bad reset date' };
  // recurring window: if the declared reset is already past, roll it forward
  if (Number.isFinite(reset) && windowHours && reset <= now) {
    while (reset <= now) reset += windowHours * 3.6e6;
  }
  const totalAvail = (quota || 0) + (rollover || 0);
  const left = totalAvail - (used || 0);
  if (left <= 0) return { state: 'empty', note: 'exhausted — downshift or park metered behind the budget gate' };
  const hoursLeft = Number.isFinite(reset) ? Math.max(0.1, (reset - now) / 3.6e6) : null;
  const pct = left / totalAvail;
  if (pct < 0.1) return { state: 'pacing', note: `${pct.toLocaleString(undefined, { style: 'percent' })} left${hoursLeft != null ? `, ${hoursLeft.toFixed(1)}h to reset` : ''} — pace it` };
  return { state: 'ok', note: `${pct.toLocaleString(undefined, { style: 'percent' })} of quota left${rollover ? ` (+${rollover.toLocaleString()} rollover)` : ''}` };
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


// ---- rate-limit meters --------------------------------------------------------
// request-rate ceilings declared per lane (rpm/rps). The chat driver calls
// rateGuard BEFORE each request; it delays until the sliding window has room
// or returns false when waiting would exceed the cap. Never invents a 429.
const rateLog = new Map(); // lane -> [tsMs, ...] of recent request starts
export async function rateGuard(laneName, { rpm = null, rps = null, maxWaitMs = 30000 } = {}) {
  if (!rpm && !rps) return true;
  const now = Date.now();
  const log = (rateLog.get(laneName) || []).filter((t) => now - t < 60000);
  const check = () => {
    if (rps) {
      const lastSec = log.filter((t) => now - t < 1000).length;
      if (lastSec >= rps) return false;
    }
    if (rpm) {
      if (log.length >= rpm) return false;
    }
    return true;
  };
  if (check()) {
    log.push(now);
    rateLog.set(laneName, log);
    return true;
  }
  // wait until the oldest request ages out of the stricter window, then retry once
  const waitMs = rps
    ? 1000 - (now - log[log.length - Math.ceil(rps)])
    : 60000 - (now - log[0]);
  if (!Number.isFinite(waitMs) || waitMs <= 0 || waitMs > maxWaitMs) return false;
  await new Promise((r) => setTimeout(r, Math.ceil(waitMs)));
  return rateGuard(laneName, { rpm, rps, maxWaitMs: 0 }); // one retry, no further wait
}

// ---- entitlement view: what the router reads ----------------------------------
// One snapshot per lane: pacing verdict + entitlement shape. Shapes:
//   unlimited-queued : no quota, but requests may queue (latency, not cost)
//   window           : recurring window_hours with a quota (e.g. 5h windows)
//   monthly          : calendar quota + reset_at
//   rollover         : monthly + rollover_tokens that burn after quota
//   rate-limited     : rpm/rps ceilings (hard)
export function entitlementShape(m) {
  if (!m) return 'undeclared';
  if (m.rpm || m.rps) return 'rate-limited';
  if (m.rollover_tokens) return 'rollover';
  if (m.window_hours) return 'window';
  if (m.quota_tokens != null && m.reset_at) return 'monthly';
  if (m.queued) return 'unlimited-queued';
  return 'declared-partial';
}

// The router's meter input: per-lane { state, shape, left } + provider grouping.
// Lanes with no meter are 'undeclared' (routed by cost class alone).
export function entitlementView(laneNames, { usage } = {}) {
  const meters = loadMeters();
  const byLane = new Map();
  for (const name of laneNames) {
    const m = meters.find((x) => x.lane === name) || null;
    const p = m ? pacing({
      quota: m.quota_tokens, resetAt: m.reset_at,
      used: usage?.get(name)?.tokens || 0,
      rollover: m.rollover_tokens || 0, windowHours: m.window_hours || null,
    }) : { state: 'undeclared', note: 'no meter declared' };
    byLane.set(name, { state: p.state, note: p.note, shape: entitlementShape(m), provider: m?.provider || null });
  }
  const byProvider = {};
  for (const [name, v] of byLane) {
    const key = v.provider || '(undeclared)';
    (byProvider[key] ||= []).push({ lane: name, ...v });
  }
  return { byLane, byProvider };
}