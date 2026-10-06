// Claims that have to be true as behavior: scope lock, skills, named hands,
// kernel confinement, map learning, meter reads, the MCP connect path.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import http from 'node:http';
import { mkdtempSync, writeFileSync, mkdirSync, readFileSync, existsSync, chmodSync, utimesSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const run = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const BIN = join(ROOT, 'bin/cadre.js');

function home(name) {
  const dir = mkdtempSync(join(tmpdir(), `cadre-${name}-`));
  return { dir, env: { ...process.env, CADRE_HOME: dir } };
}

test('scope lock: a file outside the manifest is rejected before PROVEN', async () => {
  const h = home('scope');
  const proj = mkdtempSync(join(tmpdir(), 'cadre-scope-'));
  writeFileSync(join(proj, 'package.json'), JSON.stringify({ name: 'scope', scripts: { test: 'node -e "process.exit(0)"' } }));
  mkdirSync(join(h.dir, 'lanes'), { recursive: true });
  const writer = join(h.dir, 'writer.sh');
  writeFileSync(writer, '#!/bin/sh\nprintf "yes\\n" > asked.txt\nprintf "no\\n" > extra.txt\nexit 0\n');
  chmodSync(writer, 0o755);
  writeFileSync(join(h.dir, 'lanes', 'file-writer.json'), JSON.stringify({
    name: 'file-writer', good_at: ['create', 'write', 'fixtures'], cost: 'free', talks: 'terminal', proves: 'commands',
    invoke: { kind: 'command', command: `/bin/sh ${writer}` },
  }));
  const r = await run('node', [BIN, 'go', 'create asked.txt containing the single line: yes', '--cwd', proj, '--scope', 'asked.txt'], {
    env: h.env, cwd: ROOT, timeout: 90000,
  }).then((x) => ({ rc: 0, stdout: x.stdout }), (e) => ({ rc: e.code ?? 1, stdout: e.stdout || '', stderr: e.stderr || '' }));
  assert.equal(existsSync(join(proj, 'extra.txt')), false);
  assert.equal(readFileSync(join(proj, 'asked.txt'), 'utf-8').trim(), 'yes');
  if (r.rc !== 0) {
    assert.ok(r.stdout.includes('gate asks why'), r.stdout);
    assert.ok(!r.stdout.includes('PROVEN'), r.stdout);
  }
  const runs = (await import('node:fs')).readdirSync(join(h.dir, 'runs'));
  const log = readFileSync(join(h.dir, 'runs', runs.sort().at(-1), 'run.log'), 'utf-8');
  assert.ok(log.includes('SCOPE re-read'), log.slice(-500));
  assert.ok(existsSync(join(proj, '.cadre', 'scope.json')));
});

test('skills are files: a same-named file in CADRE_HOME replaces the shipped one', async () => {
  const h = home('skills');
  const prev = process.env.CADRE_HOME;
  process.env.CADRE_HOME = h.dir;
  try {
    mkdirSync(join(h.dir, 'skills'), { recursive: true });
    writeFileSync(join(h.dir, 'skills', 'read-before-reacting.md'), '# read-before-reacting\n\nUNIQUE-SKILL-SENTENCE\n');
    const { loadSkills } = await import(join(ROOT, 'src/skills.js'));
    const skills = loadSkills();
    const names = skills.map((s) => s.name);
    assert.ok(names.includes('read-before-reacting'));
    assert.ok(names.includes('restate-the-ask'));
    assert.ok(names.includes('verify-before-claiming'));
    const overridden = skills.find((s) => s.name === 'read-before-reacting');
    assert.ok(overridden.text.includes('UNIQUE-SKILL-SENTENCE'));
    assert.ok(overridden.path.startsWith(h.dir));
  } finally {
    if (prev) process.env.CADRE_HOME = prev; else delete process.env.CADRE_HOME;
  }
});

test('named hands sol and terra are on the roster and persist as files', async () => {
  const h = home('hands');
  const prev = process.env.CADRE_HOME;
  process.env.CADRE_HOME = h.dir;
  try {
    const { buildRoster } = await import(join(ROOT, 'src/scan.js'));
    const roster = await buildRoster();
    const sol = roster.lanes.find((l) => l.name === 'sol');
    const terra = roster.lanes.find((l) => l.name === 'terra');
    assert.ok(sol, 'sol is a lane');
    assert.equal(sol.identity, 'sol builds');
    assert.equal(sol.invoke.kind, 'hand');
    assert.equal(sol.invoke.persists, true);
    assert.ok(terra, 'terra is a lane');
    assert.equal(terra.identity, 'terra reviews');
    assert.ok(existsSync(join(ROOT, 'hands', 'sol.json')));
    assert.ok(existsSync(join(ROOT, 'skills', sol.invoke.skill + '.md')));
  } finally {
    if (prev) process.env.CADRE_HOME = prev; else delete process.env.CADRE_HOME;
  }
});

test('one flag overrides a role', async () => {
  const { assignRoles } = await import(join(ROOT, 'src/router.js'));
  const roster = { lanes: [
    { name: 'sol', good_at: ['scaffold'], cost: 'plan', invoke: { kind: 'hand' } },
    { name: 'other', good_at: ['edits', 'tests', 'scaffold'], cost: 'free', invoke: { kind: 'command' } },
  ] };
  const routed = assignRoles(roster, { brief: 'scaffold the module', roleOverride: 'builder=sol' });
  const builder = routed.assignments.find((a) => a.role === 'builder');
  assert.equal(builder.lane, 'sol');
  assert.equal(builder.why, 'explicit override');
});

test('kernel confinement: a write outside the allow root does not land', async () => {
  if (process.platform !== 'darwin') return;
  const { runConfined } = await import(join(ROOT, 'src/sandbox.js'));
  const allow = mkdtempSync(join(tmpdir(), 'cadre-allow-'));
  const deny = mkdtempSync(join(tmpdir(), 'cadre-deny-'));
  const inside = await runConfined(process.execPath, ['-e', 'require("fs").writeFileSync(process.argv[1], "ok")', join(allow, 'a.txt')], { allow: [allow] });
  const outside = await runConfined(process.execPath, ['-e', 'require("fs").writeFileSync(process.argv[1], "no")', join(deny, 'b.txt')], { allow: [allow] });
  assert.equal(inside.ok, true);
  assert.equal(inside.kernel, true);
  assert.equal(existsSync(join(allow, 'a.txt')), true);
  assert.equal(outside.ok, false);
  assert.equal(outside.kernel, true);
  assert.equal(existsSync(join(deny, 'b.txt')), false);
});

test('frugal pipes keep diff hunks and drop a file dump', async () => {
  const { forContext } = await import(join(ROOT, 'src/frugal.js'));
  const dump = 'x'.repeat(400);
  const text = `diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js\n@@ -1 +1 @@\n-old\n+new\n${dump}\n`;
  const out = forContext(text);
  assert.ok(out.text.includes('+new'));
  assert.ok(!out.text.includes(dump));
  assert.ok(out.compressedBytes <= out.originalBytes);
});

test('the map learns which files a passing run touched', async () => {
  const h = home('map');
  const prev = process.env.CADRE_HOME;
  process.env.CADRE_HOME = h.dir;
  const root = mkdtempSync(join(tmpdir(), 'cadre-map-'));
  try {
    const { learnFromRun, loadMap } = await import(join(ROOT, 'src/map.js'));
    learnFromRun(root, { files: ['src/a.js'], passed: false });
    learnFromRun(root, { files: ['src/a.js'], passed: true });
    learnFromRun(root, { files: ['src/b.js'], passed: false });
    const map = loadMap(root);
    assert.equal(map.hotZones[0].path, 'src/a.js');
    assert.equal(map.hotZones[0].learned, true);
    assert.equal(map.outcomes.length, 3);
  } finally {
    if (prev) process.env.CADRE_HOME = prev; else delete process.env.CADRE_HOME;
  }
});

test('meter reads stay on loopback, send no credentials, and hit the ledger', async () => {
  const h = home('meter');
  const prev = process.env.CADRE_HOME;
  process.env.CADRE_HOME = h.dir;
  const server = http.createServer((req, res) => {
    res.setHeader('x-got-auth', req.headers.authorization ? 'yes' : 'no');
    res.end(JSON.stringify({ remaining: 7 }));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const { readLocalMeter } = await import(join(ROOT, 'src/meters.js'));
    const port = server.address().port;
    const refused = await readLocalMeter('https://example.com/usage');
    assert.equal(refused.ok, false);
    assert.match(refused.error, /loopback/);
    const read = await readLocalMeter(`http://127.0.0.1:${port}/usage`);
    assert.equal(read.ok, true);
    assert.equal(read.auth, false);
    assert.equal(read.body.remaining, 7);
    const ledger = readFileSync(join(h.dir, 'audit.log'), 'utf-8');
    assert.ok(ledger.includes('"kind":"meter-read"'));
    assert.ok(ledger.includes('"auth":false'));
    assert.ok(!ledger.includes('authorization'));
  } finally {
    server.close();
    if (prev) process.env.CADRE_HOME = prev; else delete process.env.CADRE_HOME;
  }
});

test('a degrading preference is set aside unless the override is explicit', async () => {
  const h = home('prefs');
  const prev = process.env.CADRE_HOME;
  process.env.CADRE_HOME = h.dir;
  try {
    const { recordOutcome, judgeRole } = await import(join(ROOT, 'src/preferences.js'));
    const { assignRoles } = await import(join(ROOT, 'src/router.js'));
    for (let i = 0; i < 3; i++) recordOutcome({ role: 'builder', lane: 'sol', source: 'explicit', passed: false, creep: true });
    recordOutcome({ role: 'builder', lane: 'file-writer', source: 'fit', passed: true });
    recordOutcome({ role: 'builder', lane: 'file-writer', source: 'fit', passed: true });
    const judgment = judgeRole('builder', 'sol');
    assert.equal(judgment.degrading, true);
    const roster = { lanes: [
      { name: 'sol', good_at: ['scaffold'], cost: 'plan', invoke: { kind: 'hand', bin: '/bin/echo' } },
      { name: 'file-writer', good_at: ['create', 'write'], cost: 'free', invoke: { kind: 'command', command: 'echo' } },
    ] };
    const held = assignRoles(roster, { brief: 'create the file', roleOverride: 'builder=sol' });
    assert.equal(held.assignments.find((a) => a.role === 'builder').lane, 'sol');
    assert.ok(held.assignments.alerts.some((a) => a.includes('explicit')));
    const corrected = assignRoles(roster, { brief: 'create the file' });
    assert.equal(corrected.assignments.find((a) => a.role === 'builder').lane, 'file-writer');
    assert.ok(corrected.assignments.alerts.some((a) => a.includes('degrading')));
  } finally {
    if (prev) process.env.CADRE_HOME = prev; else delete process.env.CADRE_HOME;
  }
});

test('an out-of-lock file is removed, and a named reason keeps it', async () => {
  const { settleCreep } = await import(join(ROOT, 'src/scope.js'));
  const cwd = mkdtempSync(join(tmpdir(), 'cadre-revert-'));
  writeFileSync(join(cwd, 'kept.txt'), 'old');
  writeFileSync(join(cwd, 'extra.txt'), 'no');
  const prior = new Set(['kept.txt']);
  const rejected = settleCreep({ creep: ['extra.txt', 'kept.txt'], why: '', cwd, prior });
  assert.equal(existsSync(join(cwd, 'extra.txt')), false);
  assert.equal(existsSync(join(cwd, 'kept.txt')), true);
  assert.ok(rejected.reverted.some((r) => r.file === 'extra.txt' && r.result === 'removed'));
  writeFileSync(join(cwd, 'extra.txt'), 'again');
  const allowed = settleCreep({ creep: ['extra.txt'], why: 'extra.txt is the fixture the brief forgot', cwd, prior });
  assert.equal(allowed.action, 'allow');
  assert.equal(existsSync(join(cwd, 'extra.txt')), true);
});

test('a covered lane beats a metered lane of equal fit', async () => {
  const h = home('covered');
  const prev = process.env.CADRE_HOME;
  process.env.CADRE_HOME = h.dir;
  const { assignRoles } = await import(join(ROOT, 'src/router.js'));
  const roster = { lanes: [
    { name: 'metered-one', good_at: ['edits'], cost: 'metered', invoke: { kind: 'command', command: 'true' } },
    { name: 'plan-one', good_at: ['edits'], cost: 'plan', invoke: { kind: 'command', command: 'true' } },
  ] };
  const same = assignRoles(roster, { brief: 'edit the module' });
  assert.equal(same.assignments.find((a) => a.role === 'builder').lane, 'plan-one');
  const wider = assignRoles({ lanes: [
    { name: 'metered-one', good_at: ['edits', 'tests', 'scaffold'], cost: 'metered', invoke: { kind: 'command' } },
    { name: 'plan-one', good_at: ['edits'], cost: 'plan', invoke: { kind: 'command' } },
  ] }, { brief: 'edit the module' });
  assert.equal(wider.assignments.find((a) => a.role === 'builder').lane, 'metered-one');
  if (prev) process.env.CADRE_HOME = prev; else delete process.env.CADRE_HOME;
});

test('a passing habit becomes the builder, then yields when another lane passes more often', async () => {
  const h = home('habit');
  const prev = process.env.CADRE_HOME;
  process.env.CADRE_HOME = h.dir;
  try {
    const { recordOutcome, choiceFor } = await import(join(ROOT, 'src/preferences.js'));
    const { assignRoles } = await import(join(ROOT, 'src/router.js'));
    const equal = { lanes: [
      { name: 'habit-ace', good_at: ['scaffold'], cost: 'plan', invoke: { kind: 'command', command: 'true' } },
      { name: 'habit-pen', good_at: ['scaffold'], cost: 'free', invoke: { kind: 'command', command: 'true' } },
    ] };
    const wider = { lanes: [
      { name: 'habit-ace', good_at: ['edits', 'tests', 'scaffold', 'create', 'write'], cost: 'plan', invoke: { kind: 'command', command: 'true' } },
      { name: 'habit-pen', good_at: ['scaffold'], cost: 'free', invoke: { kind: 'command', command: 'true' } },
    ] };
    for (let i = 0; i < 3; i++) recordOutcome({ role: 'builder', lane: 'habit-pen', source: 'fit', passed: true });
    assert.equal(choiceFor('builder').source, 'habit');
    const beaten = assignRoles(wider, { brief: 'create the module' });
    assert.equal(beaten.assignments.find((a) => a.role === 'builder').lane, 'habit-ace');
    const held = assignRoles(equal, { brief: 'create the module' });
    assert.equal(held.assignments.find((a) => a.role === 'builder').lane, 'habit-pen');
    assert.match(held.assignments.find((a) => a.role === 'builder').why, /your habit/);
    recordOutcome({ role: 'builder', lane: 'habit-pen', source: 'fit', passed: true });
    const explored = assignRoles(equal, { brief: 'create the module' });
    assert.equal(explored.assignments.find((a) => a.role === 'builder').lane, 'habit-ace');
    assert.ok(explored.assignments.alerts.some((a) => a.includes('exploring past habit-pen')));
    recordOutcome({ role: 'builder', lane: 'habit-ace', source: 'fit', passed: true });
    recordOutcome({ role: 'builder', lane: 'habit-ace', source: 'fit', passed: true });
    recordOutcome({ role: 'builder', lane: 'habit-ace', source: 'fit', passed: false });
    assert.equal(choiceFor('builder').lane, 'habit-pen');
    recordOutcome({ role: 'builder', lane: 'habit-pen', source: 'fit', passed: false });
    recordOutcome({ role: 'builder', lane: 'habit-ace', source: 'fit', passed: true });
    recordOutcome({ role: 'builder', lane: 'habit-ace', source: 'fit', passed: true });
    recordOutcome({ role: 'builder', lane: 'habit-ace', source: 'fit', passed: true });
    assert.equal(choiceFor('builder').lane, 'habit-ace');
    assert.equal(choiceFor('builder').from, 'habit-pen');
    const evolved = assignRoles(wider, { brief: 'create the module' });
    assert.equal(evolved.assignments.find((a) => a.role === 'builder').lane, 'habit-ace');
    assert.ok(evolved.assignments.alerts.some((a) => a.includes('evolved habit-pen → habit-ace')));
  } finally {
    if (prev) process.env.CADRE_HOME = prev; else delete process.env.CADRE_HOME;
  }
});

test('a degrading scope is dropped for the healthier habit unless override is explicit', async () => {
  const h = home('scope-habit');
  const prev = process.env.CADRE_HOME;
  process.env.CADRE_HOME = h.dir;
  try {
    const { recordChoice, resolveHabit } = await import(join(ROOT, 'src/preferences.js'));
    for (let i = 0; i < 3; i++) recordChoice('scope', 'src', { passed: true });
    for (let i = 0; i < 3; i++) recordChoice('scope', '**', { passed: false });
    const dropped = resolveHabit('scope', '**');
    assert.equal(dropped.value, 'src');
    assert.match(dropped.note, /degrading the pipeline/);
    assert.match(dropped.note, /correction · scope src/);
    const kept = resolveHabit('scope', '**', { override: true });
    assert.equal(kept.value, '**');
    assert.match(kept.note, /explicit --override/);
    const applied = resolveHabit('scope', null);
    assert.equal(applied.value, 'src');
    assert.match(applied.note, /from habit/);
  } finally {
    if (prev) process.env.CADRE_HOME = prev; else delete process.env.CADRE_HOME;
  }
});

test('a running app with a CLI twin is talkable; an offline one stays presence', async () => {
  const { bindAppTwins } = await import(join(ROOT, 'src/scan.js'));
  const clis = [{ name: 'cli-claude', invoke: { kind: 'cli', bin: 'claude', path: '/usr/bin/claude' } }];
  const online = bindAppTwins([{ name: 'app-claude', invoke: { kind: 'app', bundle: 'Claude.app', status: 'ok' } }], clis);
  assert.equal(online[0].invoke.kind, 'agent');
  assert.equal(online[0].invoke.path, '/usr/bin/claude');
  const offline = bindAppTwins([{ name: 'app-claude', invoke: { kind: 'app', bundle: 'Claude.app', status: 'ready' } }], clis);
  assert.equal(offline[0].invoke.kind, 'app');
  const prefix = bindAppTwins(
    [{ name: 'app-claude', invoke: { kind: 'app', bundle: 'Claude.app', status: 'ok' } }],
    [{ name: 'cli-claude-code', invoke: { kind: 'cli', bin: 'claude-code', path: '/usr/bin/claude-code' } }],
  );
  assert.equal(prefix[0].invoke.kind, 'app');
  const dashed = bindAppTwins(
    [{ name: 'app-claude', invoke: { kind: 'app', bundle: 'Claude.app', status: 'ok' } }],
    [{ name: 'cli-claude-agent', invoke: { kind: 'cli', bin: 'claude-agent', path: '/usr/bin/claude-agent' } }],
  );
  assert.equal(dashed[0].invoke.kind, 'agent');
});

test('mcp exposes twelve tools and the connect config is five lines', async () => {
  const { MCP_CONFIG } = await import(join(ROOT, 'src/commands/mcp.js'));
  assert.equal(MCP_CONFIG.split('\n').length, 5);
  assert.ok(MCP_CONFIG.includes('"command": "cadre"'));
  const h = home('mcp12');
  const replies = await new Promise((resolve, reject) => {
    const p = spawn('node', [BIN, 'mcp'], { stdio: ['pipe', 'pipe', 'pipe'], env: h.env });
    let buf = '';
    const out = [];
    p.stdout.on('data', (d) => {
      buf += d;
      let n;
      while ((n = buf.indexOf('\n')) > -1) {
        const line = buf.slice(0, n).trim();
        buf = buf.slice(n + 1);
        if (line) out.push(JSON.parse(line));
      }
    });
    p.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
    p.stdin.end();
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error('mcp ' + code))));
  });
  const tools = replies.find((m) => m.id === 1).result.tools.map((t) => t.name);
  assert.equal(tools.length, 12);
  for (const name of ['cadre_parity', 'cadre_debate', 'cadre_doctor', 'cadre_go', 'cadre_sweep']) {
    assert.ok(tools.includes(name), name);
  }
});

