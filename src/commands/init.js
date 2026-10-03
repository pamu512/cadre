// init - scaffold $CADRE_HOME for a cold machine: lanes dir, one commented
// example lane, meters stub next-step hint. Idempotent - never overwrites.
import { mkdirSync, existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { home } from '../store.js';

const EXAMPLE_LANE = `{
  // A lane is any worker: a CLI, an API, a person. This one runs a shell
  // command with {brief} substituted. Rename the file to activate, edit, and
  // run: cadre lanes  (then cadre plan "..." to see it routed)
  "name": "my-first-lane",
  "good_at": ["general"],
  "cost": "free",
  "talks": "terminal",
  "proves": "commands",
  "invoke": { "kind": "command", "command": "echo", "note": "replace echo with your tool; {brief} is the task" }
}
`;

export async function cmdInit(args, flags) {
  const h = home();
  const lanesDir = join(h, 'lanes');
  const created = [];
  const existed = [];

  if (!existsSync(lanesDir)) {
    mkdirSync(lanesDir, { recursive: true });
    created.push(lanesDir);
  } else existed.push(lanesDir);

  const example = join(lanesDir, 'my-first-lane.json');
  if (!existsSync(example)) {
    // strip comments for valid JSON on disk (comments are for the docs below)
    writeFileSync(example, JSON.stringify({
      name: 'my-first-lane', good_at: ['general'], cost: 'free', talks: 'terminal', proves: 'commands',
      invoke: { kind: 'command', command: 'echo', example: true, note: 'replace echo with your tool; {brief} is the task. example:true keeps this off the roster' },
    }, null, 2) + '\n');
    created.push(example);
  } else existed.push(example);

  mkdirSync(join(h, 'runs'), { recursive: true });

  console.log(`cadre init - ${h}`);
  for (const c of created) console.log(`  created  ${c}`);
  for (const e of existed) console.log(`  exists   ${e} (left untouched)`);
  console.log('\nnext steps:');
  console.log('  1. cadre lanes            # the roster is already whatever is on this machine');
  console.log('  2. optional: a command template in ~/.cadre/lanes/*.json (the example file is not on the roster)');
  console.log('  3. cadre plan "<task>"    # see routing before spending');
  console.log('  4. cadre go "<outcome>"   # run the loop, gated on evidence');
  return 0;
}
