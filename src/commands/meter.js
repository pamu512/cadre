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
      rail: flags.rail || 'official', // official = read off your dashboard; header = flagged fallback
      updated: new Date().toISOString(),
    };
    saveMeters([...meters.filter((x) => x.lane !== m), entry]);
    console.log(`meter set: ${m} — ${entry.quota_tokens ?? '—'} tok, reset ${entry.reset_at || '—'}, rail ${entry.rail}`);
    console.log('  (official rails only: values you read off your provider dashboard; nothing scraped)');
    return 0;
  }

  const usage = usageFromAudit();

  if (meters.length === 0 && usage.size === 0) {
    console.log('no entitlements declared and no usage recorded yet.');
    console.log('\ndeclare one (official rail — your dashboard numbers):');
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

  console.log('cadre meter — what is left on the harness');
  console.log('\ndeclared entitlements (official rails; "—" = unknown, never invented):');
  const lines = renderMeters({ meters, usage: hu.perLane });
  console.log(lines.length ? lines.join('\n') : '  (none declared - cadre meter --set lane=<name> --quota <tok> --reset <iso>)');

  console.log('\nobserved burn (all sources, this machine):');
  let totalObserved = 0;
  for (const [lane, v] of hu.perLane) {
    console.log(`  ${lane.padEnd(16)} ${v.calls} call(s) · ${v.tokens.toLocaleString()} tok  (chat receipts)`);
    totalObserved += v.tokens;
  }
  if (hu.axTokens > 0) {
    console.log(`  ${'ax pipelines'.padEnd(16)} ${hu.axRuns} run log(s) · ${hu.axTokens.toLocaleString()} tok  (ax run logs)`);
    totalObserved += hu.axTokens;
  }
  if (hu.cadreMetered > 0) {
    console.log(`  ${'run rollups'.padEnd(16)} ${hu.cadreRuns} run(s) · ${hu.cadreMetered.toLocaleString()} tok  (cadre run records)`);
    totalObserved += hu.cadreMetered;
  }
  if (totalObserved === 0) console.log('  (nothing observed yet)');

  const declared = meters.reduce((sum, m) => sum + (m.quota_tokens || 0), 0);
  const declaredLeft = meters.reduce((sum, m) => {
    const used = hu.perLane.get(m.lane)?.tokens || 0;
    return sum + Math.max(0, (m.quota_tokens || 0) - used);
  }, 0);
  console.log('\nharness totals:');
  console.log(`  observed burn (all lanes) : ${totalObserved.toLocaleString()} tok`);
  if (declared > 0) {
    console.log(`  declared quota            : ${declared.toLocaleString()} tok`);
    console.log(`  declared remaining        : ${declaredLeft.toLocaleString()} tok (${Math.round(declaredLeft / declared * 100)}%)`);
    console.log(`  undeclared lanes burn unseen - declare each with --set to make them count`);
  } else {
    console.log('  declared quota            : — (nothing declared; burn is tracked but "left" is unknowable)');
  }
  console.log('\npolicy: included-first ordering · pace-to-window · degrade-on-empty (downshift → park metered behind budget gate → pause with resume plan)');
  return 0;
}
