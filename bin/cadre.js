#!/usr/bin/env node
// Cadre — any model, any bot, one command.
// CLI skeleton: go / lanes / help are real; the rest are honest stubs.
import { cmdHelp } from '../src/commands/help.js';
import { cmdGo } from '../src/commands/go.js';
import { cmdLanes } from '../src/commands/lanes.js';

const STUBS = {
  parity: 'build to parity against a cited reference, unattended',
  plan: 'the spend planner — bench lanes before you build',
  meter: 'windows, quotas, rollover, resets',
  sweep: 'resume or retire the leftovers',
  map: 'the living codebase graph',
  watch: 'attach to a live run',
  proof: 'the evidence bundle',
  debate: 'two lanes argue, citations checked',
  pin: 'optional: pin roles, cap spend',
  mcp: 'run cadre inside your editor\'s chat',
};

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
    case 'go':
      return cmdGo(_, flags);
    case 'lanes':
      return cmdLanes(flags);
    case 'help':
    case '--help':
    case '-h':
      return cmdHelp();
    default: {
      if (STUBS[command]) {
        console.error(`cadre ${command} — ${STUBS[command]}`);
        console.error('not wired yet. The contract exists; the organ doesn\'t. Say the word.');
        return 2;
      }
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
