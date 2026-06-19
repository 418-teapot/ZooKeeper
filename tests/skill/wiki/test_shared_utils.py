"""Tests for shared/utils.py — canonical wiki utilities.

All tests use ``tmp_path`` with patched ``WIKI_DIR`` and ``REPO_ROOT`` to
avoid side effects on the real wiki.
"""

from __future__ import annotations

import sys
from contextlib import ExitStack, contextmanager
from datetime import date
from pathlib import Path
from unittest.mock import patch

import pytest

# Allow import of the shared module (not on sys.path by default).
sys.path.insert(
    0,
    str(
        Path(__file__).resolve().parent.parent.parent.parent / "wiki" / "tools"
    ),
)

import shared.utils as _shared_utils  # noqa: E402
from shared.utils import (  # noqa: E402
    all_wiki_pages,
    parse_date,
    parse_frontmatter,
    parse_frontmatter_title,
    read_file,
    strip_frontmatter,
    wiki_rel,
)

# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


@contextmanager
def _patch_paths(wiki_dir: Path, repo_root: Path | None = None):
    """Context manager that patches ``WIKI_DIR`` (and optionally ``REPO_ROOT``)
    in ``shared.utils`` so that imported functions see the patched values.

    Args:
        wiki_dir: Value to assign to ``WIKI_DIR``.
        repo_root: Optional value for ``REPO_ROOT``.
    """
    patchers = [patch.object(_shared_utils, "WIKI_DIR", wiki_dir)]
    if repo_root is not None:
        patchers.append(patch.object(_shared_utils, "REPO_ROOT", repo_root))
    with ExitStack() as stack:
        for p in patchers:
            stack.enter_context(p)
        yield