test('skills check the effect, and a repeated correction becomes a skill file', async () => {
  const h = home('skills-effect');
  const prev = process.env.CADRE_HOME;
  process.env.CADRE_HOME = h.dir;
  try {
    const { checkSkills } = await import(join(ROOT, 'src/skillcheck.js'));
    const { noteCorrection, loadSkills } = await import(join(ROOT, 'src/skills.js'));
    const log = 'RESTATE: create the widget\nMAP\n';
    const missed = checkSkills(log, {
      gatePassed: true,
      mapFiles: ['src/a.js'],
      indexedFiles: ['src/a.js', 'src/b.js'],
      diffFiles: ['src/b.js'],
      brief: 'create the widget module',
      laneOutput: 'done',
      laneKind: 'command',
      reverified: true,
    });
    assert.ok(missed.missing.includes('read-before-reacting'));
    const fresh = checkSkills(log, {
      gatePassed: true,
      mapFiles: ['src/a.js'],
      indexedFiles: ['src/a.js'],
      diffFiles: ['new.txt'],
      brief: 'create the widget module',
      laneOutput: 'I created the widget module',
      laneKind: 'agent',
      reverified: true,
    });
    assert.equal(fresh.ok, true);
    const silent = checkSkills(log, {
      gatePassed: true,
      mapFiles: [],
      indexedFiles: [],
      diffFiles: ['new.txt'],
      brief: 'create the widget module',
      laneOutput: 'done',
      laneKind: 'agent',
      reverified: false,
    });
    assert.ok(silent.missing.includes('restate-the-ask'));
    assert.ok(silent.missing.includes('verify-before-claiming'));
    const words = 'keep the lock named in the brief';
    assert.equal(noteCorrection(words), null);
    assert.equal(noteCorrection(words), null);
    const written = noteCorrection(words);
    assert.ok(written && existsSync(written));
    assert.ok(loadSkills().some((s) => s.text.includes(words)));
    assert.equal(noteCorrection(words), written);
  } finally {
    if (prev) process.env.CADRE_HOME = prev; else delete process.env.CADRE_HOME;
  }
});

