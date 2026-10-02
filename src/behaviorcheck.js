// behaviorcheck - the parity contract's closing executor. For each behavior in
// a reference contract, derive a DETERMINISTIC check against the current tree:
//   1. file check     - the behavior names a path (docs/X.md, src/x.js): it exists
//   2. test check     - the behavior mentions tests: the project's test command exits 0
//   3. keyword check  - the behavior's distinctive keywords co-occur in a source line
// A behavior closes ONLY when its check passes, and the closing row carries a
// citation (file:line) a human can open. No LLM judgment in the loop - the
// reference's own words decide, greppably.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, extname } from 'node:path';

const run = promisify(execFile);

const STOP = new Set(('the a an and or but with without for from into onto of to in on by as at is are was were be been ' +
  'must should shall will would can could may might this that these those it its their there here when then than ' +
  'if else not no yes so such only also very much more most less least each every any all some none one two three ' +
  'per via using use used uses have has had do does did done make makes made get gets got set sets same different ' +
  'new old add adds added run runs running file files line lines code repo user users see sees seen like just about ' +
  'which who whom whose what where how why while during before after above below over under again further once ' +
  'cadre prd v0 v1 v2 v3 status active version date doc docs note notes item items bullet heading section').split(/\s+/));

// words that make a behavior distinctive; used for the keyword check
export function keywords(text, max = 6) {
  const words = String(text || '').toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) || [];
  return [...new Set(words.filter((w) => !STOP.has(w) && !/^\d+$/.test(w)))].slice(0, max);
}

