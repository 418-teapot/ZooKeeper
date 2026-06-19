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
  - Related field integrity (no system file references in related field)
  - Source field validation (source-type pages must have URL or raw/ path in source field)

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
    """All .md files in wiki/, excluding meta files and raw/."""
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
        and "raw"
        not in p.parts  # raw/ stores immutable source copies, not wiki pages
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


# ── Check: Related field integrity ──────────────────────────────────


def check_related_field(pages: list[Path]) -> list[dict]:
    """Check that related fields and Markdown links don't point to system files.

    System files (index.md, log.md, SCHEMA.md, overview.md) should not
    appear in:
      1. Any page's related frontmatter field
      2. Markdown links in the page body (e.g. [SCHEMA.md](SCHEMA.md))
    """
    SYSTEM_FILES = {"index.md", "log.md", "SCHEMA.md", "overview.md"}
    LINK_PATTERN = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")
    results: list[dict] = []

    for page in pages:
        content = read_file(page)
        if not content:
            continue

        rel_page = _wiki_rel(page)

        # 1. Check frontmatter related field
        fm = _parse_frontmatter(content)
        related = fm.get("related", [])

        if isinstance(related, str):
            related = [related]

        for target in related:
            target_name = Path(target).name if target else ""
            if target_name in SYSTEM_FILES:
                results.append(
                    {
                        "page": rel_page,
                        "issue": "related_to_system_file",
                        "details": f"Frontmatter 'related' field points to system file '{target}' — this is not allowed",
                    }
                )

        # 2. Check Markdown links in body text
        body = strip_frontmatter(content)
        matches = LINK_PATTERN.findall(body)
        for link_text, link_target in matches:
            link_name = Path(link_target).name if link_target else ""
            if link_name in SYSTEM_FILES:
                results.append(
                    {
                        "page": rel_page,
                        "issue": "markdown_link_to_system_file",
                        "details": f"Markdown link [{link_text}]({link_target}) points to system file — this is not allowed",
                    }
                )

    return results


# ── Check: Source field validation ──────────────────────────────────


def check_source_field(pages: list[Path]) -> list[dict]:
    """Validate source field for source-type pages.

    Checks:
      - source-type pages must have a source field
      - source field should be a valid URL (starts with http/https)
    """
    results: list[dict] = []

    for page in pages:
        # Only check files under sources/ directory
        if "sources" not in page.parts:
            continue

        content = read_file(page)
        if not content:
            continue

        fm = _parse_frontmatter(content)
        page_type = fm.get("type", "")

        # Only validate source-type pages
        if page_type != "source":
            continue

        source_value = fm.get("source")

        # Check if source field exists
        if not source_value:
            results.append(
                {
                    "page": _wiki_rel(page),
                    "issue": "missing_source_field",
                    "details": f"Source-type page '{page.name}' is missing required 'source' field",
                }
            )
            continue

        # Check if source is a valid URL or local raw copy path
        if isinstance(source_value, str) and not (
            source_value.startswith(("http://", "https://"))
            or source_value.startswith("raw/")
        ):
            results.append(
                {
                    "page": _wiki_rel(page),
                    "issue": "invalid_source_url",
                    "details": f"Page '{page.name}' has source value '{source_value}' — should be a URL (http:// or https://) or a raw/ file path",
                }
            )

    return results


# ── Check: Missing inline links (anchor text mining) ─────────────────


def _extract_anchor_map(pages: list[Path]) -> dict[str, set[str]]:
    """Scan all wiki pages and extract [display text](target) → target mappings.

    Builds a dictionary of every display text used in markdown links across
    the wiki, mapped to the set of wiki-relative target paths it points to.
    Display texts that appear in multiple pages with the same target are
    merged; the same text pointing to different targets accumulates both.

    Only targets with a ``.md`` extension are collected (excludes external
    URLs, which are intentionally out of scope for inline-link detection).
    """
    anchor_map: dict[str, set[str]] = {}
    link_pattern = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")

    for page in pages:
        content = read_file(page)
        body = strip_frontmatter(content)

        for m in link_pattern.finditer(body):
            display_text = m.group(1).strip()
            target = m.group(2).strip()

            if not display_text or not target:
                continue
            if not target.endswith(".md"):
                continue  # skip external URLs

            # Wiki convention: all links are wiki-root-relative
            # (e.g. "concepts/foo.md", NOT "../concepts/foo.md")
            try:
                rel_target = str(
                    (WIKI_DIR / target).resolve().relative_to(WIKI_DIR)
                )
            except ValueError:
                continue  # target outside wiki dir

            if display_text not in anchor_map:
                anchor_map[display_text] = set()
            anchor_map[display_text].add(rel_target)

    return anchor_map


