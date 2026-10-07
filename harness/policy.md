# ax policy — model routing, cost & orchestration constitution (v3, 2026-09-30)

## 1. Capability research (web-verified 2026-09-30)

| Capability | Winner | Evidence |
|---|---|---|
| Science/knowledge reasoning | **Grok** | Grok 4.6 leads GPQA 94.9% (mungomash); Grok 4.1: 89% MATH, 72% GPQA-D fast (serenitiesai) |
| Human-preference chat/reasoning | **Grok** | Grok 4.1 LMArena #1-2, 1483 elo thinking / 1465 non (x.ai, llm-stats) |
| Agentic public lane | **Grok** | benchlm: Grok 4.6 69.5 vs GLM-4.7 45.3 (estimated) |
| Long context | **GLM-5.3** | 1M-1.3M tokens vs Grok 4.6 500K (requesty, docsbot, vakati) |
| Tool calling / coding agents | **GLM-5.3** | tool calling + controllable reasoning effort; z.ai Code Bench gains (siliconflow, omniakey) |
| Speed | **GLM-5.3-Flash** | 3.3× faster inference, open weights (startupfortune) |

## 2. Cost ladder (per 1M tokens, list prices, sources vary ±40%)

| Model | Input | Output | Notes |
|---|---|---|---|
| **Ollama local** (qwen3-coder:30b etc.) | $0 | $0 | electricity only; offline |
| **GLM-5.3-Flash** (zai) | $0.075-0.15 | $0.25-0.50 | ~9× cheaper than GLM-5.3; 1M ctx (ampere, codersera, qcode, emergent) |
| **GLM-4.7-Flash** (zai) | ~$0.05 | ~$0.20 | cheapest paid tier (magica, derived) |
| **GLM-4.7** (zai) | $0.60 | $2.20 | (reqkey) |
| **GLM-5.3** (zai) | $0.84-1.40 | $2.64-4.40 | flagship; cache reads from $0.015-0.03 (vakati, reqkey) |
| **Grok 4.6 API** | $2.00 | $6.00 | (anotherwrapper); xAI list |
| **Grok Bot app / Cursor / Codex-CLI** | $0 marginal | $0 marginal | subscription-included |

## 2.5 Model topology (v5, where each family actually runs)

| Family | Runs on | How | Cost |
|---|---|---|---|
| **Grok 4.7/4.6/4.5** (low..xhigh ±fast) | **Cursor headless** | `ax grok` / `run_grok_model` (`-m grok-4.7-xhigh`, `AX_GROK_MODEL`, `AX_GROK_FAST`) | subscription, $0 marginal |
| Grok via GUI / cloud agents | Grok Bot app | `ax grokbot` (also launches Cursor cloud-agent workers) | subscription |
| **GLM 5.3 / 5.3-flash / 4.7** | **Hermes (zai)** | `ax glm`, `ax hermes` (`-m zai/<model>`) | per-token (flash ≈9× cheaper) |
| gemma (Ollama gateway) | Codex CLI | `ax codex` | subscription |
| Neutral judge (debates) | Codex CLI | third family, no stake in the argument | subscription |

Debate roles: grok-side = Grok-on-Cursor (headless, capturable); autoclaw-side = AutoClaw (GLM-5.3 + web). Cross-checks use web-enabled lanes. Grok-on-Cursor failures fall back to GLM with a logged notice; all grok-side calls carry a 240s hard timeout.

## 3. Cost-effectiveness routing (cheapest capable model wins)

Rule: **never pay for capability the task doesn't use.**

| Task shape | Route | Why |
|---|---|---|
| One-word/short classification, extraction, formatting | `zai/glm-5.3-flash` | 9× cheaper; trivially easy tasks |
| Drafts, summaries, routine code edits, tests | flash first, escalate on failure | flash handles most; fallback protects quality |
| Long-context builds, tool-heavy agentic work | `zai/glm-5.3` | 1M ctx + tool calling; still ~2.4× cheaper than Grok |
| Deep reasoning, science, final critique/verification | Grok (grokbot lane) | capability leader where it matters |
| Anything runnable offline / private | Ollama local (qwen3-coder:30b) | $0 |
| GUI chores / browser form-filling | grokbot (subscription) | $0 marginal |
| IDE frontend work | cursor (subscription) | $0 marginal |

Escalation contract: flash attempts → if output fails checks (tests red, plan REJECT, malformed), escalate one rung (flash → glm-5.3 → grok). Escalations are logged in history.tsv.

## 3.5 Universal evidence rule (v6)

**No model, orchestrator, or the harness itself may claim any work is DONE without checkable evidence.** Valid evidence: (a) exact command + real output (test tails with counts, exit codes, git diff --stat), (b) an existing file/diff on disk, (c) a produced artifact, (d) a verifiable citation. Claims without evidence are labeled `## UNVERIFIED` and treated as NOT DONE.

