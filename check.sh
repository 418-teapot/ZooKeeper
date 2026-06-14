#!/usr/bin/env bash
# ZooKeeper — Unified check/lint/format script for Python and TypeScript.
#
# Usage:
#   ./check.sh           # check  (lint + format, auto-fix)
#   ./check.sh lint      # lint   (check only, no auto-fix)
#   ./check.sh format    # format (format only)
set -euo pipefail

MODE="${1:-check}"

PY_FILES="install.py tests/ tools/ tools/zoo-log tools/zoo-trace tools/zoo-inspect"
TS_DIR="src/"

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

section() { printf "\n${CYAN}━━━ %s ━━━${NC}\n" "$1"; }
ok()      { printf "${GREEN}✓ %s${NC}\n" "$1"; }
fail()    { printf "${RED}✖ %s${NC}\n" "$1"; }

FAILED=0

# ── Python ───────────────────────────────────────────────────────────────
section "Python ($MODE)"

case "$MODE" in
  check)
    uv run ruff check --fix $PY_FILES && ok "ruff check" || { fail "ruff check"; FAILED=1; }
    uv run ruff format $PY_FILES      && ok "ruff format" || { fail "ruff format"; FAILED=1; }
    ;;
  lint)
    uv run ruff check $PY_FILES && ok "ruff check" || { fail "ruff check"; FAILED=1; }
    ;;
  format)
    uv run ruff format $PY_FILES && ok "ruff format" || { fail "ruff format"; FAILED=1; }
    ;;
esac

# ── TypeScript ────────────────────────────────────────────────────────────
section "TypeScript ($MODE)"

case "$MODE" in
  check)
    bunx biome check --error-on-warnings --write "$TS_DIR" && ok "biome check" || { fail "biome check"; FAILED=1; }
    bunx tsc --noEmit && ok "tsc --noEmit" || { fail "tsc --noEmit"; FAILED=1; }
    ;;
  lint)
    bunx biome lint --error-on-warnings "$TS_DIR" && ok "biome lint" || { fail "biome lint"; FAILED=1; }
    bunx tsc --noEmit && ok "tsc --noEmit" || { fail "tsc --noEmit"; FAILED=1; }
    ;;
  format)
    bunx biome format --error-on-warnings --write "$TS_DIR" && ok "biome format" || { fail "biome format"; FAILED=1; }
    ;;
esac

# ── Result ───────────────────────────────────────────────────────────────
if [ "$FAILED" -eq 0 ]; then
  section "All passed"
else
  section "Some checks failed"
  exit 1
fi