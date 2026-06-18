#!/usr/bin/env python3
"""
Structural health checks for the ZooKeeper wiki (accessed via ~/.zoo/wiki).

Unlike lint.py (which performs deeper structural checks), health.py is purely
deterministic — zero API calls, fast enough to run every session.

Usage:
    python3 wiki/tools/health.py              # print report to stdout
    python3 wiki/tools/health.py --save       # also save to wiki/health-report.md
    python3 wiki/tools/health.py --json       # machine-readable output

Checks:
  - Empty / stub files (pages with no real content beyond frontmatter)
  - Index sync (index.md entries vs actual files on disk)
  - Log coverage (source pages without a corresponding log entry)
  - Frontmatter completeness (required fields + valid enums)

Design boundary:
  health.py = structural integrity, deterministic, run every session
  lint.py   = content quality, semantic (LLM), run periodically
"""

from __future__ import annotations

import argparse
import json
import re
from datetime import date
from pathlib import Path
from typing import Any

# ZooKeeper: health.py is at wiki/tools/health.py
# 3 levels up: tools/ -> wiki/ -> repo root
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
# Wiki is accessed via the user-global ~/.zoo/wiki symlink (portable across
# plugin installations).  Resolve the symlink so that all paths resolve
# under REPO_ROOT for relative path operations.
WIKI_DIR = (Path.home() / ".zoo" / "wiki").resolve()
INDEX_FILE = WIKI_DIR / "index.md"
LOG_FILE = WIKI_DIR / "log.md"

# Minimum content length (excluding frontmatter) to not be considered a stub
STUB_THRESHOLD_CHARS = 100


def read_file(path: Path) -> str:
    return path.read_text(encoding="utf-8") if path.exists() else ""


def all_wiki_pages() -> list[Path]:
    """All .md files in wiki/, excluding meta files."""
    exclude = {
        "index.md",
        "log.md",
        "lint-report.md",
        "health-report.md",
        "overview.md",
        "SCHEMA.md",
    }
    return [
        p
        for p in WIKI_DIR.rglob("*.md")
        if p.name not in exclude
        and "templates" not in p.parts
        and "tools" not in p.parts  # tools/ only has .py files, but be safe
    ]


def strip_frontmatter(content: str) -> str:
    """Remove YAML frontmatter (--- ... ---) from content."""
    if content.startswith("---"):
        end = content.find("---", 3)
        if end != -1:
            return content[end + 3 :].strip()
    return content.strip()


def _wiki_rel(path: Path) -> str:
    """Return path relative to WIKI_DIR (wiki-root-relative, no ``wiki/`` prefix).

    Used for cross-references, index entries, log ``<path>`` and for matching
    against wiki-root-relative values returned by index / log parsers.
    """
    try:
        return str(path.relative_to(WIKI_DIR))
    except ValueError:
        return str(path)


# ── Check: Empty / Stub files ───────────────────────────────────────


def check_empty_files(
    pages: list[Path], threshold: int = STUB_THRESHOLD_CHARS
) -> list[dict]:
    """Find wiki pages that are empty or contain only frontmatter / minimal content."""
    results = []
    for p in pages:
        raw = read_file(p)
        body = strip_frontmatter(raw)
        if len(body) < threshold:
            results.append(
                {
                    "path": _wiki_rel(p),
                    "total_bytes": len(raw),
                    "body_bytes": len(body),
                    "status": "empty" if len(body) == 0 else "stub",
                }
            )
    results.sort(key=lambda x: x["body_bytes"])
    return results


# ── Check: Index sync ───────────────────────────────────────────────


def _parse_index_links(index_content: str) -> set[str]:
    """Extract markdown link targets from index.md.

    Matches patterns like: [Title](wiki/type/slug.md)
    Returns set of relative paths (e.g. 'wiki/type/slug.md').
    """
    return set(re.findall(r"\[.*?\]\(([^)]+\.md)\)", index_content))


