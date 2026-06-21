#!/usr/bin/env bash
# ZooKeeper — Auto-fix → format → strict lint for Python, TypeScript, Rust.
#
# Phase 1: auto-fix and format (best-effort, failures logged but not fatal).
# Phase 2: strict lint check (any failure fails the script).
set -euo pipefail

PY_FILES="install.py tests/ tools/ core/skills/"
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

# ═══════════════════════════════════════════════════════════════════════════
# Phase 1 — Auto-fix & format (best-effort)
# ═══════════════════════════════════════════════════════════════════════════
section "Phase 1 — Auto-fix & format"

echo "Python …"
uv run ruff check --fix $PY_FILES && ok "ruff fix" || fail "ruff fix"
uv run ruff format $PY_FILES      && ok "ruff format" || fail "ruff format"

echo "TypeScript …"
bunx biome check --error-on-warnings --write "$TS_DIR" && ok "biome fix" || fail "biome fix"

echo "Rust …"
(cd "$ZOO_DIR" && cargo clippy --all-targets --all-features --fix --allow-dirty --allow-staged) && ok "cargo clippy fix" || fail "cargo clippy fix"
(cd "$ZOO_DIR" && cargo fmt) && ok "cargo fmt" || fail "cargo fmt"

# ═══════════════════════════════════════════════════════════════════════════
# Phase 2 — Strict lint (fail on any problem)
# ═══════════════════════════════════════════════════════════════════════════
section "Phase 2 — Strict lint"

echo "Python …"
uv run ruff check $PY_FILES && ok "ruff check" || { fail "ruff check"; FAILED=1; }

echo "TypeScript …"
bunx biome lint --error-on-warnings "$TS_DIR" && ok "biome lint" || { fail "biome lint"; FAILED=1; }
bunx tsc --noEmit && ok "tsc" || { fail "tsc"; FAILED=1; }

echo "Rust …"
# Ban any #[expect(...)] or #[allow(...)] in Rust source — lints must be fixed, not suppressed.
if grep -rn '#\{0,1\}\[\(expect\|allow\)' "$ZOO_DIR" --include='*.rs' 2>/dev/null; then
  fail "no-expect/allow: found forbidden #[expect] or #[allow] — fix the code, don't suppress"
  FAILED=1
else
  ok "no-expect/allow"
fi
(cd "$ZOO_DIR" && cargo clippy --all-targets --all-features -- -D warnings) && ok "cargo clippy" || { fail "cargo clippy"; FAILED=1; }

# ═══════════════════════════════════════════════════════════════════════════
if [ "$FAILED" -eq 0 ]; then
  section "All passed"
else
  section "Some checks failed"
  exit 1
fi
