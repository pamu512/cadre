# Cadre — PRD v0.3

**Status:** active · **Date:** 2026-10-02
**Supersedes:** PRD-v0.2.md (v0.2 items landed: metrics, resume plans, parity ledger,
citation-existence gate, verifier independence, history-aware routing, cost-as-tiebreak,
fixture-writer command lane, doctor, MCP 10 tools, kill-9 e2e, generated report).

---

## Where we are

72 tests, zero deps, all 15 audit items closed. The repo is provider-neutral
(zero vendor names anywhere; provider lanes live in user JSONs and the upcoming
provider repo). The ledger has 43+ runs with honest verdicts, including two
PROVEN standalone runs and multiple correct rejections (wrong-repo drift,
scope creep, idempotent no-ops, unevidenced builders).

## What v0.3 is for: ship-quality

The harness works for its author. v0.3 makes it work for a stranger: install,
first run, and failure modes that don't require reading the source.

## Requirements (each item = one landing with tests)

- **C1 — `cadre --version` + package metadata**: version flag reads
  package.json; help shows it. Acceptance: `cadre --version` prints
  `cadre <semver>`; test asserts format.
- **C2 — real `npm pack` hygiene**: `npm pack --dry-run` lists only intended
  files (no docs debris, no fixtures beyond examples, no scripts/*.log);
  tarball installs globally via `npm i -g <tarball>` and `cadre doctor` passes
  from a clean directory. Acceptance: pack dry-run output captured in test or
  verified live in session.
- **C3 — README quickstart for a cold machine**: 4-line quickstart (clone,
  install, doctor, go --dry) at the top; Status section stays honest. Acceptance:
  manual verification in session (no test).
- **C4 — `init` command**: `cadre init` scaffolds `$CADRE_HOME` (lanes dir +
  a commented example lane), prints next steps. Idempotent. Acceptance: test
  with temp CADRE_HOME asserting created files and idempotency.
- **C5 — error surfaces**: every command catches missing-arg/missing-run/
  unknown-lane with a one-line fix hint (grep for raw stack leaks in smoke).
  Acceptance: smoke test asserts no "Cannot read properties of null" style
  errors on malformed input across all commands.
- **C6 — sweep --release wiring**: sweep can release stale ax registry claims
  in addition to retiring runs (skill pitfall: orphaned claims block re-runs).
  Acceptance: unit test with mock registry output; live release verified in
  session when an orphan exists.
- **C7 — proof --verify exit codes**: `--verify` exits 3 when bundle fails
  reality checks (distinct from 1 = run not passed) so scripts can distinguish.
  Acceptance: test with fabricated failing bundle.
- **C8 — ledger stats in `lanes`**: `cadre lanes` shows per-lane settled/pass
  counts from history next to each lane (the router's signal, made visible).
  Acceptance: test with fabricated ledger.

## Exit criteria

All C-items land with tests (target ≥ 80), README quickstart real, tarball
installs clean on a cold path, and the provider repo (separate, per standing
rule) can consume cadre as a dependency without vendoring.
