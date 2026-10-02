// mcplane - invoke MCP servers as lanes. Speaks JSON-RPC 2.0 over the server's
// stdio (the same protocol cadre itself serves). One call = full lifecycle:
// spawn -> initialize -> tools/list -> pick tool -> tools/call with the brief
// -> shutdown. Timeouts at every step; the server process never leaks.
import { spawn } from 'node:child_process';

const PROTOCOL = '2024-11-05';

export function invokeMcpLane(lane, task, opts = {}) {
  return new Promise((resolve) => {
    const inv = lane.invoke || {};
    const timeoutMs = opts.timeoutMs ?? 120000;
    const child = inv.command
      ? spawn(inv.command, inv.args || [], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env })
      : null;
    if (!child) {
      resolve({ ok: false, error: `mcp lane ${lane.name}: no command (http-only MCP not wired yet)` });
      return;
    }

    let buf = '';
    const replies = [];
    let done = false;
    const timers = [];

    const finish = (result) => {
      if (done) return;
      done = true;
      timers.forEach(clearTimeout);
      try { child.kill('SIGTERM'); } catch { /* already gone */ }
      resolve(result);
    };
    const bail = (msg) => finish({ ok: false, error: msg });

    const guard = (ms, msg) => timers.push(setTimeout(() => bail(`mcp ${lane.name}: ${msg}`), ms));
    guard(timeoutMs, `no reply within ${timeoutMs}ms`);

    child.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) > -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (line) {
          try { replies.push(JSON.parse(line)); } catch { /* non-JSON noise */ }
        }
      }
    });
    child.stderr.on('data', () => { /* server logs; not fatal */ });
    child.on('exit', (code) => { if (!done) bail(`server exited early (code ${code})`); });

    const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n');

    let sentInitialized = false;
    let sentCall = false;
    function pump() {
      const init = replies.find((r) => r.id === 1);
      if (!init) return setTimeout(pump, 200);
      if (init.error) return bail(`initialize rejected: ${init.error.message}`);

      // MCP protocol: the initialized NOTIFICATION must precede any further requests
      if (!sentInitialized) {
        send({ jsonrpc: '2.0', method: 'notifications/initialized' });
        send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
        sentInitialized = true;
      }

      const tools = replies.find((r) => r.id === 2);
      if (!tools) return setTimeout(pump, 200);
      if (tools.error) return bail(`tools/list rejected: ${tools.error.message}`);
      const list = tools.result?.tools || [];
      if (list.length === 0) return bail('server exposes no tools');

      // tool choice: name match against the task words, else the first tool.
      // READ-ONLY by default: write tools require a write verb in the brief or
      // opts.allowWrite - a discovered server must never be mutated by a read.
      const words = String(task).toLowerCase().match(/[a-z][a-z-]{3,}/g) || [];
      const WRITE_V = /^(save|update|set|add|create|record|import|rewrite|diff|delete|remove|sync|configure|link|prepare|start|evaluate)/;
      const wantsWrite = WRITE_V.test(String(task).trim().toLowerCase()) || Boolean(opts.allowWrite);
      const eligible = list.filter((t) => wantsWrite || !WRITE_V.test(t.name));
      if (eligible.length === 0) return bail('all tools are write-type and the brief is read-only (reword the brief or pass allowWrite)');
      const pick = eligible.find((t) => words.some((w) => t.name.toLowerCase().includes(w))) || eligible[0];

      if (!sentCall) {
        if (!child.stdin.writable) return bail('stdin closed before tools/call');
        // most MCP tools take a text-ish arg; find the first string property in the schema
        const props = pick.inputSchema?.properties || {};
        const argName = Object.keys(props).find((k) => props[k]?.type === 'string') || Object.keys(props)[0];
        const args = argName ? { [argName]: task } : {};
        send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: pick.name, arguments: args } });
        sentCall = true;
        guard(60000, 'tools/call timed out');
        return setTimeout(pump, 200);
      }
      const call = replies.find((r) => r.id === 3);
      if (!call) return setTimeout(pump, 200);

      if (call.error) return bail(`tools/call rejected: ${call.error.message}`);
      const content = call.result?.content || [];
      const text = content.map((c) => c.text || '').join('\n').trim();
      finish({
        ok: !call.result?.isError,
        kind: 'mcp',
        tool: pick.name,
        toolsAvailable: list.map((t) => t.name),
        text: text || '(empty response)',
        stdout: text,
      });
    }

    send({
      jsonrpc: '2.0', id: 1, method: 'initialize',
      params: { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'cadre', version: '0.2.0' } },
    });
    pump();
  });
}

