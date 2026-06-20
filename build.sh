#!/usr/bin/env bash
# ZooKeeper — Build Rust CLI tools in release mode.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR/tools"

GREEN='\033[0;32m'
CYAN='\033[0;36m'
NC='\033[0m'

section() { printf "\n${CYAN}━━━ %s ━━━${NC}\n" "$1"; }
ok()      { printf "${GREEN}✓ %s${NC}\n" "$1"; }

section "Release build"
cargo build --release

section "Binaries"
for bin in zlog zfind zinspect; do
    path="target/release/$bin"
    if [ -f "$path" ]; then
        size=$(du -h "$path" | cut -f1)
        ok "$bin ($size) → $SCRIPT_DIR/tools/$path"
    else
        echo "  ✖ $bin not found"
    fi
done
