#!/bin/bash
# beyond-parity loop v2 — hardened against the zombie failure mode of v1:
#   1. GATE-AWARE SUCCESS: an iteration only counts when the run settles with a
#      passed gate verdict (read from the ledger, not cadre's exit code —
#      cadre rc=0 just means "launched cleanly").
#   2. WALL-CLOCK BUDGET ENFORCED: per-iteration timeout kills the child; a
#      total loop budget stops everything even if every iteration hangs.
#   3. SELF-REGISTRATION: pidfile + heartbeat; scripts/loop-watchdog.sh kills
#      any loop whose heartbeat went stale, so orphans can't burn tokens.
#   4. CIRCUIT BREAKER: 2 consecutive unproven iterations = stop and file state.
#   5. NO LOG TRUNCATION: appends (v1 wiped its own history with `: >`).
set -u
cd /Users/pamu/Desktop/cadre || exit 1
N=${1:-10}
AX=~/.local/bin/ax
LOG=docs/beyond-parity-runs.log
PIDFILE=${CADRE_LOOP_PIDFILE:-/tmp/cadre-beyond-parity-loop.pid}
HEARTBEAT=${CADRE_LOOP_HB:-/tmp/cadre-beyond-parity-loop.hb}
TOTAL_BUDGET_S=${CADRE_LOOP_TOTAL_S:-3600}   # hard stop for the whole loop
PER_ITER_S=${CADRE_LOOP_ITER_S:-900}         # hard stop per iteration
export PER_ITER_S
echo $$ > "$PIDFILE"

loop_start=$(date +%s)
consecutive_fail=0

heartbeat() { date +%s > "$HEARTBEAT"; }
trap 'rm -f "$PIDFILE" "$HEARTBEAT"' EXIT
heartbeat

declare -a ITEMS=(
  "B2: go --local standalone loop without ax: builder = user lanes (invoke kind command) or a keyed chat lane; plan/critique local scaffold; verify+gate unchanged. Tests with a command-kind lane fixture. Stay in this repo."
  "B3: adapter breadth: detect gemini CLI in scan.js when present; add examples/lanes/generic-cli.json with a {brief} command template. Tests."
  "B4: map warmth: cache map index under CADRE_HOME/maps with mtime invalidation; go/plan consult hot zones as router hints. Tests with a fake cache."
  "B5: frugal pipes: compress builder output before run.log (collapse blank runs, cap 16KB head+tail, saved-bytes counter). Tests."
  "B8: gate hardening: no pass on builder-only evidence; require one command evidence from a non-builder role. gate.js + tests."
  "B9: failure-mode tests: CLI-level kill -9 mid-run found by sweep with snapshot; quiet-hours refusal exit 3; scope-creep rejection exit 1."
  "B10: cadre metrics --report generates docs/BEYOND-PARITY.md from the ledger (iteration, item, verdict, metric moved). Deterministic-regeneration test."
  "B2b: MCP tool for metrics + parity ledger in the mcp server tool list. Tests."
  "B3b: README/help updated for every new flag added by B-items; theater-ban test still green."
  "B10b: docs/BEYOND-PARITY.md generated end-to-end from the live ledger; numbers match ledger exactly."
)

for i in $(seq 1 $N); do
  heartbeat
  now=$(date +%s)
  if [ $((now - loop_start)) -ge "$TOTAL_BUDGET_S" ]; then
    echo "TOTAL BUDGET HIT (${TOTAL_BUDGET_S}s) - stopping" | tee -a "$LOG"; break
  fi

  ITEM="${ITEMS[$(( (i-1) % 10 ))]}"
  TAG="${ITEM%%:*}"; BRIEF="${ITEM#*:}"
  echo "=== iteration $i [$TAG] $(date +%H:%M:%S) ===" | tee -a "$LOG"

  for W in $($AX work list 2>/dev/null | grep '/Users/pamu/Desktop/cadre' | grep -o 'w-[0-9]*-[0-9]*'); do
    $AX work release --id "$W" >/dev/null 2>&1
  done

  node -e "
    const { spawn } = require('node:child_process');
    const c = spawn('node', ['bin/cadre.js', 'parity', process.argv[1], '--ref', 'docs/PRD-v0.2.md', '--budget', '15 min', '--override'], { stdio: 'inherit' });
    const t = setTimeout(() => { try { c.kill('SIGKILL'); } catch {} }, parseInt(process.env.PER_ITER_S || '900', 10) * 1000);
    c.on('exit', (code) => { clearTimeout(t); process.exit(code ?? 0); });
  " "$BRIEF Beyond-parity item $TAG per docs/PRD-v0.2.md. Checkable evidence for every step." >> "$LOG" 2>&1

  # GATE-AWARE verdict: read the run record, not the exit code
  LAST=$(ls ~/.cadre/runs | grep -E '^[0-9]{4}$' | sort | tail -1)
  STATUS=$(node -e "try{const r=JSON.parse(require('fs').readFileSync(process.env.HOME+'/.cadre/runs/${LAST}/run.json','utf8'));console.log(r.status)}catch{console.log('missing')}")
  if [ "$STATUS" = "passed" ]; then
    consecutive_fail=0
    echo "iteration $i [$TAG] PROVEN (run $LAST)" | tee -a "$LOG"
  else
    consecutive_fail=$((consecutive_fail + 1))
    echo "iteration $i [$TAG] NOT PROVEN (run $LAST status=$STATUS) - fail streak $consecutive_fail/2" | tee -a "$LOG"
    node bin/cadre.js sweep --retire "$LAST" >/dev/null 2>&1
    if [ "$consecutive_fail" -ge 2 ]; then
      echo "CIRCUIT BREAKER: 2 consecutive unproven iterations - stopping, leftovers filed" | tee -a "$LOG"; break
    fi
  fi

  npm test >/dev/null 2>&1 || { echo "TESTS FAILING after iteration $i - stopping" | tee -a "$LOG"; break; }
  heartbeat
done
echo "=== loop complete $(date) ===" | tee -a "$LOG"
