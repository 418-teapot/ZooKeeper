#!/usr/bin/env bash
# ZooKeeper — Run all tests (Python + TypeScript).
set -euo pipefail

PY_TEST_DIRS=("installer/tests/")

# Auto-discover all *.test.ts files under the plugin source tree plus the
# golden behaviour baseline suite.
TS_TEST_FILES=()
while IFS= read -r -d '' f; do
  TS_TEST_FILES+=("$f")
done < <(find src tests/golden -type f -name '*.test.ts' -print0 | sort -z)

if [ ${#TS_TEST_FILES[@]} -eq 0 ]; then
  echo "ERROR: no *.test.ts files found under src/ or tests/golden/" >&2
  exit 1
fi

# Shared line-coverage threshold for the TypeScript suite and every Rust crate.
COV_THRESHOLD=90

# Rust coverage components are discovered from the workspace manifest so the
# crate list has a single source of truth.
COV_CRATES=()
while IFS= read -r crate; do
  COV_CRATES+=("$crate")
done < <(awk '
  /^\[workspace\]/ { in_ws = 1; next }
  in_ws && /^\[/ { in_ws = 0 }
  in_ws && /^members[[:space:]]*=/ { in_members = 1 }
  in_members {
    n = split($0, fields, "\"")
    for (i = 2; i <= n; i += 2) print fields[i]
    if ($0 ~ /\]/) in_members = 0
  }
' tools/Cargo.toml)

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

section() { printf "\n${CYAN}━━━ %s ━━━${NC}\n" "$1"; }
ok()      { printf "${GREEN}✓ %s${NC}\n" "$1"; }
fail()    { printf "${RED}✖ %s${NC}\n" "$1"; }

FAILED=0

# run_section <title> <label> <command...>: announce <title>, run <command>,
# and print one pass/fail line for <label>.  A failed command sets FAILED so
# the run exits non-zero at the end.
run_section() {
  local title="$1" label="$2"
  shift 2
  section "$title"
  if "$@"; then
    ok "$label"
  else
    fail "$label"
    FAILED=1
  fi
}

# bun does not auto-sync node_modules like uv/cargo do; a stale install makes
# tsc/bun test fail with misleading errors, so bail out early on sync failure.
section "TypeScript dependencies"
if bun install; then
  ok "bun install"
else
  fail "bun install — node_modules could not be synced with package.json/bun.lock"
  exit 1
fi

run_section "Python static tests" "pytest all Python tests" \
  uv run pytest "${PY_TEST_DIRS[@]}" -v

run_section "Rust workspace tests" "cargo test --workspace" \
  env RUSTFLAGS="-D warnings" cargo test --manifest-path tools/Cargo.toml --workspace -- --test-threads=1

# Coverage is mandatory: a missing cargo-llvm-cov or LLVM toolchain fails the
# run instead of silently skipping it.  LLVM tools come from rustup
# (llvm-tools-preview) or a system package manager.
has_llvm_tools() {
  # rustup component — cargo-llvm-cov locates these automatically.
  if rustup component list 2>/dev/null | grep -q 'llvm-tools.*installed'; then
    return 0
  fi
  # System LLVM tools (brew/apt/nix).  When the rustup llvm-tools-preview
  # component is absent, cargo-llvm-cov needs LLVM_PROFDATA/LLVM_COV to
  # point at the system binaries (else it errors "failed to find
  # llvm-tools-preview").  Export them so the run below picks them up.
  local profdata cov
  if profdata="$(command -v llvm-profdata 2>/dev/null)" \
     && cov="$(command -v llvm-cov 2>/dev/null)"; then
    export LLVM_PROFDATA="$profdata"
    export LLVM_COV="$cov"
    return 0
  fi
  return 1
}

section "Rust coverage"
if ! command -v cargo-llvm-cov &>/dev/null; then
  fail "cargo-llvm-cov not found — Rust coverage cannot run"
  echo "   Install: cargo install cargo-llvm-cov"
  FAILED=1
elif ! has_llvm_tools; then
  fail "LLVM tools not available — Rust coverage cannot run"
  echo "   Option A: rustup component add llvm-tools-preview"
  echo "   Option B: install llvm via system package manager (brew/apt/etc.)"
  FAILED=1
else
  COV_OUTPUT=$(RUSTFLAGS="-D warnings" cargo llvm-cov --manifest-path tools/Cargo.toml --workspace --summary-only -- --test-threads=1 2>&1) || true

  if echo "$COV_OUTPUT" | grep -q "llvm-tools"; then
    echo "$COV_OUTPUT"
    fail "llvm-tools not found at runtime — Rust coverage cannot run"
    echo "   Option A: rustup component add llvm-tools-preview"
    echo "   Option B: install llvm via system package manager (brew/apt/etc.)"
    FAILED=1
  else
    echo "$COV_OUTPUT"

    # Aggregate coverage across all source files under a crate prefix.
    crate_cov() {
      # Sum instrumented lines (col 2) and missed lines (col 3) across
      # all files matching prefix.  Columns: path, inst-lines, missed-lines,
      # line-cov%, inst-funcs, missed-funcs, func-cov%, inst-regions,
      # missed-regions, region-cov%, inst-branches, missed-branches, branch-cov%.
      echo "$COV_OUTPUT" | awk -v prefix="$1" '
        $1 ~ prefix {
          lines += $2
          missed += $3
        }
        END {
          if (lines > 0)
            printf "%.2f", (lines - missed) / lines * 100
          else
            print "0"
        }'
    }

    check_cov() {
      local name="$1" cov="$2" thr="$3"
      if [ -z "$cov" ]; then
        fail "$name coverage (could not parse)"
        return 1
      fi
      if ! [[ "$cov" =~ ^[0-9.]+$ ]]; then
        fail "$name coverage (invalid format: $cov)"
        return 1
      fi
      if awk -v c="$cov" -v t="$thr" 'BEGIN{exit (c < t)}'; then
        ok "$name ${cov}% (≥ ${thr}%)"
      else
        fail "$name ${cov}% < ${thr}% threshold"
        return 1
      fi
    }

    # All discovered crates share one threshold; the total line stays
    # non-blocking as before.
    for crate in "${COV_CRATES[@]}"; do
      check_cov "$crate" "$(crate_cov "$crate/src/")" "$COV_THRESHOLD" || FAILED=1
    done
    check_cov "total" \
      "$(echo "$COV_OUTPUT" | awk '/^TOTAL/ {print $4}' | tr -d '%')" \
      "$COV_THRESHOLD" || true
  fi
fi

section "TypeScript type check"
if bunx tsc --noEmit; then
  ok "tsc --noEmit"
else
  fail "tsc --noEmit"
  FAILED=1
fi

section "TypeScript tests"
set +e
TS_OUTPUT=$(bun test --coverage "${TS_TEST_FILES[@]}" 2>&1)
TS_EXIT=$?
set -e

echo "$TS_OUTPUT"

TS_COV=$(echo "$TS_OUTPUT" | awk -F'|' '/All files/ {gsub(/[[:space:]]/, "", $3); print $3}')

if [ -z "$TS_COV" ]; then
  fail "ts coverage (could not parse 'All files' line from coverage output)"
  FAILED=1
elif awk -v cov="$TS_COV" -v thr="$COV_THRESHOLD" 'BEGIN{exit (cov < thr)}'; then
  ok "ts coverage ${TS_COV}%"
else
  fail "ts coverage ${TS_COV}% < ${COV_THRESHOLD}% threshold"
  FAILED=1
fi

if [ $TS_EXIT -ne 0 ]; then
  fail "ts tests (exit code $TS_EXIT)"
  FAILED=1
fi

if [ "$FAILED" -eq 0 ]; then
  section "All tests passed"
else
  section "Some tests failed"
  exit 1
fi
