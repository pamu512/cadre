// Preferences learned from how this machine's runs actually go.
// A lane that keeps passing becomes the habit for that role and is used next
// time. A better pass rate replaces it. A habit that fails the gate or creeps
// the scope is not adopted and is not applied; the correction is named.
// Keeping a degrading habit takes an explicit --override or --role on this run.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { home } from './store.js';

const MAX_EVENTS = 80;
const MIN_SAMPLES = 3;

function path() {
  return join(home(), 'preferences.json');
}

export function loadPrefs() {
  try {
    const raw = JSON.parse(readFileSync(path(), 'utf-8'));
    return {
      choices: raw.choices && typeof raw.choices === 'object' ? raw.choices : {},
      choicesStats: raw.choicesStats && typeof raw.choicesStats === 'object' ? raw.choicesStats : {},
      events: Array.isArray(raw.events) ? raw.events : [],
    };
  } catch {
    return { choices: {}, choicesStats: {}, events: [] };
  }
}

function save(prefs) {
  mkdirSync(home(), { recursive: true });
  writeFileSync(path(), JSON.stringify(prefs, null, 2));
}

export function choiceFor(role) {
  const c = loadPrefs().choices?.[role];
  if (!c?.lane) return null;
  return c;
}

function laneStats(events) {
  const counts = new Map();
  for (const e of events) {
    const cur = counts.get(e.lane) || { seen: 0, passed: 0, creep: 0 };
    cur.seen += 1;
    if (e.passed) cur.passed += 1;
    if (e.creep) cur.creep += 1;
    counts.set(e.lane, cur);
  }
  return counts;
}

function isDegrading(stats) {
  if (!stats || stats.seen < MIN_SAMPLES) return false;
  return stats.passed / stats.seen < 0.5 || stats.creep / stats.seen > 0.5;
}

// Healthiest lane with enough samples. A degrading lane is never a candidate.
function bestHabit(events) {
  const ranked = [...laneStats(events).entries()]
    .filter(([, s]) => s.seen >= MIN_SAMPLES && !isDegrading(s))
    .sort((a, b) => {
      const rate = (s) => s.passed / s.seen;
      if (rate(b[1]) !== rate(a[1])) return rate(b[1]) - rate(a[1]);
      return b[1].seen - a[1].seen;
    });
  if (!ranked.length) return null;
  const [lane, s] = ranked[0];
  return { lane, passed: s.passed, seen: s.seen, rate: s.passed / s.seen };
}

// Adopt a passing habit. Replace the current one only when it has enough
// samples and the new lane passes more often, or the current one is degrading.
// A worse lane is left unused. An explicit steer with fewer than MIN_SAMPLES
// stays until the evidence is in.
function evolveRole(prefs, role) {
  const events = prefs.events.filter((e) => e.role === role);
  const best = bestHabit(events);
  const current = prefs.choices[role];
  if (!best) return;
  if (!current) {
    prefs.choices[role] = {
      lane: best.lane, at: new Date().toISOString(), source: 'habit',
      passed: best.passed, seen: best.seen,
    };
    return;
  }
  if (current.lane === best.lane) {
    delete current.from;
    current.passed = best.passed;
    current.seen = best.seen;
    return;
  }
  const cur = laneStats(events).get(current.lane) || { seen: 0, passed: 0, creep: 0 };
  if (cur.seen < MIN_SAMPLES) return;
  const curRate = cur.passed / cur.seen;
  if (!isDegrading(cur) && best.rate <= curRate) return;
  prefs.choices[role] = {
    lane: best.lane, at: new Date().toISOString(), source: 'habit',
    from: current.lane, passed: best.passed, seen: best.seen,
  };
}

// An explicit steer (--role, a pin that was used) is remembered immediately.
// Every outcome updates the counts, then a healthy habit can take the role.
export function recordOutcome({ role, lane, source = 'fit', passed = false, creep = false, tokens = 0 } = {}) {
  if (!role || !lane) return loadPrefs();
  const prefs = loadPrefs();
  prefs.events.push({
    at: new Date().toISOString(),
    role, lane, source,
    passed: Boolean(passed),
    creep: Boolean(creep),
    tokens: Number(tokens) || 0,
  });
  prefs.events = prefs.events.slice(-MAX_EVENTS);
  if (source === 'explicit' || source === 'pin') {
    prefs.choices[role] = { lane, at: new Date().toISOString(), source };
  }
  evolveRole(prefs, role);
  save(prefs);
  return prefs;
}

export function recordChoice(kind, value, { passed } = {}) {
  if (!kind || value == null || value === '') return loadPrefs();
  const prefs = loadPrefs();
  const key = `${kind}:${value}`;
  const cur = prefs.choicesStats[key] || { kind, value: String(value), seen: 0, passed: 0 };
  if (passed !== undefined) {
    cur.seen += 1;
    if (passed) cur.passed += 1;
  }
  prefs.choicesStats[key] = cur;
  save(prefs);
  return cur;
}

export function judgeChoice(kind, value) {
  const cur = loadPrefs().choicesStats?.[`${kind}:${value}`];
  if (!cur || cur.seen < MIN_SAMPLES) return { degrading: false, samples: cur?.seen || 0, why: 'not enough runs yet' };
  const rate = cur.passed / cur.seen;
  const degrading = rate < 0.5;
  return {
    degrading,
    samples: cur.seen,
    rate,
    why: `${cur.passed}/${cur.seen} passed`,
  };
}

// The passing value of a flag (scope, budget) once it has been used enough.
// A value under half passes is not a habit.
export function bestChoice(kind) {
  const ranked = Object.values(loadPrefs().choicesStats || {})
    .filter((s) => s.kind === kind && s.seen >= MIN_SAMPLES && s.passed / s.seen >= 0.5)
    .sort((a, b) => (b.passed / b.seen) - (a.passed / a.seen) || b.seen - a.seen);
  return ranked[0] || null;
}

