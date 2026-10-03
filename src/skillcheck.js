// Skills are checks on what the run did.
// read-before-reacting: a diff of an indexed file has to be one the map slice named.
//   A new file, or a slice that named nothing, passes. Callers that only have
//   the log still pass on the MAP marker.
// restate-the-ask: a speaking lane repeats distinctive brief words in its own
//   output. A command lane passes on the RESTATE marker.
// verify-before-claiming: the gate passed and the re-run of its commands exited 0.
import { loadSkills } from './skills.js';

const SPEAKING = new Set(['hand', 'agent', 'anthropic', 'openai-compatible', 'http-chat', 'chat']);

function base(p) {
  return String(p).split('/').pop();
}

function namedIn(file, list) {
  const b = base(file);
  return (list || []).some((m) => m === file || m === b || String(m).endsWith(`/${b}`));
}

export function checkSkills(log, {
  gatePassed = false,
  mapFiles = null,
  indexedFiles = null,
  diffFiles = null,
  brief = null,
  laneOutput = null,
  laneKind = null,
  reverified = null,
} = {}) {
  const names = new Set(loadSkills().map((s) => s.name));
  const missing = [];
  const text = String(log || '');

  if (names.has('read-before-reacting')) {
    let ok;
    if (mapFiles == null && indexedFiles == null) ok = text.includes('MAP');
    else if (!(mapFiles || []).length) ok = true;
    else if (!(diffFiles || []).length) ok = true;
    else {
      ok = diffFiles.every((f) => namedIn(f, mapFiles) || !namedIn(f, indexedFiles));
    }
    if (!ok) missing.push('read-before-reacting');
  }

  if (names.has('restate-the-ask')) {
    let ok;
    if (brief == null || laneOutput == null || !SPEAKING.has(laneKind)) ok = text.includes('RESTATE:');
    else {
      const need = [...new Set(String(brief).toLowerCase().match(/[a-z][a-z0-9-]{4,}/g) || [])];
      const out = String(laneOutput).toLowerCase();
      const hits = need.filter((w) => out.includes(w));
      ok = need.length === 0 || hits.length >= Math.min(2, need.length);
    }
    if (!ok) missing.push('restate-the-ask');
  }

  if (names.has('verify-before-claiming')) {
    const ok = reverified == null ? gatePassed : (gatePassed && reverified);
    if (!ok) missing.push('verify-before-claiming');
  }
  return { ok: missing.length === 0, missing };
}
