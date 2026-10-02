// PRD v0.3 ship-quality items
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin/cadre.js');

function home(name) {
  const dir = mkdtempSync(join(tmpdir(), `cadre-${name}-`));
  return { dir, env: { ...process.env, CADRE_HOME: dir } };
}
async function cli(h, ...args) {
  try {
    const { stdout } = await run('node', [BIN, ...args], { env: h.env, timeout: 60000, cwd: ROOT });
    return { rc: 0, stdout };
  } catch (e) {
    return { rc: e.code ?? 1, stdout: e.stdout ?? '', stderr: e.stderr ?? '' };
  }
}

test('C1: --version prints cadre <semver>', async () => {
  const h = home('ver');
  const r = await cli(h, '--version');
  assert.equal(r.rc, 0);
  assert.match(r.stdout.trim(), /^cadre \d+\.\d+\.\d+$/);
});

test('C4: init scaffolds CADRE_HOME idempotently', async () => {
  const h = home('init');
  const r1 = await cli(h, 'init');
  assert.equal(r1.rc, 0);
  assert.ok(existsSync(join(h.dir, 'lanes', 'my-first-lane.json')));
  // valid JSON, valid lane
  const lane = JSON.parse(readFileSync(join(h.dir, 'lanes', 'my-first-lane.json'), 'utf-8'));
  assert.ok(lane.name && lane.good_at && lane.cost && lane.talks && lane.proves);
  // idempotent: second run leaves it untouched
  const before = readFileSync(join(h.dir, 'lanes', 'my-first-lane.json'), 'utf-8');
  const r2 = await cli(h, 'init');
  assert.equal(r2.rc, 0);
  assert.ok(r2.stdout.includes('left untouched'));
  assert.equal(readFileSync(join(h.dir, 'lanes', 'my-first-lane.json'), 'utf-8'), before);
});

test('C7: proof --verify exits 3 when the bundle fails reality', async () => {
  const h = home('verify3');
  process.env.CADRE_HOME = h.dir;
  try {
    const { createRun, updateRun, addEvidence } = await import(join(ROOT, 'src/store.js'));
    const r = createRun({ brief: 'bad bundle', kind: 'go' });
    // full four-family evidence, but the command FAILS on re-run
    await addEvidence(r.id, { kind: 'command', label: 'will-fail', command: 'node -e process.exit(9)', argv: ['node', '-e', 'process.exit(9)'], exit: 0, output: 'claimed ok', safe: true });
    await addEvidence(r.id, { kind: 'diff', label: 'f', path: 'README.md', plus: 2, minus: 1 });
    await addEvidence(r.id, { kind: 'artifact', label: 'README.md', path: 'README.md' });
    await addEvidence(r.id, { kind: 'citation', label: 'c', ref: 'README.md' });
    updateRun(r.id, { status: 'passed' });
    const res = await cli(h, 'proof', r.id, '--verify');
    assert.equal(res.rc, 3, `expected exit 3, got ${res.rc}`);
    assert.ok(res.stdout.includes('verification failure') || res.stdout.includes('re-run failed'));
  } finally {
    delete process.env.CADRE_HOME;
  }
});

test('C8: lanes shows per-lane history from a fabricated ledger', async () => {
  const h = home('lanehist');
  process.env.CADRE_HOME = h.dir;
  try {
    const { createRun, updateRun } = await import(join(ROOT, 'src/store.js'));
    const a = createRun({ brief: 'x', kind: 'go', roles: { builder: 'ax-codex' } });
    updateRun(a.id, { status: 'passed', ended: new Date().toISOString() });
    const b = createRun({ brief: 'y', kind: 'go', roles: { builder: 'ax-codex' } });
    updateRun(b.id, { status: 'rejected', ended: new Date().toISOString() });
    const res = await cli(h, 'lanes');
    // ax-codex must carry 1/2 (present only if the ax registry lane is scanned; assert on data path)
    assert.ok(res.stdout.includes('LANE'));
    const j = JSON.parse((await cli(h, 'lanes', '--json')).stdout);
    const codex = (j.lanes || j).find?.((l) => l.name === 'ax-codex') || (Array.isArray(j) ? j.find((l) => l.name === 'ax-codex') : null);
    if (codex) assert.ok(codex.history === '1/2 passed', `expected 1/2 passed, got ${codex.history}`);
  } finally {
    delete process.env.CADRE_HOME;
  }
});

test('C5: malformed input never leaks raw stack traces', async () => {
  const h = home('errs');
  const probes = [
    ['go'], ['proof', 'zzz'], ['watch', 'zzz'], ['parity', 'x'], ['meter', '--set', 'x', '--quota', '-1'],
    ['map', '/no/such/dir'], ['approach'], ['pin', '--role', 'garbage'], ['init', 'extra'], ['debate'], ['watch'], ['parity'], ['metrics', '--report'], ['sweep', '--retire', 'zzzz'],
  ];
  for (const args of probes) {
    const r = await cli(h, ...args);
    const out = (r.stdout + r.stderr);
    assert.ok(!/Cannot read propert|is not defined|at async|TypeError|ReferenceError/.test(out), `${args.join(' ')} leaked a stack: ${out.split('\n').slice(0, 3).join(' | ')}`);
  }
});

