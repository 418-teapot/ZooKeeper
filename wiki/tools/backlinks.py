#!/usr/bin/env python3
"""
backlinks.py — Auto-maintain bidirectional cross-page backlinks for the
ZooKeeper wiki.

Scans all wiki pages, extracts cross-references (frontmatter ``related``,
inline markdown links ``[text](path.md)``, and backtick-wrapped paths from
``## Relations`` sections), builds a reverse index, and optionally writes
``## Backlinks`` sections into each page.

Usage::

    python3 wiki/tools/backlinks.py              # print report to stdout
    python3 wiki/tools/backlinks.py --write      # update all pages in-place
    python3 wiki/tools/backlinks.py --json       # machine-readable output
"""

from __future__ import annotations

import argparse
import json
import re
from pathlib import Path
from typing import Any

# ZooKeeper: backlinks.py is at wiki/tools/backlinks.py
# 3 levels up: tools/ -> wiki/ -> repo root
REPO_ROOT = Path(__file__).resolve().parent.parent.parent
# Wiki is accessed via the user-global ~/.zoo/wiki symlink (portable across
# plugin installations).  Resolve the symlink so that all paths resolve
# under REPO_ROOT for relative path operations.
WIKI_DIR = (Path.home() / ".zoo" / "wiki").resolve()

# System files that should never appear as backlink targets
SYSTEM_FILES: set[str] = {
    "index.md",
    "log.md",
    "lint-report.md",
    "health-report.md",
    "overview.md",
    "SCHEMA.md",
}

# Regex: inline markdown link [text](path.md)
MD_LINK_RE = re.compile(r"\[([^\]]+)\]\(([^)]+\.md)\)")
# Regex: backtick-wrapped path `path.md`
BT_LINK_RE = re.compile(r"`([^\s`]+\.md)`")


# ── Helpers (mirror health.py) ────────────────────────────────────────


def read_file(path: Path) -> str:
    """Read a file, returning empty string if it does not exist."""
    return path.read_text(encoding="utf-8") if path.exists() else ""


def all_wiki_pages() -> list[Path]:
    """All .md files in wiki/, excluding meta / system / template / tool files."""
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
        and "tools" not in p.parts
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

    Used for cross-references, index entries, and log entries.
    """
    try:
        return str(path.relative_to(WIKI_DIR))
    except ValueError:
        return str(path)


def _parse_frontmatter(content: str) -> dict[str, Any]:
    """Minimal YAML frontmatter parser.

    Handles ``key: value`` pairs and YAML list syntax (both inline ``[a, b]``
    and block ``- a\\n- b``). Returns a dict with raw string/list values.
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


def _parse_frontmatter_title(content: str) -> str:
    """Extract the title from frontmatter."""
    fm = _parse_frontmatter(content)
    return str(fm.get("title", "")) if fm.get("title") else ""


# ── Link extraction ───────────────────────────────────────────────────


def _is_valid_wiki_target(path_str: str) -> bool:
    """Check whether *path_str* is a valid wiki-root-relative link target.

    Must be a ``.md`` path that is not a system file, not under
    ``templates/`` or ``tools/``, and points to a file that actually exists.
    """
    p = Path(path_str)
    if p.suffix != ".md":
        return False
    if p.name in SYSTEM_FILES:
        return False
    if any(part in p.parts for part in ("templates", "tools", "raw")):
        return False
    # Resolve: must be under WIKI_DIR
    try:
        resolved = (WIKI_DIR / p).resolve()
        resolved.relative_to(WIKI_DIR)
        return resolved.exists()
    except (ValueError, OSError):
        return False


def _strip_backlinks_section(body: str) -> str:
    """Remove the ``## Backlinks`` section from *body*.

    Links inside the ``## Backlinks`` section of a page are *incoming*
    references (pages that link TO this page).  They must not be treated as
    *outgoing* references from this page, otherwise a feedback loop is
    created where Backlinks generate new cross-references on each run.
    """
    pos = _find_section_pos(body, "Backlinks")
    if pos:
        return body[: pos[0]] + body[pos[1] :]
    return body


