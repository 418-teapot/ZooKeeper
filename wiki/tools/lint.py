#!/usr/bin/env python3
"""
lint.py — Deep structural checks for wiki pages.

Performs 4 deterministic checks on the wiki:
  1. Broken links (Markdown links + frontmatter `related` entries)
  2. Orphan pages (zero inbound links AND not listed in index.md)
  3. Sparse pages (body text < 50 chars after stripping frontmatter)
  4. Stale pages (updated > 90 days ago, status != deprecated)

No LLM calls — pure structural validation.
"""

from __future__ import annotations

import json
import re
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

REPO_ROOT = (
    Path(__file__).resolve().parent.parent.parent
)  # lint.py -> tools/ -> wiki/ -> repo root
# Wiki is accessed via the user-global ~/.zoo/wiki symlink.
# Resolve the symlink so that all paths resolve under REPO_ROOT.
WIKI_DIR = (Path.home() / ".zoo" / "wiki").resolve()

# Meta pages that are excluded from most checks (config, logs, index, etc.)
META_PAGES: set[str] = {
    "index.md",
    "log.md",
    "SCHEMA.md",
    "lint-report.md",
    "health-report.md",
    "overview.md",
}

STALE_DAYS = 90
SPARSE_BODY_CHARS = 50

# Regex to extract Markdown links pointing to .md files
MD_LINK_RE = re.compile(r"\[([^\]]*)\]\(([^)]+\.md)\)")

# Regex to match YAML frontmatter delimiters
FRONTMATTER_RE = re.compile(r"^---\s*$", re.MULTILINE)


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _pages() -> list[Path]:
    """Return all .md files under WIKI_DIR, excluding meta pages."""
    pages: list[Path] = []
    for p in sorted(WIKI_DIR.rglob("*.md")):
        if p.name in META_PAGES:
            continue
        if p.name == ".gitkeep":
            continue
        # Skip template files (infrastructure, not wiki content)
        if "templates" in p.parts:
            continue
        # Skip tools directory (only has .py files, but be safe)
        if "tools" in p.parts:
            continue
        pages.append(p)
    return pages


def _read_file(path: Path) -> str:
    """Read file content, return empty string on error."""
    try:
        return path.read_text(encoding="utf-8")
    except (FileNotFoundError, IOError, UnicodeDecodeError):
        return ""


def _parse_frontmatter(content: str) -> dict[str, Any]:
    """
    Minimal YAML frontmatter parser.

    Handles key: value pairs and YAML list syntax (both inline `[a, b]`
    and block `- a\\n- b`). Returns a dict with raw string/list values.
    """
    fm: dict[str, Any] = {}
    # Match content between first pair of --- markers
    m = FRONTMATTER_RE.match(content)
    if not m:
        return fm
    end = m.end()
    m2 = FRONTMATTER_RE.search(content, end)
    if not m2:
        return fm
    raw = content[end : m2.start()].strip()

    current_key: str | None = None
    list_accum: list[str] = []

    for line in raw.split("\n"):
        stripped = line.strip()
        # Block list item
        if stripped.startswith("- ") and current_key is not None:
            list_accum.append(stripped[2:].strip())
            continue

        # If we were accumulating a list, save it now
        if current_key is not None and list_accum:
            fm[current_key] = list_accum
            list_accum = []

        # Empty line or comment
        if not stripped or stripped.startswith("#"):
            if not stripped:
                current_key = None
            continue

        # key: value line
        if ":" in stripped and not stripped.startswith("-"):
            colon_idx = stripped.index(":")
            current_key = stripped[:colon_idx].strip()
            value_part = stripped[colon_idx + 1 :].strip()

            # Inline list: [a, b, c]
            if value_part.startswith("[") and value_part.endswith("]"):
                items = [
                    item.strip().strip('"').strip("'")
                    for item in value_part[1:-1].split(",")
                ]
                items = [i for i in items if i]
                fm[current_key] = items
                list_accum = []
            elif value_part:
                # Strip surrounding quotes
                value_part = value_part.strip('"').strip("'")
                fm[current_key] = value_part
                list_accum = []
            else:
                # Value might be a block list starting on next lines
                list_accum = []
        else:
            current_key = None

    # Flush trailing list accumulator
    if current_key is not None and list_accum:
        fm[current_key] = list_accum

    return fm


