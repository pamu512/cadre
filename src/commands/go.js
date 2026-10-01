// go — the one command. Wraps the ax harness's build pipeline:
// plan gate -> implement -> codex finalize -> EVIDENCE GATE.
// Nothing counts as done unless backed by checkable evidence.
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

const run = promisify(execFile);
const AX = join(homedir(), '.local/bin/ax');

export async function cmdGo(args, flags) {
  const brief = args.join(' ').trim();
  if (!brief) {
    console.error('cadre go "<outcome>" — what should the cadre do?');
    return 2;
  }

  if (flags.dry) {
    console.log('cadre go (dry) — would ask ax to build:');
    console.log(`  brief: ${brief}`);
    console.log('  pipeline: plan gate -> implement -> codex finalize -> evidence gate');
    return 0;
  }

  if (!existsSync(AX)) {
    console.error('cadre: ax not found at', AX);
    console.error('the go organ wraps ax; install ax first or point CADRE_AX at the binary.');
    return 1;
  }

  console.log(`cadre go — mustering the crew for: ${brief}`);
  const axArgs = ['build', brief];
  if (flags.impl) axArgs.push('--impl', String(flags.impl));
  if (flags.override) axArgs.push('--override');

  try {
    const { stdout } = await run(AX, axArgs, { timeout: 1000 * 60 * 30 });
    process.stdout.write(stdout);
    // ax build ends with an evidence-gate verdict; surface it
    const verdict = /EVIDENCE GATE|## CONSENSUS: (APPROVE|REJECT)/.exec(stdout);
    if (verdict) {
      console.log(`\ncadre gate: ${verdict[0].startsWith('##') ? verdict[1].toLowerCase() : 'checked'}`);
    }
    return 0;
  } catch (err) {
    process.stderr.write(err.stdout || '');
    process.stderr.write(err.stderr || '');
    console.error(`cadre: ax build failed (exit ${err.code})`);
    return err.code || 1;
  }
}