def extract_links(content: str) -> list[str]:
    """Extract cross-reference link targets from *content*.

    Sources (in order):
      1. Frontmatter ``related`` field
      2. Inline markdown links ``[text](path.md)`` in body text
         (excluding the ``## Backlinks`` section)
      3. Backtick-wrapped paths ``\\`path.md\\````` in body text
         (common in ``## Relations`` sections, excluding ``## Backlinks``)

    Returns a sorted list of wiki-root-relative ``.md`` paths that pass
    :func:`_is_valid_wiki_target`.
    """
    links: set[str] = set()
    body = strip_frontmatter(content)
    body = _strip_backlinks_section(body)
    fm = _parse_frontmatter(content)

    # 1. Frontmatter related field
    related = fm.get("related", [])
    if isinstance(related, str):
        related = [related]
    for r in related:
        r = r.strip()
        if r.endswith(".md"):
            links.add(r)

    # 2. Inline markdown links [text](path.md) in body (backlinks stripped)
    for m in MD_LINK_RE.finditer(body):
        target = m.group(2).strip()
        if not target.startswith(("http://", "https://", "mailto:")):
            links.add(target)

    # 3. Backtick-wrapped paths `path.md` in body (Relations convention)
    for m in BT_LINK_RE.finditer(body):
        target = m.group(1).strip()
        if not target.startswith(("http://", "https://")):
            links.add(target)

    return sorted(ln for ln in links if _is_valid_wiki_target(ln))


# ── Reverse index ─────────────────────────────────────────────────────


def build_reverse_index(pages: list[Path]) -> dict[str, list[str]]:
    """Build reverse-link index.

    Returns a dict mapping each target page (wiki-root-relative path) to a
    sorted list of source pages (wiki-root-relative paths) that link to it.
    """
    reverse: dict[str, list[str]] = {}

    for page in pages:
        rel = _wiki_rel(page)
        content = read_file(page)
        if not content:
            continue

        targets = extract_links(content)
        for target in targets:
            if target not in reverse:
                reverse[target] = []
            if rel not in reverse[target]:
                reverse[target].append(rel)

    # Sort source lists for deterministic output
    for target in reverse:
        reverse[target].sort()

    return dict(sorted(reverse.items()))


def _page_title(rel_path: str) -> str:
    """Return the page title from frontmatter, falling back to the filename."""
    page_path = WIKI_DIR / rel_path
    content = read_file(page_path)
    if content:
        title = _parse_frontmatter_title(content)
        if title:
            return title
    return Path(rel_path).stem.replace("-", " ").title()


# ── Section manipulation helpers ──────────────────────────────────────


def _find_section_pos(content: str, heading: str) -> tuple[int, int] | None:
    """Find a ``## <heading>`` section in *content*.

    Returns ``(start_offset, end_offset)`` where *start* is the offset of the
    ``## <heading>`` line and *end* is the offset of the next ``##`` heading
    (or end of content).

    Returns ``None`` if the heading is not found.
    """
    pattern = re.compile(rf"^## {re.escape(heading)}\s*$", re.MULTILINE)
    m = pattern.search(content)
    if not m:
        return None
    start = m.start()
    # Find next ## heading after this section
    next_m = re.search(r"^## ", content[m.end() :], re.MULTILINE)
    if next_m:
        end = m.end() + next_m.start()
    else:
        end = len(content)
    return (start, end)


def _format_backlinks_section(target: str, sources: list[str]) -> str:
    """Format a ``## Backlinks`` section body for *target* with *sources*."""
    lines = ["## Backlinks", ""]
    lines.append("由 `backlinks.py` 自动维护。列出引用本页面的其他页面。")
    lines.append("")
    for src in sources:
        title = _page_title(src)
        lines.append(f"- [{title}]({src})")
    return "\n".join(lines) + "\n\n"


# ── Backlink report ───────────────────────────────────────────────────


def format_report(reverse_index: dict[str, list[str]]) -> str:
    """Format the backlink index as a human-readable markdown report.

    Only pages that have at least one backlink are included.
    """
    lines = [
        "# Wiki 反向链接报告",
        "",
        f"共 {len(reverse_index)} 个页面有反向链接。",
        "",
    ]

    for target, sources in reverse_index.items():
        lines.append(f"## {_page_title(target)}")
        lines.append("")
        lines.append(f"页面：`{target}`")
        lines.append("")
        lines.append(f"被 {len(sources)} 个页面引用：")
        lines.append("")
        for src in sources:
            title = _page_title(src)
            lines.append(f"- [{title}]({src})")
        lines.append("")

    return "\n".join(lines)