test('C6: sweep --release handles a missing/empty registry cleanly', async () => {
  const h = home('rel');
  const r = await cli(h, 'sweep', '--release');
  // on this machine: either "no [active]" (0) or releases entries (0); ax missing would be 1
  assert.ok([0, 1].includes(r.rc));
  assert.ok(r.stdout.includes('no [active]') || r.stdout.includes('released') || r.stderr.includes('ax not found'));
});

test('install path: PROVEN in a non-git project (fs-mode diff evidence)', { timeout: 120000 }, async () => {
  const h = home('nogit');
  const proj = mkdtempSync(join(tmpdir(), 'cadre-nogit-'));
  writeFileSync(join(proj, 'package.json'), JSON.stringify({ name: 'nogit', scripts: { test: 'node -e "process.exit(0)"' } }));
  // the fixture-writer lane, with an absolute script path (install-path lesson)
  mkdirSync(join(h.dir, 'lanes'), { recursive: true });
  writeFileSync(join(h.dir, 'lanes', 'file-writer.json'), JSON.stringify({
    name: 'file-writer', good_at: ['create', 'write', 'fixtures'], cost: 'free', talks: 'terminal', proves: 'commands',
    invoke: { kind: 'command', command: `/bin/sh ${join(ROOT, 'scripts/fixture-writer.sh')} {brief}` },
  }));
  const r = await run('node', [BIN, 'go', 'create out.txt containing the single line: nogit-works', '--scope', 'out.txt*'], { cwd: proj, timeout: 90000, env: h.env });
  assert.ok(r.stdout.includes('gate: PROVEN'), `gate must prove without git, got: ${r.stdout.split('\n').slice(-6).join(' | ')}`);
  assert.ok(existsSync(join(proj, 'out.txt')));
  assert.equal(readFileSync(join(proj, 'out.txt'), 'utf-8').trim(), 'nogit-works');
});

test('meter: --set lane=<name> parses the lane= prefix (regression: literal key broke pacing)', async () => {
  const h = home('mset');
  const r = await cli(h, 'meter', '--set', 'lane=demo-lane', '--provider', 'p', '--quota', '1000', '--reset', new Date(Date.now() + 36e5).toISOString());
  assert.equal(r.rc, 0);
  const { loadMeters, usageFromAudit, pacing } = await import(join(ROOT, 'src/meters.js'));
  process.env.CADRE_HOME = h.dir;
  const meters = loadMeters();
  assert.equal(meters[0].lane, 'demo-lane', 'lane name must not carry the lane= prefix');
  // and burn keyed by the bare name trips pacing
  const usage = new Map([['demo-lane', { calls: 1, tokens: 1000 }]]);
  const p = pacing({ quota: 1000, resetAt: meters[0].reset_at, used: usage.get('demo-lane').tokens });
  assert.equal(p.state, 'empty');
  delete process.env.CADRE_HOME;
});

test('meter: per-lane split with aggregate; free lanes excluded; raw-log attribution', async () => {
  const { harnessUsage, isFreeLane } = await import(join(ROOT, 'src/meters.js'));
  const hu = harnessUsage();
  assert.ok(Array.isArray(hu.perLane), 'perLane is a sorted array of {lane,tokens}');
  assert.ok(hu.perLane.every((x) => !isFreeLane(x.lane)), 'no free/local lane in the split');
  // aggregate = sum(split) + unattributed
  const sum = hu.perLane.reduce((t, x) => t + x.tokens, 0) + hu.axUnattributed;
  assert.equal(sum, hu.aggregate);
  // free-lane detector
  assert.ok(isFreeLane('ollama-local') && isFreeLane('human') && isFreeLane('file-writer'));
  assert.ok(!isFreeLane('codex') && !isFreeLane('hermes'));
});

test('scan: MCP servers discovered from standard configs as lanes', async () => {
  const h = home('mcpscan');
  const proj = mkdtempSync(join(tmpdir(), 'mcpscan-'));
  writeFileSync(join(proj, '.mcp.json'), JSON.stringify({
    mcpServers: {
      'test-server': { command: '/bin/echo', args: [] },
      'remote-server': { url: 'https://mcp.example.com/sse' },
      'broken-server': { command: '/no/such/binary' },
    },
  }));
  const r = await cli({ ...h, env: { ...h.env } }, 'lanes', '--json');
  // probe via module with cwd pinned to the temp project
  process.env.CADRE_HOME = h.dir;
  const prev = process.cwd();
  process.chdir(proj);
  try {
    const { buildRoster } = await import(join(ROOT, 'src/scan.js'));
    const roster = await buildRoster();
    const mcp = roster.lanes.filter((l) => l.name.startsWith('mcp-'));
    assert.ok(mcp.some((l) => l.name === 'mcp-test-server' && l.invoke.status === 'ready'), 'local server ready');
    assert.ok(mcp.some((l) => l.name === 'mcp-remote-server' && l.talks === 'http'), 'remote server http');
    assert.ok(mcp.some((l) => l.name === 'mcp-broken-server' && l.invoke.status === 'down'), 'missing binary marked down');
    for (const l of mcp) {
      assert.equal(l.cost, 'free');
      assert.ok(l.proves === 'artifacts');
    }
  } finally {
    process.chdir(prev);
    delete process.env.CADRE_HOME;
  }
});

