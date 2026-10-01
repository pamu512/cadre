# Cadre — Product Requirements Document

**Status:** draft for review · **Version:** 0.1 · **Date:** 2026-10-02
**Owner:** pamu · **Repo:** `cadre/` · **Concept page:** `../V1 Cadre.html` · **Research:** `../research/muster-market-20261001-1930/`

---

## 1. Summary

Cadre is a **model/bot-agnostic agent harness**: a local-first CLI that turns any model, CLI agent, GUI bot, MCP server — or human — into an interchangeable **lane**, musters a fitted crew per ask, and refuses to mark work **done** unless a **gate** holds checkable evidence.

One line: **any model, any bot, one command — and done means proven.**

Positioning (from market research, 2026-10-01): the category exists and is newly named ("agent harness" → "meta-harness" / "agent control plane"), but **no shipped product combines lanes + artifact-evidence gating + quota-aware economics + interrupted-run recovery**. Cadre enters as the **completion-authority layer**, not another orchestrator.

## 2. Problem

Agents fail at *stopping*, not starting:

- **Premature termination** = 8.6% of multi-agent failures; **missing/incomplete verification** ≈ 9% (MAST, NeurIPS'25 — arXiv:2503.13657).
- **42% of agent tokens are avoidable** (measured community audit); practitioners report tool-bloat burning 55k tokens before work begins.
- **Gartner: 40% of agentic AI projects canceled by 2027** (cost escalation, weak governance); 71% of orgs use agents, 11% reach production.
- Tooling is fragmented: session managers don't gate; gates don't orchestrate; routers don't read plan quotas; nobody recovers interrupted runs (research-only — "Safe to Resume?", arXiv:2608.29381).

The user runs 3–7 subscriptions/CLIs that don't know about each other, can't prove their own output, and burn paid quota blindly.

## 3. Goals / Non-goals

**Goals**
1. `cadre go "<outcome>"` — the one command: form the crew, run the loop, gate on evidence, file receipts.
2. Universal lane contract (7 fields) adopting what the user already runs — zero enrollment.
3. Evidence gate as completion authority: commands+output, diffs, artifacts, citations — with local audit trail and replay.
4. Meters: burn included quota before metered cents; pace to reset windows; degrade gracefully — never surprise-bill, never die silent.
5. Sweep: interrupted runs (esc / quota-dry / timeout / plan-changed) are discovered, triaged against their ledger, resumed or retired with evidence kept.
6. Surfaces: terminal-first; the same core served inside editor/platform GUIs via an MCP tool head.

**Non-goals**
- Not another kanban / parallel-session manager (Vibe Kanban's sunset is the market's own verdict on that as a standalone).
- Not a framework to code against (CrewAI/LangGraph own that space).
- Not a cloud service: local-first, single-user by default; the ledger is the API.
- Not building models, sandboxes, or IDEs.
- Enterprise/multi-tenant governance: later motion, not the beachhead.

## 4. Users

- **Primary — the AI power user:** runs ≥3 agent subscriptions/CLIs (Claude Code + Codex + a local model is the modal rig); feels token burn, quota cliffs, unprovable "done"; lives in terminal + one editor.
- **Secondary — the prosumer solo dev:** wants crews and parity builds without babysitting; will adopt via `cadre go` and the editor chat surface.
- **Explicitly later — team/compliance buyers:** want audit trails and tamper-evidence (IETF draft-sharif-agent-audit-trail exists); only after the core earns trust.

## 5. Competitive landscape (summary)

| Player | What it has | What it lacks (Cadre's wedge) |
|---|---|---|
| builderz-labs/mission-control (closest; 6.3k★, alpha) | self-hosted lanes (OpenClaw/CC/Codex/frameworks), spend views, LLM-verdict gate, MCP/CLI | artifact-evidence gate (theirs is a verdict string); meters (keyword tiers); sweep (retry counters); editor head |
| Gas Town | roles, Bors verify gates, quota batching, crash persistence | Claude-Code-centric; no cost routing; no human/GUI lanes |
| HAR | best evidence gating (tree-hash commit gate), agent-agnostic | no crews, no routing, lifecycle ends at handoff |
| 9Router / TeamClaude / CLIProxyAPI | real quota-window routing | single-user proxies; no runs, no gate |
| Claude Code stop hooks / Agent Teams | native gating + crews | single-vendor; transcript-only judgment |

**Moats to defend:** meters (least-served pillar), sweep (research-only), artifact-evidence gate as *product* (naming-age microcategory — one cycle to claim it), cross-vendor neutrality + local trust (what incumbents structurally won't ship).

## 6. Requirements

Priorities: **P0** = trust core (without these it isn't Cadre) · **P1** = economics & memory (differentiation) · **P2** = depth features.

### 6.1 Adapter — lanes
- **P0** Lane contract v1: 7 fields (`name, identity?, good_at[], cost, talks, proves, craft[]`) — closed schema, validator shipped (`schemas/lane.schema.json`); user lanes from `~/.cadre/lanes/*.json`.
- **P0** Adapters: `ax` (live today), Claude Code, Codex CLI — adopt binaries the user already runs; no keys beyond what the lane itself owns.
- **P1** Gemini CLI, Cursor, generic-CLI template (talks: terminal/stdin).
- **P2** GUI bots (accessibility/talks:chat), humans (Slack/quiet hours; cost: coffee), MCP-servers-as-lanes.

### 6.2 The loop — `go`
- **P0** `cadre go "<outcome>"` dispatches plan→implement→finalize→evidence-gate via ax (e2e proven 2026-10-01); `--dry` prints the pipeline without spend; detached execution, no wrapper timeout; registry-aware (won't double-claim active work).
- **P1** Standalone loop (own choreography; ax becomes just another adapter).
- **P2** Role-fitted auto-assembly from `good_at` + bench results.

### 6.3 Trust — gate · proof · watch
- **P0** Evidence gate: run ends DONE only with checkable evidence (commands+output, diffs, artifacts, citations); verdict recorded; nothing exits on prose.
- **P0** Run ledger: `~/.cadre/runs/*.log` + lock files (write before work breathes); every ending is a filed state.
- **P0** `cadre proof [run]`: render the bundle from the ledger (cross-checked against reality — files exist, commands re-runnable).
- **P1** `cadre watch [run]` (+ `--replay`): attach to live/finished runs from the ledger; this is the answer to shared-harness contention (lesson from e2e).

### 6.4 Economics — plan · meter · pin
- **P1** `cadre plan "task"`: bench lanes on task class; accuracy-per-dollar ranking; expected spend vs cap — routing shown before any spend.
- **P1** `cadre meter`: multi-provider entitlement ledger (windows, quotas, rollover, resets, pacing projection). **Official rider rails only** (Sign-in-with-ChatGPT-style plan sharing, Gemini credits, API fallback); header telemetry is a clearly-marked fallback, never the identity.
- **P1** `cadre pin`: the only config — pins (lane=role), budget caps per run, quiet hours; unpinned roles stay bench- and meter-routed.
- Included-first ordering; pace-to-window; degrade-on-empty (downshift → park metered behind budget gate → pause with resume plan).

### 6.5 Memory — sweep · map
- **P1** `cadre sweep`: discover leftovers (interrupted/quota-dry/timeout/plan-changed) from ledger+locks; triage with evidence snapshot; resume from checkpoint / re-lock as new run / retire with closure note. **Honest resume:** market "checkpoint + evidence replay + resume plan," never magic (per research: shipped durability ≠ valid recovery).
- **P2** `cadre map`: living codebase graph (symbols/edges/hot zones) kept warm across runs; work memory adjusts routing; 0 full re-reads.

### 6.6 Discipline (scope + tokens)
- **P1** Scope lock: brief → manifest (files, exclusions, done-condition); every loop re-reads it; creep (diff outside the lock) is caught at the gate with the critic's citation. Dogfooded on Cadre's own repo.
- **P2** Frugal pipes (compress tool output before context; compose with rtk-style tooling); patch+confine edits inside the lock.

### 6.7 Depth — parity · debate
- **P2** `cadre parity "match X" --ref`: contract from cited reference (behaviors ↔ checks ↔ citations); unattended loops; parity ledger; stretch items proposed, never smuggled.
- **P2** `cadre debate "q"`: two lanes argue with citation cross-checks; verdict with receipts (ax decide is the working reference implementation).

### 6.8 Surfaces — mcp
- **P1** `cadre mcp`: serve the command set as MCP tools (stdio, local); the platform's agent drives, Cadre runs; editor panel and terminal read the same ledger.

## 7. UX principles

1. One command; everything else is for looking.
2. Zero config by default (`pin` is the only knob, and it's optional).
3. Honesty: no invented metrics; simulated examples badged; unknown values `—`.
4. Local-first: no telemetry; credentials never leave the lane that owns them.
5. The terminal is the protagonist; GUIs are views on the same ledger.

## 8. Success metrics (v0.1 → 0.2)

- **Activation:** first successful `cadre go` < 5 min from clone (no API keys added).
- **Gate precision:** false-DONE rate ≤ 5% on sampled gated runs (audited by `proof --verify`).
- **Economics:** ≥20% median token-burn reduction vs the user's un-harnessed baseline (P1 target; research cites 42% avoidable).
- **Sweep:** ≥90% of interrupted runs resume or retire with evidence intact; 0 silent losses.
- **Trust:** median time for a reviewer to inspect a proof bundle and reach a verdict < 2 min.

## 9. Architecture (current → target)

- **Now (M0):** `cadre` CLI → `ax build` (plan gate → implement → codex finalize → evidence gate); lanes projected from the live ax registry; ledger = ax runs + inbox evidence. Zero npm deps; Node ≥18.
- **Target:** Cadre core owns **router · meters · sweep · gate · ledger**; adapters (incl. ax) plug in via the contract; MCP head serves surfaces; ledger format stable enough for external tools (align with IETF audit-trail draft where sensible).

## 10. Milestones

| M | Name | Ships | Exit criteria |
|---|---|---|---|
| M0 | Scaffold | go (ax-wrapped), lanes, contract+validator | **done** 2026-10-01 (e2e proven, 7/7 tests) |
| M1 | Trust core | standalone gate on runs, proof, watch, ledger v1 | a rejected run and an approved run, both provable from the ledger |
| M2 | Economics | plan, meter (official rails), pin | a run re-routes mid-flight on quota exhaustion; never surprise-bills |
| M3 | Memory | sweep, map | an interrupted run resumes with evidence; repo graph answers "where" without re-reading |
| M4 | Depth & surfaces | parity, debate, mcp | parity build passes a cited gate; editor chat drives the same run |
| M5 | 0.1 public | hardening, docs, trademark screen | external user completes M1 journey unaided |

## 11. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Platform absorption (stop hooks, Agent Teams) | be what incumbents can't: cross-vendor, local, tamper-evident, evidence-first; move within one naming cycle |
| Meter ToS / opaque entitlements | official rider rails only; headers = flagged fallback; degrade gracefully when unreadable |
| ax coupling | ax is one adapter behind the contract; M1 starts extracting the core |
| Our own scope creep | scope lock dogfooded on this repo from M1; every PR's done-condition written before work |
| "Cadre" naming (cleared 2026-10-01; 17-candidate scan) | trademark screen before M5; wordmark + `cadre-cli` handles reserved early |
| Evidence gate gamed by agents (research: reward hacking) | verifier independence (never the builder's transcript alone); tamper-evident ledger; gate checks artifacts, not claims about artifacts |

## 12. Open questions

1. Standalone loop timing: extract at M1, or keep ax-wrap until M2 revenue of attention justifies it?
2. Gate strictness default: fail-closed (block DONE) vs warn-open (flag, allow)? Proposal: fail-closed for `go`, advisory for `debate`.
3. Human-lane UX: Slack app vs plain terminal prompts for quiet-hours sign-off?
4. Monetization: OSS core (MIT, like the scaffold) + paid hosted meters/audit later — or pure OSS? Decide by M4.
5. Ledger format: align to IETF agent-audit-trail draft now (churn risk) or pin v1 and map later?

## 13. References

- Market deep-research (6 dives, ~110 searches, graded): `../research/muster-market-20261001-1930/` (see `insight.md`, `verify.md`)
- Concept page (12-command grammar, anatomy): `../V1 Cadre.html`
- Live harness (reference implementation of debate + evidence gate): `~/.local/bin/ax`, audit at `~/.config/ax/`
- Key external: MAST arXiv:2503.13657 · mission-control (closest competitor) · "Safe to Resume?" arXiv:2608.29381 · IETF draft-sharif-agent-audit-trail