// ---- agent mode: chain multiple tool calls per brief ---------------------------
// Keeps ONE server alive across the whole task. Loop: pick tool from the task
// text -> call -> observe -> pick next (from reply text) until no new tool
// matches or maxSteps. Returns every step (tool, args, reply) - the transcript
// IS the evidence, nothing summarized away.
export function invokeMcpAgent(lane, task, opts = {}) {
  return new Promise((resolve) => {
    const inv = lane.invoke || {};
    const timeoutMs = opts.timeoutMs ?? 300000;
    const maxSteps = opts.maxSteps ?? 5;
    const child = inv.command
      ? spawn(inv.command, inv.args || [], { stdio: ['pipe', 'pipe', 'pipe'], env: process.env })
      : null;
    if (!child) {
      resolve({ ok: false, error: `mcp lane ${lane.name}: no command (http-only MCP not wired yet)` });
      return;
    }

    let buf = '';
    let nextId = 1;
    const pending = new Map(); // id -> {resolve}
    const steps = [];
    const tools = [];
    const usedTools = new Set();
    const timers = [];
    let done = false;

    const finish = (result) => {
      if (done) return;
      done = true;
      timers.forEach(clearTimeout);
      try { child.kill('SIGTERM'); } catch { /* gone */ }
      resolve(result);
    };
    const bail = (msg) => finish({ ok: false, error: `mcp agent ${lane.name}: ${msg}`, steps });

    const guard = (ms, msg) => timers.push(setTimeout(() => bail(msg), ms));
    guard(timeoutMs, `no completion within ${timeoutMs}ms`);

    child.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) > -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        try {
          const msg = JSON.parse(line);
          if (msg.id != null && pending.has(msg.id)) {
            pending.get(msg.id)(msg);
            pending.delete(msg.id);
          }
        } catch { /* noise */ }
      }
    });
    child.stderr.on('data', () => {});
    child.on('exit', (code) => { if (!done) bail(`server exited early (code ${code})`); });

    const send = (obj) => child.stdin.write(JSON.stringify(obj) + '\n');
    const request = (method, params) => new Promise((res) => {
      const id = nextId++;
      pending.set(id, res);
      send({ jsonrpc: '2.0', id, method, params });
    });

    const words = (t) => String(t).toLowerCase().match(/[a-z][a-z-]{3,}/g) || [];
    const WRITE_VERBS = /^(save|update|set|add|create|record|import|rewrite|diff|delete|remove|sync|configure|link|prepare|start|evaluate)/;
    const briefWantsWrite = WRITE_VERBS.test(String(task).trim().toLowerCase()) || Boolean(opts.allowWrite);
    const pickTool = (text) => {
      const ws = words(text);
      // rank: unused tools, read/write affinity to the brief, then name-part hits
      const scored = tools
        .filter((t) => !usedTools.has(t.name) && fillable(t))
        .map((t) => {
          const parts = t.name.toLowerCase().split('_');
          const hits = parts.filter((p) => ws.includes(p)).length;
          const isWrite = WRITE_VERBS.test(t.name);
          let score = hits;
          if (briefWantsWrite === isWrite) score += 0.5; // affinity with the brief's intent
          else score -= 0.5;
          return { t, score };
        })
        .filter((x) => x.score > 0.5)
        .sort((a, b) => b.score - a.score);
      // write tools NEVER get picked mid-chain from reply text alone
      if (!briefWantsWrite) {
        const readOnly = scored.filter((x) => !WRITE_VERBS.test(x.t.name));
        return readOnly[0] ? readOnly[0].t : null;
      }
      return scored[0] ? scored[0].t : null;
    };

    // effective type of a schema property, seeing through anyOf (pydantic style)
    const propType = (p) => {
      if (p?.type) return p.type;
      for (const sub of p?.anyOf || []) if (sub.type) return sub.type;
      return null;
    };
    const argFor = (tool, text) => {
      const props = tool.inputSchema?.properties || {};
      const argName = Object.keys(props).find((k) => propType(props[k]) === 'string');
      return argName ? { [argName]: condense(text) } : {};
    };
    // structured replies must not be fed raw into string args: extract the
    // longest string leaf (the meat of the reply), else pass text through.
    const condense = (text) => {
      const t = String(text || '');
      if (!t.trim().startsWith('{') && !t.trim().startsWith('[')) return t;
      let parsed;
      try { parsed = JSON.parse(t); } catch { return t; }
      let best = '';
      const walk = (v) => {
        if (typeof v === 'string') { if (v.length > best.length && v.length <= 4000) best = v; return; }
        if (Array.isArray(v)) return v.forEach(walk);
        if (v && typeof v === 'object') return Object.values(v).forEach(walk);
      };
      walk(parsed);
      return best || t.slice(0, 2000);
    };
    const fillable = (tool) => {
      const props = tool.inputSchema?.properties || {};
      const required = tool.inputSchema?.required || [];
      return required.every((k) => props[k] && (!propType(props[k]) || propType(props[k]) === 'string'));
    };

    (async () => {
      const init = await request('initialize', { protocolVersion: PROTOCOL, capabilities: {}, clientInfo: { name: 'cadre', version: '0.2.0' } });
      if (init.error) return bail(`initialize rejected: ${init.error.message}`);
      send({ jsonrpc: '2.0', method: 'notifications/initialized' });
      const listed = await request('tools/list');
      if (listed.error) return bail(`tools/list rejected: ${listed.error.message}`);
      tools.push(...(listed.result?.tools || []));
      if (tools.length === 0) return bail('server exposes no tools');

      let focus = task;
      for (let step = 0; step < maxSteps; step++) {
        const tool = pickTool(focus);
        if (!tool) break; // no unused tool matches - work is done
        usedTools.add(tool.name);
        const call = await request('tools/call', { name: tool.name, arguments: argFor(tool, focus) });
        const content = call.result?.content || [];
        const text = content.map((c) => c.text || '').join('\n').trim() || '(empty)';
        const errored = Boolean(call.error || call.result?.isError);
        steps.push({ tool: tool.name, args: argFor(tool, focus), reply: text.slice(0, 4000), error: errored });
        if (errored) break;
        focus = text; // next pick reads the last reply
      }

      finish({
        ok: steps.every((s) => !s.error),
        kind: 'mcp-agent',
        toolsAvailable: tools.map((t) => t.name),
        steps,
        text: steps.map((s) => `[${s.tool}] ${s.reply.slice(0, 400)}`).join('\n'),
        stdout: steps.map((s) => `[${s.tool}] ${s.reply}`).join('\n'),
      });
    })().catch((e) => bail(String(e.message).slice(0, 300)));
  });
}
