#!/usr/bin/env python3
"""
lint.py — Deep structural checks for wiki pages.

Performs 4 deterministic checks on the wiki:
  1. Broken links (Markdown links + frontmatter `related` entries)
  2. Orphan pages (zero inbound links AND not listed in index.md)
  3. Sparse pages (body text < 50 chars after stripping frontmatter)
   4. Stale pages (timestamp > 90 days ago, status != deprecated)

No LLM calls — pure structural validation.
"""

from __future__ import annotations

import json
import re
from datetime import date, datetime, timedelta
from pathlib import Path
from typing import Any

from shared.utils import (
    WIKI_DIR,
    all_wiki_pages,
    parse_date,
    parse_frontmatter,
    read_file,
    strip_frontmatter,
    wiki_rel,
)

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


def _body_text(content: str) -> str:
    """Return body text after stripping frontmatter and heading markers."""
    body = strip_frontmatter(content)
    # Remove leading # headings and blockquote markers for length estimation
    lines = []
    for line in body.split("\n"):
        s = line.strip()
        # Keep actual text content
        if s and not s.startswith("#") and not s.startswith(">"):
            lines.append(s)
    return " ".join(lines)


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
    fm = parse_frontmatter(content)
    related = fm.get("related", [])
    if isinstance(related, str):
        related = [related]
    for rel in related:
        links.append((f"related: {rel}", rel))

    return links


def _pages_referenced_in_index() -> set[str]:
    """Return set of wiki-relative paths referenced in index.md."""
    index_path = WIKI_DIR / "index.md"
    content = read_file(index_path)
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
        content, fm = page_cache.get(wiki_rel(page), ("", {}))
        if not content:
            continue
        links = _links_in_page(content, page)
        for text, target in links:
            resolved = _resolve_target(target)
            if resolved is None:
                results.append(
                    {
                        "page": wiki_rel(page),
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
    rel_names = {wiki_rel(p) for p in pages}

    for page in pages:
        rel = wiki_rel(page)
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
                    target_rel = wiki_rel(resolved)
                    if target_rel in rel_names:
                        if target_rel not in inbound:
                            inbound[target_rel] = set()
                        inbound[target_rel].add(rel)
                except ValueError:
                    pass

    # Find orphans
    results: list[dict[str, Any]] = []
    for page in pages:
        rel = wiki_rel(page)
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
        rel = wiki_rel(page)
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

    Pages where `timestamp` date is more than STALE_DAYS ago AND
    `status` is not `deprecated`.
    """
    if reference_date is None:
        reference_date = date.today()
    cutoff = reference_date - timedelta(days=STALE_DAYS)
    results: list[dict[str, Any]] = []
    for page in pages:
        rel = wiki_rel(page)
        _, fm = page_cache.get(rel, ("", {}))
        if not fm:
            continue
        status = fm.get("status", "")
        if status == "deprecated":
            continue
        timestamp_str = fm.get("timestamp")
        if not timestamp_str:
            continue
        timestamp_date = parse_date(str(timestamp_str))
        if timestamp_date is None:
            continue
        if timestamp_date < cutoff:
            results.append(
                {
                    "page": rel,
                    "timestamp": str(timestamp_str),
                    "status": status,
                    "days_since_update": (
                        reference_date - timestamp_date
                    ).days,
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
            lines.append("| 页面 | 时间戳 | 状态 | 距今天数 |")
            lines.append("|------|--------|------|----------|")
            for item in items:
                page = item.get("page", "")
                timestamp = item.get("timestamp", "")
                status = item.get("status", "")
                days = item.get("days_since_update", 0)
                lines.append(f"| {page} | {timestamp} | {status} | {days} |")

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
    pages = all_wiki_pages()

    # Preload all page content and frontmatter into cache
    page_cache: dict[str, tuple[str, dict[str, Any]]] = {}
    for page in pages:
        rel = wiki_rel(page)
        content = read_file(page)
        fm = parse_frontmatter(content)
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