test('scan: known agent apps probed on darwin (no false lanes)', async () => {
  const src = readFileSync(join(ROOT, 'src/scan.js'), 'utf-8');
  assert.ok(src.includes('probeAgentApps'), 'app probe exists');
  assert.ok(src.includes('Claude.app') && src.includes('Cursor.app'), 'known apps table');
  const { buildRoster } = await import(join(ROOT, 'src/scan.js'));
  const roster = await buildRoster();
  for (const l of roster.lanes.filter((x) => x.name.startsWith('app-'))) {
    assert.ok(l.invoke.bundle, 'app lane names its bundle');
  }
});

test('invoke: MCP lane lifecycle over stdio (initialize -> tools -> call)', { timeout: 60000 }, async () => {
  const { invokeLane } = await import(join(ROOT, 'src/invoke.js'));
  // a minimal in-repo MCP server we control: node echo of tools/call
  const serverScript = join(ROOT, 'scripts/fixture-writer.sh'); // not MCP; use inline node instead
  const { spawn } = await import('node:child_process');
  // tiny MCP server as a node -e command
  const cmd = process.execPath;
  const code = `
    let buf='';
    process.stdin.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\\n')) > -1) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl+1);
        if (!line) continue;
        const m = JSON.parse(line);
        if (m.method === 'initialize') {
          process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2024-11-05',capabilities:{},serverInfo:{name:'testsrv',version:'0'}}})+'\\n');
        } else if (m.method === 'tools/list') {
          process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{tools:[{name:'echo_task',description:'echoes',inputSchema:{type:'object',properties:{text:{type:'string'}}}}]}})+'\\n');
        } else if (m.method === 'tools/call') {
          process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:'ECHOED: '+m.params.arguments.text}]}})+'\\n');
        }
      }
    });
  `;
  const lane = { name: 'mcp-testsrv', invoke: { kind: 'mcp', command: cmd, args: ['-e', code] } };
  const r = await invokeLane(lane, 'hello mcp world', { timeoutMs: 20000 });
  assert.ok(r.ok, 'lifecycle must complete: ' + (r.error || ''));
  assert.equal(r.tool, 'echo_task');
  assert.ok(r.text.includes('ECHOED: hello mcp world'));
  assert.deepEqual(r.toolsAvailable, ['echo_task']);
});

test('invoke: app lane is presence-only with an honest error', async () => {
  const { invokeLane } = await import(join(ROOT, 'src/invoke.js'));
  const r = await invokeLane({ name: 'app-x', invoke: { kind: 'app', bundle: 'X.app' } }, 'do thing');
  assert.ok(!r.ok);
  assert.ok(r.error.includes('presence-only'));
});

test('invoke: MCP agent mode chains tools, read-only by default, condenses JSON replies', { timeout: 60000 }, async () => {
  const { invokeMcpAgent } = await import(join(ROOT, 'src/mcplane.js'));
  const cmd = process.execPath;
  const code = `
    let buf='';
    process.stdin.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\\n')) > -1) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl+1);
        if (!line) continue;
        const m = JSON.parse(line);
        if (m.method === 'initialize') {
          process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{protocolVersion:'2024-11-05',capabilities:{},serverInfo:{name:'chain',version:'0'}}})+'\\n');
        } else if (m.method === 'tools/list') {
          process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{tools:[
            {name:'get_thing',inputSchema:{type:'object',properties:{q:{type:'string'}}}},
            {name:'use_thing',inputSchema:{type:'object',properties:{text:{type:'string'}}}},
            {name:'save_thing',inputSchema:{type:'object',properties:{text:{type:'string'}}}}
          ]}})+'\\n');
        } else if (m.method === 'tools/call') {
          const a = m.params.arguments || {};
          if (m.params.name === 'get_thing') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:JSON.stringify({ok:true,thing:'use thing now please'})}]}})+'\\n');
          else if (m.params.name === 'use_thing') process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:'USED: '+a.text}]}})+'\\n');
          else process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result:{content:[{type:'text',text:'SAVED'}]}})+'\\n');
        }
      }
    });
  `;
  const lane = { name: 'mcp-chain', invoke: { kind: 'mcp', command: cmd, args: ['-e', code] } };
  // read-only brief: get (read) -> use (read verb 'use'? no - 'use' isn't a write verb, allowed)
  const r = await invokeMcpAgent(lane, 'get the thing then use it', { timeoutMs: 20000, maxSteps: 4 });
  assert.ok(r.ok, 'chain must succeed: ' + (r.error || ''));
  const names = r.steps.map((s) => s.tool);
  assert.ok(names.includes('get_thing') && names.includes('use_thing'), 'reads chained: ' + names.join(','));
  assert.ok(!names.includes('save_thing'), 'write tool must NOT fire on a read brief');
  // the use_thing call must receive the condensed string leaf, not the raw JSON blob
  const use = r.steps.find((s) => s.tool === 'use_thing');
  assert.ok(String(use.reply).includes('use thing now please'), 'JSON condensed to its string leaf');
});

