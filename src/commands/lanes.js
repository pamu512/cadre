// lanes - the machine scan. CLIs, apps, models, keys, MCP, ax status.
import { writeSync } from 'node:fs';
import { buildRoster } from '../scan.js';

// console.log drops the tail of a large roster: the process exits before the
// pipe drains. Write the whole buffer before returning.
function emit(text) {
  const buf = Buffer.from(String(text).endsWith('\n') ? String(text) : String(text) + '\n');
  let off = 0;
  while (off < buf.length) off += writeSync(1, buf, off, buf.length - off);
}

export async function cmdLanes(flags) {
  const roster = await buildRoster();
  const lanes = roster.lanes;

  // C8: history made visible - per-lane settled/pass counts from the ledger
  const { listRuns } = await import('../store.js');
  const stats = new Map();
  for (const r of listRuns()) {
    if (!r.roles || !['passed', 'rejected', 'failed'].includes(r.status)) continue;
    for (const lane of Object.values(r.roles)) {
      const cur = stats.get(lane) || { runs: 0, passed: 0 };
      cur.runs += 1;
      if (r.status === 'passed') cur.passed += 1;
      stats.set(lane, cur);
    }
  }
  for (const l of lanes) {
    const st = stats.get(l.name);
    if (st) l.history = `${st.passed}/${st.runs} passed`;
  }

  if (flags.json) {
    emit(JSON.stringify({
      lanes,
      clis: roster.clis.map((c) => c.label),
      platform: roster.platform,
    }, null, 2));
    return 0;
  }

  if (lanes.length === 0) {
    emit('no lanes found. Nothing on this machine answered the scan.');
    return 0;
  }

  const w = (s, n) => String(s).padEnd(n);
  const lines = [`${w('LANE', 14)}${w('STATUS', 9)}${w('GOOD AT', 30)}${w('COST', 9)}${w('TALKS', 10)}PROVES`];
  for (const l of lanes) {
    const status = l.invoke?.status || 'ready';
    lines.push(
      `${w(l.name, 14)}${w(status, 9)}${w(l.good_at.join(', '), 30)}${w(l.cost, 9)}${w(l.talks, 10)}${w(l.proves, 14)}${l.history || '—'}`
    );
  }
  lines.push(`\n${lanes.length} lane${lanes.length === 1 ? '' : 's'} · ${roster.clis.length} cli(s) on PATH · ${roster.platform}`);
  lines.push('roster = this machine (clis, apps, models, keys, mcp, who is online). Nothing to enroll.');
  emit(lines.join('\n'));
  return 0;
}
