#!/usr/bin/env bash
# Sync the vendored harness into the live install (~/.config/ax/ax).
# Backs up the current copy first. Run from anywhere.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/../" && pwd)"
SRC="$HERE/ax"
DST="${AX_INSTALL_DST:-$HOME/.config/ax/ax}"
[[ -f "$SRC" ]] || { echo "sync-install: missing $SRC" >&2; exit 1; }
if [[ -f "$DST" ]]; then
  BAK="$DST.bak-$(date +%Y%m%d-%H%M%S)"
  cp "$DST" "$BAK"
  echo "backup: $BAK"
fi
cp "$SRC" "$DST"
chmod +x "$DST"
echo "installed: $DST ($(bash -n "$DST" && echo 'syntax ok'))"
