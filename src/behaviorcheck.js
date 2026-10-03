// behaviorcheck - the parity contract's closing executor. A behavior closes only
// when the line names a check and that check exits 0 (or the file contains the
// named text, or the named path exists). Prose does not close. The citation is
// the check that passed.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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

const UNCHECKABLE = 'no check named (command, file contains, test name, or path exists)';

function stripQuotes(s) {
  return String(s || '').trim().replace(/^["']|["']$/g, '');
}

// A line closes only when it names a check. Prose, a mentioned path, and an
// issue number do not.
export function parseCheck(behavior) {
  const line = String(behavior || '').trim();
  let m;
  if ((m = /^command:\s*(.+)$/i.exec(line))) return { kind: 'command', command: m[1].trim() };
  if ((m = /^`([^`]+)`$/.exec(line))) return { kind: 'command', command: m[1].trim() };
  if ((m = /^(?:create|write|provide)\s+([\w./-]+\.[A-Za-z0-9]+)\s+containing\s+(.+)$/i.exec(line))) {
    return { kind: 'contains', path: m[1], text: stripQuotes(m[2]) };
  }
  if ((m = /^([\w./-]+\.[A-Za-z0-9]+)\s+contains\s+(.+)$/i.exec(line))) {
    return { kind: 'contains', path: m[1], text: stripQuotes(m[2]) };
  }
  if ((m = /^([\w./-]+\.[A-Za-z0-9]+)\s+exists$/i.exec(line))) return { kind: 'file', path: m[1] };
  if ((m = /^test:\s*(.+)$/i.exec(line))) return { kind: 'test', name: m[1].trim() };
  if ((m = /^test\s+(.+?)\s+passes$/i.exec(line))) return { kind: 'test', name: m[1].trim() };
  if (/^(?:npm test|tests?)\s+(?:pass(?:es)?|exits?\s+0)$/i.test(line)) return { kind: 'test', name: null };
  return null;
}

// Headings choose the bucket. Non-goals stay out even when the goal asks for stretch.
export function splitSpec(text) {
  const core = [];
  const stretch = [];
  const excluded = [];
  let mode = 'core';
  for (const raw of String(text || '').split('\n')) {
    const l = raw.trim();
    if (/^#{1,4}\s+/.test(l)) {
      const h = l.replace(/^#{1,4}\s+/, '');
      if (/non-goal|out of scope/i.test(h)) mode = 'excluded';
      else if (/stretch|future|nice-to-have|\blater\b/i.test(h)) mode = 'stretch';
      else mode = 'core';
      continue;
    }
    if (/^[-*=#]{3,}$/.test(l) || l.length <= 8) continue;
    const clean = l.replace(/^[-*]\s+/, '');
    if (!clean || !/^\S/.test(clean)) continue;
    (mode === 'stretch' ? stretch : mode === 'excluded' ? excluded : core).push(clean);
  }
  return { core: core.slice(0, 40), stretch: stretch.slice(0, 15), excluded };
}

export function wantsBeyond(goal) {
  return /\bbeyond parity\b|\bstretch\b|\bgo further\b/i.test(String(goal || ''));
}

// Run ONE behavior's check against the tree. Returns:
//   { closed, kind, citation?, reason }
export function runBehaviorCheck(behavior, cwd) {
  const parsed = parseCheck(behavior);
  if (!parsed) return { closed: false, kind: 'uncheckable', reason: UNCHECKABLE };
  if (parsed.kind === 'command') {
    return { closed: null, kind: 'command', command: parsed.command, reason: 'check deferred' };
  }
  if (parsed.kind === 'test') {
    return { closed: null, kind: 'test', name: parsed.name, reason: 'check deferred' };
  }
  if (parsed.kind === 'file') {
    return existsSync(join(cwd, parsed.path))
      ? { closed: true, kind: 'file', citation: parsed.path, reason: `path exists: ${parsed.path}` }
      : { closed: false, kind: 'file', reason: `missing named path: ${parsed.path}` };
  }
  const full = join(cwd, parsed.path);
  if (!existsSync(full)) return { closed: false, kind: 'contains', reason: `missing file ${parsed.path}` };
  let body = '';
  try { body = readFileSync(full, 'utf-8'); } catch { return { closed: false, kind: 'contains', reason: `${parsed.path} unreadable` }; }
  return body.includes(parsed.text)
    ? { closed: true, kind: 'contains', citation: parsed.path, reason: `${parsed.path} contains ${parsed.text}` }
    : { closed: false, kind: 'contains', reason: `${parsed.path} does not contain ${parsed.text}` };
}

// async wrapper: runs the test check kind by executing the project's tests
function namedTestResult(out, name) {
  const lines = String(out || '').split('\n');
  if (lines.some((l) => /not ok\b/.test(l) && l.includes(name))) return false;
  if (lines.some((l) => /^\s*ok\b/.test(l) && l.includes(name))) return true;
  return null;
}

export async function runBehaviorCheckAsync(behavior, cwd, opts = {}) {
  const sync = runBehaviorCheck(behavior, cwd);
  const timeout = opts.testTimeoutMs || 1000 * 60 * 5;
  if (sync.kind === 'command' && sync.closed === null) {
    try {
      await run('sh', ['-c', sync.command], { cwd, timeout, maxBuffer: 1024 * 1024 * 4 });
      return { closed: true, kind: 'command', citation: `${sync.command} (exit 0)`, reason: 'command exited 0' };
    } catch (e) {
      const tail = `${e.stdout || ''}${e.stderr || e.message || ''}`.slice(-400);
      return { closed: false, kind: 'command', citation: `${sync.command} (exit ${e.code ?? 1})`, reason: `command failed: ${tail}` };
    }
  }
  if (sync.kind !== 'test' || sync.closed !== null) return sync;
  if (!opts.testCmd) return { closed: false, kind: 'test', reason: 'no project test command detected' };
  const label = `${opts.testCmd.cmd} ${opts.testCmd.args.join(' ')}`.trim();
  try {
    await run(opts.testCmd.cmd, opts.testCmd.args, { cwd, timeout, maxBuffer: 1024 * 1024 * 8 });
    return { closed: true, kind: 'test', citation: `${label} (exit 0)`, reason: sync.name ? `test ${sync.name} passed` : 'project tests pass' };
  } catch (e) {
    const out = `${e.stdout || ''}\n${e.stderr || ''}`;
    if (sync.name && namedTestResult(out, sync.name) === true) {
      return { closed: true, kind: 'test', citation: `${label} (${sync.name})`, reason: `test ${sync.name} passed` };
    }
    const tail = out.trim().slice(-400) || 'project tests fail';
    return { closed: false, kind: 'test', citation: `${label} (exit ${e.code ?? 1})`, reason: sync.name ? `test ${sync.name} failed: ${tail}` : tail };
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
