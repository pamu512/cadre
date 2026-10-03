// doctor - one-command preflight for a cold machine: checks Node, ax, lanes,
// env keys, and prints ONE fix line per problem. Exit 0 = healthy, 1 = problems
// found (with fixes), 2 = usage error. No README needed to get running.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { buildRoster } from '../scan.js';
import { chatLaneAvailable } from '../chatlane.js';

const run = promisify(execFile);

export async function cmdDoctor(args, flags) {
  const problems = [];
  const oks = [];

  // Node version
  const [major] = process.versions.node.split('.').map(Number);
  if (major >= 18) oks.push(`node ${process.versions.node}`);
  else problems.push({ what: `node ${process.versions.node} (< 18)`, fix: 'install Node 18+: https://nodejs.org' });

  // ax (optional but powers the ax lanes)
  const axPath = process.env.CADRE_AX || join(homedir(), '.local/bin/ax');
  if (existsSync(axPath)) oks.push(`ax at ${axPath}`);
  else problems.push({ what: 'ax not found', fix: 'ax lanes are optional; to enable, install ax or set CADRE_AX. The standalone loop works without it.' });

  // roster
  let roster;
  try {
    roster = await buildRoster();
    oks.push(`${roster.lanes.length} lane(s) on this machine (${roster.platform})`);
    if (roster.lanes.length === 0) {
      problems.push({ what: 'no lanes detected', fix: 'the scan found nothing on this machine (no PATH clis, apps, models, keys, or MCP configs)' });
    }
  } catch (e) {
    problems.push({ what: `roster scan failed: ${e.message.split('\n')[0]}`, fix: 're-run cadre lanes; the roster is the machine scan' });
  }

  // keyed chat lanes
  const keyed = (roster?.lanes || []).filter(chatLaneAvailable);
  if (keyed.length) oks.push(`keyed chat lanes: ${keyed.map((l) => l.name).join(', ')}`);
  else oks.push('no keyed chat lanes (optional - drafting/judging skip cleanly without one)');

  // test command detectable in cwd
  if (existsSync('package.json') || existsSync('Makefile') || existsSync('Cargo.toml') || existsSync('pyproject.toml')) {
    oks.push('project test command detectable in cwd');
  } else {
    problems.push({ what: 'no test command detected in cwd', fix: 'run cadre from a project root (package.json/Makefile/Cargo.toml/pyproject.toml) so verify has something to run' });
  }

  // state dir writable
  const { home } = await import('../store.js');
  try {
    const { mkdirSync } = await import('node:fs');
    mkdirSync(join(home(), 'runs'), { recursive: true });
    oks.push(`state dir writable: ${home()}`);
  } catch (e) {
    problems.push({ what: `state dir not writable: ${home()}`, fix: 'fix permissions or set CADRE_HOME to a writable path' });
  }

  console.log('cadre doctor');
  for (const o of oks) console.log(`  ✓ ${o}`);
  if (problems.length) {
    console.log(`\n${problems.length} problem(s):`);
    for (const p of problems) console.log(`  ✗ ${p.what}\n    fix: ${p.fix}`);
    if (flags.json) console.log(JSON.stringify({ oks, problems }, null, 2));
    return 1;
  }
  console.log('\nhealthy - cadre go "<outcome>" to run');
  if (flags.json) console.log(JSON.stringify({ oks, problems }, null, 2));
  return 0;
}
