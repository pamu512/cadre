// go - the one command. Scans the room, forms the cadre, runs the loop,
// gates on evidence, files the receipts. Every step is real on this machine:
// ax lanes delegate to the ax binary; keyed chat lanes (any OpenAI-compatible
// re-checks artifacts on disk before stamping anything.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildRoster } from '../scan.js';
import { assignRoles, explainRouting } from '../router.js';
import { auditCall } from '../laneaudit.js';
import { chatLaneAvailable, chatLane } from '../chatlane.js';
import { gateVerdict, renderGateReport, verifyCommands } from '../gate.js';
import { invokeLane } from '../invoke.js';
import { buildScopeManifest, scopeCreep, renderManifest } from '../scope.js';
import {
  createRun, updateRun, appendLog, addEvidence, audit, listRuns, loadPins, home,
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
    return 0;
  }

  // sweep-on-start (#13): fold compatible leftovers into this run (same brief
  // text = compatible; their evidence attaches), retire the rest is NOT done
  // here - incompatible leftovers stay for cadre sweep.
  const leftovers = listRuns().filter((r) => ['running', 'interrupted'].includes(r.status));
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
  const record = createRun({
    brief, kind: 'go',
    roles: Object.fromEntries(routing.assignments.map((a) => [a.role, a.lane])),
    meta: { scope: manifest },
  });
  acquireLock(record.id, { brief });
  globalThis.CADRE_ACTIVE_RUN = record.id;
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

  // ---- 2. build ------------------------------------------------------------
  console.log('\n── build ────────────────────────────');
  const before = await gitState(cwd);
  const builder = byRole.builder;
  let buildOutput = '';
  if (builder) {
    try {
      console.log(`builder · ${builder.name} on the task`);
      const res = await invokeLane(builder, brief, { timeoutMs: 1000 * 60 * 30, override: Boolean(flags.override), context: flags.context });
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
  } else {
    console.error('builder · no fitting lane - roster too thin to build');
    await updateRun(record.id, { status: 'failed', ended: new Date().toISOString() });
    releaseLock(record.id, 'no-builder');
    return 1;
  }

  // ---- 3. critique ----------------------------------------------------------
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
    console.log('critic · no keyed reasoning lane - step recorded as skipped (not silently passed)');
    appendLog(record.id, 'CRITIQUE skipped: no keyed reasoning lane');
  }

  // ---- 4. verify ------------------------------------------------------------
  console.log('\n── verify ───────────────────────────');
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

  // diff evidence from git
  const after = await gitState(cwd);
  if (before && after) {
    const changedNow = after.porcelain.trim().length > 0;
    if (changedNow) {
      for (const line of after.numstat.split('\n').filter(Boolean)) {
        const [plus, minus, file] = line.split('\t');
        await addEvidence(record.id, { kind: 'diff', label: file, path: file, plus: Number(plus) || 0, minus: Number(minus) || 0 });
      }
      // untracked files = artifacts + diffs (a new file's diff is all-plus:
      // count its added lines so a first-commit repo can still prove "diffs")
      for (const line of after.porcelain.split('\n').filter((l) => l.startsWith('??'))) {
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

  // artifact: the run's own log is always filed
  await addEvidence(record.id, { kind: 'artifact', label: `runs/${record.id}/run.log`, path: join(home(), 'runs', record.id, 'run.log') });

  // ---- 5. gate --------------------------------------------------------------
  console.log('\n── gate ─────────────────────────────');
  // scope-creep check (PRD 6.6): diff outside the lock is caught here, with citation
  if (after && after.porcelain.trim().length > 0) {
    const changed = after.numstat.split('\n').filter(Boolean).map((l) => l.split('\t')[2]);
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
