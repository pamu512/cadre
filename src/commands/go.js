// go - the one command. Scans the room, forms the cadre, runs the loop,
// gates on evidence, files the receipts. Every step is real on this machine:
// ax lanes delegate to the ax binary; keyed chat lanes (any OpenAI-compatible
// re-checks artifacts on disk before stamping anything.
import { createHash } from 'node:crypto';
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildRoster } from '../scan.js';
import { recordOutcome, recordChoice, resolveHabit, scoreRole, inferQuietHours } from '../preferences.js';
import { laneDrivable } from '../invoke.js';
import { assignRoles, explainRouting, bestDrivable } from '../router.js';
import { auditCall } from '../laneaudit.js';
import { chatLaneAvailable, chatLane } from '../chatlane.js';
import { gateVerdict, renderGateReport, verifyCommands, runGate } from '../gate.js';
import { invokeLane } from '../invoke.js';
import { buildScopeManifest, scopeCreep, renderManifest, checkDoneCondition, writeScopeFile, readScopeFile, runDeltaFiles, settleCreep, lockSpecs } from '../scope.js';
import {
  createRun, updateRun, appendLog, addEvidence, audit, listRuns, loadPins, savePins, home, readRun,
  acquireLock, releaseLock,
} from '../store.js';

const run = promisify(execFile);

function notePreferences(roles, flags, { passed, creep, tokens, planText = '', delta = [], critique = '', verified = null }) {
  for (const [role, lane] of Object.entries(roles || {})) {
    if (!lane) continue;
    const explicit = Boolean(flags.override) || (typeof flags.role === 'string' && flags.role.startsWith(`${role}=`));
    const rolePassed = scoreRole(role, { passed, planText, delta, critique, verified });
    recordOutcome({ role, lane, source: explicit ? 'explicit' : 'fit', passed: rolePassed, creep: role === 'builder' ? creep : false, tokens });
  }
  if (typeof flags.scope === 'string') recordChoice('scope', String(flags.scope), { passed });
  if (flags.budget) recordChoice('budget', String(flags.budget), { passed });
}

async function rememberHands(byRole, { brief, delta, passed, critique }) {
  const { rememberHandOutcome } = await import('../invoke.js');
  const files = (delta || []).map((f) => String(f?.file || f)).filter(Boolean);
  for (const lane of Object.values(byRole || {})) {
    if (lane?.invoke?.kind !== 'hand') continue;
    rememberHandOutcome(lane, { files, passed, critique, task: brief });
  }
}

function markPhase(id, phase, data = {}) {
  const cur = readRun(id);
  const prev = cur?.checkpoint || { phases: [] };
  updateRun(id, { checkpoint: { ...prev, ...data, phases: [...new Set([...(prev.phases || []), phase])] } });
}

function detectTestCommand(cwd) {
  if (existsSync(join(cwd, 'package.json'))) {
    try {
      const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf-8'));
      if (pkg.scripts?.test) return { cmd: 'npm', args: ['test'], label: 'npm test' };
    } catch { /* fall through */ }
  }
  if (existsSync(join(cwd, 'Makefile'))) return { cmd: 'make', args: ['test'], label: 'make test' };
  if (existsSync(join(cwd, 'Cargo.toml'))) return { cmd: 'cargo', args: ['test'], label: 'cargo test' };
  if (existsSync(join(cwd, 'pyproject.toml'))) return { cmd: 'python3', args: ['-m', 'pytest'], label: 'pytest' };
  return null;
}

// fs snapshot for non-git projects: the diff family must not be git-only
function fsSnapshot(cwd) {

  const snap = new Map();
  const walk = (dir, prefix) => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith('.') || e.name === 'node_modules') continue;
      const full = join(dir, e.name);
      const rel = prefix ? prefix + '/' + e.name : e.name;
      if (e.isDirectory()) walk(full, rel);
      else {
        try { snap.set(rel, statSync(full).mtimeMs + ':' + statSync(full).size); } catch { /* raced */ }
      }
    }
  };
  walk(cwd, '');
  return snap;
}

function fsDiff(before, after) {
  const out = [];
  for (const [f, sig] of after) if (!before.has(f) || before.get(f) !== sig) out.push({ file: f, isNew: !before.has(f) });
  return out;
}

async function gitState(cwd) {
  if (!existsSync(join(cwd, '.git'))) return null;
  try {
    const { stdout } = await run('git', ['diff', 'HEAD', '--numstat'], { cwd, maxBuffer: 1024 * 1024 * 16 });
    const { stdout: un } = await run('git', ['status', '--porcelain'], { cwd, maxBuffer: 1024 * 1024 });
    return { numstat: stdout, porcelain: un };
  } catch { return null; }
}

function referenceMoved(run) {
  const ref = run?.meta?.ref;
  const prev = run?.meta?.refSha;
  if (!ref || !prev || !existsSync(ref)) return null;
  const now = createHash('sha256').update(readFileSync(ref)).digest('hex');
  return now === prev ? null : { ref, prev, now };
}