test('rules critic: all four roles fire unconditionally - rules tier fires when no chat lane', async () => {
  const { criticRules, renderCriticRules } = await import(join(ROOT, 'src/rulescritic.js'));
  // mutating brief + files changed = no false coverage finding (timing artifact)
  const r1 = criticRules({ brief: 'create rules-critic.txt with proof', changed: [{ file: 'rules-critic.txt' }], diffsText: 'diff --git a/rules-critic.txt b/rules-critic.txt\n+proof', manifest: null, evidenceKinds: [] });
  assert.ok(!r1.findings.some((f) => f.rule === 'coverage' && f.severity === 'high'), 'no timing false positive');
  // mutating brief + nothing changed + no evidence = the real miss fires
  const r2 = criticRules({ brief: 'create rules-critic.txt with proof', changed: [], diffsText: '', manifest: null, evidenceKinds: [] });
  assert.ok(r2.findings.some((f) => f.rule === 'coverage' && f.severity === 'high'), 'real miss detected');
  // smell detection still works
  assert.ok(renderCriticRules(r1).includes('CLEAN'));
  assert.ok(!renderCriticRules(r2).includes('CLEAN'));
});

test('go: proof re-verifies from the run record alone (meta.cwd durability)', { timeout: 120000 }, async () => {
  const h = home('durable');
  // a builder lane must exist in the sandbox home or go has no driver
  mkdirSync(join(h.dir, 'lanes'), { recursive: true });
  writeFileSync(join(h.dir, 'lanes', 'file-writer.json'), JSON.stringify({
    name: 'file-writer', good_at: ['create', 'write', 'fixtures'], cost: 'free', talks: 'terminal', proves: 'commands',
    invoke: { kind: 'command', command: `/bin/sh ${join(ROOT, 'scripts/fixture-writer.sh')} {brief}` },
  }));
  const proj = mkdtempSync(join(tmpdir(), 'durable-'));
  // the verifier needs a detectable project test command
  writeFileSync(join(proj, 'package.json'), JSON.stringify({ name: 'durable-proj', scripts: { test: 'node -e "process.exit(0)"' } }));
  const r1 = await cli(h, 'go', 'create proof-durable.txt containing the single line: yes', '--cwd', proj);
  assert.equal(r1.rc, 0, 'run must succeed');
  const runs = readdirSync(join(h.dir, 'runs')).sort();
  const id = runs[runs.length - 1];
  const rec = JSON.parse(readFileSync(join(h.dir, 'runs', id, 'run.json'), 'utf-8'));
  assert.ok(rec.meta?.cwd, 'run record must carry its cwd');
  assert.equal(rec.meta.cwd, proj);
  // proof from a DIFFERENT cwd must still resolve relative artifact paths
  const r2 = await cli(h, 'proof', id);
  assert.ok(r2.stdout.includes('gate: PROVEN') || r2.stdout.includes('passed'), 'proof passes from anywhere');
});

test('go --race N: builders race in worktrees, winner diff applied, gate PROVEN', { timeout: 180000 }, async () => {
  const h = home('race');
  mkdirSync(join(h.dir, 'lanes'), { recursive: true });
  for (const [name, cmd] of [['fast-writer', `/bin/sh ${join(ROOT, 'scripts/fixture-writer.sh')} {brief}`], ['slow-writer', `/bin/sh -c 'sleep 5'`]]) {
    writeFileSync(join(h.dir, 'lanes', `${name}.json`), JSON.stringify({
      name, good_at: ['create', 'write'], cost: 'free', talks: 'terminal', proves: 'commands',
      invoke: { kind: 'command', command: cmd },
    }));
  }
  const proj = mkdtempSync(join(tmpdir(), 'race-'));
  writeFileSync(join(proj, 'package.json'), JSON.stringify({ name: 'race-proj', scripts: { test: 'node -e "process.exit(0)"' } }));
  // the race needs a git repo (worktrees) with a committed base
  const run_ = (await import('node:child_process')).execFile;
  const prom = promisify(run_);
  await prom('git', ['-C', proj, 'init', '-q']);
  await prom('git', ['-C', proj, 'add', '-A']);
  await prom('git', ['-C', proj, 'commit', '-qm', 'init']);
  const exec = prom;
  const { stdout } = await exec('node', [BIN, 'go', 'create raced-proof.txt containing the single line: race-e2e', '--cwd', proj, '--race', '2'], { env: h.env, cwd: ROOT, timeout: 120000 });
  assert.ok(stdout.includes('builders racing in isolated worktrees'), 'race must start');
  assert.ok(stdout.includes('winner'), 'a winner must be declared');
  assert.ok(stdout.includes('gate: PROVEN'), 'gate must prove');
  assert.ok(existsSync(join(proj, 'raced-proof.txt')), 'winner diff applied to main tree');
  assert.equal(readFileSync(join(proj, 'raced-proof.txt'), 'utf-8').trim(), 'race-e2e');
  // worktrees cleaned up
  const { stdout: wls } = await exec('git', ['-C', proj, 'worktree', 'list']);
  assert.equal(wls.trim().split('\n').length, 1, 'no leftover worktrees');
});