def _strip_frontmatter(content: str) -> str:
    """Return content with YAML frontmatter removed."""
    m = FRONTMATTER_RE.match(content)
    if not m:
        return content
    end = m.end()
    m2 = FRONTMATTER_RE.search(content, end)
    if not m2:
        return content
    return content[m2.end() :].strip()


def _body_text(content: str) -> str:
    """Return body text after stripping frontmatter and heading markers."""
    body = _strip_frontmatter(content)
    # Remove leading # headings and blockquote markers for length estimation
    lines = []
    for line in body.split("\n"):
        s = line.strip()
        # Keep actual text content
        if s and not s.startswith("#") and not s.startswith(">"):
            lines.append(s)
    return " ".join(lines)


def _parse_date(date_str: str) -> date | None:
    """Parse YYYY-MM-DD string, return date or None."""
    try:
        return datetime.strptime(date_str.strip(), "%Y-%m-%d").date()
    except (ValueError, AttributeError):
        return None


def _relative_path(path: Path) -> str:
    """Return path relative to WIKI_DIR."""
    try:
        return str(path.relative_to(WIKI_DIR))
    except ValueError:
        return str(path)


def _resolve_target(link_target: str) -> Path | None:
    """
    Resolve a link target to an absolute path.

    Links are now wiki-root-relative (e.g. ``concepts/foo.md``). For backward
    compatibility, legacy ``wiki/``-prefixed targets are also accepted.
    """
    p = Path(link_target)
    if p.is_absolute():
        return None
    # Strip legacy wiki/ prefix for backward compatibility
    if str(p).startswith("wiki/"):
        p = Path(*p.parts[1:])
    full = (WIKI_DIR / p).resolve()
    return full if full.exists() else None


def _links_in_page(content: str, page_path: Path) -> list[tuple[str, str]]:
    """
    Extract all outgoing links from a page.

    Returns list of (link_text, link_target) tuples.
    Includes Markdown links and frontmatter `related` entries.
    """
    links: list[tuple[str, str]] = []

    # Markdown links
    for match in MD_LINK_RE.finditer(content):
        text = match.group(1)
        target = match.group(2)
        links.append((text, target))

    # Frontmatter `related` field
    fm = _parse_frontmatter(content)
    related = fm.get("related", [])
    if isinstance(related, str):
        related = [related]
    for rel in related:
        links.append((f"related: {rel}", rel))

    return links


def _pages_referenced_in_index() -> set[str]:
    """Return set of wiki-relative paths referenced in index.md."""
    index_path = WIKI_DIR / "index.md"
    content = _read_file(index_path)
    referenced: set[str] = set()
    for match in MD_LINK_RE.finditer(content):
        target = match.group(2)
        ref_path = Path(target)
        # Strip legacy wiki/ prefix; current paths are already wiki-root-relative
        if str(ref_path).startswith("wiki/"):
            ref_path = Path(*ref_path.parts[1:])
        referenced.add(str(ref_path))
    return referenced


# ---------------------------------------------------------------------------
# Check implementations
# ---------------------------------------------------------------------------


def check_broken_links(
    pages: list[Path],
    page_cache: dict[str, tuple[str, dict[str, Any]]],
) -> list[dict[str, Any]]:
    """
    Check 1: Broken links.

    For each page, extract all outgoing links (Markdown + frontmatter related).
    Report any link whose target file does not exist on disk.
    """
    results: list[dict[str, Any]] = []
    for page in pages:
        content, fm = page_cache.get(_relative_path(page), ("", {}))
        if not content:
            continue
        links = _links_in_page(content, page)
        for text, target in links:
            resolved = _resolve_target(target)
            if resolved is None:
                results.append(
                    {
                        "page": _relative_path(page),
                        "link_text": text,
                        "link_target": target,
                        "issue": "target_not_found",
                    }
                )
    return results