def check_index_sync(pages: list[Path]) -> dict:
    """Compare wiki/index.md entries against actual files on disk.

    Returns:
        {
            "in_index_not_on_disk": [...],   # stale index entries
            "on_disk_not_in_index": [...],   # missing from index
        }
    """
    index_content = read_file(INDEX_FILE)
    index_links = _parse_index_links(index_content)

    # Meta pages that are not listed as index entries under per-type sections.
    # Exclude them from both sides to avoid false positives.
    meta_pages = {"overview.md"}

    index_paths = set()
    for link in index_links:
        resolved = (WIKI_DIR / link).resolve()
        if resolved.name not in meta_pages:
            index_paths.add(resolved)

    disk_paths = set()
    for p in pages:
        if p.name not in meta_pages:
            disk_paths.add(p.resolve())

    in_index_not_on_disk = [
        _wiki_rel(p) for p in sorted(index_paths - disk_paths)
    ]
    on_disk_not_in_index = [
        _wiki_rel(p) for p in sorted(disk_paths - index_paths)
    ]

    return {
        "in_index_not_on_disk": in_index_not_on_disk,
        "on_disk_not_in_index": on_disk_not_in_index,
    }


# ── Check: Log coverage ────────────────────────────────────────────


def _parse_log_entries(log_content: str) -> set[str]:
    """Extract paths from log.md entries.

    ZooKeeper log format:
        ## [<YYYY-MM-DD>] <op> | <path> | <action> — <note>
    Returns set of relative paths (e.g. 'wiki/sources/adr/some-file.md').
    """
    return set(
        m.group(1).strip()
        for m in re.finditer(
            r"^## \[\d{4}-\d{2}-\d{2}\] \w+ \| ([^|]+) \|",
            log_content,
            re.MULTILINE,
        )
    )


def _parse_frontmatter_title(content: str) -> str:
    """Extract and lightly unescape a frontmatter title scalar.

    Handles YAML-escaped quotes (e.g. title: "few \"people\" laptop")
    so that log coverage matching doesn't false-positive on escaped strings.
    """
    match = re.search(r"^title:\s*(.+?)\s*$", content, re.MULTILINE)
    if not match:
        return ""
    raw = match.group(1).strip()
    # Strip surrounding quotes and unescape inner ones
    if len(raw) >= 2 and raw[0] == raw[-1] == '"':
        raw = raw[1:-1]
        raw = raw.replace(r"\"", '"').replace(r"\'", "'").replace(r"\\", "\\")
    elif len(raw) >= 2 and raw[0] == raw[-1] == "'":
        raw = raw[1:-1].replace("''", "'")
    return raw.strip().lower()


def check_log_coverage(pages: list[Path]) -> list[dict]:
    """Find source pages that have no corresponding log entry in log.md.

    Only checks wiki/sources/ (adr/, rfc/, notes/) — entity/concept pages
    are created as side-effects of ingest and don't need their own log entry.
    """
    log_content = read_file(LOG_FILE)
    logged_paths = _parse_log_entries(log_content)

    source_dir = WIKI_DIR / "sources"
    if not source_dir.exists():
        return []

    source_pages = sorted(source_dir.rglob("*.md"))

    missing = []
    for p in source_pages:
        rel_path = _wiki_rel(p)

        # Match by wiki-root-relative path against logged paths
        if rel_path not in logged_paths:
            content = read_file(p)
            fm_title = _parse_frontmatter_title(content)
            missing.append(
                {
                    "path": rel_path,
                    "slug": p.stem,
                    "title": fm_title or p.stem,
                }
            )

    return missing


# ── Check: Frontmatter completeness ──────────────────────────────