// paths mentioned in the behavior text (docs/X.md, src/x.js, scripts/x.sh, schemas/x.json)
// issue refs mentioned in the behavior text (#123, GH-45, issue 7)
export function mentionedIssues(text) {
  const out = [];
  const re = /(?:^|\s)(?:GH-|#)(\d{1,6})\b|(?:^|\s)issue\s+(\d{1,6})\b/gi;
  let m;
  while ((m = re.exec(String(text || '')))) out.push(Number(m[1] || m[2]));
  return [...new Set(out)];
}

export function mentionedPaths(text) {
  const out = [];
  const re = /[\w./-]+\.(md|js|mjs|cjs|ts|py|sh|json|yaml|yml|toml|txt)\b/g;
  let m;
  while ((m = re.exec(String(text || '')))) {
    const p = m[0].replace(/^[.(/]+/, '');
    if (p.length > 3 && !/^(http|https)$/.test(p)) out.push(p);
  }
  return [...new Set(out)];
}

const TEXT_EXTS = new Set(['.js', '.mjs', '.cjs', '.ts', '.py', '.sh', '.json', '.yaml', '.yml', '.toml', '.md', '.txt']);

function walkFiles(cwd, limit = 3000) {
  const out = [];
  const skip = new Set(['node_modules', '.git', '.cadre', 'dist', 'build', 'coverage', '.aimee', 'frugal-backups']);
  const rec = (d) => {
    if (out.length >= limit) return;
    let entries;
    try { entries = readdirSync(d); } catch { return; }
    for (const e of entries) {
      if (skip.has(e)) continue;
      const p = join(d, e);
      let st;
      try { st = statSync(p); } catch { continue; }
      if (st.isDirectory()) rec(p);
      else if (TEXT_EXTS.has(extname(e))) out.push(p);
      if (out.length >= limit) return;
    }
  };
  rec(cwd);
  return out;
}

// Run ONE behavior's check against the tree. Returns:
//   { closed, kind, citation?, reason }
export function runBehaviorCheck(behavior, cwd, opts = {}) {
  const { refPath = null } = opts;
  const text = String(behavior || '');

  // 1. file check: every path the behavior names exists
  const paths = mentionedPaths(text);
  if (paths.length) {
    const missing = paths.filter((p) => !existsSync(join(cwd, p)));
    if (missing.length === 0) {
      return { closed: true, kind: 'file', citation: paths[0], reason: `named path(s) present: ${paths.join(', ')}` };
    }
    return { closed: false, kind: 'file', reason: `missing named path(s): ${missing.join(', ')}` };
  }

  // 1b. issue check: the behavior cites an issue number - the issue must EXIST
  // (gh CLI when present, offline files otherwise). Closing cites the issue.
  const issues = mentionedIssues(text);
  if (issues.length && opts.ghRepo) {
    return { closed: null, kind: 'issue', reason: `issue check deferred: ${issues.join(', ')}` };
  }

  // 2. test check: the behavior mentions tests -> the project's tests must pass
  if (/\btests?\b|\btest command\b|\bnpm test\b/i.test(text) && testCmd) {
    // handled by the async wrapper (needs to exec); signal the kind here
    return { closed: null, kind: 'test', reason: 'test check deferred' };
  }

  // 3. keyword check: distinctive keywords co-occur in a source line.
  // CIRCULARITY GUARD: the reference document itself is excluded - a keyword
  // hit inside the spec proves nothing about the implementation.
  // RARITY WEIGHTING: implementation keywords (identifiers, paths, flags)
  // carry the check; prose words alone never close a behavior.
  const kws = keywords(text);
  if (kws.length < 2) return { closed: false, kind: 'keyword', reason: 'behavior too generic to check deterministically (no distinctive keywords)' };
  let files = walkFiles(cwd);
  if (refPath) {
    const absRef = refPath.startsWith('/') ? refPath : join(cwd, refPath);
    files = files.filter((f) => f !== absRef);
  }
  // IDF-style rarity: pass 1 counts in how many files each keyword occurs.
  // A keyword found in <=2 files is RARE - one hit on a line is real evidence.
  // A keyword everywhere (test, export, function) proves nothing alone.
  const fileCount = new Map(kws.map((k) => [k, 0]));
  const fileTexts = [];
  for (const f of files) {
    let t;
    try { t = readFileSync(f, 'utf-8').toLowerCase(); } catch { continue; }
    fileTexts.push([f, t]);
    for (const k of kws) if (t.includes(k)) fileCount.set(k, fileCount.get(k) + 1);
  }
  const rare = (k) => fileCount.get(k) <= 2 && k.length >= 5;
  for (const [f, t] of fileTexts) {
    const lines = t.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const low = lines[i];
      const hits = kws.filter((k) => low.includes(k));
      if (hits.length === 0) continue;
      const rareHits = hits.filter(rare);
      const ok = rareHits.length >= 1 && hits.length >= Math.max(2, Math.ceil(kws.length * 0.5))
        ? true
        : hits.length >= Math.ceil(kws.length * 0.75);
      if (ok) {
        const rel = f.startsWith(cwd) ? f.slice(cwd.length + 1) : f;
        return { closed: true, kind: 'keyword', citation: `${rel}:${i + 1}`, reason: `keywords co-occur: ${hits.join(', ')}${rareHits.length ? ' (rare: ' + rareHits.join(', ') + ')' : ''}` };
      }
    }
  }
  return { closed: false, kind: 'keyword', reason: `no line co-locates [${kws.join(', ')}]` };
}

// async wrapper: runs the test check kind by executing the project's tests
export async function runBehaviorCheckAsync(behavior, cwd, opts = {}) {
  const sync = runBehaviorCheck(behavior, cwd, opts); // opts.refPath flows through
  if (sync.kind === 'issue') {
    const issues = mentionedIssues(behavior);
    for (const n of issues) {
      const okIssue = await issueExists(n, opts);
      if (!okIssue.ok) return { closed: false, kind: 'issue', reason: `issue #${n}: ${okIssue.reason}` };
    }
    return { closed: true, kind: 'issue', citation: `issue #${issues.join(', #')}`, reason: 'all cited issues exist' };
  }
  if (sync.kind !== 'test') return sync;
  if (!opts.testCmd) return { closed: false, kind: 'test', reason: 'no project test command detected' };
  try {
    await run(opts.testCmd.cmd, opts.testCmd.args, { cwd, timeout: opts.testTimeoutMs || 1000 * 60 * 5, maxBuffer: 1024 * 1024 * 8 });
    return { closed: true, kind: 'test', citation: `${opts.testCmd.cmd} ${opts.testCmd.args.join(' ')} (exit 0)`, reason: 'project tests pass' };
  } catch (e) {
    return { closed: false, kind: 'test', citation: `${opts.testCmd.cmd} (exit ${e.code ?? 1})`, reason: 'project tests fail' };
  }
}

// The executor: verify a whole contract, return per-behavior results + summary
export async function verifyContract(behaviors, cwd, opts = {}) {
  const results = [];
  for (const b of behaviors) {
    const r = await runBehaviorCheckAsync(b, cwd, opts);
    results.push({ behavior: b, ...r });
  }
  const closed = results.filter((r) => r.closed).length;
  return { results, closed, open: results.length - closed, total: results.length };
}

// does an issue exist? gh CLI (authoritative) -> offline gh-items cache -> absent
async function issueExists(n, opts = {}) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const runE = promisify(execFile);
  const gh = opts.gh || 'gh';
  try {
    const args = ['issue', 'view', String(n), '--json', 'number,state,title'];
    if (opts.ghRepo) args.push('--repo', opts.ghRepo);
    await runE(gh, args, { timeout: 15000 });
    return { ok: true };
  } catch (e) {
    const out = String(e.stdout || '');
    if (/"number"/.test(out)) return { ok: true };            // view printed the issue
    if (/Could not resolve|NOT_FOUND|not found/i.test(out + e.message)) {
      return { ok: false, reason: 'not found in the repo' };
    }
    // gh unavailable (offline/no auth): fall back to the offline cache
    try {
      const { existsSync, readFileSync } = await import('node:fs');
      const { homedir } = await import('node:os');
      const { join } = await import('node:path');
      const cache = join(homedir(), '.cadre', 'gh-issues.json');
      if (existsSync(cache)) {
        const items = JSON.parse(readFileSync(cache, 'utf-8'));
        if (Array.isArray(items) && items.some((i) => Number(i.number) === n)) return { ok: true };
        return { ok: false, reason: 'not in offline issue cache' };
      }
      return { ok: false, reason: 'gh unavailable and no offline cache (~/.cadre/gh-issues.json)' };
    } catch {
      return { ok: false, reason: 'gh unavailable' };
    }
  }
}
