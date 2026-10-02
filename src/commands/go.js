// go - the one command. Scans the room, forms the cadre, runs the loop,
// gates on evidence, files the receipts. Every step is real on this machine:
// ax lanes delegate to the ax binary, apertus lanes call the API, the gate
// re-checks artifacts on disk before stamping anything.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { buildRoster } from '../scan.js';
import { assignRoles, explainRouting } from '../router.js';
import { apertusAvailable, apertusChat, auditCall } from '../apertus.js';
import { gateVerdict, renderGateReport, verifyCommands } from '../gate.js';
import { invokeLane } from '../invoke.js';
import {
  createRun, updateRun, appendLog, addEvidence, audit, listRuns, loadPins, home,
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
    console.log(`apertus: ${apertusAvailable() ? 'live (APERTUS_API_KEY set) - planner/critic routed to it' : 'not keyed - planner uses the local scaffold, critic skipped'}`);
    console.log('pipeline: sweep -> scan -> route -> plan -> build -> critique -> verify -> gate -> file');
    return 0;
  }

  // sweep-on-start: surface leftovers before spending anything
  const leftovers = listRuns().filter((r) => ['running', 'interrupted'].includes(r.status));
  if (leftovers.length > 0) {
    console.log(`sweep · ${leftovers.length} leftover run(s) noted: ${leftovers.map((l) => l.id).join(', ')} (cadre sweep to triage)`);
  }

  const roster = await buildRoster();
  const routing = assignRoles(roster, { brief });
  const record = createRun({
    brief, kind: 'go',
    roles: Object.fromEntries(routing.assignments.map((a) => [a.role, a.lane])),
  });
  console.log(`cadre go - run ${record.id} · ${brief}`);
  console.log(`roster · ${roster.lanes.length} lane(s)`);
  console.log(explainRouting(routing).replace(/^/gm, '  '));
  appendLog(record.id, `routing: ${routing.assignments.map((a) => `${a.role}=${a.lane}`).join(' ')}`);
  audit({ kind: 'run-start', run: record.id, brief, roles: record.roles });

  const pins = loadPins();
  const budgetTokens = Number(flags.budget || pins.budget || 200000);
  let meteredTokens = 0;
  const underBudget = () => meteredTokens < budgetTokens;

  const byRole = Object.fromEntries(routing.assignments.map((a) => [a.role, roster.lanes.find((l) => l.name === a.lane)]));

  // ---- 1. plan -------------------------------------------------------------
  console.log('\n── plan ─────────────────────────────');
  let planText = null;
  const planner = byRole.planner;
  if (planner?.invoke?.kind === 'apertus' && apertusAvailable() && underBudget()) {
    try {
      const res = await apertusChat([
        { role: 'system', content: 'You are the planner of a coding cadre. Given a brief, produce a numbered plan of at most 6 concrete, checkable steps. Each step: verb, target, and how to verify it. No prose preamble.' },
        { role: 'user', content: `Brief: ${brief}\nWorking directory contains a code project.` },
      ], { model: planner.invoke.model.startsWith('Apertus-70B') ? 'Apertus-70B' : 'Apertus-8B', max_tokens: 700 });
      meteredTokens += (res.usage?.total_tokens || 0);
      planText = res.text;
      auditCall(record.id, planner.name, res);
      await addEvidence(record.id, { kind: 'citation', label: `planner (${planner.name}) plan`, ref: `runs/${record.id}/run.log#plan` });
      console.log('planner · apertus accepted the brief:');
      console.log(planText.replace(/^/gm, '  '));
      appendLog(record.id, `PLAN (apertus ${res.model}):\n${planText}`);
    } catch (e) {
      console.log(`planner · apertus failed (${e.message}) - falling back to local scaffold`);
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
      appendLog(record.id, `BUILD (${builder.name}):\n${buildOutput.slice(0, 20000)}`);
      console.log(buildOutput.split('\n').slice(-12).join('\n').replace(/^/gm, '  '));
      // citation: the ax run log, if the builder went through ax
      const axRun = /run-\d{8}-\d{6}/.exec(buildOutput);
      if (axRun) {
        await addEvidence(record.id, { kind: 'citation', label: `builder log (${builder.name})`, ref: `~/.config/ax/runs/${axRun[0]}` });
      }
    } catch (e) {
      buildOutput = e.stdout || '';
      console.error(`builder · ${builder.name} failed: ${e.message.split('\n')[0]}`);
      appendLog(record.id, `BUILD FAILED (${builder.name}): ${e.message.slice(0, 2000)}`);
      await updateRun(record.id, { status: 'failed', ended: new Date().toISOString() });
      audit({ kind: 'run-end', run: record.id, status: 'failed' });
      return 1;
    }
  } else {
    console.error('builder · no fitting lane - roster too thin to build');
    await updateRun(record.id, { status: 'failed', ended: new Date().toISOString() });
    return 1;
  }

  // ---- 3. critique ----------------------------------------------------------
  console.log('\n── critique ─────────────────────────');
  const critic = byRole.critic;
  if (critic?.invoke?.kind === 'apertus' && apertusAvailable() && underBudget()) {
    try {
      const res = await apertusChat([
        { role: 'system', content: 'You are the critic of a coding cadre. Review the builder output below against the brief. List concrete findings with file references where possible. If nothing is wrong, say CLEAN.' },
        { role: 'user', content: `Brief: ${brief}\n\nBuilder output (tail):\n${buildOutput.slice(-4000)}` },
      ], { model: 'Apertus-70B', max_tokens: 600 });
      meteredTokens += (res.usage?.total_tokens || 0);
      auditCall(record.id, 'apertus-70b', res);
      await addEvidence(record.id, { kind: 'citation', label: 'critic (apertus-70b) review', ref: `runs/${record.id}/run.log#critique` });
      console.log(`critic · apertus-70b:`);
      console.log(res.text.replace(/^/gm, '  '));
      appendLog(record.id, `CRITIQUE (apertus-70b):\n${res.text}`);
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
      verifyEv = { kind: 'command', label: test.label, command: `${test.cmd} ${test.args.join(' ')}`, argv: [test.cmd, ...test.args], exit: 0, output: stdout.slice(0, 4000) };
      console.log(`verifier · ${test.label} ✓`);
      appendLog(record.id, `VERIFY ${test.label} exit 0:\n${stdout.slice(0, 4000)}`);
    } catch (e) {
      verifyEv = { kind: 'command', label: test.label, command: `${test.cmd} ${test.args.join(' ')}`, argv: [test.cmd, ...test.args], exit: e.code ?? 1, output: String(e.stdout || e.message).slice(0, 4000) };
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
      // untracked files = artifacts
      for (const line of after.porcelain.split('\n').filter((l) => l.startsWith('??'))) {
        const p = line.slice(3).trim();
        if (existsSync(resolve(cwd, p))) {
          await addEvidence(record.id, { kind: 'artifact', label: p, path: p });
        }
      }
      console.log(`diffs · ${after.numstat.split('\n').filter(Boolean).length} file(s) changed`);
    }
  }

  // artifact: the run's own log is always filed
  await addEvidence(record.id, { kind: 'artifact', label: `runs/${record.id}/run.log`, path: join(home(), 'runs', record.id, 'run.log') });

  // ---- 5. gate --------------------------------------------------------------
  console.log('\n── gate ─────────────────────────────');
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

  console.log(`\n${gate.passed ? '✓' : '✗'} run ${record.id} ${gate.passed ? 'PROVEN' : `not proven - ${gate.summary}`}`);
  console.log(`  metered ${meteredTokens} of ${budgetTokens} token budget · proof: cadre proof ${record.id} · replay: cadre watch ${record.id}`);
  return gate.passed ? 0 : 1;
}