def check_orphan_pages(
    pages: list[Path],
    page_cache: dict[str, tuple[str, dict[str, Any]]],
) -> list[dict[str, Any]]:
    """
    Check 2: Orphan pages.

    Build an inbound link graph. Any page with zero inbound links AND
    not listed in index.md is orphaned.
    """
    # Build set of pages referenced in index.md
    index_refs = _pages_referenced_in_index()

    # Build inbound graph: for each page, collect pages that link to it
    inbound: dict[str, set[str]] = {}
    rel_names = {_relative_path(p) for p in pages}

    for page in pages:
        rel = _relative_path(page)
        if rel not in inbound:
            inbound[rel] = set()
        content, _ = page_cache.get(rel, ("", {}))
        if not content:
            continue
        links = _links_in_page(content, page)
        for _, target in links:
            resolved = _resolve_target(target)
            if resolved is not None:
                try:
                    target_rel = _relative_path(resolved)
                    if target_rel in rel_names:
                        if target_rel not in inbound:
                            inbound[target_rel] = set()
                        inbound[target_rel].add(rel)
                except ValueError:
                    pass

    # Find orphans
    results: list[dict[str, Any]] = []
    for page in pages:
        rel = _relative_path(page)
        linked_from_elsewhere = len(inbound.get(rel, set())) > 0
        in_index = rel in index_refs or page.name in index_refs
        if not linked_from_elsewhere and not in_index:
            results.append(
                {
                    "page": rel,
                    "inbound_links": len(inbound.get(rel, set())),
                    "in_index": False,
                }
            )
    return results


def check_sparse_pages(
    pages: list[Path],
    page_cache: dict[str, tuple[str, dict[str, Any]]],
) -> list[dict[str, Any]]:
    """
    Check 4: Sparse pages.

    Pages where body text (after stripping frontmatter) is less than
    SPARSE_BODY_CHARS characters.
    """
    results: list[dict[str, Any]] = []
    for page in pages:
        rel = _relative_path(page)
        content, _ = page_cache.get(rel, ("", {}))
        if not content:
            continue
        body = _body_text(content)
        if len(body) < SPARSE_BODY_CHARS:
            results.append(
                {
                    "page": rel,
                    "body_length": len(body),
                    "threshold": SPARSE_BODY_CHARS,
                }
            )
    return results


def check_stale_pages(
    pages: list[Path],
    page_cache: dict[str, tuple[str, dict[str, Any]]],
    reference_date: date | None = None,
) -> list[dict[str, Any]]:
    """
    Check 5: Stale pages.

    Pages where `updated` date is more than STALE_DAYS ago AND
    `status` is not `deprecated`.
    """
    if reference_date is None:
        reference_date = date.today()
    cutoff = reference_date - timedelta(days=STALE_DAYS)
    results: list[dict[str, Any]] = []
    for page in pages:
        rel = _relative_path(page)
        _, fm = page_cache.get(rel, ("", {}))
        if not fm:
            continue
        status = fm.get("status", "")
        if status == "deprecated":
            continue
        updated_str = fm.get("updated")
        if not updated_str:
            continue
        updated_date = _parse_date(str(updated_str))
        if updated_date is None:
            continue
        if updated_date < cutoff:
            results.append(
                {
                    "page": rel,
                    "updated": str(updated_str),
                    "status": status,
                    "days_since_update": (reference_date - updated_date).days,
                    "threshold_days": STALE_DAYS,
                }
            )
    return results


# ---------------------------------------------------------------------------
# Output formatting
# ---------------------------------------------------------------------------


