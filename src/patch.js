// patch-confinement-take: patch-scoped file edits with enforced path confinement.
// Design source: patch-confinement tooling ("precise hands" — patch edits + enforced
// path confinement). Cadre's version: a patch language small enough to audit
// (exact-match find→replace per file), applied ONLY inside a confinement root,
// with every rejected op explained. The loop hands builders this instead of
// free-form shell access when precision matters.
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { isAbsolute, join, resolve, relative } from 'node:path';
import { seatbeltProfile } from './sandbox.js';

function writeInside(target, contents, root) {
  if (process.platform === 'darwin' && existsSync('/usr/bin/sandbox-exec')) {
    const profile = seatbeltProfile([root]);
    execFileSync('/usr/bin/sandbox-exec', ['-p', profile, process.execPath, '-e',
      'require("fs").writeFileSync(process.argv[1], process.argv[2])', target, contents],
    { stdio: 'pipe' });
    return;
  }
  writeFileSync(target, contents);
}

// A patch: { file, find, replace } — find must be an exact, unique substring.
// Ops outside the confinement root are rejected before any file is touched.
export function applyPatch(patch, { root = process.cwd() } = {}) {
  const errors = [];
  const target = isAbsolute(patch.file) ? patch.file : join(root, patch.file);
  const rel = relative(resolve(root), resolve(target));
  if (rel.startsWith('..') || isAbsolute(rel)) {
    return { ok: false, file: patch.file, error: 'confinement: path escapes the root', changed: false };
  }
  if (!existsSync(target)) {
    return { ok: false, file: patch.file, error: 'no such file', changed: false };
  }
  let src;
  try { src = readFileSync(target, 'utf-8'); } catch (e) {
    return { ok: false, file: patch.file, error: `unreadable: ${e.message}`, changed: false };
  }
  const first = src.indexOf(patch.find);
  if (first === -1) {
    return { ok: false, file: patch.file, error: 'find-string not present', changed: false };
  }
  if (src.indexOf(patch.find, first + 1) !== -1) {
    return { ok: false, file: patch.file, error: 'find-string is not unique, refusing ambiguous edit', changed: false };
  }
  const out = src.slice(0, first) + patch.replace + src.slice(first + patch.find.length);
  try {
    writeInside(target, out, root);
  } catch (e) {
    return { ok: false, file: patch.file, error: `write failed: ${e.message}`, changed: false };
  }
  return { ok: true, file: patch.file, changed: true, plus: (patch.replace.length - patch.find.length) };
}

// apply a batch; all-or-nothing per op, each op reported. Rejected ops never
// touch the file; successful ops list their byte delta for the ledger.
export function applyPatches(patches, opts = {}) {
  return patches.map((p) => applyPatch(p, opts));
}

// smoke check the confinement boundary itself (the patch-confinement security property)
export function confined(path, root = process.cwd()) {
  const rel = relative(resolve(root), resolve(isAbsolute(path) ? path : join(root, path)));
  return !rel.startsWith('..') && !isAbsolute(rel);
}