# ── Write mode ────────────────────────────────────────────────────────


def update_backlinks(
    reverse_index: dict[str, list[str]],
    pages: list[Path],
) -> int:
    """Write ``## Backlinks`` sections into each wiki page.

    For each page that has inbound links, adds or updates a ``## Backlinks``
    section.  The section is placed after ``## Relations`` (if it exists),
    after ``## Details``, or before ``## References``.

    Pages with no inbound links that still carry a ``## Backlinks`` section
    (e.g. from a previous run) will have it removed to keep pages clean.

    Returns the number of pages that were modified.
    """
    updated_count = 0

    for page in pages:
        rel = _wiki_rel(page)
        sources = reverse_index.get(rel, [])
        has_backlinks = len(sources) > 0

        content = read_file(page)
        if not content:
            continue

        existing = _find_section_pos(content, "Backlinks")

        if has_backlinks:
            # Build the new Backlinks section content
            backlinks_content = _format_backlinks_section(rel, sources)

            if existing:
                start, end = existing
                new_content = (
                    content[:start] + backlinks_content + content[end:]
                )
            else:
                insertion_point = _find_insertion_point(content)
                if insertion_point is None:
                    continue
                new_content = (
                    content[:insertion_point]
                    + "\n"
                    + backlinks_content
                    + content[insertion_point:]
                )
        else:
            # No inbound links — remove stale Backlinks section if present
            if existing:
                start, end = existing
                # Remove the section including surrounding blank lines
                # (eat up to one preceding blank line and one trailing blank line)
                pre = content[:start]
                post = content[end:]
                # Remove leading blank line from the section
                if pre.endswith("\n\n"):
                    pre = pre[:-1]
                elif pre.endswith("\n"):
                    pre = pre[:-1]
                # Remove trailing blank line after the section
                if post.startswith("\n\n"):
                    post = post[1:]
                elif post.startswith("\n"):
                    post = post[1:]
                new_content = pre + post
            else:
                new_content = content

        if new_content != content:
            page.write_text(new_content, encoding="utf-8")
            updated_count += 1

    return updated_count


def _find_insertion_point(content: str) -> int | None:
    """Find the best offset to insert a new ``## Backlinks`` section.

    Priority:
      1. After ``## Relations`` (at its end)
      2. After ``## Details`` (at its end)
      3. Before ``## References`` (at its start)

    Returns the character offset, or ``None`` if none of the anchors exist.
    """
    # Priority 1: after ## Relations
    pos = _find_section_pos(content, "Relations")
    if pos:
        return pos[1]

    # Priority 2: after ## Details
    pos = _find_section_pos(content, "Details")
    if pos:
        return pos[1]

    # Priority 3: before ## References
    pos = _find_section_pos(content, "References")
    if pos:
        return pos[0]

    return None


# ── Main entry point ──────────────────────────────────────────────────


def main() -> None:
    parser = argparse.ArgumentParser(
        description="ZooKeeper wiki 反向链接自动维护工具",
    )
    parser.add_argument(
        "--write",
        action="store_true",
        help="将 ## Backlinks 节写入所有页面",
    )
    parser.add_argument(
        "--json",
        action="store_true",
        help="以机器可读的 JSON 格式输出",
    )
    args = parser.parse_args()

    pages = all_wiki_pages()
    reverse_index = build_reverse_index(pages)

    if args.write:
        updated = update_backlinks(reverse_index, pages)
        print(f"已更新 {updated} 个页面的反向链接。")
    elif args.json:
        # Build a clean JSON structure
        output: dict[str, Any] = {
            "total_pages": len(pages),
            "pages_with_backlinks": len(reverse_index),
            "backlinks": {},
        }
        for target, sources in reverse_index.items():
            output["backlinks"][target] = {
                "title": _page_title(target),
                "sources": [
                    {"path": s, "title": _page_title(s)} for s in sources
                ],
            }
        print(json.dumps(output, indent=2, ensure_ascii=False))
    else:
        report = format_report(reverse_index)
        print(report)


if __name__ == "__main__":
    main()
