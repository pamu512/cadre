// invoke - execute work through a lane, whatever it talks.
// terminal (ax lane): delegate to the ax binary. http (apertus/openai-class):
// one POST. The lane contract's `talks` field decides; secrets never leave the
// process that reads them from env.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { apertusChat } from './apertus.js';

const run = promisify(execFile);
const AX = process.env.CADRE_AX || join(homedir(), '.local/bin/ax');

export async function invokeLane(lane, task, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 1000 * 60 * 30;
  const kind = lane.invoke?.kind || (lane.talks === 'http' ? 'http' : 'terminal');

  if (kind === 'ax') {
    const axLane = lane.invoke.lane;
    const axArgs = ['build', task, '--impl', axLane];
    if (opts.override) axArgs.push('--override');
    if (opts.context) axArgs.push('-c', opts.context);
    const { stdout } = await run(AX, axArgs, { timeout: timeoutMs, maxBuffer: 1024 * 1024 * 32 });
    return { ok: true, kind, stdout };
  }
  if (kind === 'apertus') {
    const model = lane.invoke.model.startsWith('Apertus-70B') ? 'Apertus-70B' : 'Apertus-8B';
    const result = await apertusChat(
      [
        { role: 'system', content: 'You are the ' + (lane.identity || 'cadre lane') + ' working this task. Be precise. Cite or concede.' },
        { role: 'user', content: task },
      ],
      { model },
    );
    return { ok: true, kind, text: result.text, usage: result.usage };
  }
  if (kind === 'http') {
    throw new Error(`lane ${lane.name}: generic http invoke not configured (endpoint lanes need a driver; apertus has one)`);
  }
  throw new Error(`lane ${lane.name}: no invoke driver for talks=${lane.talks}`);
}
