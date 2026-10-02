#!/usr/bin/env node
// Cadre - any model, any bot, one command.
import { cmdHelp } from '../src/commands/help.js';
import { cmdGo } from '../src/commands/go.js';
import { resolve } from 'node:path';
import { cmdLanes } from '../src/commands/lanes.js';
import { cmdParity } from '../src/commands/parity.js';
import { cmdPlan } from '../src/commands/plan.js';
import { cmdMeter } from '../src/commands/meter.js';
import { cmdSweep } from '../src/commands/sweep.js';
import { cmdMap } from '../src/commands/map.js';
import { cmdWatch } from '../src/commands/watch.js';
import { cmdProof } from '../src/commands/proof.js';
import { cmdMetrics } from '../src/commands/metrics.js';
import { cmdApproach } from '../src/commands/approach.js';
import { cmdDoctor } from '../src/commands/doctor.js';
import { cmdInit } from '../src/commands/init.js';
import { cmdDebate } from '../src/commands/debate.js';
import { cmdPin } from '../src/commands/pin.js';
import { cmdMcp } from '../src/commands/mcp.js';

// flags that take a value as the next token (--flag value); all others are boolean
const VALUE_FLAGS = new Set([
  'impl', 'budget', 'context', 'timeout', 'why', 'retire', 'resume', 'clear', 'role', 'ref',
  'quiet', 'set', 'provider', 'quota', 'reset', 'rollover', 'rail', 'lane', 'scope', 'lines', 'root', 'mcp-agent', 'cwd',
]);

function parseArgv(argv) {
  const _ = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > -1) {
        flags[a.slice(2, eq)] = a.slice(eq + 1);
      } else {
        const name = a.slice(2);
        if (VALUE_FLAGS.has(name) && i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
          flags[name] = argv[++i];
        } else {
          flags[name] = true;
        }
      }
    } else {
      _.push(a);
    }
  }
  return { _, flags };
}

// Ctrl-C = safe stop: nothing lost. Every run carries its own lock + ledger, so
// an interrupted run is a filed state sweep picks up - never a corrupted one.
import { updateRun as _updateRun } from '../src/store.js';
import { readFileSync } from 'node:fs';
const getActiveRun = () => globalThis.CADRE_ACTIVE_RUN || null;
process.on('SIGINT', () => {
  console.log('\ncadre: interrupted - stopping. Nothing is lost.');
  const ACTIVE_RUN_ID = getActiveRun();
  if (ACTIVE_RUN_ID) {
    try {
      _updateRun(ACTIVE_RUN_ID, { status: 'interrupted', ended: new Date().toISOString() });
      console.log(`  run ${ACTIVE_RUN_ID} filed as interrupted - cadre sweep --resume ${ACTIVE_RUN_ID} to continue`);
    } catch { /* best effort; the lock file still tells sweep the truth */ }
  } else {
    console.log('  (cadre sweep will find any leftovers)');
  }
  process.removeAllListeners('SIGINT');
  process.on('SIGINT', () => process.exit(130));
  process.exitCode = 130;
  setTimeout(() => process.exit(130), 300).unref();
});

async function main() {
  const argv = process.argv.slice(2);
  if (argv.length === 0) return cmdHelp();
  const [command, ...rest] = argv;
  const { _, flags } = parseArgv(rest);

  switch (command) {
    case 'go': return cmdGo(_, flags, { cwd: typeof flags.cwd === 'string' ? resolve(flags.cwd) : undefined });
    case 'lanes': return cmdLanes(flags);
    case 'help':
    case '--help':
    case '-h': return cmdHelp();
    case '--version':
    case '-v': {
      const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
      console.log(`cadre ${pkg.version}`);
      return 0;
    }
    case 'parity': return cmdParity(_, flags);
    case 'plan': return cmdPlan(_, flags);
    case 'meter': return cmdMeter(_, flags);
    case 'sweep': return cmdSweep(_, flags);
    case 'map': return cmdMap(_, flags);
    case 'watch': return cmdWatch(_, flags);
    case 'proof': return cmdProof(_, flags);
    case 'metrics': return cmdMetrics(_, flags);
    case 'approach': return cmdApproach(_, flags);
    case 'doctor': return cmdDoctor(_, flags);
    case 'init': return cmdInit(_, flags);
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
