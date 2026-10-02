// human - the coffee lane. A person is a worker exactly like the AIs: given a
// task, expected to answer back. Costs coffee, proves verdicts, talks in the
// terminal. Used at decision points the AIs shouldn't decide alone.
import { createInterface } from 'node:readline';

export const HUMAN_LANE = {
  name: 'human',
  identity: 'coffee-class',
  good_at: ['judgment', 'taste', 'decisions', 'sign-off', 'priorities'],
  cost: 'coffee',
  talks: 'chat',
  proves: 'verdict',
  craft: ['ask-sharp-questions'],
  invoke: { kind: 'human' },
};

// Ask a human a question in the terminal. Returns their answer, or null on
// EOF/timeout (they walked away - file it, don't fake it).
export function askHuman(question, { timeoutMs = 0 } = {}) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    let done = false;
    const finish = (ans) => {
      if (done) return;
      done = true;
      try { rl.close(); } catch { /* already closed */ }
      resolve(ans);
    };
    if (timeoutMs > 0) {
      const t = setTimeout(() => {
        console.log(`  (human lane: no answer in ${Math.round(timeoutMs / 60000)} min - filing as skipped, not faked)`);
        finish(null);
      }, timeoutMs);
      rl.on('close', () => clearTimeout(t));
    }
    rl.question(`\n[human lane] ${question}\n> `, (ans) => finish(ans == null ? null : String(ans).trim() || null));
  });
}