def _write(path: Path, text: str) -> Path:
    """Write *text* to *path*, creating parent directories."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


# ===================================================================
# 1. read_file
# ===================================================================


class TestReadFile:
    """``read_file`` — file I/O with graceful fallback."""

    def test_reads_existing_file(self, tmp_path: Path) -> None:
        """Existing file returns its UTF-8 content."""
        p = _write(tmp_path / "hello.md", "Hello, world!\n")
        assert read_file(p) == "Hello, world!\n"

    def test_file_not_found_returns_empty(self, tmp_path: Path) -> None:
        """Nonexistent file returns ``""``."""
        p = tmp_path / "nope.md"
        assert read_file(p) == ""

    def test_io_error_returns_empty_string(self, tmp_path: Path) -> None:
        """``IOError`` (e.g. a directory path) returns ``""``."""
        d = tmp_path / "dir"
        d.mkdir()

        result = read_file(d)

        assert result == ""

    def test_io_error_message_on_stderr(
        self, tmp_path: Path, capsys: pytest.CaptureFixture
    ) -> None:
        """Warning about IOError is printed to stderr."""
        d = tmp_path / "dir_for_ioerror"
        d.mkdir()
        read_file(d)
        captured = capsys.readouterr()
        assert "warning:" in captured.err
        assert str(d) in captured.err


# ===================================================================
# 2. all_wiki_pages
# ===================================================================


class TestAllWikiPages:
    """``all_wiki_pages`` — page discovery with exclusions."""

    def test_includes_regular_md(self, tmp_path: Path) -> None:
        """Regular ``.md`` files under WIKI_DIR are included."""
        wiki_dir = tmp_path / "wiki"
        _write(wiki_dir / "concepts" / "foo.md", "# Foo")
        _write(wiki_dir / "entities" / "bar.md", "# Bar")

        with _patch_paths(wiki_dir):
            result = all_wiki_pages()

        names = sorted(p.name for p in result)
        assert names == ["bar.md", "foo.md"]

    def test_excludes_meta_files(self, tmp_path: Path) -> None:
        """System / meta files are excluded."""
        wiki_dir = tmp_path / "wiki"
        _write(wiki_dir / "regular.md", "# Regular")
        for meta in (
            "index.md",
            "log.md",
            "lint-report.md",
            "health-report.md",
            "overview.md",
            "SCHEMA.md",
            ".gitkeep",
        ):
            _write(wiki_dir / meta, f"# {meta}")

        with _patch_paths(wiki_dir):
            result = all_wiki_pages()

        names = {p.name for p in result}
        assert names == {"regular.md"}

    def test_excludes_templates_dir(self, tmp_path: Path) -> None:
        """Files under ``templates/`` are excluded."""
        wiki_dir = tmp_path / "wiki"
        _write(wiki_dir / "regular.md", "# Regular")
        _write(wiki_dir / "templates" / "page-tpl.md", "# Tpl")

        with _patch_paths(wiki_dir):
            result = all_wiki_pages()

        names = {p.name for p in result}
        assert names == {"regular.md"}

    def test_excludes_tools_dir(self, tmp_path: Path) -> None:
        """Files under ``tools/`` are excluded."""
        wiki_dir = tmp_path / "wiki"
        _write(wiki_dir / "regular.md", "# Regular")
        _write(wiki_dir / "tools" / "helper.md", "# Helper")

        with _patch_paths(wiki_dir):
            result = all_wiki_pages()

        names = {p.name for p in result}
        assert names == {"regular.md"}

    def test_excludes_raw_dir(self, tmp_path: Path) -> None:
        """Files under ``raw/`` are excluded."""
        wiki_dir = tmp_path / "wiki"
        _write(wiki_dir / "regular.md", "# Regular")
        _write(wiki_dir / "raw" / "notes.md", "# Notes")

        with _patch_paths(wiki_dir):
            result = all_wiki_pages()

        names = {p.name for p in result}
        assert names == {"regular.md"}

    def test_sorted_order(self, tmp_path: Path) -> None:
        """Results are sorted alphabetically."""
        wiki_dir = tmp_path / "wiki"
        _write(wiki_dir / "z.md", "# Z")
        _write(wiki_dir / "a.md", "# A")
        _write(wiki_dir / "m.md", "# M")

        with _patch_paths(wiki_dir):
            result = all_wiki_pages()

        names = [p.name for p in result]
        assert names == ["a.md", "m.md", "z.md"]


# ===================================================================
# 3. strip_frontmatter
# ===================================================================


class TestStripFrontmatter:
    """``strip_frontmatter`` — YAML frontmatter removal."""

    def test_empty_string(self) -> None:
        """Empty string returns empty string."""
        assert strip_frontmatter("") == ""

    def test_no_frontmatter(self) -> None:
        """Content without frontmatter is returned as-is (stripped)."""
        assert strip_frontmatter("  just text  ") == "just text"

    def test_frontmatter_only(self) -> None:
        """Content that is only frontmatter returns empty string."""
        content = "---\ntitle: only frontmatter\n---"
        assert strip_frontmatter(content) == ""

    def test_trailing_content(self) -> None:
        """Body after the closing ``---`` is returned."""
        content = "---\ntitle: hello\n---\n\nreal content here"
        assert strip_frontmatter(content) == "real content here"

    def test_leading_and_trailing_whitespace(self) -> None:
        """Leading/trailing whitespace around body is stripped."""
        content = "---\ntitle: foo\n---\n  \nbody\n  "
        assert strip_frontmatter(content) == "body"

    def test_multiple_frontmatter_markers(self) -> None:
        """Only the first ``---`` … ``---`` pair is treated as frontmatter."""
        content = "---\ntitle: foo\n---\n\n---\nnot frontmatter\n---"
        assert strip_frontmatter(content) == "---\nnot frontmatter\n---"

    def test_no_closing_marker(self) -> None:
        """Opening ``---`` without closing ``---`` returns original content."""
        content = "---\ntitle: no close"
        assert strip_frontmatter(content) == "---\ntitle: no close"


# ===================================================================
# 4. parse_frontmatter
# ===================================================================


class TestParseFrontmatter:
    """``parse_frontmatter`` — minimal YAML frontmatter parser."""

    def test_scalar_values(self) -> None:
        """Simple ``key: value`` pairs are parsed correctly."""
        content = "---\ntitle: Hello\ntype: concept\nstatus: draft\n---\n"
        result = parse_frontmatter(content)
        assert result == {
            "title": "Hello",
            "type": "concept",
            "status": "draft",
        }

    def test_inline_list(self) -> None:
        """Inline list ``[a, b]`` is parsed as a Python list."""
        content = "---\ntags: [python, test]\nrelated: [foo.md, bar.md]\n---\n"
        result = parse_frontmatter(content)
        assert result["tags"] == ["python", "test"]
        assert result["related"] == ["foo.md", "bar.md"]

    def test_block_list(self) -> None:
        """Block-level list (``- a``) is parsed as a Python list."""
        content = "---\ntags:\n- python\n- test\n---\n"
        result = parse_frontmatter(content)
        assert result == {"tags": ["python", "test"]}

    def test_empty_frontmatter(self) -> None:
        """Empty frontmatter (just delimiters) returns empty dict."""
        content = "---\n---\nBody here."
        result = parse_frontmatter(content)
        assert result == {}

    def test_no_frontmatter(self) -> None:
        """Content without frontmatter returns empty dict."""
        content = "# Just a heading\n\nNo frontmatter here.\n"
        result = parse_frontmatter(content)
        assert result == {}

    def test_mixed_types(self) -> None:
        """Scalars, inline lists, and block lists in the same frontmatter."""
        content = (
            "---\ntitle: Mixed\ntype: concept\n"
            "tags: [foo, bar]\nrelated:\n- a.md\n- b.md\n---\n"
        )
        result = parse_frontmatter(content)
        assert result["title"] == "Mixed"
        assert result["type"] == "concept"
        assert result["tags"] == ["foo", "bar"]
        assert result["related"] == ["a.md", "b.md"]

    def test_quoted_values_stripped(self) -> None:
        """Quoted values have their surrounding quotes stripped."""
        content = '---\ntitle: "Hello World"\n---\n'
        result = parse_frontmatter(content)
        assert result["title"] == "Hello World"

    def test_single_quoted_values_stripped(self) -> None:
        """Single-quoted values have surrounding quotes stripped."""
        content = "---\ntitle: 'Hello World'\n---\n"
        result = parse_frontmatter(content)
        assert result["title"] == "Hello World"

    def test_commented_lines_ignored(self) -> None:
        """Lines starting with ``#`` in frontmatter are ignored."""
        content = (
            "---\ntitle: Hello\n# this is a comment\ntype: concept\n---\n"
        )
        result = parse_frontmatter(content)
        assert result == {"title": "Hello", "type": "concept"}


