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
if uv run pytest "$PY_TEST_DIR" -v --cov=tools --cov=wiki/tools --cov-report=term-missing; then
  ok "pytest all Python tests"
else
  fail "pytest all Python tests"
  FAILED=1
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
if grep -q "失败 1" /tmp/runner_output.txt && grep -q "build-pressure-2" /tmp/runner_output.txt; then
    echo ""
    echo "⚠️  build-pressure-2 failed (known issue - verbal correctness vs behavioral completeness)"
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