export async function cmdGo(args, flags, { cwd = process.cwd() } = {}) {
  let brief = args.join(' ').trim();
  let resumed = null;
  if (flags.resume) {
    resumed = readRun(String(flags.resume));
    if (!resumed) {
      console.error(`no run ${flags.resume}`);
      return 1;
    }
    if (!brief) brief = resumed.brief;
    const moved = referenceMoved(resumed);
    if (moved) {
      const neu = createRun({
        brief: resumed.brief, kind: 'parity',
        meta: { ref: moved.ref, refSha: moved.now, queuedFrom: resumed.id },
      });
      updateRun(neu.id, { status: 'queued', verdict: { passed: false, summary: `reference moved; re-locked from ${resumed.id}` } });
      updateRun(resumed.id, { status: 'retired', ended: new Date().toISOString(), verdict: { passed: false, summary: `reference moved; re-locked as ${neu.id}` } });
      console.log(`reference moved · retired ${resumed.id} · queued ${neu.id} to re-lock ${moved.ref}`);
      return 0;
    }
  }
  if (!brief) {
    console.error('cadre go "<outcome>" - what should the cadre do?');
    return 2;
  }
  const scopeHabit = resolveHabit('scope', typeof flags.scope === 'string' ? flags.scope : null, { override: Boolean(flags.override) });
  if (scopeHabit.note) console.log(scopeHabit.note);
  flags.scope = scopeHabit.value;
  const budgetAsked = flags.budget ? String(flags.budget) : null;
  const budgetHabit = resolveHabit('budget', budgetAsked, { override: Boolean(flags.override) });
  if (budgetHabit.note) console.log(budgetHabit.note);
  if (budgetAsked || (budgetHabit.value && !loadPins().budget)) flags.budget = budgetHabit.value;

  // --dry: show the real routing + pipeline for THIS machine, spend nothing.
  if (flags.dry) {
    const roster = await buildRoster();
    const routing = assignRoles(roster, { brief, roleOverride: flags.role || null, override: Boolean(flags.override) });
    console.log(`cadre go (dry) - ${brief}`);
    console.log(`roster: ${roster.lanes.length} lane(s) on this machine (${roster.clis.map((c) => c.label).join(', ') || 'no CLIs'} · ${roster.platform})`);
    console.log('crew (roles by fit, pins override):');
    console.log(explainRouting(routing).replace(/^/gm, '  '));
    for (const a of routing.assignments.alerts || []) console.log(a);
    const fitBuilder = routing.assignments.find((a) => a.role === 'builder');
    console.log(`builder by fit: ${fitBuilder?.lane || '-'}`);
    console.log(`keyed chat lanes: ${roster.lanes.filter(chatLaneAvailable).map((l) => l.name).join(', ') || 'none - planner uses the local scaffold, critic skipped'}`);
    console.log('pipeline: sweep -> scan -> route -> plan -> build -> critique -> verify -> gate -> file');
    return 0;
  }

  const roster = await buildRoster();
  const routing = assignRoles(roster, { brief, roleOverride: flags.role || null, override: Boolean(flags.override) });
  // scope lock (PRD 6.6): manifest before work breathes
  const manifest = buildScopeManifest({ brief, scope: typeof flags.scope === 'string' ? flags.scope : null, cwd, doneCondition: typeof flags.done === 'string' ? flags.done : null });
  const scopeManifest = manifest; // alias for the rules critic below
  let mapSlice = 'MAP (empty index)';
  let mapFiles = [];
  let indexedFiles = [];
  try {
    const { ensureMap, sliceFor, mapIsWarm } = await import('../map.js');
    const { forContext } = await import('../frugal.js');
    const mapped = ensureMap(cwd);
    const rawSlice = sliceFor(mapped, { brief, lock: manifest.lock });
    indexedFiles = [...new Set((mapped.bySymbol || []).flatMap((s) => s.files || []))];
    mapFiles = [...new Set([...rawSlice.matchAll(/[\w./-]+\.(?:js|mjs|cjs|ts|tsx|py|sh|json|md|txt)\b/g)].map((x) => x[0]))];
    const frugalSlice = forContext(rawSlice);
    mapSlice = frugalSlice.text.startsWith('MAP') ? frugalSlice.text : `MAP\n${frugalSlice.text}`;
    console.log(mapIsWarm(mapped) ? 'map · warm' : 'map · cold');
    if ((mapped.hotZones || []).length) console.log(`map · hot zones: ${mapped.hotZones.slice(0, 3).map((h) => h.path).join(', ')}`);
  } catch { /* the slice stays empty; the skill check will say so */ }
  const roles = Object.fromEntries(routing.assignments.map((a) => [a.role, a.lane]));
  const record = resumed
    ? updateRun(resumed.id, { status: 'running', roles, meta: { ...(resumed.meta || {}), scope: manifest, cwd } })
    : createRun({ brief, kind: 'go', roles, meta: { scope: manifest, cwd } });
  if (resumed) console.log(`resume · ${record.id} from checkpoint [${(resumed.checkpoint?.phases || []).join(', ') || 'start'}]`);
  for (const a of routing.assignments.alerts || []) console.log(a);
  acquireLock(record.id, { brief });
  globalThis.CADRE_ACTIVE_RUN = record.id;
  writeScopeFile(join(home(), 'runs', record.id, 'scope.json'), manifest);
  writeScopeFile(join(cwd, '.cadre', 'scope.json'), manifest);
  appendLog(record.id, `SCOPE locked:\n${renderManifest(manifest)}`);
  const restatement = String(brief).replace(/\s+/g, ' ').slice(0, 180);
  appendLog(record.id, `RESTATE: ${restatement}`);
  appendLog(record.id, mapSlice.startsWith('MAP') ? mapSlice : `MAP\n${mapSlice}`);
  // sweep-on-start (#13): fold compatible leftovers into this run (same brief
  // text = compatible; their evidence attaches), retire the rest is NOT done
  // here - incompatible leftovers stay for cadre sweep.
  const leftovers = listRuns().filter((r) => r.id !== record.id && ['running', 'interrupted'].includes(r.status));
  if (leftovers.length > 0) {
    const compatible = leftovers.filter((l) => l.brief === brief);
    const incompatible = leftovers.filter((l) => l.brief !== brief);
    for (const l of compatible) {
      console.log(`sweep · folding leftover ${l.id} into this run (same brief; ${((l.evidence || []).length)} evidence item(s) attach)`);
      for (const ev of l.evidence || []) await addEvidence(record.id, { ...ev, foldedFrom: l.id });
      updateRun(l.id, { status: 'retired', ended: new Date().toISOString(), verdict: { passed: false, summary: `folded into run ${record.id}` } });
      audit({ kind: 'sweep-fold', from: l.id, into: record.id });
    }
    if (incompatible.length) {
      console.log(`sweep · ${incompatible.length} incompatible leftover(s) left for cadre sweep: ${incompatible.map((l) => l.id).join(', ')}`);
    }
  }

  console.log(`cadre go - run ${record.id} · ${brief}`);
  console.log(`roster · ${roster.lanes.length} lane(s)`);
  console.log(explainRouting(routing).replace(/^/gm, '  '));
  if (flags.scope) {
    console.log('scope lock:');
    console.log(renderManifest(manifest).replace(/^/gm, '  '));
  }
  appendLog(record.id, `SCOPE MANIFEST:\n${renderManifest(manifest)}`);
  appendLog(record.id, `routing: ${routing.assignments.map((a) => `${a.role}=${a.lane}`).join(' ')}`);
  audit({ kind: 'run-start', run: record.id, brief, roles: record.roles });

  const pins = loadPins();
  const budgetTokens = Number(flags.budget || pins.budget || 200000);
  let meteredTokens = 0;
  const underBudget = () => meteredTokens < budgetTokens;
  // EVERY exit path stamps the usage rollup - early-aborted runs cost real
  // tokens too and the audit trail must say how many.
  const stampUsage = (runId) => {
    try {
      const r = readRun(runId);
      if (r && !r.usage?.budget_tokens) updateRun(runId, { usage: { metered_tokens: meteredTokens, budget_tokens: budgetTokens } });
    } catch { /* ledger write best-effort */ }
  };

  const byRole = Object.fromEntries(routing.assignments.map((a) => [a.role, roster.lanes.find((l) => l.name === a.lane)]));

  // The builder is whoever fits and can be driven. --ax forces an ax lane.
  // A command lane wins only when its tags fit, not because it was declared.
  if (!flags.ax) {
    if (byRole.builder && !laneDrivable(byRole.builder)) {
      const next = bestDrivable(roster, 'builder', brief, laneDrivable);
      if (next) {
        byRole.builder = next;
        appendLog(record.id, `builder ${routing.assignments.find((a) => a.role === 'builder')?.lane} has no driver; using ${next.name}`);
        console.log(`builder · fit pick has no driver, using ${next.name}`);
      }
    } else if (byRole.builder) {
      console.log(`builder by fit: ${byRole.builder.name}`);
    }
  } else {
    const axLane = roster.lanes.find((l) => l.invoke?.kind === 'ax' && laneDrivable(l));
    if (axLane) byRole.builder = axLane;
  }


  // ---- quiet hours: refuse to spend inside the window (unless --override) --
  // the 3am promise: unattended loops don't burn quotas while you sleep.
  try {
    const pinsNow = loadPins();
    if (!pinsNow.quiet_hours) {
      const inferred = inferQuietHours(listRuns());
      if (inferred) {
        pinsNow.quiet_hours = inferred;
        savePins(pinsNow);
        console.log(`quiet hours · learned ${inferred.start}–${inferred.end} from a week with no proven run in that window. --override spends anyway.`);
      }
    }
    const pinsQ = loadPins().quiet_hours;
    if (pinsQ && !flags.override) {
      const now = new Date();
      const mins = now.getHours() * 60 + now.getMinutes();
      const [sh, sm] = String(pinsQ.start || '23:00').split(':').map(Number);
      const [eh, em] = String(pinsQ.end || '07:00').split(':').map(Number);
      const start = sh * 60 + (sm || 0);
      const end = eh * 60 + (em || 0);
      const inside = start <= end ? (mins >= start && mins < end) : (mins >= start || mins < end); // overnight window wraps
      if (inside) {
        console.log(`quiet hours · inside ${pinsQ.start}–${pinsQ.end} - refusing to spend; filing paused-with-resume-plan (--override to break glass)`);
        appendLog(record.id, `QUIET HOURS: inside ${pinsQ.start}-${pinsQ.end} - paused before any spend`);
        updateRun(record.id, { status: 'resumed-brief', verdict: { passed: false, summary: `paused: quiet hours ${pinsQ.start}-${pinsQ.end}` } });
        audit({ kind: 'quiet-hours-refusal', run: record.id, window: `${pinsQ.start}-${pinsQ.end}` });
        releaseLock(record.id, 'quiet-hours');
        return 3;
      }
    } else if (pinsQ && flags.override) {
      console.log(`quiet hours · ${pinsQ.start}–${pinsQ.end} active but --override passed - proceeding (recorded)`);
      appendLog(record.id, `QUIET HOURS override: proceeding inside ${pinsQ.start}-${pinsQ.end} by explicit flag`);
    }
  } catch { /* quiet-hours check is best-effort */ }

  // ---- meter preflight: downshift or wait-for-refill before spending -------
  try {
    const { loadMeters, pacing } = await import('../meters.js');
    const meters = loadMeters();
    if (meters.length) {
      const { usageFromAudit } = await import('../meters.js');
      const usage = usageFromAudit();
      for (const m of meters) {
        const p = pacing({ quota: m.quota_tokens, resetAt: m.reset_at, used: m.used_tokens != null ? m.used_tokens : (usage.get(m.lane)?.tokens || 0) });
        if (p.state === 'empty') {
          const hrs = ((new Date(m.reset_at) - Date.now()) / 3.6e6);
          if (m.reset_at && hrs > 0 && hrs <= 6 && !flags.no_wait) {
            appendLog(record.id, `METER: ${m.lane} exhausted; reset in ${hrs.toFixed(1)}h - pausing, will resume after refill`);
            console.log(`meter · ${m.lane} empty - reset in ${hrs.toFixed(1)}h. Filing as paused-with-resume-plan (re-run after refill, or --no-wait to downshift now).`);
            updateRun(record.id, { status: 'resumed-brief', verdict: { passed: false, summary: `paused: ${m.lane} quota empty, resets ${m.reset_at}` } });
            stampUsage(record.id);
            return 3;
          }
          appendLog(record.id, `METER: ${m.lane} exhausted - falling down the chain`);
          console.log(`meter · ${m.lane} empty - falling down the chain`);
          // plan-router take: multi-tier fallback chain, included stops first
          roster.lanes = roster.lanes.filter((l) => l.name !== m.lane);
          const { buildChain, pickStop } = await import('../fallback.js');
          // downshift only to lanes THIS loop can actually drive (a free lane
          // with no driver is a dead stop, not a fallback)
          const drivable = roster.lanes.filter((l) => laneDrivable(l) && (l.cost === 'free' || l.cost === 'plan'));
          const undrivable = roster.lanes.filter((l) => !drivable.includes(l)).map((l) => l.name);
          if (undrivable.length) appendLog(record.id, `CHAIN skipped undrivable lane(s): ${undrivable.join(', ')}`);
          const health = Object.fromEntries(drivable.map((l) => [l.name, l.invoke?.status || 'ok']));
          const pick = pickStop(buildChain({ lanes: drivable }, 'builder', { budgetTokens }), { health });
          if (pick.lane) {
            byRole.builder = drivable.find((l) => l.name === pick.lane) || roster.lanes.find((l) => l.name === pick.lane);
            console.log(`chain · stop ${pick.stop}: ${pick.lane}${pick.rerouted ? ' (rerouted)' : ''}${pick.notes.length ? ' - ' + pick.notes.join('; ') : ''}`);
            appendLog(record.id, `CHAIN stop ${pick.stop}: ${pick.lane} ${pick.notes.join('; ')}`);
          } else {
            console.log(`chain · all stops exhausted - pausing with resume plan`);
            updateRun(record.id, { status: 'resumed-brief', verdict: { passed: false, summary: 'all chain stops exhausted' } });
            stampUsage(record.id);
            return 3;
          }
        } else if (p.state === 'pacing') {
          console.log(`meter · ${m.lane} ${p.note}`);
        }
      }
    }
  } catch (e) { console.log(`meter preflight skipped (${e.message.split('\n')[0]})`); }


  // ---- 0. reuse ------------------------------------------------------------
  console.log('\n── reuse ────────────────────────────');
  try {
    const { findReuse } = await import('../reuse.js');
    const candidates = await findReuse({ brief, root: cwd });
    if (candidates.length) {
      appendLog(record.id, `REUSE candidates:\n${candidates.map((c) => `- [${c.source}] ${c.what} (${c.where}) - ${c.why}`).join('\n')}`);
      console.log('before building new, reuse exists:');
      for (const c of candidates) console.log(`  [${c.source}] ${c.what} (${c.where}) - ${c.why}`);
      await addEvidence(record.id, { kind: 'citation', label: 'reuse survey', ref: `runs/${record.id}/run.log#reuse` });
    } else {
      console.log('no existing fit found - new build justified');
      appendLog(record.id, 'REUSE: no existing fit found');
    }
  } catch (e) {
    console.log(`reuse survey skipped (${e.message.split('\n')[0]})`);
  }

  // ---- 1. plan -------------------------------------------------------------
  console.log('\n── plan ─────────────────────────────');
  let planText = null;
  const planned = readRun(record.id)?.checkpoint;
  if (resumed && planned?.phases?.includes('plan') && planned.planText) {
    planText = planned.planText;
    console.log('resume · plan checkpoint kept');
    appendLog(record.id, 'RESUME plan checkpoint kept');
  }
  const planner = byRole.planner;
  if (!planText && planner && chatLaneAvailable(planner) && underBudget()) {
    try {
      const res = await chatLane(planner, [
        { role: 'system', content: 'You are the planner of a coding cadre. Given a brief, produce a numbered plan of at most 6 concrete, checkable steps. Each step: verb, target, and how to verify it. No prose preamble.' },
        { role: 'user', content: `Brief: ${brief}\n\n${mapSlice}` },
      ], { max_tokens: 700 });
meteredTokens += (res.usage?.total_tokens || 0);
      planText = res.text;
      auditCall(record.id, planner.name, res);
      await addEvidence(record.id, { kind: 'citation', label: `planner (${planner.name}) plan`, ref: `runs/${record.id}/run.log#plan` });
      console.log(`planner · ${planner.name} accepted the brief:`);
      console.log(planText.replace(/^/gm, '  '));
      appendLog(record.id, `PLAN (${planner.name} ${res.model}):\n${planText}`);
    } catch (e) {
      console.log(`planner · ${planner.name} failed (${e.message.split('\n')[0]}) - falling back to local scaffold`);
    }
  }
  if (!planText && !(resumed && planned?.phases?.includes('plan'))) {
    planText = [
      `1. read the brief: ${brief}`,
      '2. builder implements the change',
      '3. critic reviews the diff for scope creep and defects',
      '4. verifier runs the project checks',
      '5. gate: evidence in all four families or it goes back',
    ].join('\n');
    console.log('planner · local scaffold:');
    console.log(planText.replace(/^/gm, '  '));
    appendLog(record.id, `PLAN (local scaffold):\n${planText}`);
  }
  if (planText) markPhase(record.id, 'plan', { planText });


  // ---- 2. build (optionally raced across builders in isolated worktrees) ----
  console.log('\n── build ────────────────────────────');
  let changedFilesList = [];
  let diffsTextForCritic = '';
  let evidenceKindsForCritic = [];
  const before = await gitState(cwd);
  globalThis.CADRE_FS_SNAPSHOT = before ? null : fsSnapshot(cwd);
  let builder = byRole.builder;
  let buildOutput = '';
  // ---- pace-to-the-window preflight: the math says so BEFORE the run starts --
  // need = budget cap (the honest upper bound of this run's spend). If even a
  // fresh window can't cover it, refuse now - no hour-one blowthrough.
  globalThis.CADRE_WINDOW_BUCKETS = null;
  try {
    const { loadMeters, usageFromAudit, pacePlan, windowBucket } = await import('../meters.js');
    const meters2 = loadMeters();
    const usage2 = usageFromAudit();
    if (meters2.length) {
      // the lane we plan to build with carries the pacing constraint
      const bl = builder?.name;
      const bm = bl ? meters2.find((x) => x.lane === bl) : null;
      if (bm && bm.quota_tokens != null) {
        const plan = pacePlan({
          quota: bm.quota_tokens, resetAt: bm.reset_at,
          used: bm.used_tokens != null ? bm.used_tokens : (usage2.get(bm.lane)?.tokens || 0),
          rollover: bm.rollover_tokens || 0, windowHours: bm.window_hours || null,
          neededTokens: budgetTokens,
        });
        appendLog(record.id, `PACE PLAN (${bm.lane}): ${plan.mode} - ${plan.note}`);
        if (!plan.closes) {
          console.log(`pace · ${bm.lane} ${plan.note}`);
          console.log('pace · refusing to start: the math does not close BEFORE we spend a cent');
          updateRun(record.id, { status: 'resumed-brief', verdict: { passed: false, summary: `pace: ${plan.note}` } });
          audit({ kind: 'pace-refusal', run: record.id, lane: bm.lane, note: plan.note });
          releaseLock(record.id, 'pace-no-close');
          return 8;
        }
        if (plan.mode === 'pace') {
          console.log(`pace · ${bm.lane} ${plan.note}`);
          globalThis.CADRE_WINDOW_BUCKETS = new Map([[bm.lane, windowBucket({
            quota: bm.quota_tokens, rollover: bm.rollover_tokens || 0,
            used: bm.used_tokens != null ? bm.used_tokens : (usage2.get(bm.lane)?.tokens || 0), windowHours: bm.window_hours || 24,
          })]]);
        }
      }
    }
  } catch { /* pace preflight best-effort */ }


  // speculative race (--race N): N file-acting builders work the same brief
  // concurrently in isolated git worktrees; judged in fit order (changes +
  // project tests); first PROVEN candidate is applied; losers recorded.
  const raceN = Math.max(1, Math.min(Number(flags.race) || 1, 5));
  let raced = false;
  if (raceN >= 2 && before) {
    const { scoreLane, historyPenalty, laneHistory } = await import('../router.js');
    // rank: fit, then DEMONSTRATED RESULTS (wins), then penalty, then cost
    const racers = roster.lanes
      .filter((l) => ['command', 'mcp'].includes(l.invoke?.kind) && l.invoke?.status !== 'down')
      .map((l) => {
        const h = laneHistory().get(l.name) || { runs: 0, passed: 0 };
        return { lane: l, s: scoreLane(l, 'builder'), hp: historyPenalty(l), wins: h.passed };
      })
      .sort((a, b) => (b.s.fit - a.s.fit) || (b.wins - a.wins) || (a.hp - b.hp) || ((a.s.costRank ?? 3) - (b.s.costRank ?? 3)))
      .slice(0, raceN)
      .map((x) => x.lane);
    if (racers.length < 2) {
      console.log(`race · only ${racers.length} file-acting builder(s) - racing off`);
      appendLog(record.id, `RACE off: ${racers.length} file-acting builder(s)`);
    } else {
      raced = true;
      const raceDir = join(home(), 'runs', record.id, 'race');
      mkdirSync(raceDir, { recursive: true });
      const slots = racers.map((l, i) => ({ lane: l, dir: join(raceDir, `wt-${i}`) }));
      const outcomes = [];
      let winner = null;
      try {
        await Promise.all(slots.map((x) => run('git', ['worktree', 'add', '--detach', x.dir, 'HEAD'], { cwd, maxBuffer: 1024 * 1024 })));
        console.log(`race · ${slots.length} builders racing in isolated worktrees: ${slots.map((x) => x.lane.name).join(', ')}`);
        appendLog(record.id, `RACE start: ${slots.map((x) => x.lane.name).join(', ')} (worktrees: runs/${record.id}/race/)`);
        const settled = await Promise.allSettled(slots.map(async (x) => {
          const res = await invokeLane(x.lane, brief, { timeoutMs: 1000 * 60 * 30, override: Boolean(flags.override), context: flags.context, cwd: x.dir, allowWrites: [x.dir] });
          return { ...x, res };
        }));
        const test = detectTestCommand(cwd);
        for (let i = 0; i < settled.length; i++) {
          const st = settled[i];
          const slot = slots[i];
          if (st.status !== 'fulfilled' || !st.value.res.ok) { outcomes.push(`${slot.lane.name}: build failed`); continue; }
          const wt = await gitState(slot.dir);
          if (!wt || wt.porcelain.trim().length === 0) { outcomes.push(`${slot.lane.name}: no changes`); continue; }
          let testsOk = true;
          if (test) {
            try { await run(test.cmd, test.args, { cwd: slot.dir, timeout: 1000 * 60 * 5, maxBuffer: 1024 * 1024 * 16 }); }
            catch { testsOk = false; }
          }
          if (!testsOk) { outcomes.push(`${slot.lane.name}: tests failed`); continue; }
          outcomes.push(`${slot.lane.name}: PROVEN (winner)`);
          winner = { slot, res: st.value.res };
          break;
        }
        if (winner) {
          await run('git', ['-C', winner.slot.dir, 'add', '-A'], { maxBuffer: 1024 * 1024 * 8 });
          const { stdout: wdiff } = await run('git', ['-C', winner.slot.dir, 'diff', '--cached', 'HEAD'], { maxBuffer: 1024 * 1024 * 32 });
          const patchPath = join(raceDir, 'winner.patch');
          writeFileSync(patchPath, wdiff);
          await run('git', ['-C', cwd, 'apply', patchPath], { maxBuffer: 1024 * 1024 * 8 });
          builder = winner.slot.lane;
          buildOutput = winner.res.stdout || winner.res.text || '';
          appendLog(record.id, `BUILD (race winner ${builder.name}):\n${buildOutput.slice(0, 20000)}`);
          appendLog(record.id, `RACE outcomes:\n  ${outcomes.join('\n  ')}`);
          console.log(`race · winner: ${builder.name} (diff applied to the working tree)`);
          console.log(outcomes.map((o) => `  ${o}`).join('\n'));
          await addEvidence(record.id, { kind: 'citation', label: `race outcomes (${slots.length} builders)`, ref: `runs/${record.id}/run.log#race` });
        } else {
          appendLog(record.id, `RACE outcomes (no winner):\n  ${outcomes.join('\n  ')}`);
          console.log(`race · no candidate proven:\n${outcomes.map((o) => `  ${o}`).join('\n')}`);
          await updateRun(record.id, { status: 'failed', ended: new Date().toISOString(), verdict: { passed: false, missing: [], summary: 'race: no candidate proven' } });
stampUsage(record.id);
    stampUsage(record.id);
      audit({ kind: 'run-end', run: record.id, status: 'failed' });
          releaseLock(record.id, 'race-no-winner');
          return 1;
        }
      } finally {
        for (const x of slots) { try { await run('git', ['worktree', 'remove', '--force', x.dir], { cwd, maxBuffer: 1024 * 1024 }); } catch { /* gone */ } }
        try { await run('git', ['worktree', 'prune'], { cwd, maxBuffer: 1024 * 1024 }); } catch { /* fine */ }
      }
    }
  } else if (raceN >= 2 && !before) {
    console.log('race · needs a git repo for worktrees - racing off');
    appendLog(record.id, 'RACE off: not a git repo (worktrees unavailable)');
  }

  const buildCheckpoint = readRun(record.id)?.checkpoint;
  if (builder && !raced && resumed && buildCheckpoint?.phases?.includes('build')) {
    buildOutput = buildCheckpoint.buildOutput || '';
    console.log('resume · build checkpoint kept');
    appendLog(record.id, 'RESUME build checkpoint kept');
  } else if (builder && !raced) {
    try {
      console.log(`builder · ${builder.name} on the task`);
      let tasked = brief;
      try {
        const { skillsBrief } = await import('../skills.js');
        const skills = skillsBrief();
        if (skills) appendLog(record.id, `SKILLS:\n${skills}`);
        tasked = `${skills ? `${skills}\n\n` : ''}${mapSlice}\n\n${brief}`;
      } catch { tasked = `${mapSlice}\n\n${brief}`; }
      const runBuilder = async (lane) => invokeLane(lane, tasked, { timeoutMs: 1000 * 60 * 30, override: Boolean(flags.override), context: flags.context, cwd, allowWrites: lockSpecs(manifest, cwd), runId: record.id });
      let res;
      try {
        res = await runBuilder(builder);
      } catch (e) {
        if (e.code === 'CADRE_RATE_LIMITED') {
          const next = bestDrivable({ lanes: roster.lanes.filter((l) => l.name !== builder.name && (l.cost === 'free' || l.cost === 'plan')) }, 'builder', brief, laneDrivable);
          if (!next) throw e;
          console.log(`builder · ${builder.name} rate-limited, downshift to ${next.name}`);
          appendLog(record.id, `RATE LIMIT downshift ${builder.name} -> ${next.name}`);
          builder = next;
          res = await runBuilder(builder);
        } else throw e;
      }
      buildOutput = res.stdout || res.text || '';
      const { forContext } = await import('../frugal.js');
      const frugal = forContext(buildOutput, { backupDir: join(home(), 'runs', record.id, 'frugal-backups'), label: 'build' });
      buildOutput = frugal.text;
      appendLog(record.id, `BUILD (${builder.name}) [frugal in: map slice, out: ${frugal.originalBytes}→${frugal.compressedBytes} bytes, ${frugal.saved} saved${frugal.restorable ? ', original backed up' : ''}]:\n${buildOutput.slice(0, 20000)}`);
      console.log(buildOutput.split('\n').slice(-12).join('\n').replace(/^/gm, '  '));
      const axRun = /run-\d{8}-\d{6}/.exec(buildOutput);
      if (axRun) {
        await addEvidence(record.id, { kind: 'citation', label: `builder log (${builder.name})`, ref: `~/.config/ax/runs/${axRun[0]}` });
      }
      markPhase(record.id, 'build', { buildOutput, builder: builder.name });
    } catch (e) {
      if (e.code === 'CADRE_PACED') {
        appendLog(record.id, `PACE pause: ${e.message}`);
        console.log(`pace · ${e.message}`);
        updateRun(record.id, { status: 'checkpointed', verdict: { passed: false, summary: e.message } });
        stampUsage(record.id);
        releaseLock(record.id, 'paced');
        console.log(`resume · cadre go --resume ${record.id}`);
        return 3;
      }
      if (e.code === 'CADRE_RATE_LIMITED' || e.code === 'CADRE_PACED') {
        appendLog(record.id, `PAUSE: ${e.message}`);
        updateRun(record.id, { status: 'checkpointed', verdict: { passed: false, summary: e.message } });
        stampUsage(record.id);
        releaseLock(record.id, 'paused');
        console.log(`resume · cadre go --resume ${record.id}`);
        return 3;
      }
      buildOutput = e.stdout || '';
      const axTail = String(e.stdout || e.stderr || e.message).trim().split('\n').filter(Boolean).slice(-5).join('\n      ');
      console.error(`builder · ${builder.name} failed: ${e.message.split('\n')[0]}`);
      if (axTail) console.error(`      ${axTail}`);
      appendLog(record.id, `BUILD FAILED (${builder.name}): ${e.message.slice(0, 2000)}`);
      await updateRun(record.id, { status: 'failed', ended: new Date().toISOString() });
      stampUsage(record.id);
      audit({ kind: 'run-end', run: record.id, status: 'failed' });
      releaseLock(record.id, 'build-failed');
      return 1;
    }
  } else if (!raced) {
    console.error('builder · no fitting lane - roster too thin to build');
    await updateRun(record.id, { status: 'failed', ended: new Date().toISOString() });
    stampUsage(record.id);
    releaseLock(record.id, 'no-builder');
    return 1;
  }


  // artifact: the run's own log is always filed
  await addEvidence(record.id, { kind: 'artifact', label: `runs/${record.id}/run.log`, path: join(home(), 'runs', record.id, 'run.log') });

  // the run's own log is always a followable citation (citations family)
  await addEvidence(record.id, { kind: 'citation', label: 'run log (verifier-attributed)', ref: `runs/${record.id}/run.log`, by: 'verifier' });

  // ---- post-build state (captured BEFORE verify: test-runner output files
  // are never harvested as the run's work, and the critic sees real diffs)
  const after = await gitState(cwd);
  // diff evidence from git — or from an fs snapshot when the project isn't a repo
  if (!before && !after && globalThis.CADRE_FS_SNAPSHOT) {
    const afterSnap = fsSnapshot(cwd);
    const changed = fsDiff(globalThis.CADRE_FS_SNAPSHOT, afterSnap);
    changedFilesList = changed;
    for (const c of changed.slice(0, 50)) {
      await addEvidence(record.id, { kind: 'diff', label: `${c.file} (${c.isNew ? 'new file' : 'modified'})`, path: c.file, plus: c.isNew ? 1 : 1, minus: 0 });
    }
    if (changed.length) console.log(`diffs · ${changed.length} file(s) changed (fs mode - not a git repo)`);
  }
  if (before && after) {
    // BEFORE/AFTER DELTA: only files whose git state changed during this run
    // count as the run's diffs - pre-existing dirt is not our work
    const beforeSet = new Set(before.porcelain.split('\n').filter(Boolean));
    const afterSet = new Set(after.porcelain.split('\n').filter(Boolean));
    const deltaLines = [...afterSet].filter((l) => !beforeSet.has(l));
    const changedNow = deltaLines.length > 0;
    if (changedNow) {
      for (const line of after.numstat.split('\n').filter(Boolean)) {
        const [plus, minus, file] = line.split('\t');
        await addEvidence(record.id, { kind: 'diff', label: file, path: file, plus: Number(plus) || 0, minus: Number(minus) || 0 });
      }
      // untracked files = artifacts + diffs (a new file's diff is all-plus:
      // count its added lines so a first-commit repo can still prove "diffs")
      for (const line of deltaLines.filter((l) => l.startsWith('??'))) {
        const p = line.slice(3).trim();
        const full = resolve(cwd, p);
        if (existsSync(full) && statSync(full).isFile()) {
          await addEvidence(record.id, { kind: 'artifact', label: p, path: p });
          try {
            const lines = readFileSync(full, 'utf-8').split('\n').length;
            await addEvidence(record.id, { kind: 'diff', label: `${p} (new file)`, path: p, plus: lines, minus: 0 });
          } catch { /* unreadable (binary?) - artifact evidence still filed */ }
        }
      }
      console.log(`diffs · ${after.numstat.split('\n').filter(Boolean).length} file(s) changed`);
    }
    try { diffsTextForCritic = execFileSync('git', ['-C', cwd, 'diff', 'HEAD'], { encoding: 'utf-8', maxBuffer: 1024 * 1024 * 8 }); } catch { diffsTextForCritic = ''; }
    try {
      const { forContext } = await import('../frugal.js');
      diffsTextForCritic = forContext(diffsTextForCritic).text;
    } catch { /* critic still gets the unfiltered diff */ }
  }


  // rules critic inputs: evidence kinds collected so far
  evidenceKindsForCritic = (readRun(record.id)?.evidence || []).map((e) => e.kind);

  // ---- 3+4. critique ∥ verify ------------------------------------------------
  // independent readers of the built tree: run in parallel, one stream shows both
  console.log('\n── critique ∥ verify (parallel) ─────');
  let critiqueText = '';
  let verifyRan = null;
  const critiqueTask = (async () => {
  console.log('\n── critique ─────────────────────────');
  if (resumed && (readRun(record.id)?.checkpoint?.phases || []).includes('critique')) {
    console.log('resume · critique checkpoint kept');
    appendLog(record.id, 'RESUME critique checkpoint kept');
    return;
  }
  const critic = byRole.critic;
  let reviewed = false;
  if (critic && (critic.invoke?.kind === 'hand' || critic.invoke?.kind === 'agent') && underBudget()) {
    try {
      const { forContext } = await import('../frugal.js');
      const packed = forContext(`Brief: ${brief}\n\n${buildOutput.slice(-4000)}`).text;
      const res = await invokeLane(critic, packed, { timeoutMs: 1000 * 60 * 10, cwd, allowWrites: lockSpecs(manifest, cwd) });
      critiqueText = (res.stdout || res.text || res.error || '').slice(0, 4000);
      appendLog(record.id, `CRITIQUE (${critic.name}):\n${critiqueText}`);
      await addEvidence(record.id, { kind: 'citation', label: `critic (${critic.name}) review`, ref: `runs/${record.id}/run.log#critique` });
      console.log(`critic · ${critic.name}`);
      reviewed = Boolean(res.ok);
    } catch (e) {
      console.log(`critic · ${critic.name} failed (${e.message.split('\n')[0]})`);
    }
  }
  if (reviewed) { /* the named critic answered */ }
  else if (critic && chatLaneAvailable(critic) && underBudget()) {
    try {
      const res = await chatLane(critic, [
        { role: 'system', content: 'You are the critic of a coding cadre. Review the builder output below against the brief. List concrete findings with file references where possible. If nothing is wrong, say CLEAN.' },
        { role: 'user', content: `Brief: ${brief}\n\n${mapSlice}\n\nBuilder output (tail):\n${buildOutput.slice(-4000)}` },
      ], { max_tokens: 600 });
      meteredTokens += (res.usage?.total_tokens || 0);
      auditCall(record.id, critic.name, res);
      await addEvidence(record.id, { kind: 'citation', label: `critic (${critic.name}) review`, ref: `runs/${record.id}/run.log#critique` });
      console.log(`critic · ${critic.name}:`);
      console.log(res.text.replace(/^/gm, '  '));
      critiqueText = res.text;
      appendLog(record.id, `CRITIQUE (${critic.name}):\n${res.text}`);
    } catch (e) {
      console.log(`critic · skipped (${e.message.split('\n')[0]})`);
      appendLog(record.id, `CRITIQUE skipped: ${e.message.slice(0, 500)}`);
    }
  } else {
    // deterministic rules critic ALWAYS fires when no chat lane exists - the
    // critic role is unconditional; the tier is honestly labeled
    try {
      const { criticRules, renderCriticRules } = await import('../rulescritic.js');
      const changed = (changedFilesList || []).map((c) => c.file);
      const rr = criticRules({ brief, changed, diffsText: diffsTextForCritic || '', manifest: scopeManifest, evidenceKinds: evidenceKindsForCritic || [] });
      console.log(`critic · rules tier (no chat lane on this machine):`);
      critiqueText = renderCriticRules(rr);
      console.log(critiqueText.replace(/^/gm, '  ') || '  (no findings)');
      appendLog(record.id, `CRITIQUE (rules tier):\n${critiqueText}`);
      await addEvidence(record.id, { kind: 'citation', label: 'critic (rules tier) review', ref: `runs/${record.id}/run.log#critique` });
      if (rr.findings.some((f) => f.severity === 'high')) {
        appendLog(record.id, 'CRITIQUE rules tier: HIGH findings present - see above');
      }
    } catch (e) {
      console.log(`critic · rules tier failed (${e.message.split('\n')[0]}) - recorded`);
      appendLog(record.id, `CRITIQUE rules tier failed: ${e.message.slice(0, 300)}`);
    }
  }
  markPhase(record.id, 'critique');

  })();

  const verifyTask = (async () => {
  console.log('\n── verify (in parallel with critique) ──');
  if (resumed && (readRun(record.id)?.checkpoint?.phases || []).includes('verify')) {
    console.log('resume · verify checkpoint kept');
    appendLog(record.id, 'RESUME verify checkpoint kept');
    return;
  }
  const test = detectTestCommand(cwd);
  let verifyEv = null;
  if (test) {
    verifyRan = true;
    // INDEPENDENCE: the verifier runs the project test itself, in a process
    // cadre spawned (pid recorded on the evidence). The builder never grades
    // its own work; a missing by-field would not be independent either.
    const { runCaptured } = await import('../gate.js');
    const res = await runCaptured([test.cmd, ...test.args], { cwd, timeoutMs: 1000 * 60 * 10 });
    verifyEv = {
      kind: 'command', label: test.label, by: 'verifier',
      command: `${test.cmd} ${test.args.join(' ')}`, argv: [test.cmd, ...test.args],
      exit: res.exit, output: (res.stdout || res.stderr || '').slice(0, 4000),
      cadre: { by: 'cadre', at: new Date().toISOString(), pid: res.pid, recorder: process.pid, how: 'spawn' },
    };
    if (res.ok) {
      console.log(`verifier · ${test.label} ✓`);
      appendLog(record.id, `VERIFY ${test.label} exit 0 (spawned pid ${res.pid}):\n${(res.stdout || '').slice(0, 4000)}`);
    } else {
      console.error(`verifier · ${test.label} ✗ (exit ${res.exit})`);
      appendLog(record.id, `VERIFY ${test.label} FAILED (spawned pid ${res.pid}, exit ${res.exit}):\n${String(res.stdout || res.stderr || '').slice(0, 4000)}`);
    }
    await addEvidence(record.id, verifyEv);
  } else {
    console.log('verifier · no project test command detected (package.json/Makefile/Cargo.toml/pyproject.toml)');
    appendLog(record.id, 'VERIFY skipped: no test command detected');
  }
  markPhase(record.id, 'verify');
  })();

  // both run concurrently; the single stream interleaves them as they happen
  await Promise.all([critiqueTask, verifyTask]);

  // ---- 5. gate --------------------------------------------------------------
  console.log('\n── gate ─────────────────────────────');
  // Re-read the manifest the run locked. Drift (a new file, an un-asked
  // refactor) is named here, and the work does not count until that is answered.
  const fresh = readScopeFile(join(cwd, '.cadre', 'scope.json'))
    || readScopeFile(join(home(), 'runs', record.id, 'scope.json'))
    || manifest;
  appendLog(record.id, `SCOPE re-read: lock ${fresh.lock.join(' ')} · done ${String(fresh.done).slice(0, 160)}`);
  const now = await gitState(cwd);
  let delta = [];
  if (before && now) {
    delta = runDeltaFiles(before, now);
    try { diffsTextForCritic = execFileSync('git', ['-C', cwd, 'diff', 'HEAD'], { encoding: 'utf-8', maxBuffer: 1024 * 1024 * 8 }); } catch { diffsTextForCritic = ''; }
  } else if (globalThis.CADRE_FS_SNAPSHOT) {
    delta = fsDiff(globalThis.CADRE_FS_SNAPSHOT, fsSnapshot(cwd)).map((c) => c.file);
  } else {
    delta = (changedFilesList || []).map((c) => c.file || c);
  }
  try {
    const { forContext } = await import('../frugal.js');
    if (diffsTextForCritic) diffsTextForCritic = forContext(diffsTextForCritic).text;
  } catch { /* critic still sees the raw diff */ }
  const creep = scopeCreep(delta, fresh);
  if (creep.length > 0) {
    let why = typeof flags.why === 'string' ? flags.why : '';
    if (!why && process.stdin.isTTY) {
      try {
        const { askHuman } = await import('../human.js');
        const ans = await askHuman(`why are these files outside the lock: ${creep.join(', ')}? Name each file in the answer, or press enter to reject.`, { timeoutMs: 60000 });
        if (ans) why = ans;
      } catch { /* non-interactive */ }
    }
    const prior = new Set(globalThis.CADRE_FS_SNAPSHOT ? globalThis.CADRE_FS_SNAPSHOT.keys() : []);
    const settled = settleCreep({ creep, why, cwd, prior });
    if (settled.action === 'allow') {
      fresh.lock = [...new Set([...fresh.lock, ...creep])];
      writeScopeFile(join(cwd, '.cadre', 'scope.json'), fresh);
      appendLog(record.id, `SCOPE why accepted: ${why}`);
      try { const { noteCorrection } = await import('../skills.js'); noteCorrection(why); } catch { /* a skill file is not the gate */ }
      console.log(`scope · why accepted, lock now ${fresh.lock.join(' ')}`);
    } else {
      const whyLine = `gate asks why: ${creep.join(', ')} is outside the scope lock (${fresh.lock.join(' ')}). Answer with --why naming each file, or the write is reverted.`;
      appendLog(record.id, `SCOPE CREEP: ${whyLine} reverted: ${settled.reverted.map((r) => `${r.file}=${r.result}`).join(', ')}`);
      console.log(`scope · ✗ ${whyLine}`);
      updateRun(record.id, {
        status: 'rejected',
        verdict: { passed: false, missing: [], summary: whyLine },
        ended: new Date().toISOString(),
      });
      stampUsage(record.id);
      audit({ kind: 'run-end', run: record.id, status: 'rejected', creep });
      try { const { learnFromRun } = await import('../map.js'); learnFromRun(cwd, { files: delta, passed: false, lane: byRole.builder?.name }); } catch { /* map learns when it can */ }
      try { notePreferences(record.roles, flags, { passed: false, creep: true, tokens: meteredTokens, planText, delta, critique: critiqueText, verified: verifyRan }); } catch { /* preference ledger is best-effort */ }
      try { await rememberHands(byRole, { brief, delta, passed: false, critique: critiqueText }); } catch { /* hand memory is best-effort */ }
      releaseLock(record.id, 'rejected-scope-creep');
      console.log(`\n✗ run ${record.id} REJECTED - work outside the scope lock`);
      return 1;
    }
  }
  if (delta.length) console.log('scope · ✓ changes inside the lock');
  const cur = updateRun(record.id, {
    status: 'gating',
    usage: { metered_tokens: meteredTokens, budget_tokens: budgetTokens },
  });
  // DONE-CONDITION: the manifest's explicit done statement is checked BEFORE
  // the gate stamps anything - a run can hold all four families and still not
  // be the work that was asked for.
  let doneCheck = { checked: false, ok: null, note: '' };
  try {
    doneCheck = checkDoneCondition(fresh, {
      changedFiles: (changedFilesList || []).map((c) => c.file || c),
      cwd,
    });
    appendLog(record.id, `DONE-CONDITION: ${doneCheck.note}`);
    if (doneCheck.checked) console.log(`done · ${doneCheck.ok ? '✓' : '✗'} ${doneCheck.note}`);
  } catch (e) { appendLog(record.id, `DONE-CONDITION check error: ${String(e.message).slice(0, 200)}`); }
  // THE GATE: cadre re-runs commands in processes it spawns, cross-checks
  // diffs against the live worktree, re-checks artifacts, and fetches any
  // http citations. Receipts are saved back into the record so the proof
  // bundle carries them. Unstamped evidence is refused at the door.
  const gate = await runGate(cur, {
    cwd,
    save: (patched) => updateRun(record.id, { evidence: patched.evidence }),
  });
  if (gate.passed && meteredTokens > budgetTokens) {
    gate.passed = false;
    gate.failed.push({ family: 'budget', ok: false, label: 'token budget', detail: `${meteredTokens} > ${budgetTokens}` });
    gate.summary = `budget exceeded: ${meteredTokens} > ${budgetTokens}`;
  }
  if (gate.passed && doneCheck.checked && doneCheck.ok === false) {
    gate.passed = false;
    gate.failed.push({ family: 'done-condition', ok: false, label: 'manifest done-condition', detail: doneCheck.note });
    gate.summary = `done-condition unmet: ${doneCheck.note.slice(0, 120)}`;
  }
  console.log(renderGateReport(gate).replace(/^/gm, '  '));
  appendLog(record.id, `GATE ${gate.passed ? 'PROVEN' : 'NOT PROVEN'}: ${gate.summary}`);

  let reverifyOk = true;
  if (flags['re-verify'] !== false && gate.passed) {
    // runGate already re-ran the commands in spawned processes (receipts on
    // the evidence); this spot-check keeps the double-run honest.
    const reverified = await verifyCommands(cur, { cwd, max: 2 });
    for (const rv of reverified) {
      if (!rv.ok) {
        reverifyOk = false;
        gate.passed = false;
        gate.failed.push({ family: 'commands', label: rv.command, detail: `re-run exited ${rv.reexit}` });
        console.log(`  ✗ re-verify: ${rv.command} exited ${rv.reexit}`);
      }
    }
  }

  try {
    const { checkSkills } = await import('../skillcheck.js');
    const { noteCorrection } = await import('../skills.js');
    const line = String(critiqueText).split('\n').map((s) => s.trim()).find((s) => s.length >= 12 && !/CLEAN/i.test(s));
    if (line) noteCorrection(line);
    const log = readFileSync(join(home(), 'runs', record.id, 'run.log'), 'utf-8');
    const skills = checkSkills(log, {
      gatePassed: gate.passed,
      mapFiles,
      indexedFiles,
      diffFiles: delta,
      brief,
      laneOutput: buildOutput,
      laneKind: builder?.invoke?.kind || null,
      reverified: flags['re-verify'] === false ? true : reverifyOk,
    });
    if (gate.passed && !skills.ok) {
      gate.passed = false;
      gate.summary = `skills unmet: ${skills.missing.join(', ')}`;
      console.log(`skills · unmet: ${skills.missing.join(', ')}`);
    }
  } catch { /* a missing skill file does not invent a pass */ }
  const finalStatus = gate.passed ? 'passed' : 'rejected';
  updateRun(record.id, {
    status: finalStatus,
    verdict: { passed: gate.passed, missing: gate.missing, summary: gate.summary },
    ended: new Date().toISOString(),
  });
  audit({ kind: 'run-end', run: record.id, status: finalStatus, metered_tokens: meteredTokens });
  releaseLock(record.id, finalStatus);

  try {
    const { learnFromRun } = await import('../map.js');
    learnFromRun(cwd, { files: delta, passed: gate.passed, lane: byRole.builder?.name || null });
  } catch { /* a missing map never blocks the verdict */ }
  try { notePreferences(record.roles, flags, { passed: gate.passed, creep: false, tokens: meteredTokens, planText, delta, critique: critiqueText, verified: verifyRan }); } catch { /* preference ledger is best-effort */ }
  try { await rememberHands(byRole, { brief, delta, passed: gate.passed, critique: critiqueText }); } catch { /* hand memory is best-effort */ }
  console.log(`\n${gate.passed ? '✓' : '✗'} run ${record.id} ${gate.passed ? 'PROVEN' : `not proven - ${gate.summary}`}`);
  console.log(`  metered ${meteredTokens} of ${budgetTokens} token budget · proof: cadre proof ${record.id} · replay: cadre watch ${record.id}`);
  return gate.passed ? 0 : 1;
}