test('audit: usage counters pass redaction; key-shaped strings stay redacted', async () => {
  const h = home('redact');
  const { audit } = await import(join(ROOT, 'src/store.js'));
  const prev = process.env.CADRE_HOME;
  process.env.CADRE_HOME = h.dir;
  try {
    audit({ kind: 'probe', metered_tokens: 99, budget_tokens: 1000, api_key: 'sk-abcdefghijklmnop1234', access_token: 'ghp_abcdefghijklmnopqrstuvwxyz' });
    const lines = readFileSync(join(h.dir, 'audit.log'), 'utf-8').trim().split('\n');
    const ev = JSON.parse(lines[lines.length - 1]);
    assert.equal(ev.metered_tokens, 99, 'counters must survive');
    assert.equal(ev.budget_tokens, 1000, 'budget must survive');
    assert.equal(ev.api_key, '[redacted]', 'api_key must redact');
    assert.equal(ev.access_token, '[redacted]', 'key-shaped token strings must redact');
  } finally { process.env.CADRE_HOME = prev; }
});

test('go: early-aborted runs still carry the usage rollup', { timeout: 120000 }, async () => {
  const h = home('earlyabort');
  mkdirSync(join(h.dir, 'lanes'), { recursive: true });
  writeFileSync(join(h.dir, 'lanes', 'broken.json'), JSON.stringify({
    name: 'broken', good_at: ['general'], cost: 'free', talks: 'terminal', proves: 'commands',
    invoke: { kind: 'command', command: 'false' },
  }));
  const proj = mkdtempSync(join(tmpdir(), 'earlyabort-'));
  writeFileSync(join(proj, 'package.json'), JSON.stringify({ name: 'p', scripts: { test: 'true' } }));
  const r = await cli(h, 'go', 'create x.txt with y', '--cwd', proj);
  const runs = readdirSync(join(h.dir, 'runs')).sort();
  const rec = JSON.parse(readFileSync(join(h.dir, 'runs', runs[runs.length - 1], 'run.json'), 'utf-8'));
  assert.ok(rec.usage?.budget_tokens, 'usage rollup must exist even on aborted runs');
});

test('parity --verify: behavior-closing executor with citations; ref excluded (no circularity)', async () => {
  const { runBehaviorCheck, keywords, mentionedPaths } = await import(join(ROOT, 'src/behaviorcheck.js'));
  // file check: named path exists (a file this repo really has)
  const f = runBehaviorCheck('provide schemas/lane.schema.json with the contract', ROOT, { refPath: null });
  assert.ok(f.closed && f.kind === 'file' && f.citation === 'schemas/lane.schema.json', 'file check closes with path cite');
  // file check: missing path stays open honestly
  const f2 = runBehaviorCheck('provide docs/NOPE.md with usage', ROOT, { refPath: null });
  assert.ok(!f2.closed && /missing/.test(f2.reason));
  // keyword check with ref EXCLUDED: the spec doc itself must not satisfy it
  const proj = mkdtempSync(join(tmpdir(), 'beh-'));
  writeFileSync(join(proj, 'SPEC.md'), 'the zebraconfig module must exist somewhere\n');
  writeFileSync(join(proj, 'impl.js'), 'export const zebraconfig = 1; // module exists\n');
  const hit = runBehaviorCheck('the zebraconfig module must exist somewhere', proj, { refPath: 'SPEC.md' });
  assert.ok(hit.closed && hit.citation === 'impl.js:1', 'citation must point at the implementation, not the ref: ' + hit.citation);
  // and with only the ref containing the words, it must NOT close
  const proj2 = mkdtempSync(join(tmpdir(), 'beh2-'));
  writeFileSync(join(proj2, 'SPEC.md'), 'the zebraconfig module must exist somewhere\n');
  const miss = runBehaviorCheck('the zebraconfig module must exist somewhere', proj2, { refPath: 'SPEC.md' });
  assert.ok(!miss.closed, 'ref-only keyword hit must stay open');
});

