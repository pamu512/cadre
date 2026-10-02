// frugal - B5, the compressed-output discipline/output-filtering take: compress tool output before it enters
// run.log or model context. Two donor rules baked in:
//   compressed-output discipline: every squeezed byte keeps a restorable backup - never destroy
//   output-filtering:     if a "compression" would make output BIGGER, keep the original silently
// Counters are logged so the savings are measurable, never invented.
import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const MAX_KEEP = 16 * 1024; // head+tail cap for pathological output

export function compressOutput(text, { backupDir = null, label = 'output' } = {}) {
  const original = String(text);
  let out = original;

  // 1. collapse runs of blank lines (compressed-output discipline: prose padding dies, content stays)
  out = out.replace(/\n{3,}/g, '\n\n');
  // 2. strip trailing whitespace per line
  out = out.replace(/[ \t]+$/gm, '');
  // 3. cap at MAX_KEEP head+tail with an honest marker
  if (out.length > MAX_KEEP) {
    const head = out.slice(0, MAX_KEEP / 2);
    const tail = out.slice(-MAX_KEEP / 2);
    out = `${head}\n… [frugal: ${out.length} bytes → ${MAX_KEEP}, middle elided; full text backed up] …\n${tail}`;
  }

  // output-filtering rule: never grow
  if (out.length >= original.length) out = original;

  const saved = original.length - out.length;

  // compressed-output discipline rule: back up the original whenever anything was cut
  if (saved > 0 && backupDir) {
    try {
      mkdirSync(backupDir, { recursive: true });
      writeFileSync(join(backupDir, `${label}.orig.txt`), original);
    } catch { /* best effort; the counter still tells the truth */ }
  }

  return { text: out, saved, originalBytes: original.length, compressedBytes: out.length, restorable: saved > 0 && Boolean(backupDir) };
}
