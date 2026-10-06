// derive - derived hand memory (the useful half of the "memory bank" idea):
// per-hand capability cards regenerated from the hand ledger on demand.
// The jsonl ledger is TRUTH; these files are a cache — when the two
// disagree, the ledger wins and the card regenerates. Nothing here is ever
// an input that overrides an explicit pin or preference: it only makes the
// ledger inspectable (so a routing choice can cite it).
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

function handsDir() {
  return join(process.env.CADRE_HOME || join(homedir(), '.cadre'), 'hands-memory');
}

function readLedger(name) {
  try {
    return readFileSync(join(handsDir(), `${name}.jsonl`), 'utf-8').trim().split('\n').filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } })
      .filter(Boolean)
      .filter((e) => !e.retracted); // retracted claims never count
  } catch { return []; }
}

// regenerate every hand's capability card from its ledger.
// returns the list of cards written.
export function deriveHandCards() {
  let names = [];
  try { names = readdirSync(handsDir()).filter((f) => f.endsWith('.jsonl')).map((f) => f.replace(/\.jsonl$/, '')); } catch { return []; }
  const written = [];
  for (const name of names) {
    const entries = readLedger(name);
    const passed = entries.filter((e) => e.passed);
    const failed = entries.filter((e) => !e.passed);
    const runIds = [...new Set(entries.map((e) => e.run).filter(Boolean))];
    // file affinity: which files this hand has actually touched (verdict-claimed)
    const fileCount = new Map();
    for (const e of entries) for (const f of e.files || []) fileCount.set(f, (fileCount.get(f) || 0) + 1);
    const hotFiles = [...fileCount.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
    const card = [
      `# hand ${name} — capability card (derived)`,
      ``,
      `generated ${new Date().toISOString()} · from ${entries.length} ledger claim(s) · ${runIds.length} run(s)`,
      `ledger is truth: this card regenerates from hands-memory/${name}.jsonl`,
      ``,
      `## verdicts`,
      `- passed: ${passed.length}`,
      `- failed: ${failed.length}`,
      `- pass rate: ${entries.length ? Math.round((passed.length / entries.length) * 100) : 0}%`,
      ``,
      ...(runIds.length ? [`## runs (provenance)`, ...runIds.map((r) => `- ${r}`), ``] : []),
      ...(hotFiles.length ? [`## files touched (most first)`, ...hotFiles.map(([f, n]) => `- ${f} ×${n}`), ``] : []),
      ...(failed.length ? [`## recent failures (learn from)`, ...failed.slice(-5).map((e) => `- ${e.at} ${e.critique || '(no critique)'}`), ``] : []),
      ...(passed.length ? [`## recent passes`, ...passed.slice(-3).map((e) => `- ${e.at} ${(e.task || '').slice(0, 100)}`)] : []),
      ``,
    ].join('\n');
    const outDir = join(handsDir(), 'derived');
    mkdirSync(outDir, { recursive: true });
    const p = join(outDir, `${name}.md`);
    writeFileSync(p, card);
    written.push(p);
  }
  return written;
}

// inspect one claim: trace a verdict back to its run + evidence.
export function explainClaim(name, at) {
  const hit = readLedger(name).find((e) => e.at === at);
  if (!hit) return null;
  return {
    hand: name, at: hit.at, passed: hit.passed, critique: hit.critique,
    run: hit.run || null, evidence: hit.evidence || [], files: hit.files || [],
    retracted: Boolean(hit.retracted),
  };
}
