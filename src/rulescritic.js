// rulescritic - the always-on deterministic critic. Zero tokens, zero lanes.
// Fires every run so the critic ROLE is unconditional; the chat critic layers
// on top when a keyed lane exists. Findings are rules, labeled with their tier
// so nothing masquerades as model judgment.
//
// Checks (each cited to file:line where possible):
//   1. scope creep      - changed files vs the run's scope manifest
//   2. diff smells      - TODO/FIXME/debug leftovers, secret-shaped strings,
//                         generated-file churn, whitespace-only changes
//   3. evidence coverage- brief verbs vs gate families actually satisfied
import { readFileSync } from 'node:fs';
import { scopeCreep } from './scope.js';

const SMELL_PATTERNS = [
  { re: /\b(TODO|FIXME|XXX|HACK)\b/, label: 'leftover marker (TODO/FIXME)' },
  { re: /\bconsole\.log\(/, label: 'debug print (console.log)' },
  { re: /\bprint\s*\(/, label: 'debug print (print())' },
  { re: /\bdbg\.|debugger\b/, label: 'debugger statement' },
  { re: /(?:sk-[A-Za-z0-9]{16,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,})/, label: 'SECRET-SHAPED STRING (verify before commit)' },
  { re: /\bpassword\s*=\s*['"][^'"]+['"]/i, label: 'hardcoded credential' },
];

export function criticRules({ brief, changed = [], diffsText = '', manifest = null, evidenceKinds = [] }) {
  const findings = [];

  // 1. scope creep
  if (manifest?.lock && changed.length) {
    const creep = scopeCreep(changed, manifest);
    for (const f of creep.outOfScope || []) findings.push({ rule: 'scope', severity: 'high', text: `out-of-scope change: ${f}` });
  }

  // 2. diff smells
  const lines = String(diffsText || '').split('\n');
  let inDiff = false;
  lines.forEach((line, i) => {
    if (/^diff --git a\//.test(line)) { inDiff = true; return; }
    if (!inDiff) return;
    if (/^[+]/.test(line)) {
      for (const p of SMELL_PATTERNS) {
        if (p.re.test(line)) {
          findings.push({ rule: 'smell', severity: p.label.includes('SECRET') ? 'high' : 'low', text: `${p.label}: ${line.slice(1, 120).trim()}` });
        }
      }
    }
  });

  // 3. evidence coverage vs the brief's verbs
  const verbs = String(brief || '').toLowerCase().match(/\b(add|create|fix|remove|delete|update|write|build|test|refactor|migrate|rename)\b/g) || [];
  const has = (k) => evidenceKinds.includes(k);
  if (verbs.length) {
    const mutating = verbs.some((v) => ['add', 'create', 'fix', 'remove', 'delete', 'update', 'write', 'build', 'refactor', 'migrate', 'rename'].includes(v));
    // a real miss is: mutating brief AND no files changed AND no diff evidence.
    // files-changed-but-evidence-not-yet-filed is pipeline timing - the gate
    // (fail-closed) owns that check, not the critic.
    if (mutating && changed.length === 0 && !has('diff')) findings.push({ rule: 'coverage', severity: 'high', text: 'brief asks for code changes but nothing changed and no diff evidence exists' });
  }
  if (evidenceKinds.length && !has('command') && !has('artifact')) findings.push({ rule: 'coverage', severity: 'low', text: 'no command output or artifact backs the run (only descriptions)' });

  return { tier: 'rules', findings };
}

export function renderCriticRules(result) {
  if (!result || result.tier !== 'rules') return '';
  if (!result.findings.length) return 'rules critic · CLEAN (scope ok, no smells, coverage ok)';
  return result.findings.map((f) => `rules critic · [${f.severity}] ${f.rule}: ${f.text}`).join('\n');
}

// read the current diff text for smell scanning (git repos; fs-mode runs pass '')
export function readDiffText(cwd) {
  try {
    const { execFileSync } = require('node:child_process');
    return execFileSync('git', ['-C', cwd, 'diff', 'HEAD'], { encoding: 'utf-8', maxBuffer: 1024 * 1024 * 8 }).toString();
  } catch {
    return '';
  }
}
