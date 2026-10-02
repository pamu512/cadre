// pin - role pins and spend caps, persisted to $CADRE_HOME/pins.json.
// Reads and writes the file cadre go / router actually consult.
import { loadPins, savePins, home, pinsPath } from '../store.js';
import { buildRoster } from '../scan.js';
import { audit } from '../store.js';

export function inQuietHours(q) {
  if (!q || !q.start || !q.end) return false;
  const now = new Date();
  const cur = now.getHours() * 60 + now.getMinutes();
  const [sh, sm] = String(q.start).split(':').map(Number);
  const [eh, em] = String(q.end).split(':').map(Number);
  const s = sh * 60 + (sm || 0), e = eh * 60 + (em || 0);
  return s <= e ? (cur >= s && cur < e) : (cur >= s || cur < e); // overnight wrap
}

export async function cmdPin(args, flags) {
  const pins = loadPins();

  // cadre pin                          -> show
  // cadre pin --role planner=apertus-8b
  // cadre pin --budget 50000
  // cadre pin --quiet 23:00-07:00
  // cadre pin --clear role|budget|quiet
  if (args.length === 0 && !flags.role && !flags.budget && !flags.quiet && !flags.clear) {
    console.log(`pins · ${pinsPath()}`);
    const roles = Object.entries(pins.roles || {});
    if (roles.length === 0) console.log('roles: none - router picks by fit each run');
    else for (const [r, l] of roles) console.log(`  ${r} = ${l}`);
    console.log(`budget: ${pins.budget ?? 'none'}${pins.budget ? ' tokens' : ' (cadre pin --budget <n>)'}`);
    console.log(`quiet hours: ${pins.quiet_hours ? `${pins.quiet_hours.start}–${pins.quiet_hours.end}` : 'none (cadre pin --quiet 23:00-07:00)'}`);
    console.log('\ncadre pin --role <role>=<lane> · cadre pin --budget <tokens> · cadre pin --quiet <HH:MM-HH:MM> · cadre pin --clear <role|budget|quiet>');
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
  if (flags.quiet) {
    const m = /^(\d{1,2}:\d{2})-(\d{1,2}:\d{2})$/.exec(String(flags.quiet));
    if (!m) { console.error('quiet hours must look like 23:00-07:00'); return 2; }
    pins.quiet_hours = { start: m[1], end: m[2] };
    changed = true;
    console.log(`quiet hours pinned: ${m[1]}–${m[2]} (cadre go refuses during the window without --override)`);
  }
  if (flags.clear) {
    const what = String(flags.clear);
    if (what === 'budget') { pins.budget = null; changed = true; console.log('budget pin cleared'); }
    else if (what === 'quiet') { pins.quiet_hours = null; changed = true; console.log('quiet-hours pin cleared'); }
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
