# Vendored `ax` harness

This directory vendors the live consensus harness (`~/.config/ax/ax`, symlinked
from `~/.local/bin/ax`) into the repo so its behaviour is version-controlled,
tested, and reviewable alongside the `cadre` CLI that drives it.

- `ax` — the harness itself (bash). The installed copy is a symlink target at
  `~/.config/ax/ax`; sync after edits (see `test/sync-install.sh`).
- `policy.md` — model-routing constitution (research table + cost ladder).
  Kept in sync with `~/.config/ax/policy.md`.
- `test/run-tests.sh` — unit + sandboxed integration tests. Unit parts stub the
  lanes; no model spend. Run: `bash test/run-tests.sh`.

## 2026-10-07 robustness release

Measured on real history: 31/55 debates stalled with no audit trail; 25 of
them died before any position was written (empty lane replies cascading into
debate with empty positions). This release makes every one of those failure
classes loud, attributable, and recoverable:

1. **Empty-reply guard** (`retry_nonempty`): decide's lane calls (autoclaw
   review, grok plan/rebuttal, cross-checks) retry once on empty/failed output,
   log every empty attempt into the run log, then fail loudly.
2. **Stall audits** (`stall_exit`): any un-recoverable stage writes
   `outcome: STALLED - <stage>` into the debate dir's `audit.md` and exits 5 —
   no more silent deaths. `ax stats` counts these.
3. **Per-task plan seeding**: `ax decide`/`ax build` only seed from
   `plan-grokbot.md` / `plan-approved.md` when the file's first `PLAN:` line
   matches the current task; stale plans are parked to `*.stale-<ts>.md`.
   Cross-task plan inheritance is gone.
4. **Headless grokbot lane**: `run_grokbot` delivers via `gbot send` (patched
   grok-bot-cli, gateway descriptor v3) with verified delivery, falling back to
   GUI keystrokes only when the CLI is unavailable (`AX_GROKBOT_MODE=gui`
   forces GUI; `AX_GROKBOT_TARGET` picks another bot).
5. **`ax stats`**: debate completion rate, stall stages, lane volumes and
   nonzero-exit counts from `history.tsv`.
6. **`ax bg` history rows** are now tab-formatted with lane + exit code
   (previously free-text), so `ax stats`/`ax last` parse them.
7. **Binary overrides** for testability: `AX_HERMES_BIN`, `AX_CURSOR_BIN`,
   `AX_CODEX_BIN`, `AX_OC_NODE`, `AX_OC_CLI`, `AX_AC_RT`.

Fix prompt-rot: the cross-check prompt duplicated "Use web search" — now once.

## 2026-10-07 slot-hygiene release

Grokbot's local-exec daemon SIGKILLs process groups ~5s after the foreground
command exits; ax's EXIT-trap slot release never runs, so killed runs leaked
queue slots. Capacity-2 lanes then read "busy" for up to AX_SLOT_TTL=1800s
(30 min), and only the next call on that SAME lane would reap them —
Grokbot-retried runs queued, timed out (rc 124), and the failure reinforced
itself.

- `reap_dead_slots`: every `slot_acquire` now runs a global pass that frees
  dead-pid slots on ALL lanes (verified live: one `ax glm` call reaped orphans
  on grok + autoclaw simultaneously).
- `AX_SLOT_TTL` default lowered 1800s → 600s: stale slots age out in 10 min
  even if nothing touches the queue.

## 2026-10-07 anti-nesting release
## 2026-10-07 polling release

Live incident: the one-piece-looks build (19:43) had its implement agent shell
out ANOTHER `ax build` for the same task at 20:25; the outer build then waited
70+ min on its own duplicate while holding slots - the "stuck all day" state.

- **Build lock**: one `ax build` per repo. A second invocation (nested or
  parallel) dies fast with explicit guidance ("do NOT nest ax build - edit
  files directly; poll with ax work list / ax status"). Stale locks with a
  dead holder pid are cleared automatically.
- **ANTI-NESTING RULE** added to all three implement-lane prompts: agents
  inside a build are told to edit files and run tests themselves, never
  re-invoke ax build/decide/bg.

`ax bg` previously accepted only lanes — Grokbot-initiated `build`/`decide`
had to run foreground (dying to the daemon's exec deadline) and "polling"
meant rereading logs. Now:

- `ax bg <build|decide|lane> "<prompt>"` backgrounds FULL pipelines:
  prints a run id instantly, survives group-kills, and writes `<id>.pid` +
  `<id>.done` markers alongside the log.
- `ax status <id> [-q]` polls by file inspection only — no lane or queue slot
  is ever occupied by a status check. Exit codes: 0 RUNNING, 1 DONE
  (rc included), 2 unknown. Output carries a capped tail so a chatty build
  can't stall a 10s exec window. Verified live end-to-end on a real build:
  RUNNING (gate → implement → finalize) → DONE rc=0, artifact on disk,
  evidence gate green.

## Install / sync

After editing `harness/ax` here, sync the live copy:

```bash
bash harness/test/sync-install.sh   # backs up ~/.config/ax/ax, copies, chmods
```

Or manually:

```bash
cp harness/ax ~/.config/ax/ax && chmod +x ~/.config/ax/ax
```
