# Cadre

> Any model. Any bot. One command.

A model/bot-agnostic agent harness — **experiment stage**. This scaffold wraps the
[ax](~/.config/ax/) consensus harness on this machine: `cadre go` delegates to
`ax build` (plan gate → implement → codex finalize → **evidence gate**), `cadre lanes`
reads the live ax registry and projects it onto the lane contract.

## The lane contract

Seven fields. That's the whole integration story.

```json
{
  "name": "ax-codex",
  "identity": "terra-class",
  "good_at": ["edits", "tests"],
  "cost": "plan",
  "talks": "terminal",
  "proves": "test-output",
  "craft": ["verify-before-claiming"]
}
```

- `name` — kebab-case id
- `identity` — optional named-agent class that persists across runs
- `good_at` — task classes (feeds the router)
- `cost` — `free | metered | plan | rollover | coffee` (coffee = a human)
- `talks` — `terminal | http | stdin | chat`
- `proves` — what checkable evidence this lane produces: `diffs | test-output | commands | artifacts | citations | verdict`
- `craft` — named, versioned skills the lane swears by

Formal schema: [`schemas/lane.schema.json`](schemas/lane.schema.json).
Declare your own lanes in `~/.cadre/lanes/*.json`.

## Run

```bash
./bin/cadre.js help
./bin/cadre.js lanes            # live ax registry + your declared lanes
./bin/cadre.js lanes --json
./bin/cadre.js go "fix the flaky checkout test" --dry   # see the pipeline
./bin/cadre.js go "fix the flaky checkout test"          # actually runs (ax build)
```

Requires Node ≥18. Zero npm dependencies.

## Status

| Command | State |
|---|---|
| `go` | **working** — wraps `ax build` (evidence gate included) |
| `lanes` | **working** — ax registry + user lanes, validated |
| parity / plan / meter / sweep / map / watch / proof / debate / pin / mcp | contract only — honest stubs, exit 2 |

## Design docs

- Concept page: `../V12 Muster.html` (the product story; predates the rename)
- Market research: `../research/muster-market-20261001-1930/`

Name note: "Cadre" chosen after a 17-candidate collision scan (2026-10-01);
"Muster" was dropped — taken twice in-category.