def _parse_frontmatter(content: str) -> dict[str, Any]:
    """Minimal YAML frontmatter parser.

    Handles ``key: value`` pairs and YAML list syntax (both inline ``[a, b]``
    and block ``- a\\n- b``). Returns a dict with raw string/list values.

    Adapted from lint.py's ``_parse_frontmatter``.
    """
    fm: dict[str, Any] = {}
    fm_match = re.match(r"^---\s*$", content, re.MULTILINE)
    if not fm_match:
        return fm
    end = fm_match.end()
    fm_end = re.search(r"^---\s*$", content[end:], re.MULTILINE)
    if not fm_end:
        return fm
    raw = content[end : end + fm_end.start()].strip()

    current_key: str | None = None
    list_accum: list[str] = []

    for line in raw.split("\n"):
        stripped = line.strip()
        if stripped.startswith("- ") and current_key is not None:
            list_accum.append(stripped[2:].strip())
            continue

        if current_key is not None and list_accum:
            fm[current_key] = list_accum
            list_accum = []

        if not stripped or stripped.startswith("#"):
            if not stripped:
                current_key = None
            continue

        if ":" in stripped and not stripped.startswith("-"):
            colon_idx = stripped.index(":")
            current_key = stripped[:colon_idx].strip()
            value_part = stripped[colon_idx + 1 :].strip()

            if value_part.startswith("[") and value_part.endswith("]"):
                items = [
                    item.strip().strip('"').strip("'")
                    for item in value_part[1:-1].split(",")
                ]
                items = [i for i in items if i]
                fm[current_key] = items
                list_accum = []
            elif value_part:
                value_part = value_part.strip('"').strip("'")
                fm[current_key] = value_part
                list_accum = []
            else:
                list_accum = []
        else:
            current_key = None

    if current_key is not None and list_accum:
        fm[current_key] = list_accum

    return fm


REQUIRED_FRONTMATTER_FIELDS = [
    "title",
    "type",
    "created",
    "updated",
    "tags",
    "status",
]
VALID_TYPES = {"concept", "entity", "source", "analysis", "synthesis"}
VALID_STATUSES = {"draft", "review", "stable", "deprecated"}


def _parse_date(date_str: str) -> date | None:
    """Parse YYYY-MM-DD string, return ``date`` or ``None``."""
    try:
        return date.fromisoformat(date_str.strip())
    except (ValueError, AttributeError):
        return None


def check_frontmatter(pages: list[Path]) -> list[dict]:
    """Verify every page has required frontmatter fields with valid values.

    Checks:
      - Required fields: title, type, created, updated, tags, status
      - Valid type enum: concept/entity/source/analysis/synthesis
      - Valid status enum: draft/review/stable/deprecated
      - Valid date format (YYYY-MM-DD) for created and updated
    """
    results: list[dict] = []
    for page in pages:
        content = read_file(page)
        if not content:
            continue
        fm = _parse_frontmatter(content)
        rel = _wiki_rel(page)

        if not fm:
            results.append(
                {
                    "page": rel,
                    "issue": "missing_frontmatter",
                    "details": "No YAML frontmatter found",
                }
            )
            continue

        for field in REQUIRED_FRONTMATTER_FIELDS:
            if field not in fm:
                results.append(
                    {
                        "page": rel,
                        "issue": f"missing_field:{field}",
                        "details": f"Required frontmatter field '{field}' is missing",
                    }
                )

        page_type = fm.get("type")
        if page_type is not None and page_type not in VALID_TYPES:
            results.append(
                {
                    "page": rel,
                    "issue": f"invalid_type:{page_type}",
                    "details": f"Type '{page_type}' is not valid. Must be one of: {', '.join(sorted(VALID_TYPES))}",
                }
            )

        status = fm.get("status")
        if status is not None and status not in VALID_STATUSES:
            results.append(
                {
                    "page": rel,
                    "issue": f"invalid_status:{status}",
                    "details": f"Status '{status}' is not valid. Must be one of: {', '.join(sorted(VALID_STATUSES))}",
                }
            )

        for date_field in ("created", "updated"):
            val = fm.get(date_field)
            if val and _parse_date(str(val)) is None:
                results.append(
                    {
                        "page": rel,
                        "issue": f"invalid_date:{date_field}",
                        "details": f"Field '{date_field}' value '{val}' is not a valid YYYY-MM-DD date",
                    }
                )

    return results


# ── Report Generation ───────────────────────────────────────────────


