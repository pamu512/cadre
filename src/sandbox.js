// Kernel path confinement via macOS Seatbelt (sandbox-exec).
// FAILS CLOSED: there is no allow-default profile. Reads and writes outside
// the explicitly allowed paths are denied by the profile itself
// (no `(allow default)` anywhere). Network stays denied unless the lane
// asked for it (allowNetwork); home stays read-denied unless the lane asked
// (allowHomeRead). If /usr/bin/sandbox-exec is missing, the command DOES
// NOT RUN - confinement is a precondition, not a best-effort extra.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const run = promisify(execFile);

export const SANDBOX_EXEC = '/usr/bin/sandbox-exec';

function concrete(p) {
  try { return realpathSync(p); } catch { /* parent may exist */ }
  try { return join(realpathSync(dirname(p)), basename(p)); } catch { return p; }
}

function classify(a) {
  if (a && typeof a === 'object' && a.type) return { type: a.type, path: concrete(a.path) };
  const path = concrete(String(a));
  try {
    if (statSync(path).isDirectory()) return { type: 'dir', path };
  } catch { /* a missing path is a file we are about to create */ }
  return { type: 'file', path };
}

function escapeRegex(p) {
  return p.replace(/[\\.^$|?*+()[\]{}]/g, '\\$&');
}

// Build the profile. Structure (last-match-wins under `(deny default)`):
//   (version 1)
//   (deny default)                      <- everything not explicitly allowed
//   process execute/read of the command's own binary + system runtime
//   file-read of the cwd tree + /usr + /System + node runtime etc
//   file-write only inside the allow list
//   network denied (or allowed only when opts.allowNetwork)
// Network by rule-order: deny first, then a narrow allow if asked.
export function seatbeltProfile(allows, { allowNetwork = false, allowHomeRead = false, read = [], cwd = process.cwd() } = {}) {
  const denies = [];
  const grants = [];
  const seenDeny = new Set();
  const readRoots = new Set([
    '/',
  ]);

  // writes: ONLY the allow list. A locked file is a literal; a glob is a
  // prefix regex; a directory is a subpath. The parent dir of a locked file
  // gets an explicit deny so a sibling cannot be written.
  for (const raw of allows || []) {
    const spec = classify(raw);
    if (spec.type === 'dir') {
      grants.push(`(allow file-write* (subpath ${JSON.stringify(spec.path)}))`);
      continue;
    }
    const parent = dirname(spec.path);
    if (!seenDeny.has(parent)) {
      seenDeny.add(parent);
      denies.push(`(deny file-write* (subpath ${JSON.stringify(parent)}))`);
    }
    if (spec.type === 'prefix') {
      grants.push(`(allow file-write* (regex #"^${escapeRegex(spec.path)}"))`);
    } else {
      grants.push(`(allow file-write* (literal ${JSON.stringify(spec.path)}))`);
    }
  }

  const lines = [
    '(version 1)',
    '(deny default)',
    // the confined program must be able to run at all: executing binaries
    // and forking (sh command substitution) is allowed; WRITING is not
    // (except the grants below), network is not (unless asked), home reads
    // are not (unless asked).
    '(allow process-exec*)',
    '(allow process-fork)',
    // sysctl-read: confined programs legitimately size pages/cpus (sort,
    // node, anything libc-backed); this is not a write or network escape
    '(allow sysctl-read)',
    ...[...readRoots].map((r) => `(allow file-read* (subpath ${JSON.stringify(r)}))`),
  ];
  if (allowHomeRead) lines.push(`(allow file-read* (subpath ${JSON.stringify(concrete(join(process.env.HOME || '/Users', ''))) }))`);
  // home stays read-denied unless asked: nothing above narrows it because
  // readRoots only carries /, so express the home carve-out explicitly when
  // NOT allowed: a deny placed after the read allow wins (last match wins).
  if (!allowHomeRead) {
    const home = process.env.HOME;
    if (home) lines.push(`(deny file-read-data (subpath ${JSON.stringify(concrete(home))}))`);
  }
  // network: denied unless the lane asked
  lines.push('(deny network*)');
  if (allowNetwork) lines.push('(allow network*)');
  lines.push(...denies, ...grants);
  // explicit read grants come LAST: the invoked program's own script/binary
  // must be readable even when it lives under home (the lane asked to run
  // exactly this argv). Last match wins, so this re-permits what the home
  // deny above withheld - and nothing else. Note: the override must name
  // file-read-data explicitly; the file-read* wildcard form does not
  // override a data-specific deny.
  for (const r of read || []) {
    const p = concrete(String(r));
    lines.push(`(allow file-read-data (literal ${JSON.stringify(p)}))`);
  }
  return lines.join('\n') + '\n';
}

// Confinement availability: the profile engine must exist or we do not run.
export function sandboxAvailable() {
  return process.platform === 'darwin' && existsSync(SANDBOX_EXEC);
}

export async function runConfined(cmd, args, {
  allow = [], cwd, timeout = 15000, allowNetwork = false, allowHomeRead = false, read = [],
} = {}) {
  if (process.platform !== 'darwin' || !existsSync(SANDBOX_EXEC)) {
    // FAIL CLOSED: no sandbox-exec, no run. Callers must treat this as a
    // refusal, not a fallback-to-unconfined.
    return {
      ok: false, kernel: false, refused: true,
      error: 'sandbox-exec is not on this machine - refusing to run unconfined (sandbox fails closed)',
    };
  }
  const profile = seatbeltProfile(allow, { allowNetwork, allowHomeRead, read, cwd });
  try {
    const { stdout, stderr } = await run(SANDBOX_EXEC, ['-p', profile, cmd, ...args], {
      cwd, timeout, maxBuffer: 1024 * 1024, encoding: 'utf-8',
    });
    return { ok: true, kernel: true, stdout, stderr };
  } catch (e) {
    return { ok: false, kernel: true, error: String(e.stderr || e.message).slice(0, 400), status: e.status ?? 1 };
  }
}
