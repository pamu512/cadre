#!/usr/bin/env node
// Cadre — any model, any bot, one command.
import { cmdHelp } from '../src/commands/help.js';
import { cmdGo } from '../src/commands/go.js';
import { cmdLanes } from '../src/commands/lanes.js';
import { cmdParity } from '../src/commands/parity.js';
import { cmdPlan } from '../src/commands/plan.js';
import { cmdMeter } from '../src/commands/meter.js';
import { cmdSweep } from '../src/commands/sweep.js';
import { cmdMap } from '../src/commands/map.js';
import { cmdWatch } from '../src/commands/watch.js';
import { cmdProof } from '../src/commands/proof.js';
import { cmdDebate } from '../src/commands/debate.js';
import { cmdPin } from '../src/commands/pin.js';
import { cmdMcp } from '../src/commands/mcp.js';

function parseArgv(argv) {
  const _ = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > -1) flags[a.slice(2, eq)] = a.slice(eq + 1);
      else flags[a.slice(2)] = true;
    } else {
      _.push(a);
    }
  }
  return { _, flags };
}

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) return cmdHelp();
  const [command, ...rest] = argv;
  const { _, flags } = parseArgv(rest);

  switch (command) {
    case 'go': return cmdGo(_, flags);
    case 'lanes': return cmdLanes(flags);
    case 'help':
    case '--help':
    case '-h': return cmdHelp();
    case 'parity': return cmdParity(_, flags);
    case 'plan': return cmdPlan(_, flags);
    case 'meter': return cmdMeter(_, flags);
    case 'sweep': return cmdSweep(_, flags);
    case 'map': return cmdMap(_, flags);
    case 'watch': return cmdWatch(_, flags);
    case 'proof': return cmdProof(_, flags);
    case 'debate': return cmdDebate(_, flags);
    case 'pin': return cmdPin(_, flags);
    case 'mcp': return cmdMcp(_, flags);
    default: {
      console.error(`unknown command: ${command}\n`);
      cmdHelp();
      return 1;
    }
  }
}

main()
  .then((code) => process.exit(typeof code === 'number' ? code : 0))
  .catch((err) => {
    console.error('cadre:', err.message);
    process.exit(1);
  });
