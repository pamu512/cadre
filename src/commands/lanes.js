// lanes — who's here, what they're good at, what they cost.
// Reads the live ax registry (ax lanes) and projects it onto the lane contract.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const AX = join(homedir(), '.local/bin/ax');

// ax lane -> contract projection (best-effort semantic mapping)
const AX_PROJECTION = {
  grok:     { good_at: ['planning', 'research'], cost: 'plan',    talks: 'terminal', proves: 'citations' },
  glm:      { good_at: ['reasoning', 'prose'],   cost: 'plan',    talks: 'terminal', proves: 'verdict' },
  hermes:   { good_at: ['backend', 'long-ctx'],  cost: 'plan',    talks: 'terminal', proves: 'diffs' },
  codex:    { good_at: ['edits', 'tests'],       cost: 'plan',    talks: 'terminal', proves: 'test-output' },
  cursor:   { good_at: ['ide-grade', 'non-ui'],  cost: 'plan',    talks: 'terminal', proves: 'diffs' },
  autoclaw: { good_at: ['ui', 'verify'],         cost: 'plan',    talks: 'http',     proves: 'artifacts' },
  grokbot:  { good_at: ['plans', 'gui'],         cost: 'plan',    talks: 'chat',     proves: 'verdict' },
};

export async function cmdLanes(flags) {
  const lanes = [];

  // 1. ax registry (live)
  if (existsSync(AX)) {
    try {
      const { stdout } = await run(AX, ['lanes'], { timeout: 15000 });
      for (const line of stdout.split('\n')) {
        const m = /^\s+(\w+)\s+(ok|busy|down|queued)\b/.exec(line);
        if (m) {
          const name = m[1];
          const proj = AX_PROJECTION[name] || { good_at: ['general'], cost: 'plan', talks: 'terminal', proves: 'verdict' };
          lanes.push({
            name: `ax-${name}`,
            good_at: proj.good_at,
            cost: proj.cost,
            talks: proj.talks,
            proves: proj.proves,
            invoke: { kind: 'ax', lane: name, status: m[2] },
          });
        }
      }
    } catch {
      console.error('cadre: ax lanes failed — continuing with local lanes only');
    }
  }

  // 2. ~/.cadre/lanes/*.json (user-declared lanes, validated against the contract)
  const dir = join(homedir(), '.cadre', 'lanes');
  if (existsSync(dir)) {
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const lane = JSON.parse(readFileSync(join(dir, f), 'utf-8'));
        const { validateLane } = await import('../contract.js');
        const v = validateLane(lane);
        if (v.valid) lanes.push(lane);
        else console.error(`cadre: skipping invalid lane ${f}: ${v.errors[0]}`);
      } catch (e) {
        console.error(`cadre: skipping unreadable lane ${f}: ${e.message}`);
      }
    }
  }

  if (flags.json) {
    console.log(JSON.stringify(lanes, null, 2));
    return 0;
  }

  if (lanes.length === 0) {
    console.log('no lanes found. ax not present and ~/.cadre/lanes/ is empty.');
    console.log('declare one: ~/.cadre/lanes/mine.json — see schemas/lane.schema.json');
    return 0;
  }

  const w = (s, n) => String(s).padEnd(n);
  console.log(`${w('LANE', 14)}${w('STATUS', 8)}${w('GOOD AT', 26)}${w('COST', 10)}${w('TALKS', 10)}PROVES`);
  for (const l of lanes) {
    const status = l.invoke?.status || 'ready';
    console.log(
      `${w(l.name, 14)}${w(status, 8)}${w(l.good_at.join(', '), 26)}${w(l.cost, 10)}${w(l.talks, 10)}${l.proves}`
    );
  }
  console.log(`\n${lanes.length} lane${lanes.length === 1 ? '' : 's'} · contract: schemas/lane.schema.json`);
  return 0;
}