def _expand_anchor_prefixes(anchor_map: dict[str, set[str]]) -> None:
    """Add prefix aliases for multi-word anchor texts.

    Generates progressive prefixes by truncating the tail of the anchor
    text character by character.  This catches shorthand references like
    "autoresearch 扩展" for "autoresearch 扩展循环", where Chinese text
    has no whitespace between the truncated components.

    Only prefixes that contain at least one space and are ≥ 5 characters
    are kept — single-token aliases are too generic.
    """
    new_entries: dict[str, set[str]] = {}
    for text, targets in anchor_map.items():
        # Split on the *first* space so we keep the leading part intact
        # and progressively truncate the trailing part.
        parts = text.split(" ", 1)
        if len(parts) < 2:
            continue
        head, tail = parts

        # Generate: head + progressively shorter tail prefixes.
        for end in range(len(tail), 0, -1):
            prefix = f"{head} {tail[:end]}".rstrip()
            if len(prefix) < 5:
                continue
            if " " not in prefix:
                continue
            if prefix in anchor_map:
                anchor_map[prefix] |= targets  # enrich existing entry
                continue
            if prefix not in new_entries:
                new_entries[prefix] = set()
            new_entries[prefix] |= targets

    anchor_map.update(new_entries)


_SKIP_LINK_CHECK_SECTIONS = {
    "relations",
    "backlinks",
    "references",
    "notes",
}


def _body_sections_to_check(body: str) -> str:
    """Return body text with Relations/Backlinks/References/Notes sections removed.

    These sections already contain explicit, structured links — checking them
    for missing inline links would produce noise.
    """
    sections = re.split(r"\n(?=## )", body)
    kept: list[str] = []
    for section in sections:
        header_match = re.match(
            r"##\s+(\S+)",
            section,
        )
        if header_match:
            header_label = header_match.group(1).strip().lower()
            if header_label in _SKIP_LINK_CHECK_SECTIONS:
                continue
        kept.append(section)
    return "\n".join(kept)


def _check_body_for_missing_links(
    body: str,
    rel_page: str,
    anchor_map: dict[str, set[str]],
    page_dir: Path,
) -> list[dict]:
    """Check a body text fragment for anchor terms missing inline links.

    Args:
        body: Raw markdown body text (may include link syntax).
        rel_page: Wiki-relative path of the page this text belongs to.
        anchor_map: Pre-built {display_text: {wiki_rel_target, ...}} map.
        page_dir: Directory of the page (for resolving relative link targets).

    Returns:
        List of missing-link issues, each with page, term, suggested_targets,
        snippet, and issue fields.
    """
    results: list[dict] = []
    link_pattern = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")

    # Strip frontmatter — the caller may pass raw text that includes YAML.
    body = strip_frontmatter(body)

    # Remove code blocks.
    body = re.sub(r"```.*?```", "", body, flags=re.DOTALL)

    # Remove the page's own h1 heading (e.g. "# autoresearch 设计文档").
    # Terms appearing in the page's own title are self-references,
    # not missing links.
    body = re.sub(r"^#\s+.+\n", "", body, count=1)

    # Keep only sections where links are expected.
    body = _body_sections_to_check(body)

    # --- Build link span map and linked-text set ------------
    link_spans: list[tuple[int, int, str]] = []
    linked_texts: set[tuple[str, str]] = set()  # {(display, target), ...}
    for m in link_pattern.finditer(body):
        target = m.group(2).strip()
        if not target.endswith(".md"):
            continue
        try:
            rel_target = str(
                (WIKI_DIR / target).resolve().relative_to(WIKI_DIR)
            )
        except ValueError:
            continue
        display = m.group(1).strip()
        link_spans.append((m.start(), m.end(), rel_target))
        linked_texts.add((display, rel_target))

    reported_terms: set[str] = set()
    for anchor_text, valid_targets in anchor_map.items():
        if len(anchor_text) < 5:
            continue
        if " " not in anchor_text and "—" not in anchor_text:
            continue
        if anchor_text in reported_terms:
            continue

        # Check if a shorter or longer form of this anchor text was
        # already linked on this page pointing to a matching target.
        # Bidirectional: "LLM Wiki" linked → "LLM Wiki vs RAG" covered,
        # and vice versa.
        covered_by_prefix = False
        for lt_text, lt_target in linked_texts:
            if lt_target not in valid_targets:
                continue
            if lt_text.startswith(anchor_text) or anchor_text.startswith(
                lt_text
            ):
                covered_by_prefix = True
                break
        if covered_by_prefix:
            continue

        targets = valid_targets - {rel_page}
        if not targets:
            continue

        idx = body.find(anchor_text)
        if idx == -1:
            continue

        covered = False
        for span_start, span_end, span_target in link_spans:
            if span_start <= idx < span_end:
                if span_target in valid_targets:
                    covered = True
                break

        if covered:
            continue

        reported_terms.add(anchor_text)
        snippet_start = max(0, idx - 20)
        snippet_end = min(len(body), idx + len(anchor_text) + 20)
        snippet = body[snippet_start:snippet_end].replace("\n", " ")

        results.append(
            {
                "page": rel_page,
                "term": anchor_text,
                "suggested_targets": sorted(valid_targets),
                "snippet": f"…{snippet}…",
                "issue": "missing_inline_link",
            }
        )

    return results


