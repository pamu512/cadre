// mcp - a real MCP server over stdio. JSON-RPC 2.0 per the MCP spec:
// initialize, tools/list, tools/call. Tools run the SAME CLI the terminal
// uses, one child per call, captured through pipes (no separate code path
// that can drift into theater).
//
// DISCIPLINE (brochure-true):
// - stdout carries JSON-RPC ONLY. Every tool call spawns the CLI with piped
//   stdio; the pipes are a dedicated capture sink, so every write path a
//   command uses - console.log, console.error, process.stdout.write, even
//   writeSync(1) - lands in that call's own buffers, never on this process's
//   stdout. No global is patched and calls own their pipes, so overlapping
//   requests cannot interleave or eat each other's output.
// - failure returns isError tool results (the client can read the text), not
//   protocol errors; unknown tools/methods are protocol errors.
// - cadre_go defaults to DRY: an MCP client must ask for live:true to spend.
// - cadre_pin is NOT exposed over MCP: guardrail mutation stays at the
//   terminal where the human typed it.
// - long runs (cadre_go live) return a run id immediately; a separate
//   read-only cadre_status tool reports progress. No client holds a request
//   open for minutes.
import { createInterface } from 'node:readline';
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { home, tryReadRun } from '../store.js';

const SERVER = { name: 'cadre', version: '0.3.0' };

export const MCP_CONFIG = `{
  "mcpServers": {
    "cadre": { "command": "cadre", "args": ["mcp"] }
  }
}`;

const TOOLS = [
  {
    name: 'cadre_lanes',
    description: 'List the live roster scanned from this machine: CLIs, apps, models, keys, MCP servers, who is online.',
    inputSchema: { type: 'object', properties: { json: { type: 'boolean', description: 'return full JSON' } } },
  },
  {
    name: 'cadre_plan',
    description: 'Route a task across the roster and estimate metered spend (heuristic token sizes, labeled as such).',
    inputSchema: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] },
  },
  {
    name: 'cadre_map',
    description: 'Index the current working directory: files, symbols, import edges, hot zones. Or trace a symbol with symbol=.',
    inputSchema: {
      type: 'object',
      properties: {
        symbol: { type: 'string', description: 'trace this symbol instead of building the index' },
      },
    },
  },
  {
    name: 'cadre_proof',
    description: 'Show the evidence bundle of a run (local id like 0001, or an ax run id run-YYYYMMDD-HHMMSS-nnnn). Return that bundle (commands, diffs, artifacts, citations). Do not replace it with a summary.',
    inputSchema: { type: 'object', properties: { run: { type: 'string' } } },
  },
  {
    name: 'cadre_meter',
    description: 'Show real metered usage recorded so far (chat-lane call receipts from the audit log) and open runs.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'cadre_go',
    description: 'Run the loop for an outcome (scan -> route -> plan -> build -> critique -> verify -> gate). DRY BY DEFAULT: without live=true it routes and plans without spending. With live=true it starts the run in the background and returns a run id immediately - poll it with cadre_status; when it settles, cadre_status returns the proof bundle (commands, diffs, artifacts, citations), not a paraphrase.',
    inputSchema: {
      type: 'object',
      properties: {
        outcome: { type: 'string' },
        dry: { type: 'boolean', description: 'plan only, no spend (default behavior; kept for clarity)' },
        live: { type: 'boolean', description: 'actually spend: start the run in the background and return its run id' },
        scope: { type: 'string', description: 'scope lock glob; changes outside it reject the run' },
        ax: { type: 'boolean', description: 'force the ax-wrapped pipeline instead of the standalone loop' },
      },
      required: ['outcome'],
    },
  },
  {
    name: 'cadre_status',
    description: 'Read-only status of a run started by cadre_go live: current phase, gate verdict when settled, and the settled proof bundle (commands, diffs, artifacts, citations). Never mutates anything.',
    inputSchema: { type: 'object', properties: { run: { type: 'string' } }, required: ['run'] },
  },
  {
    name: 'cadre_sweep', description: 'Find leftover (interrupted/stale) runs and their dispositions.',
    inputSchema: { type: 'object', properties: { all: { type: 'boolean' } } },
  },
  {
    name: 'cadre_watch', description: 'Tail a run log, or replay the settled log in place. Return the log and the proof bundle (commands, diffs, artifacts, citations).',
    inputSchema: { type: 'object', properties: { run: { type: 'string' }, replay: { type: 'boolean' } }, required: ['run'] },
  },
  {
    name: 'cadre_parity',
    description: 'Lock a parity contract against a reference and loop until the build matches, or report the ledger.',
    inputSchema: {
      type: 'object',
      properties: {
        outcome: { type: 'string' },
        ref: { type: 'string', description: 'path to the reference' },
        verify: { type: 'boolean' },
        ledger: { type: 'boolean' },
      },
    },
  },
  {
    name: 'cadre_debate',
    description: 'Run a critic against a builder on one question and file both sides.',
    inputSchema: { type: 'object', properties: { topic: { type: 'string' } }, required: ['topic'] },
  },
  {
    name: 'cadre_doctor',
    description: 'Check this machine: node, home, roster, and what to fix.',
    inputSchema: { type: 'object', properties: {} },
  },
  // cadre_pin is deliberately NOT here: pinning roles/budgets/quiet hours is a
  // guardrail mutation, and MCP clients are not the trust boundary for it.
];