def run_health() -> dict:
    """Run all health checks, return structured results."""
    pages = all_wiki_pages()

    return {
        "date": date.today().isoformat(),
        "total_pages": len(pages),
        "empty_files": check_empty_files(pages),
        "index_sync": check_index_sync(pages),
        "log_coverage": check_log_coverage(pages),
        "frontmatter": check_frontmatter(pages),
    }


def format_report(results: dict) -> str:
    """Format health check results as markdown (Chinese user-facing output)."""
    lines = [
        f"# Wiki 健康检查报告 — {results['date']}",
        "",
        f"扫描了 {results['total_pages']} 个 wiki 页面。"
        "检查纯结构层面（无 LLM 调用）。",
        "",
    ]

    # ── Empty / Stub Files
    empty = results["empty_files"]
    lines.append(f"## 空文件 / 存根文件（发现 {len(empty)} 个）")
    lines.append("")
    if empty:
        lines.append("| 页面 | 总字节 | 正文字节 | 状态 |")
        lines.append("|---|---|---|---|")
        for ef in empty:
            emoji = "🔴" if ef["status"] == "empty" else "🟡"
            status_cn = "空文件" if ef["status"] == "empty" else "存根"
            lines.append(
                f"| `{ef['path']}` | {ef['total_bytes']} | {ef['body_bytes']} | {emoji} {status_cn} |"
            )
    else:
        lines.append("所有页面在 frontmatter 之外都有实际内容。✅")
    lines.append("")

    # ── Index Sync
    isync = results["index_sync"]
    stale = isync["in_index_not_on_disk"]
    missing = isync["on_disk_not_in_index"]
    total_issues = len(stale) + len(missing)
    lines.append(f"## 索引同步（{total_issues} 个问题）")
    lines.append("")

    if stale:
        lines.append("### 索引中存在但磁盘上已删除（in_index_not_on_disk）")
        for s in stale:
            lines.append(f"- `{s}`")
        lines.append("")

    if missing:
        lines.append("### 磁盘上存在但索引中未收录（on_disk_not_in_index）")
        for m in missing:
            lines.append(f"- `{m}`")
        lines.append("")

    if not stale and not missing:
        lines.append("index.md 与磁盘保持同步。✅")
        lines.append("")

    # ── Log Coverage
    log_missing = results["log_coverage"]
    lines.append(f"## 日志覆盖（{len(log_missing)} 个源页面缺少日志记录）")
    lines.append("")
    if log_missing:
        lines.append("以下源页面在 log.md 中没有对应的操作记录：")
        lines.append("")
        for lm in log_missing:
            lines.append(f"- `{lm['path']}` — {lm['title']}")
    else:
        lines.append("所有源页面都有对应的日志记录。✅")
    lines.append("")

    # ── Frontmatter Completeness
    fm_issues = results["frontmatter"]
    lines.append(f"## Frontmatter 完整性（发现 {len(fm_issues)} 个问题）")
    lines.append("")
    if fm_issues:
        lines.append("| 页面 | 问题 | 详情 |")
        lines.append("|---|---|---|")
        for fi in fm_issues:
            lines.append(
                f"| `{fi['page']}` | {fi['issue']} | {fi['details']} |"
            )
    else:
        lines.append("所有页面 frontmatter 字段完整有效。✅")
    lines.append("")

    return "\n".join(lines)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="ZooKeeper wiki 结构性健康检查（确定性检查，无需 LLM）"
    )
    parser.add_argument(
        "--save",
        action="store_true",
        help="将报告保存到 wiki/health-report.md",
    )
    parser.add_argument(
        "--json", action="store_true", help="以机器可读的 JSON 格式输出"
    )
    args = parser.parse_args()

    results = run_health()

    if args.json:
        print(json.dumps(results, indent=2, ensure_ascii=False))
    else:
        report = format_report(results)
        print(report)

        if args.save:
            report_path = WIKI_DIR / "health-report.md"
            report_path.write_text(report, encoding="utf-8")
            print(f"\n已保存：{report_path.relative_to(REPO_ROOT)}")
