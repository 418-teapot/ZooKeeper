#!/usr/bin/env bash
#
# scan-secrets.sh — Scan git diff (staged + unstaged) for secrets, keys, credentials
#
# Usage: bash scripts/scan-secrets.sh
# Exit code: 0 = clean, 1 = secrets found (blocks commit)
# Stdout: JSON {"status":"clean"|"found","findings": [...]}
# Stderr: Human-readable color output

set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

SUSPICIOUS_FOUND=0
FINDINGS_ARR=()

echo -e "${YELLOW}Smart Git Commit — 安全检查${NC}" >&2
echo "" >&2

# Determine what to scan
if ! git diff --cached --quiet 2>/dev/null; then
  DIFF_MODE="staged"
  DIFF_CMD="git diff --cached"
  STAGED_FILES=$(git diff --cached --name-only)
  echo -e "正在扫描暂存区变更 ($(echo "$STAGED_FILES" | wc -l) 个文件)..." >&2
elif ! git diff --quiet 2>/dev/null; then
  DIFF_MODE="unstaged"
  DIFF_CMD="git diff"
  echo -e "正在扫描未暂存的变更..." >&2
else
  echo -e "${GREEN}没有需要扫描的变更。${NC}" >&2
  echo '{"status":"clean","findings":[],"message":"没有需要扫描的变更"}'
  exit 0
fi

# Pattern definitions
PATTERNS=()
PATTERN_NAMES=()

add_pattern() {
  local name="$1"
  local regex="$2"
  PATTERNS+=("$regex")
  PATTERN_NAMES+=("$name")
}

# AWS keys
add_pattern "AWS Access Key" "A""KIA[0-9A-Z]{16}"
# GitHub tokens
add_pattern "GitHub Token" "gh[pousr]_[A-Za-z0-9]{36}"
# Stripe keys
add_pattern "Stripe Secret Key" "s""k_(live|test)_[A-Za-z0-9]{24,}"
# Generic API key
add_pattern "API Key" "[Aa][Pp][Ii]_?[Kk][Ee][Yy][[:space:]]*[:=][[:space:]]*[A-Za-z0-9_-]{16,}"
# Passwords
add_pattern "Password" "[Pp][Aa][Ss][Ss][Ww][Oo][Rr][Dd][[:space:]]*[:=][[:space:]]*[A-Za-z0-9!@#$%^&*()_+-=]{8,}"
# Private keys
add_pattern "Private Key" "-----BEGIN (RSA |EC |OPENSSH |DSA |PGP )?PRIVATE KEY-----"
# Bearer tokens
add_pattern "Bearer Token" "[Bb]earer[[:space:]]+[A-Za-z0-9._-]{20,}"
# Connection strings
add_pattern "MongoDB URI" "mongodb://[^:]+:[^@]+@"
add_pattern "PostgreSQL URI" "postgresql://[^:]+:[^@]+@"
add_pattern "MySQL URI" "mysql://[^:]+:[^@]+@"
# Dangerous files
add_pattern "Dangerous file" "\.env$"
add_pattern "Dangerous file" "\.pem$"
add_pattern "Dangerous file" "\.key$"

# Scan diff content
for i in "${!PATTERNS[@]}"; do
  pattern="${PATTERNS[$i]}"
  name="${PATTERN_NAMES[$i]}"

  RESULTS=$($DIFF_CMD | grep -inE "$pattern" 2>/dev/null | head -5 || true)
  if [ -n "$RESULTS" ]; then
    SUSPICIOUS_FOUND=1
    while IFS= read -r line; do
      file_line=$(echo "$line" | cut -d: -f1,2)
      snippet=$(echo "$line" | cut -d: -f3- | sed 's/^[[:space:]]*//' | head -c 80)
      FINDINGS_ARR+=("$(printf '%s' "{\"file\":\"$file_line\",\"line\":$(echo "$file_line" | cut -d: -f2),\"pattern\":\"$name\"}")")
      echo -e "${RED}✗ 发现密钥: $file_line — $name${NC}" >&2
    done <<< "$RESULTS"
  fi
done

# Check for dangerous files in name list
for dangerous_pattern in "\.env$" "\.pem$" "\.key$" "credentials" "secrets" "id_rsa" "id_dsa" "\.keystore"; do
  MATCHES=$($DIFF_CMD --name-only | grep -iE "$dangerous_pattern" 2>/dev/null || true)
  if [ -n "$MATCHES" ]; then
    SUSPICIOUS_FOUND=1
    while IFS= read -r file; do
      FINDINGS_ARR+=("$(printf '%s' "{\"file\":\"$file\",\"line\":0,\"pattern\":\"危险文件类型: $file\"}")")
      echo -e "${RED}✗ 发现密钥: $file — 危险文件类型${NC}" >&2
    done <<< "$MATCHES"
  fi
done

# Build JSON
JSON_FINDINGS="["
FIRST=true
for f in "${FINDINGS_ARR[@]}"; do
  if [ "$FIRST" = true ]; then
    FIRST=false
  else
    JSON_FINDINGS+=","
  fi
  JSON_FINDINGS+="$f"
done
JSON_FINDINGS+="]"

if [ "$SUSPICIOUS_FOUND" -eq 1 ]; then
  echo -e "${RED}✗ 安全检查未通过 — 检测到密钥${NC}" >&2
  echo "{\"status\":\"found\",\"findings\":$JSON_FINDINGS,\"message\":\"检测到密钥 — 提交已阻止\"}"
  exit 1
else
  echo -e "${GREEN}✓ 未发现密钥 — 可安全提交${NC}" >&2
  echo "{\"status\":\"clean\",\"findings\":[],\"message\":\"未发现密钥\"}"
  exit 0
fi
