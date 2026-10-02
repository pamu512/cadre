// invoke - execute work through a lane, whatever it talks.
// terminal (ax lane): delegate to the ax binary. chat kinds (any OpenAI-compatible):
// one POST. The lane contract's `talks` field decides; secrets never leave the
// process that reads them from env.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { chatLane, CHAT_KINDS } from './chatlane.js';

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
  if (CHAT_KINDS.includes(kind)) {
    // any OpenAI-compatible endpoint lane — provider-agnostic driver
    const result = await chatLane(
      lane,
      [
        { role: 'system', content: 'You are the ' + (lane.identity || 'cadre lane') + ' working this task. Be precise. Cite or concede.' },
        { role: 'user', content: task },
      ],
    );
    return { ok: true, kind, text: result.text, usage: result.usage };
  }
  if (kind === 'command') {
    // user lane with a command template: run it with {brief} substituted.
    // B2's local-builder path: any CLI on this machine becomes a builder lane.
    const tpl = String(lane.invoke.command || '');
    if (!tpl) return { ok: false, kind, error: 'invoke.command missing' };
    // split honoring single/double quotes (a plain whitespace split would break
    // any templated argument containing spaces)
    const parts = [];
    const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
    let m;
    while ((m = re.exec(tpl)) !== null) parts.push(m[1] ?? m[2] ?? m[3]);
    let args = parts.slice(1).map((a) => a.replaceAll('{brief}', task));
    if (!tpl.includes('{brief}')) args = [...args, task]; // no placeholder: brief becomes the trailing arg
    try {
      const { stdout } = await run(parts[0], args, { timeout: timeoutMs, maxBuffer: 1024 * 1024 * 16 });
      return { ok: true, kind, stdout };
    } catch (e) {
      return { ok: false, kind, error: String(e.message).slice(0, 500), stdout: e.stdout || '' };
    }
  }
  if (kind === 'http') {
    throw new Error(`lane ${lane.name}: generic http invoke not configured (endpoint lanes need a driver; OpenAI-compatible ones have one)`);
  }
  throw new Error(`lane ${lane.name}: no invoke driver for talks=${lane.talks}`);
}