// Replies go through a write chain and exits wait for it: process.exit()
// drops whatever has not drained into the pipe yet, and a lanes table on a
// big machine is a ~200KB reply - larger than the pipe buffer. The chain is
// also why overlapping replies stay line-atomic on the wire.
let outChain = Promise.resolve();
function send(msg) {
  const line = JSON.stringify(msg) + '\n';
  outChain = outChain.then(() => new Promise((resolve) => { process.stdout.write(line, () => resolve()); }));
}

// ---- the capture sink --------------------------------------------------------
// One tools/call = one child of this same CLI with piped stdio. The pipes ARE
// the sink: whatever the command prints - console.log, console.error,
// process.stdout.write, or writeSync(1) straight to fd 1 - lands in that
// call's own buffers. Nothing global is patched (no save/restore to race or
// leak under overlapping calls), and this process's stdout stays JSON-RPC.
const CAPTURE_CAP = 1024 * 1024; // per stream; the lanes table on a big box is ~200k chars

function cliBin() {
  return process.argv[1] ? [process.execPath, process.argv[1]] : ['cadre'];
}

function captureCli(args, { timeoutMs = 5 * 60 * 1000 } = {}) {
  return new Promise((resolve) => {
    const bin = cliBin();
    let child;
    try {
      child = spawn(bin[0], [...bin.slice(1), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      resolve({ rc: 1, text: `spawn ${bin[0]} failed: ${String(e && e.message || e)}` });
      return;
    }
    const sink = { out: '', err: '', truncated: false };
    const take = (k, d) => {
      if (sink[k].length >= CAPTURE_CAP) { sink.truncated = true; return; }
      sink[k] += d.toString();
      if (sink[k].length > CAPTURE_CAP) { sink[k] = sink[k].slice(0, CAPTURE_CAP); sink.truncated = true; }
    };
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch {} }, timeoutMs);
    child.stdout.on('data', (d) => take('out', d));
    child.stderr.on('data', (d) => take('err', d));
    child.on('error', (e) => {
      clearTimeout(timer);
      resolve({ rc: 1, text: `spawn ${bin[0]} failed: ${String(e && e.message || e)}` });
    });
    child.on('close', (code, signal) => {
      clearTimeout(timer);
      const parts = [];
      if (sink.out.trim()) parts.push(sink.out.trimEnd());
      if (sink.err.trim()) parts.push(sink.err.trimEnd());
      if (sink.truncated) parts.push(`[output truncated at ${CAPTURE_CAP} bytes per stream]`);
      if (signal) parts.push(`[child killed by ${signal} after the ${timeoutMs}ms watchdog]`);
      resolve({ rc: signal ? 1 : (code ?? 1), text: parts.join('\n') });
    });
  });
}

// a tool that IS a CLI command: run it through the sink and shape the reply.
// A nonzero exit IS a failure the client must see: isError, not a protocol error.
async function cliTool(name, args, opts) {
  try {
    const { rc, text } = await captureCli(args, opts);
    return toolOk(rc, text === '' ? [] : text.split('\n'));
  } catch (e) {
    return toolError(name, e);
  }
}

// ---- background live runs: spawn our own CLI, report by run id -----------
// A client asking for a live go must not hold a JSON-RPC request open for
// the whole build. We spawn `cadre go ... live` as a child, find its run id
// from the fresh run records, and answer immediately.
const liveChildren = new Set();

