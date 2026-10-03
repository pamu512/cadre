// Kernel path confinement via macOS Seatbelt (sandbox-exec).
// Exact locked files are literals. A glob is a prefix regex. A directory
// (the "**" lock, or a patch root) is a subpath. Last matching rule wins,
// so a sibling of a locked file is denied and the locked file is allowed.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';

const run = promisify(execFile);

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

export function seatbeltProfile(allows) {
  const denies = [];
  const grants = [];
  const seenDeny = new Set();
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
  return `(version 1)
(allow default)
(deny file-write*)
${denies.join('\n')}
${grants.join('\n')}
`;
}

export async function runConfined(cmd, args, { allow = [], cwd, timeout = 15000 } = {}) {
  if (process.platform !== 'darwin' || !existsSync('/usr/bin/sandbox-exec')) {
    return { ok: false, kernel: false, error: 'sandbox-exec is not on this machine' };
  }
  const profile = seatbeltProfile(allow);
  try {
    const { stdout, stderr } = await run('/usr/bin/sandbox-exec', ['-p', profile, cmd, ...args], {
      cwd, timeout, maxBuffer: 1024 * 1024, encoding: 'utf-8',
    });
    return { ok: true, kernel: true, stdout, stderr };
  } catch (e) {
    return { ok: false, kernel: true, error: String(e.stderr || e.message).slice(0, 400), status: e.status ?? 1 };
  }
}