// Apply a learned flag, or the one this run asked for.
// A degrading value is dropped and the healthier habit is the correction.
// --override is the only way to keep the degrading value.
export function resolveHabit(kind, requested, { override = false } = {}) {
  const learned = bestChoice(kind);
  const asked = requested == null || requested === '' ? null : String(requested);
  if (asked) {
    const judgment = judgeChoice(kind, asked);
    if (judgment.degrading && !override) {
      const offer = learned && String(learned.value) !== asked ? learned : null;
      const correction = offer
        ? `correction · ${kind} ${offer.value} passed ${offer.passed}/${offer.seen}.`
        : 'No healthier habit yet.';
      return {
        value: offer ? String(offer.value) : null,
        note: `preference · ${kind} ${asked} is degrading the pipeline (${judgment.why}). ${correction} --override keeps it.`,
      };
    }
    if (judgment.degrading && override) {
      return {
        value: asked,
        note: `preference · ${kind} ${asked} is degrading (${judgment.why}). Kept by explicit --override.`,
      };
    }
    return { value: asked, note: null };
  }
  if (!learned) return { value: null, note: null };
  return {
    value: String(learned.value),
    note: `preference · ${kind} ${learned.value} from habit (${learned.passed}/${learned.seen} passed).`,
  };
}

function roleEvents(role, lane) {
  return loadPrefs().events.filter((e) => e.role === role && (!lane || e.lane === lane));
}

// Best other lane for this role, by pass rate, with at least 2 samples.
function correctionFor(role, lane) {
  const counts = new Map();
  for (const e of roleEvents(role)) {
    if (e.lane === lane) continue;
    const cur = counts.get(e.lane) || { seen: 0, passed: 0 };
    cur.seen += 1;
    if (e.passed) cur.passed += 1;
    counts.set(e.lane, cur);
  }
  const ranked = [...counts.entries()]
    .filter(([, s]) => s.seen >= 2)
    .sort((a, b) => (b[1].passed / b[1].seen) - (a[1].passed / a[1].seen));
  if (!ranked.length) return null;
  const [name, s] = ranked[0];
  return { lane: name, passed: s.passed, seen: s.seen };
}

export function judgeRole(role, lane) {
  const events = roleEvents(role, lane);
  if (events.length < MIN_SAMPLES) {
    return { degrading: false, samples: events.length, why: 'not enough runs yet', correction: null };
  }
  const passed = events.filter((e) => e.passed).length;
  const creep = events.filter((e) => e.creep).length;
  const rate = passed / events.length;
  const creepRate = creep / events.length;
  const degrading = rate < 0.5 || creepRate > 0.5;
  const correction = correctionFor(role, lane);
  const why = degrading
    ? `${passed}/${events.length} passed, ${creep} scope rejection${creep === 1 ? '' : 's'}`
    : `${passed}/${events.length} passed`;
  return { degrading, samples: events.length, rate, creepRate, why, correction };
}

// Healthy remembered lane for a role, or null when there is none or it is degrading.
export function healthyChoice(role) {
  const c = choiceFor(role);
  if (!c) return null;
  const j = judgeRole(role, c.lane);
  if (j.degrading) return null;
  return c.lane;
}

// One run in five skips the habit bonus so a better lane can be tried.
export function exploreRole(role) {
  const n = loadPrefs().events.filter((e) => e.role === role).length;
  return n > 0 && n % 5 === 4;
}

// Each role is scored on its own output, not on the run's gate.
export function scoreRole(role, { passed = false, planText = '', delta = [], critique = '', verified = null } = {}) {
  const files = (delta || []).map((f) => String(f?.file || f)).filter(Boolean);
  const hit = (text) => files.some((f) => text.includes(f) || text.includes(f.split('/').pop()));
  if (role === 'planner') {
    if (!files.length || !planText) return Boolean(passed);
    return hit(planText);
  }
  if (role === 'critic') {
    if (!critique) return Boolean(passed);
    if (passed && /CLEAN|no defect/i.test(critique)) return true;
    if (!passed) return hit(critique) || /fail|error|exit|creep/i.test(critique);
    return true;
  }
  if (role === 'verifier') return verified == null ? Boolean(passed) : Boolean(verified);
  return Boolean(passed);
}

// Quiet hours after a week of proven runs that never started overnight.
// An explicit pin is the caller's job to keep; this only returns a window.
export function inferQuietHours(runs) {
  const proven = (runs || []).filter((r) => r?.verdict?.passed && r.started);
  const times = proven.map((r) => Date.parse(r.started)).filter((t) => Number.isFinite(t));
  if (times.length < 2) return null;
  if (Math.max(...times) - Math.min(...times) < 7 * 24 * 60 * 60 * 1000) return null;
  const night = proven.some((r) => {
    const h = new Date(r.started).getHours();
    return h >= 23 || h < 7;
  });
  if (night) return null;
  return { start: '23:00', end: '07:00' };
}

export function preferenceAlert({ role, lane, judgment, kept }) {
  const corr = judgment.correction
    ? `correction · ${judgment.correction.lane} passed ${judgment.correction.passed}/${judgment.correction.seen} on ${role}.`
    : `correction · use the lane that fits this brief.`;
  if (kept) {
    return `preference · ${role}=${lane} is degrading the pipeline (${judgment.why}). Kept because this run said so explicitly.`;
  }
  return `preference · ${role}=${lane} is degrading the pipeline (${judgment.why}). ${corr} --override or --role ${role}=${lane} keeps it.`;
}