Enforcement (mechanical, not trust-based):
- `ax build` runs an independent **evidence gate** after codex: the harness itself collects machine checks (git status/diff, claimed-file existence, artifact dirs) and a flash-tier judge compares them to codex's report. Final line: `VERDICT: DONE-EVIDENCED` or `VERDICT: INCOMPLETE — <missing>`. UNEVIDENCED builds are reported as NOT DONE.
- `ax decide` debates already enforce citations + mutual cross-checks (§4).
- Codex's finalization prompt bakes the rule in: every claim must carry its command+output; unverifiable items go under `## UNVERIFIED`.

## 3.7 Work registry (v9 — who works on what)

Single source of truth: `~/.config/ax/registry/work.json` via `ax work claim|update|release|list`. All agents/chats across all surfaces (AutoClaw, Hermes, Codex, Cursor CLI/IDE/cloud, Grok Bot cloud agents) must: check `ax work list --repo <r>` before repo work; claim with `--chat <where>`; update status when done/blocked. `ax build` refuses to run on a repo with active entries unless `--override`. AutoClaw's `ax-orchestrator` agent keeps the board true (verify claims, age out stale entries, coordinate conflicts). No parallel boards.

## 3.8 Concurrency rule (v10)

Overload degrades to queueing, never to failure: per-lane slot caps (GLM lanes 2 — zai rate-limits beyond that; autoclaw 2; grok 3; cursor/codex 2), wait-queue with `AX_QUEUE_TIMEOUT` (900s default, then explicit exit 124), stale-slot TTL 30 min for crashed holders, atomic-lock registry writes. Default posture for any new shared resource in the harness: lock or queue, don't race and don't drop.

## 4. Orchestration constitution (v4 — adversarial debate)

1. **Orchestrators:** grokbot (plans) + autoclaw (verifies). They do NOT need to agree.
2. **Agreement path:** autoclaw returns `## CONSENSUS: APPROVE` → plan adopted as-is.
3. **Disagreement → evidence debate.** Each side must produce:
   - `## POSITION` — the plan they stand behind
   - `## REASONING` — why it is better for this task
   - `## COMPROMISES-OK` — what they can concede without harming the outcome
   - `## NON-NEGOTIABLES` — what cannot be accepted, and why
   - `## EVIDENCE` — numbered claims each tied to a real, citable source
4. **Mutual cross-check.** Each side fact-checks the other's evidence with web search: `VERIFIED` / `FABRICATED` / `UNVERIFIABLE` per item. Fabrications sink the claims they supported.
5. **Fact-grounded scoring:** score = verified − 3×fabricated. Higher score wins. Exact tie → neutral judge (questions profile, rubric-bound: fabrications strike claims; verified strengthens; explanation quality breaks ties). Judge TIE → user decides.
6. **User override:** `--override` / `ax override` forces any decision; recorded in the audit.
7. Implementation mandate (**v7 — best in class, always**): every deliverable produced by any lane must meet a best-in-class standard —
   - **autoclaw (frontend/UI)**: design craft, real content, every interaction state (hover/focus/active/empty/loading/error), responsive, accessible, polished detail.
   - **hermes (core/backend/infra)**: correct, secure, performant, well-tested, idiomatic, readable; scoped to plan but never corner-cutting.
   - **cursor (IDE-grade, non-UI)**: correct, idiomatic, performant, proper error handling.
   - **codex (final pass)**: raises implementations to standard — defects, edge cases, error handling, naming, consistency, missing critical tests.
   
8. **Beyond-parity rule (v8):** when an opportunity exists to measurably exceed the spec or reference implementation (performance, robustness, accessibility, UX), implement it — **only with evidence**: benchmark output, before/after numbers, or test results proving the delta. Unevidenced improvement ideas are recorded as `## OPPORTUNITIES` (noted, not claimed). The evidence gate treats an unevidenced beyond-parity claim exactly like any other unevidenced claim: NOT DONE.
Cost-efficiency governs **which model** runs internal plumbing (classification, judges) and research; it NEVER lowers deliverable quality. When quality and cost conflict on a deliverable, quality wins and the run log records the escalation.
8. Codex: final pass only — edits, refactors, tests, running code. No redesigns.
9. Internal harness calls (triage classify, impl-pick, cross-checks when cheap) run on **glm-5.3-flash**; debate positions use flagship tiers; verification searches use web-enabled lanes.
10. Every debate writes a full audit: `~/.config/ax/debate/<ts>/audit.md` (positions, evidence, cross-checks, score, winner, adopted plan).
