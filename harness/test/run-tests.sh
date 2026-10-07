#!/usr/bin/env bash
# Tests for the ax harness robustness fixes (empty-reply guard, stall audit,
# stale-plan seeding, bg history format, gbot headless lane).
# Unit parts stub the lanes (no model spend). Live parts are opt-in via
# RUN_LIVE=1 (they spend real tokens).
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
AX="$HERE/../ax"
PASS=0; FAIL=0
ok()   { PASS=$((PASS+1)); echo "ok $PASS - $1"; }
fail() { FAIL=$((FAIL+1)); echo "not ok $PASS - $1"; }
note() { echo "# $*"; }

[[ -x "$AX" ]] || { echo "BAIL OUT! ax not found at $AX"; exit 1; }

# ---------- unit: retry_nonempty / stall_exit (source the pre-dispatch top) --
FUNCS=$(mktemp)
sed -n '1,/^# ---------------- global options/p' "$AX" | sed '$d' > "$FUNCS"
# guard: confirm the extraction actually captured the helpers
if ! grep -q '^retry_nonempty()' "$FUNCS"; then
  echo "BAIL OUT! could not extract retry_nonempty from ax (sed range stale?)"; exit 1
fi
if ! grep -q '^stall_exit()' "$FUNCS"; then
  echo "BAIL OUT! could not extract stall_exit from ax"; exit 1
fi
# shellcheck disable=SC1090
source "$FUNCS"
# reap_dead_slots lives past the global-options cut; extract by name
sed -n '/^reap_dead_slots()/,/^}/p' "$AX" >> "$FUNCS"
# shellcheck disable=SC1090
source "$FUNCS" 2>/dev/null || true

# retry_nonempty: succeeds on first try
OUT=$(retry_nonempty t /dev/null sh -c 'echo hello' ) && [[ "$OUT" == "hello" ]] \
  && ok "retry_nonempty passes nonempty first try" || fail "retry_nonempty first try"

# retry_nonempty: retries an empty fn then succeeds (call count proves retry)
CNT_FILE=$(mktemp); echo 0 > "$CNT_FILE"
FLAKY=$(mktemp -d)/flaky.sh
cat > "$FLAKY" <<'EOF'
#!/usr/bin/env bash
n=$(cat "$CNT_FILE"); n=$((n+1)); echo "$n" > "$CNT_FILE"
# shellcheck disable=SC2154
if [[ "$n" -lt 2 ]]; then exit 0; fi   # 1st call: empty success
echo "recovered"
EOF
chmod +x "$FLAKY"
export CNT_FILE
OUT=$(retry_nonempty t /dev/null "$FLAKY")
RC=$?
[[ $RC -eq 0 && "$OUT" == "recovered" && "$(cat "$CNT_FILE")" == "2" ]] \
  && ok "retry_nonempty retries once on empty and recovers" || fail "retry_nonempty retry path (rc=$RC out=$OUT count=$(cat "$CNT_FILE"))"

# retry_nonempty: fails loud after retries exhausted
ALWAYS_EMPTY=$(mktemp -d)/empty.sh
printf '#!/usr/bin/env bash\nexit 0\n' > "$ALWAYS_EMPTY"; chmod +x "$ALWAYS_EMPTY"
OUT=$(retry_nonempty t /dev/null "$ALWAYS_EMPTY" 2>/dev/null); RC=$?
[[ $RC -ne 0 && -z "$OUT" ]] \
  && ok "retry_nonempty fails loud when retries exhausted" || fail "retry_nonempty exhaustion (rc=$RC)"

# stall_exit: writes honest audit + exits 5
DD=$(mktemp -d)
OUT=$(stall_exit "$DD" "autoclaw-review" "empty after retries" 2>&1); RC=$?
[[ $RC -eq 5 && -f "$DD/audit.md" ]] && grep -q "STALLED - autoclaw-review" "$DD/audit.md" \
  && ok "stall_exit writes audit.md and exits 5" || fail "stall_exit (rc=$RC)"

# reap_dead_slots: orphans on ANY lane are freed by a global pass
RQ=$(mktemp -d)/queue; mkdir -p "$RQ/glm/s.stale-glm" "$RQ/autoclaw/s.live-ac"
printf '999999' > "$RQ/glm/s.stale-glm/pid"
printf '%s' "$$" > "$RQ/autoclaw/s.live-ac/pid"
OUT=$(AX_HOME="$RQ/.." reap_dead_slots all 2>&1)
[[ ! -d "$RQ/glm/s.stale-glm" && -d "$RQ/autoclaw/s.live-ac" ]] \
  && ok "reap_dead_slots frees dead-pid slots on any lane, keeps live ones" \
  || fail "reap_dead_slots (out=$OUT stale-gone=$([[ -d $RQ/glm/s.stale-glm ]] && echo no || echo yes) live-kept=$([[ -d $RQ/autoclaw/s.live-ac ]] && echo yes || echo no))"