test('hand memory keeps the runs whose files overlap the task', async () => {
  const h = home('hands');
  const prev = process.env.CADRE_HOME;
  process.env.CADRE_HOME = h.dir;
  try {
    const { rememberHandOutcome, handPrompt } = await import(join(ROOT, 'src/invoke.js'));
    const lane = { name: 'sol', invoke: { kind: 'hand' } };
    rememberHandOutcome(lane, { files: ['other.js'], passed: true, critique: 'clean other', task: 'touch other.js' });
    rememberHandOutcome(lane, { files: ['asked.txt'], passed: false, critique: 'asked.txt failed the gate', task: 'create asked.txt' });
    const prompt = handPrompt(lane, 'create asked.txt again');
    assert.match(prompt, /asked\.txt failed the gate/);
    assert.ok(!prompt.includes('clean other'));
  } finally {
    if (prev) process.env.CADRE_HOME = prev; else delete process.env.CADRE_HOME;
  }
});

test('invoke: slack is not a driver anymore - honest refusal, two drivers only', async () => {
  const { invokeLane } = await import(join(ROOT, 'src/invoke.js'));
  const res = await invokeLane(
    { name: 'slack-team', invoke: { kind: 'slack', env: 'CADRE_SLACK_WEBHOOK' } },
    'please look',
    { runId: '0007' },
  );
  assert.equal(res.ok, false);
  assert.ok(res.error.includes('no driver for invoke.kind=slack'));
  assert.ok(res.error.includes('command argv') && res.error.includes('chat POST'));
});