def format_markdown(results: dict[str, list[dict[str, Any]]]) -> str:
    """Format all results as a markdown report."""
    lines: list[str] = [
        "# Wiki Lint Report",
        "",
        f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}",
        "",
    ]

    check_names = {
        "broken_links": "断裂链接 (Broken Links)",
        "orphan_pages": "孤立页面 (Orphan Pages)",
        "sparse_pages": "稀疏页面 (Sparse Pages)",
        "stale_pages": "过时页面 (Stale Pages)",
    }

    for key, title in check_names.items():
        items = results.get(key, [])
        lines.append(f"## {title}")
        lines.append("")
        lines.append(f"共发现 **{len(items)}** 个问题。")
        lines.append("")

        if not items:
            continue

        # Build a table based on the issue type
        if key == "broken_links":
            lines.append("| 页面 | 链接文本 | 目标路径 |")
            lines.append("|------|----------|----------|")
            for item in items:
                page = item.get("page", "")
                text = item.get("link_text", "")
                target = item.get("link_target", "")
                lines.append(f"| {page} | {text} | {target} |")

        elif key == "orphan_pages":
            lines.append("| 页面 | 入链数 | 在 index 中 |")
            lines.append("|------|--------|-------------|")
            for item in items:
                page = item.get("page", "")
                inbound = item.get("inbound_links", 0)
                in_idx = "否" if not item.get("in_index") else "是"
                lines.append(f"| {page} | {inbound} | {in_idx} |")

        elif key == "sparse_pages":
            lines.append("| 页面 | 正文长度 | 阈值 |")
            lines.append("|------|----------|------|")
            for item in items:
                page = item.get("page", "")
                bl = item.get("body_length", 0)
                th = item.get("threshold", SPARSE_BODY_CHARS)
                lines.append(f"| {page} | {bl} | {th} |")

        elif key == "stale_pages":
            lines.append("| 页面 | 更新日期 | 状态 | 距今天数 |")
            lines.append("|------|----------|------|----------|")
            for item in items:
                page = item.get("page", "")
                updated = item.get("updated", "")
                status = item.get("status", "")
                days = item.get("days_since_update", 0)
                lines.append(f"| {page} | {updated} | {status} | {days} |")

        lines.append("")

    # Summary
    total = sum(len(v) for v in results.values())
    lines.append("---")
    lines.append("")
    lines.append(f"**总计：{total} 个问题**")
    lines.append("")

    return "\n".join(lines)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------


def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(
        description="Wiki lint tool — deep structural checks without LLM calls."
    )
    parser.add_argument(
        "--save",
        action="store_true",
        help="写入 wiki/lint-report.md",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="以 JSON 格式输出（机器可读）",
    )
    args = parser.parse_args()

    # Discover pages
    pages = _pages()

    # Preload all page content and frontmatter into cache
    page_cache: dict[str, tuple[str, dict[str, Any]]] = {}
    for page in pages:
        rel = _relative_path(page)
        content = _read_file(page)
        fm = _parse_frontmatter(content)
        page_cache[rel] = (content, fm)

    # Run all 4 checks
    results: dict[str, list[dict[str, Any]]] = {
        "broken_links": check_broken_links(pages, page_cache),
        "orphan_pages": check_orphan_pages(pages, page_cache),
        "sparse_pages": check_sparse_pages(pages, page_cache),
        "stale_pages": check_stale_pages(pages, page_cache),
    }

    # Summary counts
    summary = {k: len(v) for k, v in results.items()}
    summary["total"] = sum(summary.values())

    if args.json:
        output = {
            "summary": summary,
            "results": results,
        }
        print(json.dumps(output, ensure_ascii=False, indent=2))
        return

    # Markdown output
    report = format_markdown(results)

    if args.save:
        report_path = WIKI_DIR / "lint-report.md"
        report_path.write_text(report, encoding="utf-8")
        print(f"报告已写入：{report_path}")
    else:
        print(report)


if __name__ == "__main__":
    main()