# ---------- unit: run_grokbot prefers headless gbot --------------------------
GBIN=$(mktemp -d)
mkdir -p "$GBIN/bin"
cat > "$GBIN/bin/gbot" <<'EOF'
#!/usr/bin/env bash
# fake gbot: log args, emit accepted json
echo "$@" >> "$GBT_LOG"
echo '{"accepted":true,"id":"x","kind":"bot"}'
EOF
chmod +x "$GBIN/bin/gbot"
export GBT_LOG="$GBIN/gbot.log"; touch "$GBT_LOG"
# source run_grokbot only (it lives past the dispatch cut)
sed -n '/^run_grokbot()/,/^}/p' "$AX" > "$GBIN/rg.sh"
# stub the GUI fallback so we can detect it firing
printf '\nprintf %%s "GUI-USED"\n' >> "$GBIN/rg.sh"
# shellcheck disable=SC1090
( PATH="$GBIN/bin:$PATH"
  AX_GROKBOT_MODE=auto
  # shellcheck disable=SC1090
  source "$GBIN/rg.sh"
  OUT=$(run_grokbot "test brief")
  echo "$OUT" > "$GBIN/out.txt"
)
grep -q "headlessly via gbot" "$GBIN/out.txt" && grep -q "send" "$GBT_LOG" && ! grep -q "GUI-USED" "$GBIN/out.txt" \
  && ok "run_grokbot delivers headless via gbot (no GUI)" || fail "run_grokbot headless (out=$(cat "$GBIN/out.txt"))"

# ---------- integration: ax stats over a sandboxed AX_HOME -------------------
SB=$(mktemp -d)
export AX_HOME_SB="$SB"
mkdir -p "$SB/debate/20260101-000000-1" "$SB/debate/20260101-000002-2" "$SB/debate/20260101-000003-3" "$SB/runs"
echo "audit" > "$SB/debate/20260101-000000-1/audit.md"                      # completed
: > "$SB/debate/20260101-000002-2/autoclaw-position.md"                     # stalled early (empty file)
printf 'x' > "$SB/debate/20260101-000003-3/autoclaw-position.md"
printf 'x' > "$SB/debate/20260101-000003-3/grok-position.md"                # stalled mid
printf 'run-1\tglm\t0\ts\t5\nrun-2\tglm\t1\ts\t5\nrun-3\tgrok\t0\ts\t9\n' > "$SB/history.tsv"
STATS=$(AX_HOME="$SB" "$AX" stats 2>/dev/null)
grep -q "3 total, 1 completed (33%), 2 stalled" <<<"$STATS" \
  && ok "stats: debate completion math" || fail "stats: completion math ($STATS)"
grep -qE "glm +2 runs, +1 nonzero-exit" <<<"$STATS" \
  && ok "stats: lane volumes" || fail "stats: lane volumes ($STATS)"

# ---------- integration: decide parks a stale inbox plan ---------------------
SB2=$(mktemp -d)
mkdir -p "$SB2/inbox" "$SB2/runs" "$SB2/debate" "$SB2/logs"
printf 'PLAN: an old unrelated task\n\n1. old step\n' > "$SB2/inbox/plan-grokbot.md"
# stub the grok lane binary: headless planning must never really run here
STUBS=$(mktemp -d); mkdir -p "$STUBS/bin"
cat > "$STUBS/hermes-stub" <<'EOF'
#!/usr/bin/env bash
echo "PLAN: stubbed"; echo "1. stub step"
EOF
chmod +x "$STUBS/hermes-stub"
# stub the autoclaw lane too: decide's review stage must not hit the real gateway.
# It emits a JSON envelope shaped like extract_oc_reply expects.
mkdir -p "$STUBS/oc"
cat > "$STUBS/oc/node" <<'EOF'
#!/usr/bin/env bash
# openclaw-agent stub: ignore flags, print one JSON payload with text
for a in "$@"; do :; done
cat <<'JSON'
{"payloads":[{"text":"## CONSENSUS: APPROVE"}]}
JSON
EOF
chmod +x "$STUBS/oc/node"
OUT=$(AX_HOME="$SB2" AX_HERMES_BIN="$STUBS/hermes-stub" AX_CURSOR_BIN=/usr/bin/true AX_OC_NODE="$STUBS/oc/node" AX_OC_CLI=/dev/null "$AX" decide "a brand new task" 2>&1); RC=$?
grep -q "DIFFERENT task" <<<"$OUT" && ls "$SB2/inbox/" | grep -q "^plan-grokbot.stale-" \
  && ok "decide: stale inbox plan parked, not seeded" || fail "decide stale-plan parking (rc=$RC out=$OUT)"

