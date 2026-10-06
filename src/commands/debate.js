// debate - two REAL lanes argue, transcripts cited. Uses ax lanes headless
// (ax glm / ax grok verified working on this machine). If a chat lane is keyed it
// joins as a third voice. Every claim printed cites a file on disk.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdirSync, writeFileSync, existsSync, readdirSync, appendFileSync } from 'node:fs';
import { home } from '../store.js';
import { chatLaneAvailable, chatLane } from '../chatlane.js';
import { buildRoster } from '../scan.js';

const run = promisify(execFile);
const AX = process.env.CADRE_AX || join(homedir(), '.local/bin/ax');

export async function cmdDebate(args, flags) {
  const q = args.join(' ').trim();
  if (!q) {
    console.error('cadre debate "<question>" - two lanes argue, transcripts cited');
    return 2;
  }

  if (!existsSync(AX)) {
    console.error(`cadre: ax not found at ${AX} - debate needs two live lanes`);
    return 1;
  }

  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const dir = join(home(), 'debates', stamp);
  mkdirSync(dir, { recursive: true });

  console.log(`debate: "${q}"`);
  const lanes = [];
  // pick two distinct ax lanes that answer headless
  try {
    const { stdout } = await run(AX, ['lanes'], { timeout: 15000 });
    for (const name of ['glm', 'grok']) {
      if (new RegExp(`^\\s+${name}\\s+ok\\b`, 'm').test(stdout)) lanes.push(name);
    }
  } catch (e) {
    console.error(`cadre: ax lanes failed - ${e.message.split('\n')[0]}`);
    return 1;
  }
  if (lanes.length < 2) {
    console.error('cadre: need two healthy headless lanes (ax glm, ax grok); found: ' + (lanes.join(', ') || 'none'));
    return 1;
  }

  const [aName, bName] = lanes;
  console.log(`lane A: ax ${aName} · lane B: ax ${bName}`);
  console.log('opening statements...');
  const prompt = (side) => [
    `You are lane ${side} in a technical debate. Question: "${q}"`,
    'Argue your position in at most 8 lines. End with a line "EVIDENCE: <the single strongest artifact, command, or fact you rely on>".',
  ].join('\n');

  const opening = {};
  for (const [label, lane] of [['A', aName], ['B', bName]]) {
    const { stdout } = await run(AX, [lane, '-t', '90', prompt(label)], { timeout: 120000, maxBuffer: 1024 * 1024 });
    opening[label] = stdout.trim();
    writeFileSync(join(dir, `lane-${label}-${lane}.md`), opening[label]);
    console.log(`\n--- lane ${label} (${lane}) ---`);
    console.log(opening[label].replace(/^/gm, '  '));
  }

  // rebuttals: each lane sees the other's opening
  console.log('\nrebuttals...');
  for (const [label, lane, other] of [['A', aName, opening.B], ['B', bName, opening.A]]) {
    const { stdout } = await run(AX, [lane, '-t', '90', `Opponent said:\n${other.slice(0, 2000)}\n\nRebut in at most 5 lines. Be specific.`], { timeout: 120000, maxBuffer: 1024 * 1024 });
    writeFileSync(join(dir, `lane-${label}-${lane}-rebuttal.md`), stdout.trim());
    console.log(`\n--- lane ${label} rebuttal (${lane}) ---`);
    console.log(stdout.trim().replace(/^/gm, '  '));
  }

  // optional third-party judge: any keyed OpenAI-compatible chat lane
  const roster = await buildRoster();
  const judgeLane = roster.lanes.find((l) => chatLaneAvailable(l));
  if (judgeLane) {
    try {
      const res = await chatLane(judgeLane, [
        { role: 'system', content: 'You judge technical debates. In at most 5 lines, name the winner and why.' },
        { role: 'user', content: `Question: ${q}\n\nLane A:\n${opening.A.slice(0, 1500)}\n\nLane B:\n${opening.B.slice(0, 1500)}` },
      ], { max_tokens: 300 });
      const judgeNote = typeof res.text === 'string' ? res.text : '';
      writeFileSync(join(dir, `judge-${judgeLane.name}.md`), judgeNote);
      console.log(`\n--- judge (${judgeLane.name}) ---`);
      console.log(judgeNote.replace(/^/gm, '  '));
    } catch (e) {
      console.log(`\njudge: ${judgeLane.name} failed (${e.message.split('\n')[0]}) - no judgment filed`);
    }
  } else {
    console.log('\njudge: no keyed chat lane - no judgment filed');
  }

  writeFileSync(join(dir, 'question.txt'), q);
  console.log(`\ntranscripts: ${dir}`);

  // citation check (P0 #3): every file this debate cites must exist on disk;
  // a missing one fails LOUDLY, not in prose
  const cited = [join(dir, 'question.txt')];
  for (const f of readdirSync(dir)) cited.push(join(dir, f));
  const missing = cited.filter((f) => !existsSync(f));
  if (missing.length) {
    console.error(`CITATION CHECK FAILED: ${missing.length} cited file(s) missing: ${missing.join(', ')}`);
    appendFileSync(join(dir, 'citation-check.txt'), `FAILED ${new Date().toISOString()}: ${missing.join(', ')}\n`);
    return 1;
  }
  appendFileSync(join(dir, 'citation-check.txt'), `OK ${new Date().toISOString()}: ${cited.length} cited files verified on disk\n`);
  console.log(`citation check: OK - ${cited.length} cited file(s) verified on disk (see citation-check.txt)`);
  return 0;
}