# ===================================================================
# 5. parse_frontmatter_title
# ===================================================================


class TestParseFrontmatterTitle:
    """``parse_frontmatter_title`` — title extraction and unescaping."""

    def test_normal_title(self) -> None:
        """Plain unquoted title is returned lowercased."""
        content = "---\ntitle: Hello World\n---\n"
        assert parse_frontmatter_title(content) == "hello world"

    def test_double_quoted_title(self) -> None:
        """Double-quoted title is unescaped and lowercased."""
        content = '---\ntitle: "Hello World"\n---\n'
        assert parse_frontmatter_title(content) == "hello world"

    def test_escaped_quotes(self) -> None:
        """Title with escaped double quotes is properly unescaped."""
        content = '---\ntitle: "few \\"people\\" laptop"\n---\n'
        result = parse_frontmatter_title(content)
        assert result == 'few "people" laptop'

    def test_single_quotes(self) -> None:
        """Single-quoted title has surrounding quotes stripped."""
        content = "---\ntitle: 'Hello World'\n---\n"
        assert parse_frontmatter_title(content) == "hello world"

    def test_missing_title(self) -> None:
        """Content without a ``title`` field returns empty string."""
        content = "---\ntype: concept\n---\n"
        assert parse_frontmatter_title(content) == ""

    def test_no_frontmatter(self) -> None:
        """Content without any frontmatter returns empty string."""
        content = "# Just a heading\n"
        assert parse_frontmatter_title(content) == ""

    def test_title_case_preservation(self) -> None:
        """Title casing is preserved after lowercasing."""
        content = '---\ntitle: "AGENT Architecture"\n---\n'
        assert parse_frontmatter_title(content) == "agent architecture"


