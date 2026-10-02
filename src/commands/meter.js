// meter - windows, quotas, rollover, resets, pacing (PRD 6.4).
// Honest ledger: user-declared entitlements (official rails) + real burn from
// audit receipts. Unknown values are "—", never invented.
import { loadMeters, usageFromAudit, pacing, renderMeters, saveMeters } from '../meters.js';

export async function cmdMeter(args, flags) {
  const meters = loadMeters();

  // cadre meter --set lane=<name> --provider <provider> --quota 2000000 --reset 2026-10-08T00:00:00Z [--rail official]
  if (flags.set) {
    const m = String(flags.set);
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

  console.log('cadre meter — entitlement ledger (official rails; "—" = unknown, never invented)');
  const lines = renderMeters({ meters, usage });
  console.log(lines.length ? lines.join('\n') : '  (no entitlements declared — see --set above)');

  if (usage.size > 0) {
    console.log('\nreal burn (from audit receipts):');
    for (const [lane, v] of usage) console.log(`  ${lane.padEnd(16)} ${v.calls} call(s) · ${v.tokens} tok`);
  }
  console.log('\npolicy: included-first ordering · pace-to-window · degrade-on-empty (downshift → park metered behind budget gate → pause with resume plan)');
  return 0;
}
