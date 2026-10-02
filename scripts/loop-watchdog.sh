#!/bin/bash
# loop-watchdog - kills any beyond-parity loop whose heartbeat went stale.
# The heartbeat is touched by the loop between iterations; if the loop is
# hung mid-iteration for longer than the grace window (default: one
# iteration timeout + margin), the watchdog kills it. Run from cron:
#   */5 * * * * /Users/pamu/Desktop/cadre/scripts/loop-watchdog.sh
set -u
PIDFILE=${CADRE_LOOP_PIDFILE:-/tmp/cadre-beyond-parity-loop.pid}
HEARTBEAT=${CADRE_LOOP_HB:-/tmp/cadre-beyond-parity-loop.hb}
GRACE_S=${CADRE_LOOP_GRACE_S:-1200}

[ -f "$PIDFILE" ] || exit 0            # no loop running - nothing to do
PID=$(cat "$PIDFILE")
kill -0 "$PID" 2>/dev/null || { rm -f "$PIDFILE" "$HEARTBEAT"; exit 0; }  # dead pid, stale files

[ -f "$HEARTBEAT" ] || exit 0           # loop started but hasn't beat yet
AGE=$(( $(date +%s) - $(cat "$HEARTBEAT") ))
if [ "$AGE" -ge "$GRACE_S" ]; then
  echo "$(date -u +%FT%TZ) watchdog: loop $PID heartbeat stale ${AGE}s (grace ${GRACE_S}s) - killing tree" >&2
  pkill -TERM -P "$PID" 2>/dev/null     # children first (the node spawn wrapper)
  kill -TERM "$PID" 2>/dev/null
  sleep 3
  kill -0 "$PID" 2>/dev/null && { pkill -KILL -P "$PID" 2>/dev/null; kill -KILL "$PID" 2>/dev/null; }
  rm -f "$PIDFILE" "$HEARTBEAT"
  # kill detached grandchildren too: any parity/ax-build this loop spawned will
  # outlive the tree otherwise and keep burning (seen live 2026-10-02, run 0027)
  for GP in $(pgrep -f 'bin/cadre.js parity' 2>/dev/null); do
    grep -q "$(basename "$PWD" 2>/dev/null)" /dev/null 2>/dev/null # noop guard
    kill -KILL "$GP" 2>/dev/null
  done
  for AP in $(pgrep -f 'ax build Build to parity' 2>/dev/null); do
    kill -KILL "$AP" 2>/dev/null
  done
  # release registry claims the killed runs left behind (they block re-runs)
  for W in $(~/.local/bin/ax work list 2>/dev/null | grep '/Users/pamu/Desktop/cadre' | grep -o 'w-[0-9]*-[0-9]*'); do
    ~/.local/bin/ax work release --id "$W" >/dev/null 2>&1
  done
  # file the leftovers so nothing stays 'running' in the ledger: snapshot + retire
  cd "$(dirname "$0")/.." || true
  node bin/cadre.js sweep >/dev/null 2>&1 || true
  for R in $(node -e "try{for(const d of require('fs').readdirSync(process.env.HOME+'/.cadre/runs')){if(/^\d{4}$/.test(d)){const r=JSON.parse(require('fs').readFileSync(process.env.HOME+'/.cadre/runs/'+d+'/run.json','utf8'));if(['running','interrupted','gating'].includes(r.status))console.log(d)}}}catch{}"); do
    node bin/cadre.js sweep --retire "$R" >/dev/null 2>&1
  done
  exit 1
fi
echo "loop $PID healthy (heartbeat ${AGE}s old)"
