# Cadre

Any model. Any bot. One command.

Cadre is a model-agnostic agent harness that wraps the `ax` consensus harness on
this machine and adds Apertus (Swiss open LLMs) as its reasoning lane. Every
command does real work: state lives under `$CADRE_HOME` (default `~/.cadre`),
builds delegate to `ax build`, evidence gates re-check disk before stamping
anything, and anything not wired says so and exits 2.

## Commands (all real)

| Command | What it actually does |
|---|---|
| `cadre go "<outcome>"` | Scans the roster, routes roles, plans, builds via `ax build`, critiques, runs the project test command, gates on evidence, files the run under `$CADRE_HOME/runs/<id>` |
| `cadre go --dry` | Same routing + pipeline, spends nothing |
| `cadre lanes [--json]` | Live roster: `ax lanes` registry + env-keyed API lanes + local Ollama probe + your `$CADRE_HOME/lanes/*.json`, validated against the contract |
| `cadre plan "<task>"` | Real routing for the task + heuristic token estimates (labeled heuristic; no dollar figures) |
| `cadre meter` | Real usage from run records: apertus call receipts from `audit.log`, run statuses, budget pin |
| `cadre sweep [--all] [--retire <id>] [--resume <id>]` | Triages leftover runs (running/interrupted/gating); retire marks settled, resume re-briefs |
| `cadre map [--rebuild] [--why <symbol>]` | Indexes the repo (files, symbols, import edges, hot zones) into `$CADRE_HOME/maps`; `--why` traces a symbol |
| `cadre proof <run-id>` | Evidence bundle of a local run, or of an ax run (`run-YYYYMMDD-HHMMSS-nnnn`, read from `~/.config/ax/runs`) |
| `cadre watch <run-id>` | Tails a local run log until the run settles (or an ax run log tail) |
| `cadre debate "<q>"` | Two headless ax lanes (glm, grok) argue with rebuttals; transcripts filed under `$CADRE_HOME/debates/` |
| `cadre pin` | Role pins + token budget, persisted to `$CADRE_HOME/pins.json`; the router honors them |
| `cadre mcp` | MCP server on stdio (JSON-RPC 2.0): tools `cadre_lanes`, `cadre_plan`, `cadre_map`, `cadre_proof`, `cadre_meter` |
| `cadre parity "<outcome>" --ref <path-or-id>` | Runs a real `ax build` to parity against the cited reference; files the citation |

## Apertus (Hack Apertus Track 2B)

Apertus is the primary reasoning lane. Export `APERTUS_API_KEY` (and optionally
`APERTUS_BASE_URL`, default `https://api.apertus.ai`) to enable:

- `apertus-8b` - planner class (cheap hand)
- `apertus-70b` - critic/decide class (deciding hand)

Without the key, every Apertus path skips cleanly with a printed reason (no
fake success). The key is read at call time, used in one Authorization header,
never logged or stored; `audit.log` redacts key-shaped fields and stores only a
6-char fingerprint. See `docs/hack-apertus.md`.

## The lane contract

Seven fields: `name`, `identity`, `good_at`, `cost`, `talks`, `proves`, `craft`
(+ free-form `invoke`). Formal schema: `schemas/lane.schema.json`. Declare your
own lanes in `$CADRE_HOME/lanes/*.json`.

## Evidence gate

A run passes only with checkable evidence in all four families: commands with
output, diffs, artifacts that exist on disk at gate time, citations you can
follow. The gate re-runs claimed commands before stamping PROVEN.

## Install and run

Requires Node >= 18, zero npm dependencies. `ax` at `~/.local/bin/ax` (or
override with `CADRE_AX`).

```bash
./bin/cadre.js help
./bin/cadre.js lanes
./bin/cadre.js go "fix the flaky test" --dry
npm test          # node --test; contract + smoke suites
```

## Status

Experiment stage. Honest limits: `go` build quality is ax's; `map` is a
regex-symbol index, not a semantic AST; `debate` transcripts are the citation
record; MCP exposes read-only tools (no `go` through MCP yet).
