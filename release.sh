#!/usr/bin/env bash
# ZooKeeper — Build release tarball via podman on Debian 10.
#
# Produces: release/zookeeper-<VERSION>-linux-gnu-x86_64.tar.gz
#
# The tarball contains pre-built Rust CLI binaries (zwiki, zlog, zfind,
# zinspect, ztrace) plus portable project files.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
cd "$SCRIPT_DIR"

# ── VERSION ────────────────────────────────────────────────────────────────
VERSION="$(git describe --tags --abbrev=0 2>/dev/null || true)"
if [ -z "$VERSION" ]; then
    echo "✖ 错误：找不到 Git 标签，无法确定版本号。"
    echo "  请先通过 git tag 创建一个版本标签（例如 v1.0.0），再运行此脚本。"
    exit 1
fi

IMAGE="zookeeper-build"
TARBALL="zookeeper-${VERSION}-linux-gnu-x86_64.tar.gz"

# ── Staging dir with automatic cleanup ────────────────────────────────────
STAGING="$(mktemp -d)"
CLEANUP="rm -rf \"$STAGING\""
trap "$CLEANUP" EXIT

# ── Step 1: Build inside Debian 10 container ──────────────────────────────
echo "━━━ 步骤 1/4：构建容器 ${IMAGE} ━━━"
podman build -t "$IMAGE" -f Dockerfile.debian10 .

# ── Step 2: Compile in container (source mounted, output on host) ────────
echo "━━━ 步骤 2/4：编译 Rust 工具 ━━━"
podman run --rm -v "$SCRIPT_DIR:/workspace" "$IMAGE" ./build.sh

# Verify build output
if [ ! -f "$SCRIPT_DIR/tools/bin/zlog" ]; then
    echo "✖ 错误：编译失败，找不到二进制文件。" >&2
    exit 1
fi

# ── Step 3: Stage files for packaging ─────────────────────────────────────
echo "━━━ 步骤 3/4：准备打包文件 ━━━"
mkdir -p "$STAGING/zookeeper/tools/bin"
cp "$SCRIPT_DIR/tools/bin/"{zwiki,zlog,zfind,zinspect,ztrace} \
   "$STAGING/zookeeper/tools/bin/"
cp install.py           "$STAGING/zookeeper/"
cp config.toml          "$STAGING/zookeeper/"
cp .env.example         "$STAGING/zookeeper/"
cp AGENTS.md            "$STAGING/zookeeper/"
cp README.md            "$STAGING/zookeeper/"
cp -r src               "$STAGING/zookeeper/"
cp -r vendor            "$STAGING/zookeeper/"
cp -r core              "$STAGING/zookeeper/"
cp -r wiki              "$STAGING/zookeeper/"

# ── Step 4: Package tarball ───────────────────────────────────────────────
echo "━━━ 步骤 4/4：打包发布包 ━━━"
mkdir -p release
tar czf "release/$TARBALL" -C "$STAGING" zookeeper

echo ""
echo "✓ 发布包已生成：release/$TARBALL"
echo "  大小：$(du -h "release/$TARBALL" | cut -f1)"
