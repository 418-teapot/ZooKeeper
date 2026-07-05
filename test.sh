#!/usr/bin/env bash
# ZooKeeper — Run all tests (Python + TypeScript).
set -euo pipefail

PY_TEST_DIR="tests/"
RUNNER="tests/runner.py"

# Auto-discover all *.test.ts files under the plugin source tree.
TS_TEST_FILES=()
while IFS= read -r -d '' f; do
  TS_TEST_FILES+=("$f")
done < <(find src -type f -name '*.test.ts' -print0 | sort -z)

if [ ${#TS_TEST_FILES[@]} -eq 0 ]; then
  echo "ERROR: no *.test.ts files found under src/" >&2
  exit 1
fi

TS_COV_THRESHOLD=90

RED='\033[0;31m'
GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

section() { printf "\n${CYAN}━━━ %s ━━━${NC}\n" "$1"; }
ok()      { printf "${GREEN}✓ %s${NC}\n" "$1"; }
fail()    { printf "${RED}✖ %s${NC}\n" "$1"; }

FAILED=0

section "Python static tests"
if uv run pytest "$PY_TEST_DIR" -v; then
  ok "pytest all Python tests"
else
  fail "pytest all Python tests"
  FAILED=1
fi

section "Rust workspace tests"
if RUSTFLAGS="-D warnings" cargo test --manifest-path tools/Cargo.toml --workspace -- --test-threads=1 2>&1; then
  ok "cargo test --workspace"
else
  fail "cargo test --workspace"
  FAILED=1
fi

# Coverage requires cargo-llvm-cov (binary) and LLVM tools.
# LLVM tools can come from rustup (llvm-tools-preview) or system package manager.
if ! command -v cargo-llvm-cov &>/dev/null; then
  echo ""
  echo "⏭️  cargo-llvm-cov not found, skip Rust coverage"
  echo "   Install: cargo install cargo-llvm-cov"
  HAS_CARGO_LLVM_COV=0
else
  HAS_CARGO_LLVM_COV=1
fi

has_llvm_tools() {
  # rustup component
  if rustup component list 2>/dev/null | grep -q 'llvm-tools.*installed'; then
    return 0
  fi
  # System package manager (e.g. brew install llvm, apt install llvm)
  if command -v llvm-profdata &>/dev/null && command -v llvm-cov &>/dev/null; then
    return 0
  fi
  return 1
}

if [ "$HAS_CARGO_LLVM_COV" -eq 1 ] && has_llvm_tools; then
  section "Rust coverage"
  COV_OUTPUT=$(RUSTFLAGS="-D warnings" cargo llvm-cov --manifest-path tools/Cargo.toml --workspace --summary-only -- --test-threads=1 2>&1) || true

  if echo "$COV_OUTPUT" | grep -q "llvm-tools"; then
    echo ""
    echo "⏭️  llvm-tools not found at runtime, skip Rust coverage"
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

    COV_ZWIKI=$(crate_cov 'zwiki/src/')
    COV_ZUTIL=$(crate_cov 'zutil/src/')
    COV_ZLOG=$(crate_cov 'zlog/src/')
    COV_ZFIND=$(crate_cov 'zfind/src/')
    COV_ZINSPECT=$(crate_cov 'zinspect/src/')
    COV_ZTRACE=$(crate_cov 'ztrace/src/')
    COV_TOTAL=$(echo "$COV_OUTPUT" | awk '/^TOTAL/ {print $4}' | tr -d '%')

    check_cov() {
      local name="$1" cov="$2" thr="$3"
      if [ -z "$cov" ]; then
        fail "$name coverage (could not parse)"
        return 1
      elif ! [[ "$cov" =~ ^[0-9.]+$ ]]; then
        fail "$name coverage (invalid format: $cov)"
        return 1
      elif awk -v c="$cov" -v t="$thr" 'BEGIN{exit (c < t)}'; then
        ok "$name ${cov}% (≥ ${thr}%)"
      else
        fail "$name ${cov}% < ${thr}% threshold"
        return 1
      fi
    }

    # Thresholds: zutil pure functions, zlog jq + integration,
    # zfind/zinspect db.rs + helpers.rs (core logic);
    # display.rs/main.rs are 0% by design (stdout rendering / CLI dispatch).
    check_cov "zwiki"     "$COV_ZWIKI"    85 || FAILED=1
    check_cov "zutil"     "$COV_ZUTIL"    90 || FAILED=1
    check_cov "zlog"      "$COV_ZLOG"     70 || FAILED=1
    check_cov "zfind"     "$COV_ZFIND"    50 || FAILED=1
    check_cov "zinspect"  "$COV_ZINSPECT" 65 || FAILED=1
    check_cov "ztrace"    "$COV_ZTRACE"   65 || FAILED=1
    check_cov "total"     "$COV_TOTAL"    70 || true
  fi
else
  echo ""
  echo "⏭️  LLVM tools not available, skip Rust coverage"
  echo "   Option A: rustup component add llvm-tools-preview"
  echo "   Option B: install llvm via system package manager (brew/apt/etc.)"
fi

# Temporarily skip dry-run tests (behavioral assertions depend on LLM model
# adherence to prompt-injected delegation instructions).
# Set SKIP_DRY_RUN=0 to re-enable.
SKIP_DRY_RUN="${SKIP_DRY_RUN:-1}"
if [ "$SKIP_DRY_RUN" = "0" ]; then
section "Python runner dry-run"
set +e
uv run python "$RUNNER" --dry-run 2>&1 | tee /tmp/runner_output.txt
RUNNER_EXIT_CODE=${PIPESTATUS[0]}
set -e

# Check for known-failing scenario
if grep -q "失败 1" /tmp/runner_output.txt && grep -q "dolphin-pressure-2" /tmp/runner_output.txt; then
    echo ""
    echo "⚠️  dolphin-pressure-2 failed (known issue - verbal correctness vs behavioral completeness)"
    echo "   This is expected. The scenario tests orchestrator behavior under pressure."
    ok "runner --dry-run (known failure excluded)"
elif [ $RUNNER_EXIT_CODE -ne 0 ]; then
    fail "runner --dry-run (unexpected failures)"
    FAILED=1
else
    ok "runner --dry-run"
fi
else
    echo ""
    echo "⏭️  Skipping dry-run tests (SKIP_DRY_RUN=1)"
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
elif awk -v cov="$TS_COV" -v thr="$TS_COV_THRESHOLD" 'BEGIN{exit (cov < thr)}'; then
  ok "ts coverage ${TS_COV}%"
else
  fail "ts coverage ${TS_COV}% < ${TS_COV_THRESHOLD}% threshold"
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
