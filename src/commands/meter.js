// meter - real usage accounting from run records under $CADRE_HOME/runs.
// Token counts come from actual apertus usage receipts (audit.log + run.json
// usage fields). No invented quotas or windows.
import { listRuns, home, auditPath } from '../store.js';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export async function cmdMeter(args, flags) {
  const runs = listRuns();
  if (runs.length === 0) {
    console.log('no runs yet - nothing metered.');
    console.log(`run records live under ${join(home(), 'runs')} once you run cadre go`);
    return 0;
  }

  // aggregate real usage per lane from audit.log apertus-call events
  const perLane = new Map();
  let anyMetered = false;
  if (existsSync(auditPath())) {
    for (const line of readFileSync(auditPath(), 'utf-8').split('\n')) {
      if (!line.trim()) continue;
      let ev; try { ev = JSON.parse(line); } catch { continue; }
      if (ev.kind === 'apertus-call' && ev.usage) {
        anyMetered = true;
        const cur = perLane.get(ev.lane) || { calls: 0, tokens: 0 };
        cur.calls += 1;
        cur.tokens += ev.usage.total_tokens || 0;
        perLane.set(ev.lane, cur);
      }
    }
  }

  console.log(`METERS · ${runs.length} run(s) recorded under ${home()}`);
  const bar = (frac) => {
    const filled = Math.round(Math.max(0, Math.min(1, frac)) * 12);
    return '█'.repeat(filled) + '░'.repeat(12 - filled);
  };
  if (perLane.size === 0) {
    console.log('no metered calls recorded yet (apertus lanes meter when keyed)');
  } else {
    const total = [...perLane.values()].reduce((s, v) => s + v.tokens, 0);
    for (const [lane, v] of perLane) {
      console.log(`${lane.padEnd(14)} ${String(v.calls).padStart(3)} calls  ${bar(v.tokens / Math.max(total, 1))}  ${v.tokens} tok`);
    }
    console.log(`total metered: ${total} tokens across ${[...perLane.values()].reduce((s, v) => s + v.calls, 0)} call(s)`);
  }

  // run statuses: what's open vs settled
  const open = runs.filter((r) => ['running', 'interrupted', 'gating'].includes(r.status));
  console.log(`\nruns: ${runs.length - open.length} settled · ${open.length} open${open.length ? ' (' + open.map((r) => r.id + ' ' + r.status).join(', ') + ')' : ''}`);
  const pins = JSON.parse(existsSync(join(home(), 'pins.json')) ? readFileSync(join(home(), 'pins.json'), 'utf-8') : '{"budget":null}');
  console.log(`budget pin: ${pins.budget ? pins.budget + ' tokens' : 'none set (cadre pin --budget <n> to cap)'}`);
  return 0;
}