def check_missing_inline_links(pages: list[Path]) -> list[dict]:
    """Find anchor texts that appear in body text without a matching inline link.

    Uses **anchor text mining**: first scans every wiki page to build a
    dictionary of ``[display text](target)`` pairs.  Then, for each page,
    it searches the body (excluding code blocks and already-linked regions)
    for occurrences of those display texts.  Any term that appears in the
    body but is NOT wrapped in a markdown link pointing to one of its known
    targets is reported.

    Only the **first** unlinked occurrence per term per page is reported.
    Terms shorter than 5 characters or single-token terms are skipped to
    avoid noise.
    """
    anchor_map = _extract_anchor_map(pages)

    # Also register each page's own title as an anchor text pointing to itself.
    for page in pages:
        content = read_file(page)
        fm = _parse_frontmatter(content)
        title = fm.get("title", "")
        if title and len(title) >= 3:
            if title not in anchor_map:
                anchor_map[title] = set()
            anchor_map[title].add(_wiki_rel(page))

    # Expand multi-word anchor texts with prefix aliases so that
    # shorthand references (e.g. "autoresearch 扩展") are detected
    # even when only the full title ("autoresearch 扩展循环") is linked.
    _expand_anchor_prefixes(anchor_map)

    results: list[dict] = []
    for page in pages:
        content = read_file(page)
        rel_page = _wiki_rel(page)
        results.extend(
            _check_body_for_missing_links(
                content, rel_page, anchor_map, page.parent
            )
        )

    results = _deduplicate_prefix_matches(results)
    results.sort(key=lambda x: (x["page"], x["term"]))
    return results


def _deduplicate_prefix_matches(results: list[dict]) -> list[dict]:
    """Remove shorter prefix matches when a longer one already covers the same targets.

    When ``_expand_anchor_prefixes`` generates progressive truncations like
    "autoresearch 扩" → "autoresearch 扩展" → "autoresearch 扩展循",
    only the longest prefix that appears in the body should be reported.
    """
    # Group by (page, frozenset of suggested_targets).
    groups: dict[tuple[str, frozenset], list[dict]] = {}
    for r in results:
        key = (r["page"], frozenset(r["suggested_targets"]))
        if key not in groups:
            groups[key] = []
        groups[key].append(r)

    deduped: list[dict] = []
    for group in groups.values():
        # Keep only the longest term in each group.
        group.sort(key=lambda x: len(x["term"]), reverse=True)
        deduped.append(group[0])

    deduped.sort(key=lambda x: (x["page"], x["term"]))
    return deduped


# ── Check: Duplicate inline links ──────────────────────────────────


