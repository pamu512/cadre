// go - the one command. Scans the room, forms the cadre, runs the loop,
// gates on evidence, files the receipts. Every step is real on this machine:
// ax lanes delegate to the ax binary; keyed chat lanes (any OpenAI-compatible
// re-checks artifacts on disk before stamping anything.
import { execFile, execFileSync } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildRoster } from '../scan.js';
import { assignRoles, explainRouting } from '../router.js';
import { auditCall } from '../laneaudit.js';
import { chatLaneAvailable, chatLane } from '../chatlane.js';
import { gateVerdict, renderGateReport, verifyCommands } from '../gate.js';
import { invokeLane } from '../invoke.js';
import { buildScopeManifest, scopeCreep, renderManifest } from '../scope.js';
import {
  createRun, updateRun, appendLog, addEvidence, audit, listRuns, loadPins, home, readRun,
  acquireLock, releaseLock,
} from '../store.js';

const run = promisify(execFile);

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

export async function cmdGo(args, flags, { cwd = process.cwd() } = {}) {
  const brief = args.join(' ').trim();
  if (!brief) {
    console.error('cadre go "<outcome>" - what should the cadre do?');
    return 2;
  }

  // --dry: show the real routing + pipeline for THIS machine, spend nothing.
  if (flags.dry) {
    const roster = await buildRoster();
    const routing = assignRoles(roster, { brief });
    console.log(`cadre go (dry) - ${brief}`);
    console.log(`roster: ${roster.lanes.length} lane(s) on this machine (${roster.clis.map((c) => c.label).join(', ') || 'no CLIs'} · ${roster.platform})`);
    console.log('crew (roles by fit, pins override):');
    console.log(explainRouting(routing).replace(/^/gm, '  '));
    console.log(`keyed chat lanes: ${roster.lanes.filter(chatLaneAvailable).map((l) => l.name).join(', ') || 'none - planner uses the local scaffold, critic skipped'}`);
    console.log('pipeline: sweep -> scan -> route -> plan -> build -> critique -> verify -> gate -> file');
    // reflect the standalone builder override the real run will apply
    const userCmd2 = roster.lanes.find((l) => l.invoke?.kind === 'command');
    const chatL2 = roster.lanes.find((l) => ['openai-compatible', 'http-chat', 'chat'].includes(l.invoke?.kind) && chatLaneAvailable(l));
    if (!flags.ax && (userCmd2 || chatL2)) {
      console.log(`standalone builder (real run): ${chatLaneAvailable(userCmd2 || chatL2) && (userCmd2 || chatL2).invoke?.kind !== 'command' ? (userCmd2 || chatL2).name : (userCmd2 || chatL2).name}  (command/chat lane preferred over the ax routing above)`);
    }
    return 0;
  }

  const roster = await buildRoster();
  // B4/P0 #7: warm map feeds routing - hot-zone files hint which lanes fit
  let hotHint = '';
  try {
    const { loadMap, mapIsWarm } = await import('../map.js');
    const m = loadMap(cwd);
    if (m && mapIsWarm(m) && (m.hotZones || []).length) {
      const hot = m.hotZones.slice(0, 3).map((h) => h.path).join(', ');
      hotHint = hot;
      appendLog(record.id, `MAP hot zones: ${hot}`);
      console.log(`map · warm - hot zones: ${hot}`);
    }
  } catch { /* map is a hint, never a dependency */ }
  const routing = assignRoles(roster, { brief });
  // scope lock (PRD 6.6): manifest before work breathes
  const manifest = buildScopeManifest({ brief, scope: flags.scope, cwd });
  const scopeManifest = manifest; // alias for the rules critic below
  const record = createRun({
    brief, kind: 'go',
    roles: Object.fromEntries(routing.assignments.map((a) => [a.role, a.lane])),
    meta: { scope: manifest, cwd },
  });
  acquireLock(record.id, { brief });
  globalThis.CADRE_ACTIVE_RUN = record.id;
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

  const byRole = Object.fromEntries(routing.assignments.map((a) => [a.role, roster.lanes.find((l) => l.name === a.lane)]));

  // Default loop is STANDALONE (P0 #1): prefer a non-ax builder — a user
  // command-kind lane, else a keyed chat lane. ax is one adapter, not the
  // default path; `--ax` forces the old ax-wrapped behavior.
  if (!flags.ax) {
    const userCmd = roster.lanes.find((l) => l.invoke?.kind === 'command');
    const chatL = roster.lanes.find((l) => ['openai-compatible', 'http-chat', 'chat'].includes(l.invoke?.kind) && chatLaneAvailable(l));
    if (userCmd || chatL) {
      byRole.builder = userCmd || chatL;
      appendLog(record.id, `LOCAL loop: builder=${byRole.builder.name} (standalone default)`);
      console.log(`local · builder=${byRole.builder.name} (standalone loop; --ax forces the ax pipeline)`);
    } else {
      console.log('local · no non-ax builder available (no command-kind user lane, no keyed chat lane) - falling back to ax routing');
      appendLog(record.id, 'LOCAL loop: no non-ax builder, ax kept as fallback');
    }
  }


  // ---- meter preflight: downshift or wait-for-refill before spending -------
  try {
    const { loadMeters, pacing } = await import('../meters.js');
    const meters = loadMeters();
    if (meters.length) {
      const { usageFromAudit } = await import('../meters.js');
      const usage = usageFromAudit();
      for (const m of meters) {
        const p = pacing({ quota: m.quota_tokens, resetAt: m.reset_at, used: usage.get(m.lane)?.tokens || 0 });
        if (p.state === 'empty') {
          const hrs = ((new Date(m.reset_at) - Date.now()) / 3.6e6);
          if (m.reset_at && hrs > 0 && hrs <= 6 && !flags.no_wait) {
            appendLog(record.id, `METER: ${m.lane} exhausted; reset in ${hrs.toFixed(1)}h - pausing, will resume after refill`);
            console.log(`meter · ${m.lane} empty - reset in ${hrs.toFixed(1)}h. Filing as paused-with-resume-plan (re-run after refill, or --no-wait to downshift now).`);
            updateRun(record.id, { status: 'resumed-brief', verdict: { passed: false, summary: `paused: ${m.lane} quota empty, resets ${m.reset_at}` } });
            return 3;
          }
          appendLog(record.id, `METER: ${m.lane} exhausted - falling down the chain`);
          console.log(`meter · ${m.lane} empty - falling down the chain`);
          // plan-router take: multi-tier fallback chain, included stops first
          roster.lanes = roster.lanes.filter((l) => l.name !== m.lane);
          const { buildChain, pickStop } = await import('../fallback.js');
          const health = Object.fromEntries(roster.lanes.map((l) => [l.name, l.invoke?.status || 'ok']));
          const pick = pickStop(buildChain(roster, 'builder', { budgetTokens }), { health });
          if (pick.lane) {
            byRole.builder = roster.lanes.find((l) => l.name === pick.lane);
            console.log(`chain · stop ${pick.stop}: ${pick.lane}${pick.rerouted ? ' (rerouted)' : ''}${pick.notes.length ? ' - ' + pick.notes.join('; ') : ''}`);
            appendLog(record.id, `CHAIN stop ${pick.stop}: ${pick.lane} ${pick.notes.join('; ')}`);
          } else {
            console.log(`chain · all stops exhausted - pausing with resume plan`);
            updateRun(record.id, { status: 'resumed-brief', verdict: { passed: false, summary: 'all chain stops exhausted' } });
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
  const planner = byRole.planner;
  if (planner && chatLaneAvailable(planner) && underBudget()) {
    try {
      const res = await chatLane(planner, [
        { role: 'system', content: 'You are the planner of a coding cadre. Given a brief, produce a numbered plan of at most 6 concrete, checkable steps. Each step: verb, target, and how to verify it. No prose preamble.' },
        { role: 'user', content: `Brief: ${brief}\nWorking directory contains a code project.` },
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
  if (!planText) {
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

  // ---- 2. build (optionally raced across builders in isolated worktrees) ----
  console.log('\n── build ────────────────────────────');
  let changedFilesList = [];
  let diffsTextForCritic = '';
  let evidenceKindsForCritic = [];
  const before = await gitState(cwd);
  globalThis.CADRE_FS_SNAPSHOT = before ? null : fsSnapshot(cwd);
  let builder = byRole.builder;
  let buildOutput = '';

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
          const res = await invokeLane(x.lane, brief, { timeoutMs: 1000 * 60 * 30, override: Boolean(flags.override), context: flags.context, cwd: x.dir, mcpAgent: Boolean(flags['mcp-agent']) });
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

  if (builder && !raced) {
    try {
      console.log(`builder · ${builder.name} on the task`);
      const res = await invokeLane(builder, brief, { timeoutMs: 1000 * 60 * 30, override: Boolean(flags.override), context: flags.context, cwd, mcpAgent: Boolean(flags["mcp-agent"]) });
      buildOutput = res.stdout || res.text || '';
      // B5 frugal pipes: compress before the ledger; original backed up, savings counted
      const { compressOutput } = await import('../frugal.js');
      const frugal = compressOutput(buildOutput, { backupDir: join(home(), 'runs', record.id, 'frugal-backups'), label: 'build' });
      buildOutput = frugal.text;
      appendLog(record.id, `BUILD (${builder.name}) [frugal: ${frugal.originalBytes}→${frugal.compressedBytes} bytes, ${frugal.saved} saved${frugal.restorable ? ', original backed up' : ''}]:\n${buildOutput.slice(0, 20000)}`);
      console.log(buildOutput.split('\n').slice(-12).join('\n').replace(/^/gm, '  '));
      // citation: the ax run log, if the builder went through ax
      const axRun = /run-\d{8}-\d{6}/.exec(buildOutput);
      if (axRun) {
        await addEvidence(record.id, { kind: 'citation', label: `builder log (${builder.name})`, ref: `~/.config/ax/runs/${axRun[0]}` });
      }
    } catch (e) {
      buildOutput = e.stdout || '';
      const axTail = String(e.stdout || e.stderr || e.message).trim().split('\n').filter(Boolean).slice(-5).join('\n      ');
      console.error(`builder · ${builder.name} failed: ${e.message.split('\n')[0]}`);
      if (axTail) console.error(`      ${axTail}`);
      appendLog(record.id, `BUILD FAILED (${builder.name}): ${e.message.slice(0, 2000)}`);
      await updateRun(record.id, { status: 'failed', ended: new Date().toISOString() });
      audit({ kind: 'run-end', run: record.id, status: 'failed' });
      releaseLock(record.id, 'build-failed');
      return 1;
    }
  } else if (!raced) {
    console.error('builder · no fitting lane - roster too thin to build');
    await updateRun(record.id, { status: 'failed', ended: new Date().toISOString() });
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
  }


  // rules critic inputs: evidence kinds collected so far
  evidenceKindsForCritic = (readRun(record.id)?.evidence || []).map((e) => e.kind);

  // ---- 3+4. critique ∥ verify ------------------------------------------------
  // independent readers of the built tree: run in parallel, one stream shows both
  console.log('\n── critique ∥ verify (parallel) ─────');
  const critiqueTask = (async () => {
  console.log('\n── critique ─────────────────────────');
  const critic = byRole.critic;
  if (critic && chatLaneAvailable(critic) && underBudget()) {
    try {
      const res = await chatLane(critic, [
        { role: 'system', content: 'You are the critic of a coding cadre. Review the builder output below against the brief. List concrete findings with file references where possible. If nothing is wrong, say CLEAN.' },
        { role: 'user', content: `Brief: ${brief}\n\nBuilder output (tail):\n${buildOutput.slice(-4000)}` },
      ], { max_tokens: 600 });
      meteredTokens += (res.usage?.total_tokens || 0);
      auditCall(record.id, critic.name, res);
      await addEvidence(record.id, { kind: 'citation', label: `critic (${critic.name}) review`, ref: `runs/${record.id}/run.log#critique` });
      console.log(`critic · ${critic.name}:`);
      console.log(res.text.replace(/^/gm, '  '));
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
      console.log(renderCriticRules(rr).replace(/^/gm, '  ') || '  (no findings)');
      appendLog(record.id, `CRITIQUE (rules tier):\n${renderCriticRules(rr)}`);
      await addEvidence(record.id, { kind: 'citation', label: 'critic (rules tier) review', ref: `runs/${record.id}/run.log#critique` });
      if (rr.findings.some((f) => f.severity === 'high')) {
        appendLog(record.id, 'CRITIQUE rules tier: HIGH findings present - see above');
      }
    } catch (e) {
      console.log(`critic · rules tier failed (${e.message.split('\n')[0]}) - recorded`);
      appendLog(record.id, `CRITIQUE rules tier failed: ${e.message.slice(0, 300)}`);
    }
  }

  })();

  const verifyTask = (async () => {
  console.log('\n── verify (in parallel with critique) ──');
  const test = detectTestCommand(cwd);
  let verifyEv = null;
  if (test) {
    try {
      const { stdout } = await run(test.cmd, test.args, { cwd, timeout: 1000 * 60 * 10, maxBuffer: 1024 * 1024 * 16 });
      verifyEv = { kind: 'command', label: test.label, by: 'verifier', command: `${test.cmd} ${test.args.join(' ')}`, argv: [test.cmd, ...test.args], exit: 0, output: stdout.slice(0, 4000) };
      console.log(`verifier · ${test.label} ✓`);
      appendLog(record.id, `VERIFY ${test.label} exit 0:\n${stdout.slice(0, 4000)}`);
    } catch (e) {
      verifyEv = { kind: 'command', label: test.label, by: 'verifier', command: `${test.cmd} ${test.args.join(' ')}`, argv: [test.cmd, ...test.args], exit: e.code ?? 1, output: String(e.stdout || e.message).slice(0, 4000) };
      console.error(`verifier · ${test.label} ✗ (exit ${e.code ?? 1})`);
      appendLog(record.id, `VERIFY ${test.label} FAILED:\n${String(e.stdout || e.message).slice(0, 4000)}`);
    }
    await addEvidence(record.id, verifyEv);
  } else {
    console.log('verifier · no project test command detected (package.json/Makefile/Cargo.toml/pyproject.toml)');
    appendLog(record.id, 'VERIFY skipped: no test command detected');
  }
  })();

  // both run concurrently; the single stream interleaves them as they happen
  await Promise.all([critiqueTask, verifyTask]);

  // ---- 5. gate --------------------------------------------------------------
  console.log('\n── gate ─────────────────────────────');
  // scope-creep check (PRD 6.6): diff outside the lock is caught here, with citation
  if (after && after.porcelain.trim().length > 0) {
    const changed = after.numstat.split('\n').filter(Boolean).map((l) => l.split('\t')[2]);
    changedFilesList = (changed || []).map((f) => ({ file: f }));
    try { diffsTextForCritic = execFileSync('git', ['-C', cwd, 'diff', 'HEAD'], { encoding: 'utf-8', maxBuffer: 1024 * 1024 * 8 }); } catch { diffsTextForCritic = ''; }
    const creep = scopeCreep(changed, manifest);
    if (creep.length > 0) {
      appendLog(record.id, `SCOPE CREEP caught at gate: ${creep.join(', ')} (lock: ${manifest.lock.join(' ')}) — "not in the ask"`);
      console.log(`scope · ✗ creep caught: ${creep.join(', ')} — not in the ask (see run.log)`);
      const cur = updateRun(record.id, {
        status: 'rejected',
        verdict: { passed: false, missing: [], summary: `scope creep: ${creep.join(', ')}` },
        ended: new Date().toISOString(),
      });
      audit({ kind: 'run-end', run: record.id, status: 'rejected', creep });
      releaseLock(record.id, 'rejected-scope-creep');
      console.log(`\n✗ run ${record.id} REJECTED - work outside the scope lock`);
      return 1;
    } else if (flags.scope) {
      console.log('scope · ✓ all changes inside the lock');
    }
  }
  const cur = updateRun(record.id, {
    status: 'gating',
    usage: { metered_tokens: meteredTokens, budget_tokens: budgetTokens },
  });
  const gate = gateVerdict(cur, { cwd });
  console.log(renderGateReport(gate).replace(/^/gm, '  '));
  appendLog(record.id, `GATE ${gate.passed ? 'PROVEN' : 'NOT PROVEN'}: ${gate.summary}`);

  if (flags['re-verify'] !== false && gate.passed) {
    const reverified = await verifyCommands(cur, { cwd, max: 2 });
    for (const rv of reverified) {
      if (!rv.ok) {
        gate.passed = false;
        gate.failed.push({ family: 'commands', label: rv.command, detail: `re-run exited ${rv.reexit}` });
        console.log(`  ✗ re-verify: ${rv.command} exited ${rv.reexit}`);
      }
    }
  }

  const finalStatus = gate.passed ? 'passed' : 'rejected';
  updateRun(record.id, {
    status: finalStatus,
    verdict: { passed: gate.passed, missing: gate.missing, summary: gate.summary },
    ended: new Date().toISOString(),
  });
  audit({ kind: 'run-end', run: record.id, status: finalStatus, metered_tokens: meteredTokens });
  releaseLock(record.id, finalStatus);

  console.log(`\n${gate.passed ? '✓' : '✗'} run ${record.id} ${gate.passed ? 'PROVEN' : `not proven - ${gate.summary}`}`);
  console.log(`  metered ${meteredTokens} of ${budgetTokens} token budget · proof: cadre proof ${record.id} · replay: cadre watch ${record.id}`);
  return gate.passed ? 0 : 1;
}