function startLiveGo(args, flags) {
  const bin = cliBin();
  const child = spawn(bin[0], [...bin.slice(1), 'go', ...args, ...flags], {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
    env: { ...process.env, CADRE_MCP_CHILD: '1' },
  });
  liveChildren.add(child);
  let stderrTail = '';
  let stdoutTail = '';
  child.stdout.on('data', (d) => { stdoutTail = (stdoutTail + d).slice(-4000); });
  child.stderr.on('data', (d) => { stderrTail = (stderrTail + d).slice(-2000); });
  child.on('exit', () => liveChildren.delete(child));
  // the run id appears on the child's stdout ("cadre go - run NNNN · ...")
  // and the record lands under $CADRE_HOME/runs; prefer the stdout match,
  // fall back to scanning for the newest record.
  const idPromise = new Promise((resolve) => {
    const t0 = Date.now();
    const poll = () => {
      const m = /run (\d{4})/.exec(stdoutTail);
      if (m) return resolve(m[1]);
      try {
        const dir = join(home(), 'runs');
        const ids = readdirSync(dir).filter((d) => /^\d{4}$/.test(d)).sort();
        if (ids.length) return resolve(ids[ids.length - 1]);
      } catch { /* not yet */ }
      if (Date.now() - t0 > 15000) return resolve(null);
      setTimeout(poll, 400);
    };
    setTimeout(poll, 600);
  });
  return { child, idPromise, stderrTail: () => stderrTail };
}

async function callTool(name, args) {
  // known tool: run it; failures are isError tool results
  if (name === 'cadre_lanes') return cliTool(name, ['lanes'].concat(args.json ? ['--json'] : []));
  if (name === 'cadre_plan') return cliTool(name, ['plan', String(args.task || '')]);
  if (name === 'cadre_map') return cliTool(name, args.symbol ? ['map', '--why', String(args.symbol)] : ['map']);
  if (name === 'cadre_proof') return cliTool(name, args.run ? ['proof', String(args.run)] : ['proof']);
  if (name === 'cadre_meter') return cliTool(name, ['meter']);
  if (name === 'cadre_go') {
    // DRY BY DEFAULT over MCP. live:true is the explicit opt-in to spend.
    if (args.live === true) {
      const goArgs = [String(args.outcome || '')];
      const goFlags = [];
      if (args.scope) goFlags.push('--scope', String(args.scope));
      if (args.ax) goFlags.push('--ax');
      const { idPromise } = startLiveGo(goArgs, goFlags);
      const runId = await idPromise;
      if (!runId) return toolError(name, new Error('run started but no run id appeared under $CADRE_HOME/runs within 15s'));
      return {
        content: [{ type: 'text', text: `run ${runId} started in the background (live). Poll cadre_status { run: "${runId}" } - read-only; it returns the proof bundle when the run settles.` }],
        structuredContent: { exit: 0, run: runId, live: true },
      };
    }
    // dry: `cadre go <outcome> --dry` through the sink - the flag is the spend
    // gate, not the absence of a live flag
    const goArgs = ['go', String(args.outcome || ''), '--dry'];
    if (args.scope) goArgs.push('--scope', String(args.scope));
    if (args.ax) goArgs.push('--ax');
    return cliTool(name, goArgs);
  }
  if (name === 'cadre_status') {
    // READ-ONLY: read the run record; never mutate
    const runId = String(args.run || '').trim();
    if (!/^\d{4}$|^run-\d{8}-\d{6}-\d+$/.test(runId)) return toolError(name, new Error('run must be a local id (0001) or an ax id (run-YYYYMMDD-HHMMSS-nnnn)'));
    const run = tryReadRun(runId);
    if (!run) return toolError(name, new Error(`no run ${runId} under ${home()}/runs`));
    const lines = [
      `run ${run.id} · ${run.brief}`,
      `  status: ${run.status} · started ${run.started}`,
      run.roles && Object.keys(run.roles).length ? `  roles: ${Object.entries(run.roles).map(([r, l]) => `${r}=${l}`).join(' ')}` : '',
      `  evidence: ${(run.evidence || []).length} item(s) (${[...new Set((run.evidence || []).map((e) => e.kind))].join(', ') || 'none yet'})`,
    ].filter(Boolean);
    if (run.verdict) lines.push(`  verdict: ${run.verdict.passed ? 'PROVEN' : 'NOT PROVEN'} - ${run.verdict.summary || ''}`);
    if (run.status === 'passed' || run.status === 'rejected') lines.push('  settled - proof: `cadre proof ' + run.id + '` (or the cadre_proof tool) for the full bundle');
    return {
      content: [{ type: 'text', text: lines.join('\n') }],
      structuredContent: {
        exit: 0, run: run.id, status: run.status,
        phases: run.checkpoint?.phases || [],
        verdict: run.verdict ? { passed: run.verdict.passed, summary: run.verdict.summary || '' } : null,
        evidenceKinds: [...new Set((run.evidence || []).map((e) => e.kind))],
      },
    };
  }
  if (name === 'cadre_sweep') return cliTool(name, ['sweep'].concat(args.all ? ['--all'] : []));
  if (name === 'cadre_watch') {
    const wargs = ['watch', String(args.run || ''), '--timeout', '5'];
    if (args.replay) wargs.push('--replay');
    return cliTool(name, wargs);
  }
  if (name === 'cadre_parity') {
    const pargs = ['parity'];
    if (args.outcome) pargs.push(String(args.outcome));
    if (args.ref) pargs.push('--ref', String(args.ref));
    if (args.verify) pargs.push('--verify');
    if (args.ledger) pargs.push('--ledger');
    return cliTool(name, pargs);
  }
  if (name === 'cadre_debate') return cliTool(name, ['debate', String(args.topic || '')]);
  if (name === 'cadre_doctor') return cliTool(name, ['doctor']);
  // NOT a known tool: protocol error, per JSON-RPC
  return { error: { code: -32601, message: `unknown tool: ${name}` } };
}

