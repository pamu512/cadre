// laneaudit - file usage receipts for chat-lane calls: model, timing, token
// usage. Never the key. Vendor-neutral: any lane's calls land here.
import { audit } from './store.js';

// File an audit event for a chat-lane call: model, timing, token usage - never the key.
export function auditCall(runId, lane, result, error) {
  audit({
    kind: 'lane-call',
    run: runId,
    lane,
    model: result?.model || null,
    usage: result?.usage || null,
    ok: !error,
    error: error ? String(error.message).slice(0, 200) : null,
  });
}