# ---------- integration: bg history row format ------------------------------
SB3=$(mktemp -d)
mkdir -p "$SB3/runs" "$SB3/logs" "$SB3/inbox" "$SB3/queue"
BGID=$(AX_HOME="$SB3" AX_HERMES_BIN="$STUBS/hermes-stub" "$AX" bg glm "health check: reply OK" 2>/dev/null)
sleep 3
grep -qE "^$BGID[[:space:]]+glm[[:space:]]+[0-9]+[[:space:]]+bg" "$SB3/history.tsv" 2>/dev/null \
  && ok "bg: history row is tab-formatted with lane+rc" \
  || fail "bg: history row format (id=$BGID tsv=$(tail -1 "$SB3/history.tsv" 2>/dev/null))"

# ---------- integration: ax status polls without touching lanes ------------
# DONE case: fabricate a completed run (log + .pid + .done) and poll it
SB4=$(mktemp -d)
mkdir -p "$SB4/runs" "$SB4/logs" "$SB4/inbox" "$SB4/queue"
SID="run-20990101-000000-1"
echo "line one" > "$SB4/runs/$SID.log"; echo "line two: done stuff" >> "$SB4/runs/$SID.log"
printf '424242\n' > "$SB4/runs/$SID.pid"
printf 'rc=0 ended=%s\n' "$(date +%s)" > "$SB4/runs/$SID.done"
OUT=$(AX_HOME="$SB4" "$AX" status "$SID" 2>/dev/null); RC=$?
[[ $RC -eq 1 && "$OUT" == "${SID} DONE rc=0"* && "$OUT" == *"last: "*"done stuff"* ]] \
  && ok "status: DONE row with rc + capped tail" || fail "status DONE (rc=$RC out=$OUT)"
OUT=$(AX_HOME="$SB4" "$AX" status "$SID" -q 2>/dev/null)
[[ "$OUT" != *"last:"* ]] \
  && ok "status: -q suppresses tail" || fail "status -q (out=$OUT)"
# RUNNING case: .done absent, pid alive (= this test's pid)
SID2="run-20990101-000000-2"
echo "working..." > "$SB4/runs/$SID2.log"
printf '%s\n' "$$" > "$SB4/runs/$SID2.pid"
OUT=$(AX_HOME="$SB4" "$AX" status "$SID2" 2>/dev/null); RC=$?
[[ $RC -eq 0 && "$OUT" == "${SID2} RUNNING"*"pid=$$"* ]] \
  && ok "status: RUNNING row with live pid" || fail "status RUNNING (rc=$RC out=$OUT)"
# UNKNOWN case
OUT=$(AX_HOME="$SB4" "$AX" status "run-20990101-000000-9" 2>/dev/null); RC=$?
[[ $RC -eq 2 ]] \
  && ok "status: unknown id exits 2" || fail "status unknown (rc=$RC)"
# bg+status end-to-end: launch a stubbed bg run, poll RUNNING then DONE
SB5=$(mktemp -d)
mkdir -p "$SB5/runs" "$SB5/logs" "$SB5/inbox" "$SB5/queue"
SLOW="$STUBS/slow-stub"
printf '#!/usr/bin/env bash\nsleep 2\necho OK\n' > "$SLOW"; chmod +x "$SLOW"
BID=$(AX_HOME="$SB5" AX_HERMES_BIN="$SLOW" "$AX" bg glm "health check" 2>/dev/null)
sleep 0.5
R1=$(AX_HOME="$SB5" "$AX" status "$BID" -q 2>/dev/null); RC1=$?
sleep 3
R2=$(AX_HOME="$SB5" "$AX" status "$BID" -q 2>/dev/null); RC2=$?
[[ $RC1 -eq 0 && "$R1" == *"RUNNING"* && $RC2 -eq 1 && "$R2" == *"DONE rc=0"* ]] \
  && ok "bg+status: RUNNING during run, DONE rc=0 after" \
  || fail "bg+status e2e (r1='$R1' rc1=$RC1 r2='$R2' rc2=$RC2)"
# polling must not create queue slots (lane-free polling)
[[ -z $(find "$SB5/queue" -name 's.*' -type d 2>/dev/null) ]] \
  && ok "status polls occupy no queue slots" \
  || fail "status created queue slots ($(find "$SB5/queue" -name 's.*' | head -2))"

echo
echo "1..$((PASS+FAIL))"
echo "# pass=$PASS fail=$FAIL"
[[ $FAIL -eq 0 ]]
