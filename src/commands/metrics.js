// metrics - beyond-parity B1 (PRD-v0.2): the §8 success-metric numbers,
// computed from the local ledger ONLY. No invented data: every figure traces to
// run records under $CADRE_HOME/runs; anything without data renders as "—".
import { listRuns, runDir, home } from '../store.js';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const SETTLED = ['passed', 'rejected', 'failed', 'retired', 'resumed-brief'];

function median(nums) {
  if (nums.length === 0) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

export function computeMetrics() {
  const runs = listRuns();
  const settled = runs.filter((r) => SETTLED.includes(r.status));

  // false-DONE: rejected/failed runs that had claimed command evidence.
  // Those are runs that said "I ran this" and still didn't hold up.
  const falseDone = settled.filter((r) =>
    ['rejected', 'failed'].includes(r.status) &&
    (r.evidence || []).some((e) => e.kind === 'command'));

  // sweep recovery: runs that were swept (snapshot exists) and ended filed
  const swept = runs.filter((r) => existsSync(join(runDir(r.id), 'sweep-snapshot.json')));
  const recovered = swept.filter((r) => ['retired', 'resumed-brief', 'passed', 'rejected', 'failed'].includes(r.status));

  // metered burn per passed run
  const passed = settled.filter((r) => r.status === 'passed');
  const burn = passed.reduce((s, r) => s + (r.usage?.metered_tokens || 0), 0);

  // inspect time: gap between started and ended per run (how long a bundle took to settle)
  const durations = settled
    .filter((r) => r.started && r.ended)
    .map((r) => (new Date(r.ended) - new Date(r.started)) / 1000)
    .filter((n) => Number.isFinite(n) && n >= 0);

  return {
    runs_total: runs.length,
    runs_settled: settled.length,
    false_done_rate: settled.length ? falseDone.length / settled.length : null,
    false_done_count: falseDone.length,
    sweep_recovery_rate: swept.length ? recovered.length / swept.length : null,
    swept: swept.length,
    metered_burn_per_passed_run: passed.length ? burn / passed.length : null,
    passed_runs: passed.length,
    median_settle_seconds: median(durations),
  };
}

const fmt = (v, suffix = '') => (v == null ? '—' : `${typeof v === 'number' ? Math.round(v * 1000) / 1000 : v}${suffix}`);

export async function cmdMetrics(args, flags) {
  // #10: --report generates docs/BEYOND-PARITY.md from the ledger (never hand-written)
  if (flags.report) {
    const { writeFileSync, mkdirSync, readFileSync, existsSync } = await import('node:fs');
    const { join } = await import('node:path');
    const m = computeMetrics();
    // parity ledger rows, if any
    let parityRows = [];
    const pl = join(home(), 'parity-ledger.jsonl');
    if (existsSync(pl)) {
      parityRows = readFileSync(pl, 'utf-8').split('\n').filter(Boolean).map((l) => {
        try { return JSON.parse(l); } catch { return null; }
      }).filter(Boolean);
    }
    const pct = (v) => (v == null ? '—' : (v * 100).toFixed(1) + '%');
    const md = [
      '# Beyond Parity — generated from the ledger',
      '',
      `Generated: ${new Date().toISOString()} by \`cadre metrics --report\` — do not edit by hand; regenerate instead.`,
      '',
      '## Run ledger',
      '',
      `- runs recorded: **${m.runs_total}** (settled ${m.runs_settled})`,
      `- false-DONE rate: **${pct(m.false_done_rate)}** (${m.false_done_count} rejected/failed with claimed command evidence) — target ≤ 5%`,
      `- sweep recovery: **${m.swept ? pct(m.sweep_recovery_rate) : '—'}** (${m.swept} swept) — target ≥ 90%, 0 silent losses`,
      `- metered burn per passed run: **${m.passed_runs ? Math.round(m.metered_burn_per_passed_run) + ' tok' : '—'}** over ${m.passed_runs} passed run(s)`,
      `- median settle time: **${m.median_settle_seconds != null ? m.median_settle_seconds.toFixed(1) + 's' : '—'}**`,
      '',
      '## Parity ledger',
      '',
    ];
    if (parityRows.length === 0) md.push('_no parity runs recorded yet_');
    else {
      md.push('| run | verdict | ref | evidence |', '|---|---|---|---|');
      for (const e of parityRows.slice(-25)) md.push(`| ${e.run} | ${e.verdict} | ${(e.ref || '—').replace(/\|/g, '/')} | ${e.evidence_count} |`);
    }
    const out = join(process.cwd(), 'docs', 'BEYOND-PARITY.md');
    mkdirSync(join(process.cwd(), 'docs'), { recursive: true });
    writeFileSync(out, md.join('\n') + '\n');
    console.log(`report written: ${out} (from ${m.runs_total} runs, ${parityRows.length} parity entries)`);
    return 0;
  }

  const m = computeMetrics();

  if (flags.json) {
    console.log(JSON.stringify(m, null, 2));
    return 0;
  }

  console.log(`cadre metrics - from the ledger under ${join(home(), 'runs')} only ("—" = no data yet)`);
  console.log(`  runs            ${m.runs_total} recorded · ${m.runs_settled} settled`);
  console.log(`  false-DONE      ${fmt(m.false_done_rate && (m.false_done_rate * 100).toFixed(1) + '%', '')} (${m.false_done_count} rejected/failed with claimed command evidence)`);
  console.log(`  sweep recovery  ${m.swept ? (m.sweep_recovery_rate * 100).toFixed(0) + '%' : '—'} (${m.swept} swept, all filed states)`);
  console.log(`  burn / passed   ${m.passed_runs ? fmt(m.metered_burn_per_passed_run, ' tok') : '—'} over ${m.passed_runs} passed run(s)`);
  console.log(`  median settle   ${fmt(m.median_settle_seconds, 's')}`);
  console.log('\nsuccess targets (PRD §8): false-DONE ≤5% · sweep recovery ≥90% · 0 silent losses');
  return 0;
}
