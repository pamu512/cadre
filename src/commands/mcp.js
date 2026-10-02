// mcp - a real MCP server over stdio. JSON-RPC 2.0 per the MCP spec:
// initialize, tools/list, tools/call. Tools are thin wrappers over the same
// functions the CLI uses (no separate code path that can drift into theater).
import { createInterface } from 'node:readline';
import { cmdLanes } from './lanes.js';
import { cmdPlan } from './plan.js';
import { cmdMap } from './map.js';
import { cmdProof } from './proof.js';
import { cmdMeter } from './meter.js';
import { cmdGo } from './go.js';
import { cmdSweep } from './sweep.js';
import { cmdWatch } from './watch.js';
import { cmdPin } from './pin.js';

const SERVER = { name: 'cadre', version: '0.2.0' };

const TOOLS = [
  {
    name: 'cadre_lanes',
    description: 'List the live lane roster: ax registry lanes, env-keyed API lanes, local servers, user-declared lanes.',
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
    description: 'Show the evidence bundle of a run (local id like 0001, or an ax run id run-YYYYMMDD-HHMMSS-nnnn).',
    inputSchema: { type: 'object', properties: { run: { type: 'string' } } },
  },
  {
    name: 'cadre_meter',
    description: 'Show real metered usage recorded so far (chat-lane call receipts from the audit log) and open runs.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'cadre_go',
    description: 'Run the loop for an outcome (scan -> route -> plan -> build -> critique -> verify -> gate). Use dry=true to see routing without spending.',
    inputSchema: {
      type: 'object',
      properties: {
        outcome: { type: 'string' },
        dry: { type: 'boolean', description: 'plan only, no spend' },
        scope: { type: 'string', description: 'scope lock glob; changes outside it reject the run' },
        ax: { type: 'boolean', description: 'force the ax-wrapped pipeline instead of the standalone loop' },
      },
      required: ['outcome'],
    },
  },
  {
    name: 'cadre_sweep', description: 'Find leftover (interrupted/stale) runs and their dispositions.',
    inputSchema: { type: 'object', properties: { all: { type: 'boolean' } } },
  },
  {
    name: 'cadre_watch', description: 'Tail a run log (or replay it if settled).',
    inputSchema: { type: 'object', properties: { run: { type: 'string' }, replay: { type: 'boolean' } }, required: ['run'] },
  },
  {
    name: 'cadre_pin', description: 'Show or set guardrails: role pins, token budget, quiet hours.',
    inputSchema: {
      type: 'object',
      properties: {
        role: { type: 'string', description: '<role>=<lane>' },
        budget: { type: 'number' },
        quiet: { type: 'string', description: 'HH:MM-HH:MM' },
      },
    },
  },
];

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

async function callTool(name, args) {
  const capture = [];
  const origLog = console.log;
  console.log = (...a) => capture.push(a.join(' '));
  try {
    let rc = 0;
    if (name === 'cadre_lanes') rc = await cmdLanes({ json: Boolean(args.json) });
    else if (name === 'cadre_plan') rc = await cmdPlan([String(args.task || '')], {});
    else if (name === 'cadre_map') rc = args.symbol ? await cmdMap([], { why: String(args.symbol) }) : await cmdMap([], {});
    else if (name === 'cadre_proof') rc = await cmdProof(args.run ? [String(args.run)] : [], {});
    else if (name === 'cadre_meter') rc = await cmdMeter([], {});
    else if (name === 'cadre_go') rc = await cmdGo([String(args.outcome || '')], { dry: Boolean(args.dry), scope: args.scope, ax: Boolean(args.ax) });
    else if (name === 'cadre_sweep') rc = await cmdSweep([], { all: Boolean(args.all) });
    else if (name === 'cadre_watch') rc = await cmdWatch([String(args.run || '')], { replay: Boolean(args.replay), timeout: '5' });
    else if (name === 'cadre_pin') rc = await cmdPin([], { role: args.role, budget: args.budget, quiet: args.quiet });
    else return { error: { code: -32601, message: `unknown tool: ${name}` } };
    return { content: [{ type: 'text', text: capture.join('\n') || '(no output)' }], structuredContent: { exit: rc } };
  } finally {
    console.log = origLog;
  }
}

export async function cmdMcp() {
  if (process.stdin.isTTY) {
    console.error('cadre mcp - MCP server speaks JSON-RPC on stdio; connect a client, e.g.');
    console.error('  { "mcpServers": { "cadre": { "command": "node", "args": ["bin/cadre.js", "mcp"] } } }');
    console.error(`tools: ${TOOLS.map((t) => t.name).join(', ')}`);
    return 0;
  }
  start();
  return new Promise(() => {}); // serve until stdin closes
}

function start() {
const rl = createInterface({ input: process.stdin });
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
    const r = await callTool(req.params.name, req.params.arguments || {});
    send({ jsonrpc: '2.0', id: req.id, result: r.result ?? r });
  } else if (req.id !== undefined) {
    send({ jsonrpc: '2.0', id: req.id, error: { code: -32601, message: `method not found: ${req.method}` } });
  }
});
rl.on('close', () => process.exit(0));
}

if (process.env.CADRE_MCP_DEBUG) console.error(`cadre mcp - ${TOOLS.length} tools on stdio`);
