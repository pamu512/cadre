# Cadre

Any model. Any bot. One command.

Cadre is a model-agnostic agent harness that wraps the `ax` consensus harness on
this machine. Every command does real work: state lives under `$CADRE_HOME`
(default `~/.cadre`), builds delegate to `ax build`, evidence gates re-check disk
before stamping anything, and anything not wired says so and exits 2.

## Commands (all real)

| Command | What it actually does |
|---|---|
| `cadre go "<outcome>"` | Scans the roster, routes roles, plans, builds via `ax build`, critiques, runs the project test command, gates on evidence, files the run under `$CADRE_HOME/runs/<id>` |
| `cadre go --dry` | Same routing + pipeline, spends nothing |
| `cadre doctor` | Cold-machine preflight: node, ax, lanes, env keys, test command — one fix line per problem |
| `cadre lanes [--json]` | Live roster: `ax lanes` registry + env-keyed API lanes + local Ollama probe + your `$CADRE_HOME/lanes/*.json`, validated against the contract |
| `cadre plan "<task>"` | Real routing for the task + heuristic token estimates (labeled heuristic; no dollar figures) |
| `cadre meter` | Real usage from run records: call receipts from `audit.log`, run statuses, budget pin |
| `cadre sweep [--all] [--retire <id>] [--resume <id>]` | Triages leftover runs (running/interrupted/gating); retire marks settled, resume re-briefs |
| `cadre map [--rebuild] [--why <symbol>]` | Indexes the repo (files, symbols, import edges, hot zones) into `$CADRE_HOME/maps`; `--why` traces a symbol |
| `cadre proof <run-id>` | Evidence bundle of a local run, or of an ax run (`run-YYYYMMDD-HHMMSS-nnnn`, read from `~/.config/ax/runs`) |
| `cadre watch <run-id>` | Tails a local run log until the run settles (or an ax run log tail) |
| `cadre debate "<q>"` | Two headless ax lanes (glm, grok) argue with rebuttals; transcripts filed under `$CADRE_HOME/debates/` |
| `cadre pin` | Role pins + token budget, persisted to `$CADRE_HOME/pins.json`; the router honors them |
| `cadre mcp` | MCP server on stdio (JSON-RPC 2.0): tools `cadre_lanes`, `cadre_plan`, `cadre_map`, `cadre_proof`, `cadre_meter` |
| `cadre parity "<outcome>" --ref <path-or-id>` | Runs a real `ax build` to parity against the cited reference; files the citation |

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

Experiment stage. `cadre doctor` preflights a cold machine (one fix line per
problem). The default `go` loop is standalone — any command-kind user lane or
keyed OpenAI-compatible chat lane builds without ax; `--ax` forces the ax
pipeline. MCP exposes 10 tools including `go` (dry) , `sweep`, `watch`, `pin`.
Debate runs a citation check (cited files verified on disk; failures exit 1).
`map` is a regex-symbol index (not a semantic AST) with a warm cache consulted
by `go`/`plan`. `meter` is declare-your-official-rails + real burn — no
scraping. Honest limits: no `npx` publish yet (`npm i -g` from a clone works);
routing history is thin until gated runs accumulate.
