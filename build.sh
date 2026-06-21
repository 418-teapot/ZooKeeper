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
BIN_DIR="$SCRIPT_DIR/tools/bin"
mkdir -p "$BIN_DIR"

for bin in zwiki zlog zfind zinspect ztrace; do
    path="target/release/$bin"
    if [ -f "$path" ]; then
        cp "$path" "$BIN_DIR/$bin"
        strip "$BIN_DIR/$bin"
        size=$(du -h "$BIN_DIR/$bin" | cut -f1)
        ok "$bin ($size) → $BIN_DIR/$bin"
    else
        echo "  ✖ $bin not found"
    fi
done
