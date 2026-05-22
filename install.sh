#!/usr/bin/env bash
#
# install.sh — minimal Python bootstrap. Finds a working Python ≥ 3.8
# and hands off to scripts/installer.py which does EVERYTHING ELSE
# (detect openclaw, npm-install the plugin, restart gateway, start
# pairing, fire analytics).
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/chat4000/chat4000-openclaw-plugin/main/install.sh | bash
#   curl -fsSL https://raw.githubusercontent.com/chat4000/chat4000-openclaw-plugin/main/install.sh | bash -s -- --no-pair
#
# All flags pass through to installer.py. See `bash install.sh --help`
# (after fetching) for the full list.

set -euo pipefail

REPO_RAW="https://raw.githubusercontent.com/chat4000/chat4000-openclaw-plugin/main"

# Find a usable Python interpreter (≥ 3.8).
find_python() {
  for cand in python3.13 python3.12 python3.11 python3.10 python3.9 python3.8 python3 python; do
    if command -v "$cand" >/dev/null 2>&1; then
      if "$cand" -c 'import sys; sys.exit(0 if sys.version_info >= (3,8) else 1)' 2>/dev/null; then
        printf "%s" "$cand"
        return 0
      fi
    fi
  done
  return 1
}

PY="$(find_python || true)"
if [[ -z "$PY" ]]; then
  printf "\033[1;31m✗\033[0m Need Python ≥ 3.8 on PATH. Install Python first, then re-run.\n" >&2
  exit 1
fi

# Download + run installer.py. Use a temp file so argv is preserved
# (`bash -c "curl ... | python"` would lose them).
TMP="$(mktemp -t chat4000-openclaw-installer.XXXXXX.py)"
trap 'rm -f "$TMP"' EXIT
curl -fsSL "$REPO_RAW/scripts/installer.py" -o "$TMP"
exec "$PY" "$TMP" "$@"