test('a newer source file rebuilds a warm map, and a failed file is named in the slice', async () => {
  const h = home('map');
  const prev = process.env.CADRE_HOME;
  process.env.CADRE_HOME = h.dir;
  const root = mkdtempSync(join(tmpdir(), 'cadre-map-'));
  try {
    const { ensureMap, loadMap, sliceFor, learnFromRun } = await import(join(ROOT, 'src/map.js'));
    const file = join(root, 'lib.js');
    writeFileSync(file, 'export function greet() { return 1; }\n');
    ensureMap(root);
    const bumped = new Date(Date.now() + 5000);
    writeFileSync(file, 'export function greet() { return 1; }\nexport function extra() { return 2; }\n');
    utimesSync(file, bumped, bumped);
    const rebuilt = ensureMap(root);
    assert.ok(rebuilt.bySymbol.some((s) => s.name === 'extra'));
    learnFromRun(root, { files: ['lib.js'], passed: false });
    const slice = sliceFor(loadMap(root), { brief: 'fix lib.js' });
    assert.match(slice, /failed: lib\.js/);
    assert.match(slice, /symbol extra in lib\.js/);
  } finally {
    if (prev) process.env.CADRE_HOME = prev; else delete process.env.CADRE_HOME;
  }
});

test('cli-usage.json is added to the meter with no network', async () => {
  const h = home('cli-usage');
  const prev = process.env.CADRE_HOME;
  process.env.CADRE_HOME = h.dir;
  try {
    writeFileSync(join(h.dir, 'cli-usage.json'), JSON.stringify({ lanes: { claude: { tokens: 42 } } }));
    const { usageFromAudit } = await import(join(ROOT, 'src/meters.js'));
    const usage = usageFromAudit();
    assert.equal(usage.get('claude').tokens, 42);
  } finally {
    if (prev) process.env.CADRE_HOME = prev; else delete process.env.CADRE_HOME;
  }
});

