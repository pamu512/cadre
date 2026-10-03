// Skills are files, not a hardcoded policy. The repo ships the library;
// a same-named file in $CADRE_HOME/skills replaces it. Edit the file, the
// next run reads the edit.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { home } from './store.js';

const SHIPPED = join(dirname(fileURLToPath(import.meta.url)), '..', 'skills');

export function skillsDirs() {
  return [SHIPPED, join(home(), 'skills')];
}

export function loadSkills() {
  const byName = new Map();
  for (const dir of skillsDirs()) {
    if (!existsSync(dir)) continue;
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.md')) continue;
      const name = f.slice(0, -3);
      const text = readFileSync(join(dir, f), 'utf-8');
      const title = (text.match(/^#\s+(.+)$/m) || [, name])[1].trim();
      byName.set(name, { name, title, text, path: join(dir, f) });
    }
  }
  return [...byName.values()];
}

export function skillsBrief(skills = loadSkills()) {
  if (!skills.length) return '';
  return skills.map((s) => `skill ${s.name}: ${s.text.trim().split('\n').filter((l) => l && !l.startsWith('#')).join(' ')}`).join('\n');
}

// A correction the user keeps repeating becomes a skill file of their words.
// Three times writes it once. A file already there is left alone.
export function noteCorrection(text) {
  const raw = String(text || '').replace(/\s+/g, ' ').trim();
  if (raw.length < 12 || /^rules critic · CLEAN/i.test(raw)) return null;
  const key = raw.toLowerCase();
  const bookPath = join(home(), 'corrections.json');
  let book = {};
  try { book = JSON.parse(readFileSync(bookPath, 'utf-8')); } catch { /* first correction */ }
  const cur = book[key] && typeof book[key] === 'object' ? book[key] : { text: raw, n: 0 };
  cur.text = raw;
  cur.n += 1;
  book[key] = cur;
  mkdirSync(home(), { recursive: true });
  writeFileSync(bookPath, JSON.stringify(book));
  if (cur.n < 3) return null;
  const slug = key.replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'correction';
  const path = join(home(), 'skills', `${slug}.md`);
  if (existsSync(path)) return path;
  mkdirSync(join(home(), 'skills'), { recursive: true });
  writeFileSync(path, `# ${raw.slice(0, 80)}\n\n${raw}\n`);
  return path;
}