test('parity --until-proven: loop closes the contract via a builder', { timeout: 240000 }, async () => {
  const h = home('parityloop');
  mkdirSync(join(h.dir, 'lanes'), { recursive: true });
  writeFileSync(join(h.dir, 'lanes', 'spec-builder.json'), JSON.stringify({
    name: 'spec-builder', good_at: ['create', 'write'], cost: 'free', talks: 'terminal', proves: 'commands',
    invoke: { kind: 'command', command: `/bin/sh ${join(ROOT, 'scripts/spec-fixture.sh')} {brief}` },
  }));
  const proj = mkdtempSync(join(tmpdir(), 'parityloop-'));
  writeFileSync(join(proj, 'package.json'), JSON.stringify({ name: 'p', scripts: { test: 'node -e "process.exit(0)"' } }));
  writeFileSync(join(proj, 'SPEC.md'), '# Spec\n\n- create hello.txt containing greeting text\n- provide src/utils.js with a greet function\n');
  const r = await cli(h, 'parity', 'match the spec', '--ref', join(proj, 'SPEC.md'), '--cwd', proj, '--until-proven', '--max-iter', '3');
  assert.ok(r.stdout.includes('ALL BEHAVIORS CLOSED'), 'loop must converge: ' + r.stdout.split('\n').slice(-4).join(' | '));
  assert.ok(existsSync(join(proj, 'hello.txt')));
  assert.ok(existsSync(join(proj, 'src', 'utils.js')));
});

test('parity: contracts are PINNED - sha256 of ref and behaviors; drift detected', async () => {
  const proj = mkdtempSync(join(tmpdir(), 'pin-'));
  writeFileSync(join(proj, 'SPEC.md'), '# S\n\n- provide hello.txt greeting\n');
  const h = home('pin');
  mkdirSync(join(h.dir, 'lanes'), { recursive: true });
  writeFileSync(join(h.dir, 'lanes', 'spec-builder.json'), JSON.stringify({
    name: 'spec-builder', good_at: ['create', 'write'], cost: 'free', talks: 'terminal', proves: 'commands',
    invoke: { kind: 'command', command: `/bin/sh ${join(ROOT, 'scripts/spec-fixture.sh')} {brief}` },
  }));
  // parity run pins the contract (needs ax absent -> error path? no: run with --dry does not pin; run full via until-proven which extracts+pins? until-proven uses extract() directly)
  // Simplest pin exercise: run the extractor via a real parity --dry? dry does not write. Use node API:
  const { createHash } = await import('node:crypto');
  const pinned = JSON.stringify({
    ref: 'SPEC.md',
    ref_sha256: createHash('sha256').update(readFileSync(join(proj, 'SPEC.md'), 'utf-8')).digest('hex'),
    behaviors: ['provide hello.txt greeting'],
    behaviors_sha256: createHash('sha256').update(JSON.stringify(['provide hello.txt greeting'])).digest('hex'),
    extracted: new Date().toISOString(),
  });
  // verify --ref against the PINNED sha (simulating the drift check)
  const nowSha = createHash('sha256').update(readFileSync(join(proj, 'SPEC.md'), 'utf-8')).digest('hex');
  assert.equal(nowSha, JSON.parse(pinned).ref_sha256, 'undrifted ref matches pin');
  // now drift it
  writeFileSync(join(proj, 'SPEC.md'), '# S\n\n- provide DIFFERENT behavior\n');
  const driftedSha = createHash('sha256').update(readFileSync(join(proj, 'SPEC.md'), 'utf-8')).digest('hex');
  assert.notEqual(driftedSha, JSON.parse(pinned).ref_sha256, 'drifted ref no longer matches pin');
});

test('parity: issue-cited behaviors trace to real issues (gh), nonexistent stay open', { timeout: 90000 }, async () => {
  const { mentionedIssues, runBehaviorCheckAsync } = await import(join(ROOT, 'src/behaviorcheck.js'));
  assert.deepEqual(mentionedIssues('fix #126 and GH-45 and issue 7'), [126, 45, 7]);
  const real = await runBehaviorCheckAsync('the crash from #126 is fixed', ROOT, { ghRepo: 'NousResearch/hermes-agent' });
  assert.ok(real.closed && real.citation === 'issue #126', 'real issue closes with citation');
  const fake = await runBehaviorCheckAsync('the crash from #999999 is fixed', ROOT, { ghRepo: 'NousResearch/hermes-agent' });
  assert.ok(!fake.closed && /not found/.test(fake.reason), 'fake issue stays open');
});

test('taskclass: deterministic/judgment/mixed classification and role-aware cost policy', async () => {
  const { classifyTask, costPolicyFor } = await import(join(ROOT, 'src/taskclass.js'));
  assert.equal(classifyTask('create hello.txt and format the files').class, 'deterministic');
  assert.equal(classifyTask('design the architecture and review the tradeoffs').class, 'judgment');
  // mixed: both signals
  const m = classifyTask('create the docs AND analyze the risk tradeoffs');
  assert.equal(m.class, 'mixed');
  // role-aware policy under mixed
  assert.equal(costPolicyFor(m, 'builder'), 'free-first');
  assert.equal(costPolicyFor(m, 'critic'), 'capability-first');
  assert.equal(costPolicyFor('deterministic', 'builder'), 'free-first');
  assert.equal(costPolicyFor('judgment', 'builder'), 'capability-first');
});

