#!/usr/bin/env bash
# ZooKeeper — Unified check/lint/format script for Python, TypeScript, Rust.
#
# Usage:
#   ./check.sh           # check  (lint + format, auto-fix)
#   ./check.sh lint      # lint   (check only, no auto-fix)
#   ./check.sh format    # format (format only)
set -euo pipefail

MODE="${1:-check}"

PY_FILES="install.py tests/ tools/ tools/zoo-trace core/skills/ wiki/tools/"
TS_DIR="src/"
ZOO_DIR="tools/"

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

# ── Rust ──────────────────────────────────────────────────────────────────
section "Rust ($MODE)"

case "$MODE" in
  check)
    (cd "$ZOO_DIR" && cargo clippy --fix --allow-dirty --allow-staged -- -D warnings) && ok "cargo clippy" || { fail "cargo clippy"; FAILED=1; }
    (cd "$ZOO_DIR" && cargo fmt)                                                    && ok "cargo fmt"    || { fail "cargo fmt"; FAILED=1; }
    ;;
  lint)
    (cd "$ZOO_DIR" && cargo clippy -- -D warnings) && ok "cargo clippy" || { fail "cargo clippy"; FAILED=1; }
    (cd "$ZOO_DIR" && cargo fmt --check)            && ok "cargo fmt"    || { fail "cargo fmt"; FAILED=1; }
    ;;
  format)
    (cd "$ZOO_DIR" && cargo fmt) && ok "cargo fmt" || { fail "cargo fmt"; FAILED=1; }
    ;;
esac

# ── Result ───────────────────────────────────────────────────────────────
if [ "$FAILED" -eq 0 ]; then
  section "All passed"
else
  section "Some checks failed"
  exit 1
fi