def check_duplicate_inline_links(pages: list[Path]) -> list[dict]:
    """Find pages that link to the same wiki target multiple times in prose sections.

    Checks the Overview and Details sections only (Relations/Backlinks/References/Notes
    are excluded since repeated links are normal in those structured lists).

    Returns:
        List of dicts, each with:
            page: Wiki-relative path of the source page.
            target: Wiki-relative path of the duplicated target.
            occurrences: List of {"display": str, "line": int} pairs.
            issue: Always ``"duplicate_inline_link"``.
    """
    results: list[dict] = []
    link_pattern = re.compile(r"\[([^\]]+)\]\(([^)]+)\)")

    for page in pages:
        content = read_file(page)
        if not content:
            continue

        rel_page = _wiki_rel(page)
        body = strip_frontmatter(content)

        # Remove code blocks.
        body = re.sub(r"```.*?```", "", body, flags=re.DOTALL)

        # Keep only prose sections.
        body = _body_sections_to_check(body)

        # Group links by resolved target path.
        target_groups: dict[str, list[dict]] = {}
        for m in link_pattern.finditer(body):
            display_text = m.group(1).strip()
            target = m.group(2).strip()

            if not display_text or not target:
                continue
            if not target.endswith(".md"):
                continue  # skip external URLs

            # Resolve to wiki-relative path (same logic as _extract_anchor_map).
            try:
                rel_target = str(
                    (WIKI_DIR / target).resolve().relative_to(WIKI_DIR)
                )
            except ValueError:
                continue  # target outside wiki dir

            # 1-based line number within body (frontmatter already stripped).
            line_num = body[: m.start()].count("\n") + 1

            if rel_target not in target_groups:
                target_groups[rel_target] = []
            target_groups[rel_target].append(
                {"display": display_text, "line": line_num}
            )

        # Report any target with >1 occurrence in prose sections.
        for rel_target, occurrences in target_groups.items():
            if len(occurrences) > 1:
                results.append(
                    {
                        "page": rel_page,
                        "target": rel_target,
                        "occurrences": occurrences,
                        "issue": "duplicate_inline_link",
                    }
                )

    results.sort(key=lambda x: (x["page"], x["target"]))
    return results


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
        "related_field": check_related_field(pages),
        "source_field": check_source_field(pages),
        "missing_inline_links": check_missing_inline_links(pages),
        "duplicate_inline_links": check_duplicate_inline_links(pages),
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

    # ── Related Field Integrity
    related_issues = results["related_field"]
    lines.append(f"## Related 字段完整性（发现 {len(related_issues)} 个问题）")
    lines.append("")
    if related_issues:
        lines.append("| 页面 | 问题 | 详情 |")
        lines.append("|---|---|---|")
        for ri in related_issues:
            lines.append(
                f"| `{ri['page']}` | {ri['issue']} | {ri['details']} |"
            )
    else:
        lines.append("所有页面的 related 字段均合法，未指向系统文件。✅")
    lines.append("")

    # ── Source Field Validation
    source_issues = results["source_field"]
    lines.append(f"## Source 字段验证（发现 {len(source_issues)} 个问题）")
    lines.append("")
    if source_issues:
        lines.append("| 页面 | 问题 | 详情 |")
        lines.append("|---|---|---|")
        for si in source_issues:
            lines.append(
                f"| `{si['page']}` | {si['issue']} | {si['details']} |"
            )
    else:
        lines.append("所有 source 类型页面的 source 字段均有效。✅")
    lines.append("")

    # ── Missing Inline Links (Anchor Text Mining)
    link_issues = results["missing_inline_links"]
    lines.append(f"## 缺失内联链接（发现 {len(link_issues)} 处）")
    lines.append("")
    if link_issues:
        lines.append(
            "以下术语在正文首次出现时缺少 wiki 内联链接（仅报告每页每条术语的首次出现）："
        )
        lines.append("")
        lines.append("| 页面 | 术语 | 建议链接到 | 上下文 |")
        lines.append("|---|---|---|---|")
        for li in link_issues:
            targets = ", ".join(f"`{t}`" for t in li["suggested_targets"])
            snippet = li["snippet"][:60]
            lines.append(
                f"| `{li['page']}` | **{li['term']}** | {targets} | {snippet} |"
            )
    else:
        lines.append("所有已知术语在正文中的首次出现均有对应的内联链接。✅")
    lines.append("")

    # ── Duplicate Inline Links
    dup_issues = results["duplicate_inline_links"]
    lines.append(f"## 重复内联链接（发现 {len(dup_issues)} 处）")
    lines.append("")
    if dup_issues:
        lines.append(
            "以下页面在正文中多次链接到同一个目标页面"
            "（Relations/Backlinks/References/Notes 已排除）："
        )
        lines.append("")
        lines.append("| 页面 | 目标 | 出现位置 |")
        lines.append("|---|---|---|")
        for di in dup_issues:
            occ_text = "；".join(
                f"第 {o['line']} 行「{o['display']}」"
                for o in di["occurrences"]
            )
            lines.append(f"| `{di['page']}` | `{di['target']}` | {occ_text} |")
    else:
        lines.append("所有页面在正文中均无重复内联链接。✅")
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