# ===================================================================
# 6. parse_date
# ===================================================================


class TestParseDate:
    """``parse_date`` — ISO 8601 date parsing."""

    def test_valid_date(self) -> None:
        """Valid ``YYYY-MM-DD`` returns a ``date`` object."""
        result = parse_date("2024-06-01")
        assert result == date(2024, 6, 1)

    def test_invalid_date(self) -> None:
        """Invalid date string returns ``None``."""
        assert parse_date("not-a-date") is None

    def test_empty_string(self) -> None:
        """Empty string returns ``None``."""
        assert parse_date("") is None

    def test_whitespace_around_date(self) -> None:
        """Whitespace around the date string is tolerated."""
        result = parse_date("  2024-01-15  ")
        assert result == date(2024, 1, 15)

    def test_invalid_month(self) -> None:
        """Month value out of range returns ``None``."""
        assert parse_date("2024-13-01") is None

    def test_none_input(self) -> None:
        """``None`` input returns ``None``."""
        assert parse_date(None) is None  # type: ignore[arg-type]


# ===================================================================
# 7. wiki_rel
# ===================================================================


class TestWikiRel:
    """``wiki_rel`` — path relative to WIKI_DIR."""

    def test_path_under_wiki_dir(self, tmp_path: Path) -> None:
        """Path under ``WIKI_DIR`` returns wiki-root-relative string."""
        wiki_dir = tmp_path / "wiki"
        page = wiki_dir / "concepts" / "foo.md"

        with _patch_paths(wiki_dir):
            result = wiki_rel(page)

        assert result == "concepts/foo.md"

    def test_path_outside_wiki_dir(self, tmp_path: Path) -> None:
        """Path outside ``WIKI_DIR`` returns the full string form."""
        wiki_dir = tmp_path / "wiki"
        outside = tmp_path / "other" / "bar.md"

        with _patch_paths(wiki_dir):
            result = wiki_rel(outside)

        assert result == str(outside)


# ===================================================================
# 8. parse_frontmatter edge cases (lines 147, 160-161, 188)
# ===================================================================


class TestParseFrontmatterEdgeCases:
    """``parse_frontmatter`` — edge cases for previously uncovered lines."""

    def test_no_closing_marker(self) -> None:
        """Frontmatter with opening ``---`` but no closing ``---`` returns empty dict (line 147)."""
        content = "---\ntitle: Hello\ntype: concept\n"
        result = parse_frontmatter(content)
        assert result == {}

    def test_block_list_flush_on_new_key(self) -> None:
        """Block-level list followed by a new key flushes accum to dict (lines 160-161)."""
        content = "---\ntags:\n- python\n- test\ntitle: After List\n---\nBody."
        result = parse_frontmatter(content)
        assert result["tags"] == ["python", "test"]
        assert result["title"] == "After List"

    def test_non_key_line_sets_current_key_to_none(self) -> None:
        """A line without ``:`` that is not a list item sets ``current_key = None`` (line 188)."""
        content = "---\ntitle: Hello\nunknown_line\ntype: concept\n---\n"
        result = parse_frontmatter(content)
        assert result["title"] == "Hello"
        assert result["type"] == "concept"
        # "unknown_line" should not produce a key or crash