test('quiet hours are inferred from a week of daytime proven runs', async () => {
  const { inferQuietHours } = await import(join(ROOT, 'src/preferences.js'));
  const day = (n, hour = 12) => new Date(2026, 0, n, hour, 0, 0).toISOString();
  assert.equal(inferQuietHours([
    { verdict: { passed: true }, started: day(1) },
    { verdict: { passed: true }, started: day(3) },
  ]), null);
  const week = inferQuietHours([
    { verdict: { passed: true }, started: day(1) },
    { verdict: { passed: true }, started: day(10) },
  ]);
  assert.deepEqual(week, { start: '23:00', end: '07:00' });
  assert.equal(inferQuietHours([
    { verdict: { passed: true }, started: day(1) },
    { verdict: { passed: true }, started: day(10, 1) },
  ]), null);
});

// provenance + forgetting: hand ledger claims link to runs, retraction
// removes them from memory and derived cards, evidence is traceable.
test('hand memory claims carry run provenance and can be retracted', async () => {
  const h = home('hands-memory-prov');
  const prev = process.env.CADRE_HOME;
  process.env.CADRE_HOME = h.dir;
  try {
    const { rememberHandOutcome, handPrompt, retractHandRun } = await import(join(ROOT, 'src/invoke.js'));
    const { deriveHandCards, explainClaim } = await import(join(ROOT, 'src/derive.js'));
    const lane = { name: 'sol', invoke: { kind: 'hand' } };
    rememberHandOutcome(lane, { files: ['a.js'], passed: true, critique: 'gate passed', task: 'fix a.js', run: 'r-0001', evidence: ['runs/r-0001/proof.json'] });
    rememberHandOutcome(lane, { files: ['b.js'], passed: true, critique: 'gate passed', task: 'fix b.js', run: 'r-0002', evidence: ['runs/r-0002/proof.json'] });
    // derived card counts both, cites both runs
    deriveHandCards();
    let card = readFileSync(join(h.dir, 'hands-memory', 'derived', 'sol.md'), 'utf-8');
    assert.match(card, /passed: 2/);
    assert.match(card, /r-0001/);
    assert.match(card, /r-0002/);
    // claim is explainable: verdict -> run -> evidence
    const lines = readFileSync(join(h.dir, 'hands-memory', 'sol.jsonl'), 'utf-8').trim().split('\n').map((l) => JSON.parse(l));
    const first = explainClaim('sol', lines[0].at);
    assert.equal(first.run, 'r-0001');
    assert.ok(first.evidence[0].includes('r-0001'));
    // forget run r-0001: its claim stops counting, card regenerates
    const retracted = retractHandRun('r-0001');
    assert.equal(retracted.length, 1);
    const mem = handPrompt(lane, 'fix a.js again').split('\n\nfix a.js again')[0]; // memory section only
    assert.ok(!mem.includes('fix a.js')); // the retracted claim is not recalled
    deriveHandCards();
    card = readFileSync(join(h.dir, 'hands-memory', 'derived', 'sol.md'), 'utf-8');
    assert.match(card, /passed: 1/);
    assert.doesNotMatch(card, /r-0001\b(?!\/)/); // run id gone from provenance list
    // ledger stays append-only: the retracted line is still on disk
    const kept = readFileSync(join(h.dir, 'hands-memory', 'sol.jsonl'), 'utf-8').trim().split('\n');
    assert.equal(kept.length, 2);
    assert.equal(JSON.parse(kept[0]).retracted, true);
  } finally {
    if (prev) process.env.CADRE_HOME = prev; else delete process.env.CADRE_HOME;
  }
});
