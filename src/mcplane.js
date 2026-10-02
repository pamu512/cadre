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

      // tool choice: name match against the task words, else the first tool
      const words = String(task).toLowerCase().match(/[a-z][a-z-]{3,}/g) || [];
      const pick = list.find((t) => words.some((w) => t.name.toLowerCase().includes(w))) || list[0];

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
