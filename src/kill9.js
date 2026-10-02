// kill9 - spawn a real cadre go, kill -9 mid-loop, verify sweep finds it with a
// snapshot and files it to retired. The failure-mode e2e the PRD asks for (#9).
import { spawn } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

function home(name) {
  const dir = mkdtempSync(join(tmpdir(), `cadre-${name}-`));
  return { dir, env: { ...process.env, CADRE_HOME: dir } };
}

export async function runKill9Scenario(ROOT) {
  const h = home('kill9');
  // a builder lane that takes a while: sleep via a command-kind lane
  mkdirSync(join(h.dir, 'lanes'), { recursive: true });
  writeFileSync(join(h.dir, 'lanes', 'slow.json'), JSON.stringify({
    name: 'slow-builder', good_at: ['general'], cost: 'free', talks: 'terminal', proves: 'commands',
    invoke: { kind: 'command', command: "/bin/sh -c 'sleep 60 #'" },
  }));
  // a fake project so verify finds something
  mkdirSync(join(h.dir, 'proj'), { recursive: true });
  writeFileSync(join(h.dir, 'proj', 'package.json'), JSON.stringify({ name: 'p', scripts: { test: 'node -e "process.exit(0)"' } }));

  // pin builder to the slow lane so the loop is genuinely mid-build at kill time
  writeFileSync(join(h.dir, 'pins.json'), JSON.stringify({ roles: { builder: 'slow-builder' }, budget: null, quiet_hours: null }));
  const child = spawn('node', [join(ROOT, 'bin/cadre.js'), 'go', 'kill me mid loop'],
    { env: h.env, cwd: join(h.dir, 'proj'), stdio: 'ignore', detached: true });
  const pid = child.pid;
  child.unref();

  // give it time to create the run + acquire the lock, then SIGKILL
  await new Promise((r) => setTimeout(r, 2500));
  try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ } }
  await new Promise((r) => setTimeout(r, 500));

  // sweep must now find it and snapshot it
  const { stdout } = await run('node', [join(ROOT, 'bin/cadre.js'), 'sweep'], { env: h.env, cwd: ROOT, timeout: 30000 });
  const found = /leftover|snapshot|needing attention/.test(stdout);

  // retire it
  const ids = [...stdout.matchAll(/\b(\d{4})\b/g)].map((m) => m[1]);
  let retired = false;
  for (const id of [...new Set(ids)]) {
    try {
      const r2 = await run('node', [join(ROOT, 'bin/cadre.js'), 'sweep', '--retire', id], { env: h.env, cwd: ROOT, timeout: 30000 });
      if (/retired/.test(r2.stdout)) retired = true;
    } catch { /* not a run id */ }
  }

  const leftoverRuns = (await run('node', [join(ROOT, 'bin/cadre.js'), 'sweep'], { env: h.env, cwd: ROOT, timeout: 30000 })).stdout;
  return {
    ok: found && retired && /nothing rotting|all settled/.test(leftoverRuns),
    found, retired,
    detail: { sweepAfterRetire: leftoverRuns.split('\n').slice(0, 3).join(' | ') },
    homeDir: h.dir,
  };
}
