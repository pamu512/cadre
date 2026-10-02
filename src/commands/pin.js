// pin - role pins and spend caps, persisted to $CADRE_HOME/pins.json.
// Reads and writes the file cadre go / router actually consult.
import { loadPins, savePins, home, pinsPath } from '../store.js';
import { buildRoster } from '../scan.js';
import { audit } from '../store.js';

export async function cmdPin(args, flags) {
  const pins = loadPins();

  // cadre pin                          -> show
  // cadre pin --role planner=apertus-8b
  // cadre pin --budget 50000
  // cadre pin --clear role|budget
  if (args.length === 0 && !flags.role && !flags.budget && !flags.clear) {
    console.log(`pins · ${pinsPath()}`);
    const roles = Object.entries(pins.roles || {});
    if (roles.length === 0) console.log('roles: none - router picks by fit each run');
    else for (const [r, l] of roles) console.log(`  ${r} = ${l}`);
    console.log(`budget: ${pins.budget ?? 'none'}${pins.budget ? ' tokens' : ' (cadre pin --budget <n>)'}`);
    console.log('\ncadre pin --role <role>=<lane> · cadre pin --budget <tokens> · cadre pin --clear <role|budget>');
    return 0;
  }

  let changed = false;
  if (flags.role) {
    const m = /^(\w+)=(\S+)$/.exec(String(flags.role));
    if (!m) { console.error('pin --role expects <role>=<lane>, e.g. --role critic=apertus-70b'); return 2; }
    const [, role, lane] = m;
    const roster = await buildRoster();
    if (!roster.lanes.some((l) => l.name === lane)) {
      console.error(`no lane "${lane}" in the live roster (cadre lanes lists them)`);
      return 1;
    }
    pins.roles = { ...pins.roles, [role]: lane };
    changed = true;
    console.log(`pinned ${role} = ${lane}`);
  }
  if (flags.budget) {
    const n = Number(flags.budget);
    if (!Number.isFinite(n) || n <= 0) { console.error('budget must be a positive number of tokens'); return 2; }
    pins.budget = n;
    changed = true;
    console.log(`budget pinned: ${n} tokens`);
  }
  if (flags.clear) {
    const what = String(flags.clear);
    if (what === 'budget') { pins.budget = null; changed = true; console.log('budget pin cleared'); }
    else {
      if (!(pins.roles || {})[what]) { console.error(`no pin for role "${what}"`); return 1; }
      delete pins.roles[what]; changed = true; console.log(`pin cleared: ${what}`);
    }
  }
  if (changed) {
    savePins(pins);
    audit({ kind: 'pin-update', pins: { roles: pins.roles, budget: pins.budget } });
    console.log(`saved: ${pinsPath()}`);
  }
  return 0;
}
