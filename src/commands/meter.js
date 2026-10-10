// meter - windows, quotas, rollover, resets, pacing (PRD 6.4).
// Honest ledger: user-declared entitlements (official rails) + real burn from
// audit receipts. Unknown values are "—", never invented.
import { loadMeters, usageFromAudit, pacing, renderMeters, saveMeters } from '../meters.js';

export async function cmdMeter(args, flags) {
  const meters = loadMeters();

  // cadre meter --set lane=<name> --provider <provider> --quota 2000000 --reset 2026-10-08T00:00:00Z [--rail official]
  if (flags.set) {
    // accept both `--set lane=<name>` and bare `--set <name>`
    let m = String(flags.set);
    if (m.startsWith('lane=')) m = m.slice(5);
    if (!m || !/^[a-z0-9][a-z0-9-]*$/.test(m)) {
      console.error('--set needs a lane name (e.g. --set lane=my-lane or --set my-lane)');
      return 2;
    }
    const quota = flags.quota ? Number(flags.quota) : null;
    if (flags.quota && (!Number.isFinite(quota) || quota <= 0)) {
      console.error('--quota must be a positive number of tokens');
      return 2;
    }
    if (flags.reset && Number.isNaN(new Date(flags.reset).getTime())) {
      console.error('--reset must be an ISO date');
      return 2;
    }
    const entry = {
      lane: m, provider: flags.provider || null,
      quota_tokens: quota, reset_at: flags.reset || null,
      rollover_tokens: flags.rollover ? Number(flags.rollover) : null,
      rpm: flags.rpm ? Number(flags.rpm) : null,   // requests/min ceiling (rate-limit meter)
      rps: flags.rps ? Number(flags.rps) : null,   // requests/sec ceiling
      window_hours: flags['window-hours'] ? Number(flags['window-hours']) : null, // recurring window (e.g. 5h)
      status_url: typeof flags['status-url'] === 'string' ? flags['status-url'] : null,
      queued: Boolean(flags.queued),               // unlimited-but-queued entitlement
      rail: flags.rail || 'official', // official = read off your provider dashboard; header = flagged fallback
      updated: new Date().toISOString(),
    };
    saveMeters([...meters.filter((x) => x.lane !== m), entry]);
    console.log(`meter set: ${m}, ${entry.quota_tokens ?? '—'} tok, reset ${entry.reset_at || '—'}, rail ${entry.rail}`);
    console.log('  (loopback status endpoints are read with no credentials; other rails stay what you declared)');
    return 0;
  }

  const { readLocalMeter } = await import('../meters.js');
  for (const m of meters) {
    if (!m.status_url) continue;
    const read = await readLocalMeter(m.status_url);
    const how = read.ok ? `status ${read.status}` : (read.error || `status ${read.status}`);
    console.log(`meter-read ${m.lane}: ${how} (credentials sent: ${read.auth === true})`);
    if (read.ok && read.body) {
      const { applyStatusBody, saveMeters } = await import('../meters.js');
      const next = applyStatusBody(m, read.body);
      if (next) {
        const latest = (await import('../meters.js')).loadMeters();
        saveMeters(latest.map((x) => (x.lane === m.lane ? next : x)));
        Object.assign(m, next);
        console.log(`meter-read ${m.lane}: applied quota ${next.quota_tokens ?? '—'} used ${next.used_tokens ?? '—'}`);
      }
    }
  }

  const usage = usageFromAudit();
  const huEarly = (await import('../meters.js')).harnessUsage();

  if (meters.length === 0 && usage.size === 0 && huEarly.aggregate === 0 && huEarly.axUnattributed === 0) {
    console.log('no entitlements declared and no usage recorded yet.');
    console.log('\ndeclare one (official rail, your dashboard numbers):');
    console.log('  cadre meter --set lane=<name> --provider <provider> --quota 2000000 --reset 2026-10-08T00:00:00Z');
    console.log('\nusage burns are recorded automatically from run receipts (audit.log).');
    return 0;
  }

  if (flags.json) {
    console.log(JSON.stringify({
      entitlements: meters,
      usage: Object.fromEntries([...usage.entries()].map(([lane, v]) => [lane, v])),
      pacing: Object.fromEntries(meters.map((m) => [m.lane, pacing({ quota: m.quota_tokens, resetAt: m.reset_at, used: usage.get(m.lane)?.tokens || 0 })])),
    }, null, 2));
    return 0;
  }

  // harness-wide view: declared entitlements + ALL observed burn in one look
  const { harnessUsage } = await import('../meters.js');
  const hu = harnessUsage();

  console.log('cadre meter: what is left on the harness');
  console.log('(paid lanes only; free/local lanes are excluded from the split and the aggregate)');
  console.log('\ndeclared entitlements (official rails; "—" = unknown, never invented):');
  const lines = renderMeters({ meters, usage: new Map(hu.perLane.map((x) => [x.lane, { tokens: x.tokens }])) });
  console.log(lines.length ? lines.join('\n') : '  (none declared - cadre meter --set lane=<name> --quota <tok> --reset <iso>)');

  console.log('\nper-lane burn (all observed sources):');
  if (hu.perLane.length === 0 && hu.axUnattributed === 0) console.log('  (nothing observed yet)');
  const sorted = [...hu.perLane].sort((a, b) => b.tokens - a.tokens);
  for (const x of sorted) {
    console.log(`  ${x.lane.padEnd(16)} ${x.tokens.toLocaleString().padStart(12)} tok`);
  }
  if (hu.axUnattributed > 0) console.log(`  ${'(unattributed)'.padEnd(16)} ${hu.axUnattributed.toLocaleString().padStart(12)} tok`);

  console.log('\naggregate:');
  console.log(`  total observed burn (paid lanes) : ${hu.aggregate.toLocaleString()} tok`);
  const declared = meters.reduce((sum, m) => sum + (m.quota_tokens || 0), 0);
  if (declared > 0) {
    const declaredLeft = meters.reduce((sum, m) => {
      const used = hu.perLane.find((x) => x.lane === m.lane)?.tokens || 0;
      return sum + Math.max(0, (m.quota_tokens || 0) - used);
    }, 0);
    console.log(`  declared quota                   : ${declared.toLocaleString()} tok`);
    console.log(`  declared remaining               : ${declaredLeft.toLocaleString()} tok (${Math.round(declaredLeft / declared * 100)}%)`);
    console.log(`  undeclared lanes burn unseen - declare each with --set to make them count`);
  } else {
    console.log('  declared quota                   : — (nothing declared; burn is tracked but "left" is unknowable)');
  }
  console.log('\npolicy: included-first ordering · pace-to-window · degrade-on-empty (downshift → park metered behind budget gate → pause with resume plan)');
  return 0;
}
