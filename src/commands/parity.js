// parity - build to parity against a cited reference. This command runs a
// REAL ax build whose completion check cites the reference (--ref). The loop
// count and pass state come from the ax run itself, not from a script.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { existsSync, appendFileSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'node:fs';
import { createRun, updateRun, appendLog, addEvidence, audit, home, runDir, appendParityClaim } from '../store.js';

const run = promisify(execFile);
const AX = process.env.CADRE_AX || join(homedir(), '.local/bin/ax');

export async function cmdParity(args, flags) {
  // --verify: run the behavior-closing executor against the current tree.
  // Each open behavior gets a deterministic check (named file exists / tests
  // pass / keywords co-occur); closed rows carry file:line citations.
  if (flags.verify) {
    const ref = String(flags.ref || '');
    let behaviors = [];
    let source = '';
    if (ref && existsSync(ref)) {
      source = ref;
      behaviors = readFileSync(ref, 'utf-8').split('\n')
        .map((l) => l.trim())
        .filter((l) => /^([-*]\s+\S|^#{1,4}\s+\S|\S)/.test(l))
        .filter((l) => l.length > 8 && !/^[-*=#]{3,}$/.test(l))
        .slice(0, 40)
        .map((l) => l.replace(/^#{1,4}\s+/, '').replace(/^[-*]\s+/, ''));
    } else {
      // latest contract from the most recent parity run
      const runs = [...readdirSync(join(home(), 'runs'))].sort().reverse();
      for (const r of runs) {
        const cf = join(home(), 'runs', r, 'parity-contract.json');
        if (existsSync(cf)) {
          const c = JSON.parse(readFileSync(cf, 'utf-8'));
          behaviors = c.behaviors || [];
          source = `runs/${r}/parity-contract.json`;
          break;
        }
      }
    }
    if (!behaviors.length) {
      console.error('parity --verify: no contract found (pass --ref <file> or run parity once first)');
      return 2;
    }
    // drift check: a pinned contract must match the ref it was locked against
    let pinned = null;
    try { pinned = JSON.parse(readFileSync(join(home(), 'runs', [...readdirSync(join(home(), 'runs'))].sort().reverse().find((r) => existsSync(join(home(), 'runs', r, 'parity-contract.json'))) || '', 'parity-contract.json'), 'utf-8')); } catch { /* none */ }
    if (pinned?.ref_sha256 && ref && existsSync(ref)) {
      const { createHash } = await import('node:crypto');
      const nowSha = createHash('sha256').update(readFileSync(ref, 'utf-8')).digest('hex');
      if (nowSha !== pinned.ref_sha256) {
        console.log(`parity verify · REF DRIFTED since the contract was pinned (${pinned.extracted})`);
        console.log(`      pinned sha ${pinned.ref_sha256.slice(0, 12)}… != now ${nowSha.slice(0, 12)}… - re-run parity to re-pin, or verify consciously against the current text`);
        if (!flags['accept-drift']) return 6;
        console.log('      (--accept-drift: proceeding against the current ref text)');
      }
    }
    const cwd = typeof flags.cwd === 'string' ? flags.cwd : process.cwd();
    let testCmd = null;
    try {
      const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf-8'));
      if (pkg.scripts?.test) testCmd = { cmd: 'npm', args: ['test'], label: 'npm test' };
    } catch {
      for (const [mk, args] of [['make', ['test']], ['cargo', ['test']], ['python', ['-m', 'pytest']]]) {
        if (existsSync(join(cwd, mk === 'make' ? 'Makefile' : mk === 'cargo' ? 'Cargo.toml' : 'pyproject.toml'))) { testCmd = { cmd: mk, args }; break; }
      }
    }
    console.log(`parity verify · ${behaviors.length} behavior(s) from ${source} against ${cwd}`);
    const { verifyContract } = await import('../behaviorcheck.js');
    const { execFile } = await import('node:child_process');
    let ghRepo = typeof flags['gh-repo'] === 'string' ? flags['gh-repo'] : null;
    if (!ghRepo) try {
      const { promisify } = await import('node:util');
      const { stdout } = await promisify(execFile)('git', ['-C', cwd, 'remote', 'get-url', 'origin'], { timeout: 5000 });
      ghRepo = /[:/]([^/]+\/[^/.]+)(?:\.git)?\s*$/.exec(stdout.trim())?.[1] || null;
    } catch { /* no remote */ }
    const v = await verifyContract(behaviors, cwd, { testCmd, refPath: source, ghRepo });
    for (const r of v.results) {
      console.log(`  ${r.closed ? '✓ closed' : '✗ open  '} [${r.kind}] ${r.behavior.slice(0, 80)}`);
      console.log(`      ${r.reason}${r.citation ? ' · cite: ' + r.citation : ''}`);
    }
    // ledger rows: closed behaviors get citations, open ones say why
    const ledgerPath = join(home(), 'parity-ledger.jsonl');
    mkdirSync(home(), { recursive: true });
    const verifyRows = v.results.map((r) => appendParityClaim({
        ts: new Date().toISOString(),
        run: 'verify',
        target: r.behavior.slice(0, 200),
        ref: source,
        verdict: r.closed ? `behavior-closed (${r.kind})` : 'behavior-open',
        evidence_count: r.closed ? 1 : 0,
        citation: r.citation || '',
      }));
    console.log(`\nparity verify: ${v.closed}/${v.total} closed · ${v.open} open (ledger rows filed)`);
    return v.open === 0 ? 0 : 1;
  }
  // --until-proven: loop failing checks -> builder -> re-check. A line closes
  // only when its own check passes. Stretch runs after core, and only when the
  // goal asks. The lap cap checkpoints; budget and a no-progress breaker stop.
  if (flags['until-proven']) {
    let ref = String(flags.ref || '');
    let cwd = typeof flags.cwd === 'string' ? flags.cwd : process.cwd();
    let goal = args.join(' ').trim();
    const checkpointPath = join(home(), 'parity-checkpoint.json');
    if (flags.resume) {
      let saved = null;
      try { saved = JSON.parse(readFileSync(checkpointPath, 'utf-8')); } catch { /* none */ }
      if (!saved) {
        console.error('parity --resume: no checkpoint. Run parity --until-proven first.');
        return 2;
      }
      if (!ref) ref = saved.ref || '';
      if (typeof flags.cwd !== 'string' && saved.cwd) cwd = saved.cwd;
      if (!goal && saved.goal) goal = saved.goal;
      console.log(`parity loop · resuming ${saved.phase || 'core'} from checkpoint`);
    }
    const maxIter = Math.max(1, Math.min(Number(flags['max-iter']) || 20, 50));
    const { buildScopeManifest, writeScopeFile, readScopeFile } = await import('../scope.js');
    const { splitSpec, wantsBeyond, verifyContract, parseCheck } = await import('../behaviorcheck.js');
    const beyond = wantsBeyond(goal);
    const scopePath = join(cwd, '.cadre', 'scope.json');
    writeScopeFile(scopePath, buildScopeManifest({ brief: `parity ${ref || cwd}`, cwd, scope: typeof flags.scope === 'string' ? flags.scope : '**' }));
    const testCmd = (() => {
      try {
        const pkg = JSON.parse(readFileSync(join(cwd, 'package.json'), 'utf-8'));
        if (pkg.scripts?.test) return { cmd: 'npm', args: ['test'], label: 'npm test' };
      } catch { /* none */ }
      return null;
    })();
    const { invokeLane } = await import('../invoke.js');
    const { buildRoster } = await import('../scan.js');
    // BUDGET: laps continue only while the loop's metered spend stays under the
    // cap (default 200k tok, --budget overrides). Free/local lanes never
    // exhaust it - exactly "as many laps as the budget allows".
    const budgetTokens = Math.max(1, Number(flags.budget) || 200000);
    let meteredTokens = 0;
    const underBudget = () => meteredTokens < budgetTokens;
    // LEDGER: every lap files one row per behavior - passing with its
    // citation, failing with its reason. The loop lands its own evidence.
    const ledgerPath = join(home(), 'parity-ledger.jsonl');
    mkdirSync(home(), { recursive: true });
    const fileLap = (iterNo, results, source) => {
      for (const r of results) {
        // claims go through appendParityClaim so each lap's verdict on a
        // behavior supersedes the prior lap's claim (chain readable forward)
        appendParityClaim({
          ts: new Date().toISOString(),
          run: `loop-${iterNo}`,
          target: r.behavior.slice(0, 200),
          ref: source,
          verdict: r.closed ? `behavior-closed (${r.kind})` : 'behavior-open',
          evidence_count: r.closed ? 1 : 0,
          citation: r.citation || '',
          reason: r.closed ? '' : String(r.reason || '').slice(0, 300),
        });
      }
    };
    const fileSummary = () => {
      appendFileSync(ledgerPath, JSON.stringify({
        ts: new Date().toISOString(), run: 'loop-summary', ref,
        verdict: 'loop-summary', evidence_count: 0,
        laps_burned: lapsBurned, closed: lastClosed, open: lastOpen,
        metered_tokens: meteredTokens, budget_tokens: budgetTokens,
        spend_per_lane: Object.fromEntries(laneSpend),
        citation: '',
      }) + '\n');
      console.log(`parity loop · summary filed: ${lapsBurned} lap(s) · spend/lanes: ${JSON.stringify(Object.fromEntries(laneSpend))} · ${meteredTokens}/${budgetTokens} tok`);
    };
    let lastClosed = 0;
    let lastOpen = 0;
    let spec = { core: [], stretch: [], excluded: [] };
    if (ref) {
      if (!existsSync(ref)) {
        console.error(`parity --until-proven: --ref is not a file (${ref})`);
        return 2;
      }
      spec = splitSpec(readFileSync(ref, 'utf-8'));
    } else if (!testCmd) {
      console.error('parity --until-proven needs --ref <file> or a project test command');
      return 2;
    } else {
      let suiteOut = '';
      let suiteCode = 0;
      try {
        await run(testCmd.cmd, testCmd.args, { cwd, timeout: 1000 * 60 * 5, maxBuffer: 1024 * 1024 * 8 });
      } catch (e) {
        suiteCode = e.code ?? 1;
        suiteOut = `${e.stdout || ''}\n${e.stderr || ''}`;
      }
      if (suiteCode === 0) {
        console.log('parity loop · test suite already green');
        return 0;
      }
      const names = [...suiteOut.matchAll(/^not ok \d+ - (.+)$/gm)].map((m) => m[1].trim()).filter(Boolean);
      const label = `${testCmd.cmd} ${testCmd.args.join(' ')}`.trim();
      spec.core = names.length ? [...new Set(names)].map((n) => `test ${n} passes`) : [`command: ${label}`];
      ref = `${cwd} tests`;
    }
    const named = (list) => list.filter((b) => parseCheck(b));
    const coreChecks = named(spec.core);
    if (spec.core.length && !coreChecks.length) {
      console.error('parity loop · spec names no checks (command, file contains, test name, or path exists): refusing to claim parity');
      for (const b of spec.core) console.log(`  not checkable: ${b.slice(0, 120)}`);
      return 2;
    }
    for (const b of spec.core) if (!parseCheck(b)) console.log(`parity loop · not checkable, not built: ${b.slice(0, 120)}`);
    for (const b of spec.excluded) console.log(`parity loop · excluded, not built: ${b.slice(0, 120)}`);
    const stretchChecks = named(spec.stretch);
    if (!beyond && spec.stretch.length) {
      console.log(`\nparity loop · ${spec.stretch.length} stretch item(s) PROPOSED (not in the contract; never built without your say-so):`);
      for (const st of spec.stretch.slice(0, 5)) console.log(`  ~ ${st.slice(0, 100)}`);
      for (const st of spec.stretch) {
        appendParityClaim({
          ts: new Date().toISOString(), run: 'stretch', target: st.slice(0, 200), ref,
          verdict: 'stretch-proposed', evidence_count: 0, citation: '',
          reason: 'beyond parity - proposed only, requires your approval to build',
        });
      }
    } else if (beyond) {
      for (const b of spec.stretch) if (!parseCheck(b)) console.log(`parity loop · stretch not checkable, not built: ${b.slice(0, 120)}`);
      if (stretchChecks.length) console.log(`parity loop · ${stretchChecks.length} stretch check(s) run after core is green`);
    }
    if (!coreChecks.length && !(beyond && stretchChecks.length)) {
      console.error('parity loop · spec names no checks (command, file contains, test name, or path exists): refusing to claim parity');
      return 2;
    }
    const laneSpend = new Map();
    let noMoveStreak = 0;
    let prevClosed = -1;
    let lapsBurned = 0;
    const saveCheckpoint = (phase) => {
      writeFileSync(checkpointPath, JSON.stringify({ ref, cwd, goal, phase, at: new Date().toISOString() }, null, 2));
      console.log(`parity loop · checkpoint after ${maxIter} lap(s) on ${phase}. continue: cadre parity --until-proven --resume last`);
    };
    const drive = async (behaviors, phase) => {
      noMoveStreak = 0;
      prevClosed = -1;
      for (let iter = 1; iter <= maxIter; iter++) {
        if (!underBudget()) {
          console.log(`parity loop · BUDGET EXHAUSTED (${meteredTokens} >= ${budgetTokens} tok) after ${iter - 1} lap(s) - stopping honestly`);
          fileSummary();
          return 7;
        }
        const locked = readScopeFile(scopePath);
        if (!locked) {
          console.log('parity loop · scope lock missing on re-read: stopping');
          fileSummary();
          return 6;
        }
        console.log(`parity loop · scope re-read: ${locked.lock.join(' ')}`);
        const v = await verifyContract(behaviors, cwd, { testCmd, refPath: ref });
        const open = v.results.filter((r) => !r.closed);
        const closedN = v.results.length - open.length;
        lapsBurned = iter;
        fileLap(iter, v.results, ref);
        console.log(`\nparity loop · ${phase} ${iter}/${maxIter}: ${closedN}/${v.results.length} closed (ledger rows filed: ${v.results.length})`);
        lastClosed = closedN;
        lastOpen = open.length;
        for (const r of open.slice(0, 5)) console.log(`  open [${r.kind}] ${r.behavior.slice(0, 90)}\n      ${r.reason}`);
        if (open.length === 0) return 'closed';
        if (closedN === prevClosed) {
          noMoveStreak += 1;
          if (noMoveStreak >= 2) {
            console.log(`parity loop · CIRCUIT BREAKER: 2 iterations without closing a behavior - stopping honestly (${closedN}/${v.results.length})`);
            for (const r of open) console.log(`  still open: ${r.behavior.slice(0, 100)}: ${r.reason}`);
            return 4;
          }
        } else noMoveStreak = 0;
        prevClosed = closedN;
      // build toward the OPEN behaviors: hand them to the best builder lane
      const roster = await buildRoster();
      const { assignRoles, bestDrivable } = await import('../router.js');
      const { laneDrivable } = await import('../invoke.js');
      const routed = assignRoles(roster, { brief: open.slice(0, 3).map((r) => r.behavior).join('\n') });
      const picked = roster.lanes.find((l) => l.name === routed.assignments.find((a) => a.role === 'builder')?.lane);
      const builder = (picked && laneDrivable(picked)) ? picked : bestDrivable(roster, 'builder', open.map((r) => r.behavior).join('\n'), laneDrivable);
      if (!builder) {
        console.log('parity loop · no file-acting builder lane available - stopping (scanned CLIs are presence-only)');
        return 3;
      }
      const brief = `Close these failing checks in ${cwd}:\n${open.slice(0, 10).map((r, i) => `${i + 1}. ${r.behavior}\n   failed: ${String(r.reason || '').slice(0, 300)}`).join('\n')}`;
      console.log(`parity loop · builder ${builder.name} on ${Math.min(open.length, 10)} open behavior(s)`);
      const { lockSpecs, scopeCreep, settleCreep } = await import('../scope.js');
      const { readdirSync: readNames } = await import('node:fs');
      const walk = (dir, prefix, into) => {
        let entries;
        try { entries = readNames(dir, { withFileTypes: true }); } catch { return; }
        for (const e of entries) {
          if (e.name.startsWith('.') || e.name === 'node_modules') continue;
          const rel = prefix ? `${prefix}/${e.name}` : e.name;
          if (e.isDirectory()) walk(join(dir, e.name), rel, into);
          else into.add(rel);
        }
      };
      const prior = new Set();
      walk(cwd, '', prior);
      const res = await invokeLane(builder, brief, { timeoutMs: 1000 * 60 * 30, cwd, allowWrites: lockSpecs(locked, cwd) });
      const afterNames = new Set();
      walk(cwd, '', afterNames);
      const crept = scopeCreep([...afterNames].filter((f) => !prior.has(f)), locked);
      if (crept.length) {
        const settled = settleCreep({ creep: crept, why: '', cwd, prior });
        console.log(`parity loop · scope rejected ${crept.join(', ')} (${settled.reverted.map((x) => x.result).join(', ')})`);
        noMoveStreak += 1;
      }
      lapsBurned = iter;
      const laneTok = res.usage?.total_tokens || 0;
      meteredTokens += laneTok;
      laneSpend.set(builder.name, (laneSpend.get(builder.name) || 0) + laneTok);
      console.log(`parity loop · builder ${res.ok ? 'done' : 'FAILED'}${res.ok ? '' : ': ' + String(res.error || '').slice(0, 120)}`);
      if (meteredTokens >= budgetTokens) {
        console.log(`parity loop · budget now exhausted (${meteredTokens}/${budgetTokens} tok) - next lap will stop`);
      }
      if (!res.ok && ++noMoveStreak >= 2) {
        console.log('parity loop · CIRCUIT BREAKER: builder failing repeatedly - stopping honestly');
        return 4;
      }
      }
      saveCheckpoint(phase);
      fileSummary();
      return 5;
    };
    const coreResult = coreChecks.length ? await drive(coreChecks, 'core') : 'closed';
    if (coreResult !== 'closed') return coreResult;
    if (beyond && stretchChecks.length) {
      console.log('parity loop · core closed · starting stretch');
      const stretchResult = await drive(stretchChecks, 'stretch');
      if (stretchResult !== 'closed') return stretchResult;
    }
    try { unlinkSync(checkpointPath); } catch { /* no checkpoint to clear */ }
    console.log('parity loop · ALL BEHAVIORS CLOSED - contract matches the build');
    fileSummary();
    return 0;
  }
  // B6: cadre parity --ledger renders the parity ledger (no build)
  if (flags.ledger) {
    const { readFileSync } = await import('node:fs');
    const p = join(home(), 'parity-ledger.jsonl');
    if (!existsSync(p)) { console.log(`no parity ledger yet (${p})`); return 0; }
    const lines = readFileSync(p, 'utf-8').split('\n').filter(Boolean);
    console.log(`parity ledger · ${lines.length} entr${lines.length === 1 ? 'y' : 'ies'} (${p})`);
    for (const l of lines) {
      try {
        const e = JSON.parse(l);
        console.log(`  ${e.ts}  run ${e.run}  ${String(e.verdict).padEnd(8)} ref ${(e.ref || '—').padEnd(24)} ${e.evidence_count} ev ${e.citation || ''}`);
      } catch { console.log(`  (unparseable line: ${l.slice(0, 60)})`); }
    }
    return 0;
  }
  const target = args.join(' ').trim();
  if (!target) {
    console.error('cadre parity "<outcome>" --ref <reference>');
    return 2;
  }
  if (!flags.ref) {
    console.error('missing --ref: parity requires a reference to build against');
    return 2;
  }
  if (!existsSync(AX)) {
    console.error(`cadre: ax not found at ${AX} - parity drives a real build`);
    return 1;
  }
  const ref = String(flags.ref);
  const refExists = existsSync(ref);
  if (!refExists && !/^[\w./-]+$/.test(ref)) {
    console.error(`--ref "${ref}" is neither a file on disk nor a reference id`);
    return 1;
  }

  const refSha = refExists ? createHash('sha256').update(readFileSync(ref)).digest('hex') : null;
  const record = createRun({ brief: `parity: ${target} (ref ${ref})`, kind: 'parity', roles: {}, meta: { ref, refSha } });
  console.log(`cadre parity - run ${record.id} · target: ${target}`);
  console.log(`ref: ${ref}${refExists ? ' (file on disk)' : ' (reference id)'}`);

  const task = [
    `Build to parity: ${target}.`,
    refExists
      ? `Reference (read it first): ${ref}. Match its observable behavior; cite the lines you matched.`
      : `Reference id: ${ref}. Cite it in the completion notes.`,
    'The run is done only when the evidence gate passes.',
  ].join('\n');

  // --dry: show the extracted contract + plan, spend nothing
  if (flags.dry) {
    console.log(`cadre parity (dry) - ${target}`);
    console.log(`ref: ${ref}`);
    let dryBehaviors = [];
    try {
      dryBehaviors = readFileSync(ref, 'utf-8').split('\n').map((l) => l.trim())
        .filter((l) => l.length > 8 && !/^[-*=#]{3,}$/.test(l))
        .slice(0, 40).map((l) => l.replace(/^#{1,4}\s+/, '').replace(/^[-*]\s+/, ''));
    } catch { /* id refs have no file */ }
    if (dryBehaviors.length) {
      console.log(`contract: ${dryBehaviors.length} behaviors:`);
      dryBehaviors.slice(0, 10).forEach((b, i) => console.log(`  [${i + 1}/${dryBehaviors.length}] ${b.slice(0, 100)}`));
      if (dryBehaviors.length > 10) console.log(`  … (${dryBehaviors.length - 10} more)`);
    } else {
      console.log('contract: no file behaviors (id ref) - behaviors named by the builder, cited');
    }
    console.log('pipeline: extract contract -> build -> gate per behavior -> ledger rows');
    return 0;
  }

  // #14: extract a behavior contract from the reference. Each heading/bullet
  // in the ref (or each line for plain text) becomes a numbered behavior; the
  // loop tracks k/N and files one ledger row per behavior.
  let behaviors = [];
  if (refExists) {
    try {
      const text = readFileSync(ref, 'utf-8');
      // markdown: bullets and headings; plain text: non-empty lines
      behaviors = text.split('\n')
        .map((l) => l.trim())
        .filter((l) => /^([-*]\s+\S|^#{1,4}\s+\S|\S)/.test(l))
        .filter((l) => l.length > 8 && !/^[-*=#]{3,}$/.test(l))
        .slice(0, 40)
        .map((l) => l.replace(/^#{1,4}\s+/, '').replace(/^[-*]\s+/, ''));
    } catch (e) {
      console.log(`ref unreadable (${e.message.split('\n')[0]}) - behaviors not extracted`);
    }
  }
  const N = behaviors.length;
  if (N > 0) {
    appendLog(record.id, `PARITY CONTRACT: ${N} behaviors extracted from ${ref}:`);
    behaviors.forEach((b, i) => appendLog(record.id, `  [${i + 1}/${N}] ${b.slice(0, 120)}`));
    console.log(`parity contract: ${N} behavior(s) extracted from the ref (progress logged as [k/${N}])`);
    // PIN: content hashes make the contract tamper-evident - a drifted ref is
    // detected at verify time, not silently reinterpreted
    const { createHash } = await import('node:crypto');
    writeFileSync(join(runDir(record.id), 'parity-contract.json'), JSON.stringify({
      ref,
      ref_sha256: createHash('sha256').update(readFileSync(ref, 'utf-8')).digest('hex'),
      behaviors,
      behaviors_sha256: createHash('sha256').update(JSON.stringify(behaviors)).digest('hex'),
      extracted: new Date().toISOString(),
    }, null, 2));
    await addEvidence(record.id, { kind: 'artifact', label: `parity contract (${N} behaviors)`, path: join(runDir(record.id), 'parity-contract.json') });
  }

  appendLog(record.id, `PARITY ref=${ref}`);
  audit({ kind: 'parity-start', run: record.id, ref });
  // B6 parity ledger: this run's outcome gets appended to parity-ledger.jsonl
  const appendLedger = (verdict) => {
    appendParityClaim({
      ts: new Date().toISOString(),
      run: record.id,
      target: target.slice(0, 200),
      ref,
      verdict,
      evidence_count: (record.evidence || []).length,
      citation: axRunOfVerdict,
    });
  };
  let axRunOfVerdict = null;

  try {
    const axArgs = ['build', task];
    if (flags.override) axArgs.push('--override');
    const { stdout } = await run(AX, axArgs, { timeout: 1000 * 60 * 30, maxBuffer: 1024 * 1024 * 32 });
    process.stdout.write(stdout.split('\n').slice(-25).join('\n').replace(/^/gm, '  ') + '\n');
    const axRun = /run-\d{8}-\d{6}-\d+/.exec(stdout);
    axRunOfVerdict = axRun ? axRun[0] : null;
    await addEvidence(record.id, { kind: 'citation', label: 'ax build log', ref: axRun ? `~/.config/ax/runs/${axRun[0]}` : 'ax build stdout (filed in run.log)' });
    appendLog(record.id, `BUILD:\n${stdout.slice(0, 20000)}`);
    // Verdict: the FINAL evidence-gate block decides — an upstream APPROVE line
    // (e.g. "pre-approved by debate") is not the verdict. UNEVIDENCED always rejects.
    const gateBlocks = stdout.split(/evidence gate/);
    const lastGate = gateBlocks.length > 1 ? gateBlocks[gateBlocks.length - 1] : '';
    const unevidenced = /UNEVIDENCED|VERDICT: (INCOMPLETE|REJECT)/i.test(lastGate);
    const approved = !unevidenced && /CONSENSUS: APPROVE/.test(lastGate);
    if (unevidenced && /CONSENSUS: APPROVE/.test(stdout)) {
      appendLog(record.id, 'GATE NOTE: upstream APPROVE line ignored - final evidence gate says UNEVIDENCED, rejecting');
    }
    updateRun(record.id, {
      status: approved ? 'passed' : 'rejected',
      verdict: { passed: approved, summary: approved ? 'ax build approved with citations' : 'ax build did not approve' },
      ended: new Date().toISOString(),
    });
    console.log(approved ? `\n✓ parity run ${record.id} - build approved; citation filed (${axRun ? axRun[0] : 'stdout'})` : `\n✗ parity run ${record.id} - build not approved`);
    appendLedger(approved ? 'approved' : 'rejected');
    if (N > 0) {
      console.log(`parity · ax gate ${approved ? 'approved' : 'rejected'}. Per-behavior parity is cadre parity --until-proven --ref ${ref}`);
    }
    return approved ? 0 : 1;
  } catch (e) {
    const out = String(e.stdout || '');
    appendLog(record.id, `BUILD FAILED: ${String(e.message).slice(0, 2000)}`);
    updateRun(record.id, { status: 'failed', ended: new Date().toISOString() });
    process.stderr.write(out.split('\n').slice(-10).join('\n') + '\n');
    console.error(`cadre: ax build failed (exit ${e.code})`);
    appendLedger('failed');
    return e.code || 1;
  }
}
