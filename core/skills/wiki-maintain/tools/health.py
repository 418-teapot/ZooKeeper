#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
from datetime import date
from pathlib import Path

"""
Structural health checks for the ZooKeeper wiki.

Unlike lint.py (which performs deeper structural checks), health.py is purely
deterministic — zero API calls, fast enough to run every session.

Usage:
    python3 core/skills/wiki-maintain/tools/health.py              # print report to stdout
    python3 core/skills/wiki-maintain/tools/health.py --save       # also save to wiki/health-report.md
    python3 core/skills/wiki-maintain/tools/health.py --json       # machine-readable output

Checks:
  - Empty / stub files (pages with no real content beyond frontmatter)
  - Index sync (index.md entries vs actual files on disk)
  - Log coverage (source pages without a corresponding log entry)

Design boundary:
  health.py = structural integrity, deterministic, run every session
  lint.py   = content quality, semantic (LLM), run periodically
"""

# ZooKeeper: health.py is at core/skills/wiki-maintain/tools/health.py
# 5 levels up: tools/ -> wiki-maintain/ -> skills/ -> core/ -> repo root
REPO_ROOT = Path(__file__).parent.parent.parent.parent.parent
WIKI_DIR = REPO_ROOT / "wiki"
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
        if p.name not in exclude and "templates" not in p.parts
    ]


def strip_frontmatter(content: str) -> str:
    """Remove YAML frontmatter (--- ... ---) from content."""
    if content.startswith("---"):
        end = content.find("---", 3)
        if end != -1:
            return content[end + 3 :].strip()
    return content.strip()


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
                    "path": str(p.relative_to(REPO_ROOT)),
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
        resolved = (REPO_ROOT / link).resolve()
        link_name = Path(link).name
        if link_name not in meta_pages:
            index_paths.add(resolved)

    disk_paths = set()
    for p in pages:
        if p.name not in meta_pages:
            disk_paths.add(p.resolve())

    in_index_not_on_disk = [
        str(p.relative_to(REPO_ROOT))
        for p in sorted(index_paths - disk_paths)
        if REPO_ROOT in p.parents or p == REPO_ROOT
    ]
    on_disk_not_in_index = [
        str(p.relative_to(REPO_ROOT)) for p in sorted(disk_paths - index_paths)
    ]

    return {
        "in_index_not_on_disk": in_index_not_on_disk,
        "on_disk_not_in_index": on_disk_not_in_index,
    }


# ── Check: Log coverage ────────────────────────────────────────────


def _parse_log_entries(log_content: str) -> set[str]:
    """Extract paths from log.md entries.

    ZooKeeper log format:
        ## [YYYY-MM-DD] <op> | <path> | <type> — <note>
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
        rel_path = str(p.relative_to(REPO_ROOT))

        # Match by relative path against logged paths
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
