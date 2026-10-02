# Cadre — Reference Repos

The original reference list (2026-10-01), followed by what was taken from each —
and whether the take has landed in code (verified by tests) or is pending.

## Donors

| Repo | What Cadre takes | Status |
|---|---|---|
| [ponytail](https://github.com/dietrichgebert/ponytail) | "Laziest senior dev" discipline — write only what the ask needs; scope-lock instinct; **reuse-first** (smallest change that works) | ✅ scope lock (`go --scope`, creep rejects at gate) + reuse-first step (`src/reuse.js`) |
| [caveman](https://github.com/juliusbrussee/caveman) | Compressed agent output; every cut byte keeps a restorable backup | ✅ frugal pipes (`src/frugal.js`): collapse/cap before the ledger, original backed up |
| [graphify](https://github.com/Graphify-Labs/graphify) | Living codebase map — symbols, edges, hot zones; no repo re-reads | ✅ map index + graph slice/impact/blast-radius, **EXTRACTED/INFERRED edge tags + path queries** (`src/graph.js`) |
| [Chisel](https://github.com/ckanthony/Chisel) | Patch-scoped edits with enforced path confinement — "precise hands" | ⚠️ partial: scope-lock confinement at the gate; not patch-scoped edits inside the loop |
| [rtk](https://github.com/rtk-ai/rtk) | Filter/compress tool output before model context; **never grow** rule | ✅ frugal pipes: rtk's never-grow rule + savings counters (`src/frugal.js`) |
| [espresso](https://github.com/mirkobozzetto/espresso) | Named persistent agents (identity across runs); riding provider subscriptions | ✅ lane `identity` field in the contract; plan-class lanes ride subscriptions |
| [9router](https://github.com/decolua/9router) | Routing via existing plan logins instead of fresh API keys; multi-tier fallback when a tier runs dry | ⚠️ partial: plan-lane detection + single-tier downshift/wait-for-refill; no multi-tier fallback chains yet |
| [superpowers](https://github.com/obra/superpowers) | Craft as named, versioned skills — how work is done | ✅ lane `craft` field in the contract (closed 7-field schema) |

## Reference implementation

**ax** (private, this machine: `~/.local/bin/ax` → `~/.config/ax/`) — the seed
harness: debate-with-citations, evidence gate, run ledger. `cadre go` wraps
`ax build`; the engine (`gate.js`, `store.js`, `router.js`, `scan.js`,
`chatlane.js`) is cadre-native.

## Landscape (consulted, not donors)

builderz-labs/mission-control (closest competitor) · gastownhall/gastown ·
os-factory/har · smtg-ai/claude-squad · BloopAI/vibe-kanban · cline/kanban ·
snarktank/antfarm · Untrivial-ai/agent-orchestrator · musistudio/claude-code-router ·
KarpelesLab/teamclaude · router-for-me/CLIProxyAPI · awslabs/cli-agent-orchestrator ·
Agent-Field/agentfield · openai/openai-agents-python (#2172) · github/spec-kit ·
giantswarm/muster · ranger360ai/posse · omnigent-ai/omnigent · Starland9/quotarouter ·
Lians-ai/Lians · mohamedzhioua/agent-done-or-not · zhjai/agent-completion-gate ·
LeoStehlik/proof-loop · inchwormz/agent-receipts · sergezuber/FABULA-LLM-5 ·
andreahlert/scope-guard · ssheleg/pod-manifesto · agentsystems/agentsystems-notary

Full citations: `../research/muster-market-20261001-1930/` (six dive reports,
verify.md, insight.md).
