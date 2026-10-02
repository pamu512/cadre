#!/bin/bash
# fixture-writer - a generic command-lane builder for fixture-creation briefs.
# Understands briefs of the shape:
#   "create <path> containing the single line: <text>"
# Writes the file (mkdir -p) and prints what it did. Exits 1 on unparseable brief.
BRIEF="$*"
if [[ "$BRIEF" =~ create[[:space:]]+([^[:space:]]+)[[:space:]]+containing[[:space:]]+the[[:space:]]+single[[:space:]]+line:[[:space:]]*(.+)$ ]]; then
  PATH_PART="${BASH_REMATCH[1]}"
  TEXT_PART="${BASH_REMATCH[2]}"
  mkdir -p "$(dirname "$PATH_PART")"
  printf '%s\n' "$TEXT_PART" > "$PATH_PART"
  echo "created $PATH_PART with: $TEXT_PART"
  exit 0
fi
echo "fixture-writer: brief not understood (expected 'create <path> containing the single line: <text>')" >&2
exit 1
