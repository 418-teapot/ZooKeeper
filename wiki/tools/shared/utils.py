"""Canonical shared utilities for wiki CLI tools.

All wiki tools under ``wiki/tools/`` share common path resolution, I/O,
frontmatter parsing, and date-parsing logic.  This module provides the
single canonical implementation so that bugfixes and behavior changes
propagate to all tools automatically.

Import from the ``shared`` package::

    from shared.utils import WIKI_DIR, read_file, all_wiki_pages, ...
"""

from __future__ import annotations

import re
import sys
from datetime import date, datetime
from pathlib import Path
from typing import Any

# ---------------------------------------------------------------------------
# Paths
# ---------------------------------------------------------------------------

#: User-global wiki directory (resolved symlink).  Portable across plugin
#: installations — the ``~/.zoo/wiki`` symlink always points to the current
#: wiki location under the ZooKeeper repo.
WIKI_DIR = (Path.home() / ".zoo" / "wiki").resolve()

#: Repository root: walk 3 levels up from ``shared/utils.py``:
#:   shared/ → tools/ → wiki/ → repo root.
REPO_ROOT = Path(__file__).resolve().parent.parent.parent

# ---------------------------------------------------------------------------
# File I/O
# ---------------------------------------------------------------------------


def read_file(path: Path) -> str:
    """Read a file and return its contents as a UTF-8 string.

    Args:
        path: The file path to read.

    Returns:
        File contents on success, or ``""`` if the file does not exist.
        On ``IOError`` or ``UnicodeDecodeError`` a warning is printed to
        stderr and ``""`` is returned.
    """
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return ""
    except (IOError, UnicodeDecodeError) as exc:
        print(
            f"warning: failed to read {path} — {exc}",
            file=sys.stderr,
        )
        return ""


# ---------------------------------------------------------------------------
# Page discovery
# ---------------------------------------------------------------------------

#: Set of meta / system filenames excluded from wiki page listings.
_META_FILES: set[str] = {
    "index.md",
    "log.md",
    "lint-report.md",
    "health-report.md",
    "overview.md",
    "SCHEMA.md",
    ".gitkeep",
}


def all_wiki_pages() -> list[Path]:
    """Return all markdown files under ``WIKI_DIR``, excluding meta / system files.

    The following are excluded:

    * Meta files: ``index.md``, ``log.md``, ``lint-report.md``,
      ``health-report.md``, ``overview.md``, ``SCHEMA.md``, ``.gitkeep``.
    * Files under the ``templates/``, ``tools/``, and ``raw/`` directories.

    Returns:
        Sorted list of paths.
    """
    return sorted(
        p
        for p in WIKI_DIR.rglob("*.md")
        if p.name not in _META_FILES
        and "templates" not in p.parts
        and "tools" not in p.parts
        and "raw" not in p.parts
    )


# ---------------------------------------------------------------------------
# Frontmatter utilities
# ---------------------------------------------------------------------------


def strip_frontmatter(content: str) -> str:
    """Remove YAML frontmatter (``---`` … ``---``) from *content*.

    Args:
        content: Raw file content that may start with YAML frontmatter.

    Returns:
        Body text after the closing ``---`` delimiter, or the original
        content if no frontmatter is present.
    """
    if content.startswith("---"):
        end = content.find("---", 3)
        if end != -1:
            return content[end + 3 :].strip()
    return content.strip()


# Regex matching YAML frontmatter delimiter line.
_FRONTMATTER_RE = re.compile(r"^---\s*$", re.MULTILINE)


def parse_frontmatter(content: str) -> dict[str, Any]:
    """Minimal YAML frontmatter parser.

    Handles ``key: value`` pairs and YAML list syntax (both inline
    ``[a, b]`` and block ``- a\\n- b``).  Returns a dict with raw
    string / list values.

    Args:
        content: Raw file content potentially starting with YAML frontmatter.

    Returns:
        Dictionary of frontmatter fields, or an empty dict if no valid
        frontmatter is found.
    """
    fm: dict[str, Any] = {}
    fm_match = _FRONTMATTER_RE.match(content)
    if not fm_match:
        return fm
    end = fm_match.end()
    fm_end = _FRONTMATTER_RE.search(content[end:])
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


def parse_frontmatter_title(content: str) -> str:
    """Extract and lightly unescape a frontmatter title scalar.

    Handles YAML-escaped quotes (e.g. ``title: "few \\"people\\" laptop"``)
    so that title matching does not false-positive on escaped strings.

    Args:
        content: Raw file content containing YAML frontmatter.

    Returns:
        Lowercased title string, or ``""`` if no title is found.
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


def parse_date(date_str: str) -> date | None:
    """Parse an ISO 8601 date string (``YYYY-MM-DD`` or ``YYYY-MM-DDTHH:mm:ssZ``).

    Accepts both with and without time component for backward compatibility.

    Args:
        date_str: Date string in ISO 8601 format.

    Returns:
        A ``date`` object, or ``None`` if parsing fails.
    """
    try:
        cleaned = date_str.strip()
        # Handle trailing "Z" suffix
        if cleaned.endswith("Z"):
            cleaned = cleaned[:-1]
        return datetime.fromisoformat(cleaned).date()
    except (ValueError, AttributeError):
        return None


# ---------------------------------------------------------------------------
# Path helpers
# ---------------------------------------------------------------------------


def wiki_rel(path: Path) -> str:
    """Return *path* relative to ``WIKI_DIR`` (wiki-root-relative).

    The returned string has no leading ``wiki/`` prefix — it is the path
    as used in index entries, log entries, and cross-references.

    Args:
        path: An absolute or relative path under ``WIKI_DIR``.

    Returns:
        Wiki-root-relative string, or ``str(path)`` if the path is not
        under ``WIKI_DIR``.
    """
    try:
        return str(path.relative_to(WIKI_DIR))
    except ValueError:
        return str(path)