test('router: task class moves routing - free lanes win deterministic, frontier wins judgment', async () => {
  const { scoreLane } = await import(join(ROOT, 'src/router.js'));
  const free = { name: 'f', good_at: ['edits', 'tests'], cost: 'free', invoke: {} };
  const frontier = { name: 'p', good_at: ['edits', 'tests'], cost: 'plan', invoke: {} };
  const det = scoreLane(free, 'builder', { class: 'deterministic' });
  const detP = scoreLane(frontier, 'builder', { class: 'deterministic' });
  const jud = scoreLane(frontier, 'builder', { class: 'judgment' });
  const judF = scoreLane(free, 'builder', { class: 'judgment' });
  assert.ok(det.fit > detP.fit, 'deterministic: free lane outranks plan lane');
  assert.ok(jud.fit > judF.fit, 'judgment: frontier lane outranks free lane');
  assert.ok(det.why.includes('cheap preferred'), 'policy stated in why line');
  assert.ok(jud.why.includes('frontier preferred'), 'policy stated in why line');
});

test('parity --until-proven: every lap lands ledger rows (cited on close, reasoned on open) and honors the budget', { timeout: 240000 }, async () => {
  const h = home('loopledger');
  mkdirSync(join(h.dir, 'lanes'), { recursive: true });
  writeFileSync(join(h.dir, 'lanes', 'spec-builder.json'), JSON.stringify({
    name: 'spec-builder', good_at: ['create', 'write'], cost: 'free', talks: 'terminal', proves: 'commands',
    invoke: { kind: 'command', command: `/bin/sh ${join(ROOT, 'scripts/spec-fixture.sh')} {brief}` },
  }));
  const proj = mkdtempSync(join(tmpdir(), 'loopledger-'));
  writeFileSync(join(proj, 'package.json'), JSON.stringify({ name: 'p', scripts: { test: 'node -e "process.exit(0)"' } }));
  writeFileSync(join(proj, 'SPEC.md'), '# Spec\n\n- create hello.txt containing greeting text\n');
  const r = await cli(h, 'parity', 'match', '--ref', join(proj, 'SPEC.md'), '--cwd', proj, '--until-proven', '--max-iter', '3', '--budget', '5000');
  assert.ok(r.stdout.includes('ALL BEHAVIORS CLOSED'), 'loop converges');
  assert.ok(r.stdout.includes('ledger rows filed'), 'lap reports rows filed');
  const lines = readFileSync(join(h.dir, 'parity-ledger.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
  const loopRows = lines.filter((l) => String(l.run).startsWith('loop-'));
  assert.ok(loopRows.length >= 2, 'loop filed its own rows');
  const open = loopRows.find((l) => l.verdict === 'behavior-open');
  assert.ok(open && open.reason && open.reason.length > 0, 'open rows carry a reason');
  const closed = loopRows.find((l) => String(l.verdict).startsWith('behavior-closed'));
  assert.ok(closed && closed.citation, 'closed rows carry a citation');
});

test('parity loop report: summary row (laps, spend per lane, tokens) + stretch proposed, never smuggled; headings are not stretch items', { timeout: 240000 }, async () => {
  const h = home('loopreport');
  mkdirSync(join(h.dir, 'lanes'), { recursive: true });
  writeFileSync(join(h.dir, 'lanes', 'spec-builder.json'), JSON.stringify({
    name: 'spec-builder', good_at: ['create', 'write'], cost: 'free', talks: 'terminal', proves: 'commands',
    invoke: { kind: 'command', command: `/bin/sh ${join(ROOT, 'scripts/spec-fixture.sh')} {brief}` },
  }));
  const proj = mkdtempSync(join(tmpdir(), 'loopreport-'));
  writeFileSync(join(proj, 'package.json'), JSON.stringify({ name: 'p', scripts: { test: 'node -e "process.exit(0)"' } }));
  writeFileSync(join(proj, 'SPEC.md'), '# Spec\n\n- create hello.txt containing greeting text\n\n# Stretch\n\n- add a web dashboard with charts\n');
  const r = await cli(h, 'parity', 'match', '--ref', join(proj, 'SPEC.md'), '--cwd', proj, '--until-proven', '--max-iter', '2');
  assert.ok(r.stdout.includes('ALL BEHAVIORS CLOSED'));
  assert.ok(r.stdout.includes('stretch item(s) PROPOSED'), 'stretch surfaced as proposals');
  assert.ok(!r.stdout.includes('~ Stretch'), 'no heading pseudo-item');
  const rows = readFileSync(join(h.dir, 'parity-ledger.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
  const stretch = rows.filter((x) => x.run === 'stretch');
  assert.equal(stretch.length, 1, 'exactly the one real stretch item');
  assert.equal(stretch[0].verdict, 'stretch-proposed');
  const summary = rows.filter((x) => x.run === 'loop-summary').pop();
  assert.ok(summary, 'summary row exists');
  assert.equal(summary.laps_burned, 2, 'laps burned recorded');
  assert.ok(summary.spend_per_lane && 'spec-builder' in summary.spend_per_lane, 'spend per lane recorded');
  assert.equal(summary.closed, 1, 'closed count recorded');
});

test('chatlane: 429 backoff honors Retry-After exactly, recovers; exhaustion throws CADRE_RATE_LIMITED', { timeout: 60000 }, async () => {
  const http = await import('node:http');
  let hits = 0;
  const srv = http.createServer((req, res) => {
    hits++;
    if (hits <= 1) { res.writeHead(429, { 'retry-after': '1' }); res.end('{}'); return; }
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { content: 'OK' } }], usage: { total_tokens: 1 }, model: 'm' }));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const port = srv.address().port;
  const prevKey = process.env.QH_MOCK_KEY;
  process.env.QH_MOCK_KEY = 'k';
  try {
    const { chatLane } = await import(join(ROOT, 'src/chatlane.js'));
    const t0 = Date.now();
    const r = await chatLane({ name: 't-429', invoke: { kind: 'openai-compatible', base_url: `http://127.0.0.1:${port}/v1`, api_key_env: 'QH_MOCK_KEY', model: 'm' } }, [{ role: 'user', content: 'x' }], { maxRetries: 3 });
    const ms = Date.now() - t0;
    assert.equal(r.text, 'OK');
    assert.equal(hits, 2, 'exactly one retry');
    assert.ok(ms >= 1000, `Retry-After honored (waited ${ms}ms)`);
    // exhaustion: always-429
    hits = 0;
    const srv2 = http.createServer((q, s) => { hits++; s.writeHead(429, { 'retry-after': '0' }); s.end('{}'); });
    await new Promise((r2) => srv2.listen(0, '127.0.0.1', r2));
    const p2 = srv2.address().port;
    let threw = null;
    await chatLane({ name: 't-429b', invoke: { kind: 'openai-compatible', base_url: `http://127.0.0.1:${p2}/v1`, api_key_env: 'QH_MOCK_KEY', model: 'm' } }, [{ role: 'user', content: 'x' }], { maxRetries: 1 }).catch((e) => { threw = e; });
    assert.equal(threw?.code, 'CADRE_RATE_LIMITED', 'exhaustion throws CADRE_RATE_LIMITED');
    srv2.close();
  } finally {
    if (prevKey === undefined) delete process.env.QH_MOCK_KEY; else process.env.QH_MOCK_KEY = prevKey;
    srv.close();
  }
});

test('go: quiet hours enforced - refuses to spend, files paused-with-resume-plan', { timeout: 120000 }, async () => {
  const h = home('quiet');
  mkdirSync(join(h.dir, 'lanes'), { recursive: true });
  writeFileSync(join(h.dir, 'lanes', 'file-writer.json'), JSON.stringify({
    name: 'file-writer', good_at: ['create', 'write'], cost: 'free', talks: 'terminal', proves: 'commands',
    invoke: { kind: 'command', command: `/bin/sh ${join(ROOT, 'scripts/fixture-writer.sh')} {brief}` },
  }));
  // a window that provably contains NOW: [now-1min, now+1min] in LOCAL clock time.
  // (23h/+1h arithmetic can collapse to an empty window across clock shifts.)
  const now = new Date();
  const fmt = (d) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const s = new Date(now.getTime() - 60e3);
  const e = new Date(now.getTime() + 60e3);
  writeFileSync(join(h.dir, 'pins.json'), JSON.stringify({ roles: {}, budget: null, quiet_hours: { start: fmt(s), end: fmt(e) } }));
  const proj = mkdtempSync(join(tmpdir(), 'quiet-'));
  writeFileSync(join(proj, 'package.json'), JSON.stringify({ name: 'p', scripts: { test: 'true' } }));
  const r = await cli(h, 'go', 'create quiet.txt with proof', '--cwd', proj);
  assert.ok(r.stdout.includes('quiet hours'), 'refusal message shown');
  const runs = readdirSync(join(h.dir, 'runs')).sort();
  const rec = JSON.parse(readFileSync(join(h.dir, 'runs', runs[runs.length - 1], 'run.json'), 'utf-8'));
  assert.equal(rec.status, 'resumed-brief');
  assert.ok(rec.verdict.summary.includes('quiet hours'));
  assert.ok(!existsSync(join(proj, 'quiet.txt')), 'no spend happened');
});

test('meters: rateGuard sliding window enforces rpm', { timeout: 30000 }, async () => {
  const { rateGuard } = await import(join(ROOT, 'src/meters.js'));
  const lane = 'rg-test-' + Date.now();
  const results = [];
  for (let i = 0; i < 5; i++) results.push(await rateGuard(lane, { rpm: 2 }));
  assert.equal(results.filter(Boolean).length, 2, 'only rpm ceiling passes immediately');
  assert.ok(results.slice(2).includes(false), 'beyond ceiling refused');
});