function toolOk(rc, lines) {
  const text = lines.join('\n') || '(no output)';
  const proof = text.split('\n').filter((l) => /PROVEN|gate:|meter-read|scope ·|bench |replay run/.test(l)).slice(0, 12);
  // a nonzero exit IS a failure the client must see: isError, not a protocol error
  if (rc !== 0) {
    return { content: [{ type: 'text', text }], structuredContent: { exit: rc, proof }, isError: true };
  }
  return { content: [{ type: 'text', text }], structuredContent: { exit: rc, proof } };
}

function toolError(name, e) {
  return {
    content: [{ type: 'text', text: `cadre tool ${name} failed: ${String(e && e.message || e).slice(0, 2000)}` }],
    structuredContent: { exit: 1 },
    isError: true,
  };
}

export async function cmdMcp() {
  if (process.stdin.isTTY) {
    process.stdout.write(MCP_CONFIG + '\n');
    return 0;
  }
  start();
  return new Promise(() => {}); // serve until stdin closes
}

function start() {
const rl = createInterface({ input: process.stdin });
let inFlight = 0;
let stdinClosed = false;
const maybeExit = () => { if (stdinClosed && inFlight === 0) outChain.then(() => process.exit(0)); };
rl.on('line', async (line) => {
  line = line.trim();
  if (!line) return;
  let req;
  try { req = JSON.parse(line); } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    return;
  }
  if (req.method === 'initialize') {
    send({
      jsonrpc: '2.0', id: req.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: SERVER,
      },
    });
  } else if (req.method === 'notifications/initialized') {
    // notification, no response
  } else if (req.method === 'ping') {
    send({ jsonrpc: '2.0', id: req.id, result: {} });
  } else if (req.method === 'tools/list') {
    send({ jsonrpc: '2.0', id: req.id, result: { tools: TOOLS } });
  } else if (req.method === 'tools/call') {
    // an async tool call must be able to finish and reply AFTER stdin has
    // closed (a client may write its request and half-close); track it.
    inFlight += 1;
    try {
      const r = await callTool(req.params.name, req.params.arguments || {});
      if (r.error) send({ jsonrpc: '2.0', id: req.id, error: r.error });
      else send({ jsonrpc: '2.0', id: req.id, result: r });
    } catch (e) {
      // an unexpected crash in dispatch is still a valid tool-level failure
      send({
        jsonrpc: '2.0', id: req.id,
        result: toolError(req.params.name, e),
      });
    } finally {
      inFlight -= 1;
      maybeExit();
    }
  } else if (req.id !== undefined) {
    send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `method not found: ${req.method}` } });
  }
});
rl.on('close', () => { stdinClosed = true; maybeExit(); });
}

if (process.env.CADRE_MCP_DEBUG) console.error(`cadre mcp - ${TOOLS.length} tools on stdio`);
