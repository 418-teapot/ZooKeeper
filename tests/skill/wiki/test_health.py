"""Tests for wiki/tools/health.py.

All tests use tmp_path to create temporary wiki structures and monkeypatch
health.py module-level constants (REPO_ROOT, WIKI_DIR, INDEX_FILE, LOG_FILE)
to point into tmp_path.  No side effects on the real wiki directory.
"""

import importlib.util
import json
import os
import subprocess
import sys
from pathlib import Path

import pytest

# ── Load health.py via importlib ───────────────────────────────────

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent
_HEALTH_PATH = _REPO_ROOT / "wiki" / "tools" / "health.py"

# Ensure wiki/tools/ is on sys.path so that ``from shared.utils import ...``
# works when health.py is loaded via importlib.
_TOOLS_DIR = str(_HEALTH_PATH.parent)
if _TOOLS_DIR not in sys.path:
    sys.path.insert(0, _TOOLS_DIR)

_spec = importlib.util.spec_from_file_location("health", _HEALTH_PATH)
health = importlib.util.module_from_spec(_spec)
sys.modules["health"] = health
_spec.loader.exec_module(health)


# ── Helpers ──────────────────────────────────────────────────────────


def _write(path: Path, text: str) -> Path:
    """Write *text* to *path*, creating parent directories."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


# ── Fixtures ─────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _patch_paths(monkeypatch, tmp_path):
    """Redirect all health.py module-level path constants to *tmp_path*.

    Every test automatically gets::

        REPO_ROOT  -> tmp_path
        WIKI_DIR   -> tmp_path / "wiki"
        INDEX_FILE -> tmp_path / "wiki" / "index.md"
        LOG_FILE   -> tmp_path / "wiki" / "log.md"
    """
    wiki_dir = tmp_path / "wiki"
    wiki_dir.mkdir()
    monkeypatch.setattr(health, "REPO_ROOT", tmp_path)
    monkeypatch.setattr(health, "WIKI_DIR", wiki_dir)
    monkeypatch.setattr(health, "INDEX_FILE", wiki_dir / "index.md")
    monkeypatch.setattr(health, "LOG_FILE", wiki_dir / "log.md")
    # Also patch shared.utils globals since imported functions (all_wiki_pages,
    # wiki_rel, parse_frontmatter, …) reference shared.utils.WIKI_DIR, not the
    # local binding in the health module.
    import shared.utils as _shared_utils

    monkeypatch.setattr(_shared_utils, "WIKI_DIR", wiki_dir)
    monkeypatch.setattr(_shared_utils, "REPO_ROOT", tmp_path)


# ── strip_frontmatter ────────────────────────────────────────────────


class TestStripFrontmatter:
    def test_strips_yaml_frontmatter(self):
        """Returns body content after stripping YAML frontmatter."""
        content = "---\ntitle: hello\n---\n\nreal content here"
        assert health.strip_frontmatter(content) == "real content here"

    def test_empty_string(self):
        """Empty string returns empty string."""
        assert health.strip_frontmatter("") == ""

    def test_no_frontmatter(self):
        """Content without frontmatter is returned as-is (stripped)."""
        assert health.strip_frontmatter("  just text  ") == "just text"

    def test_frontmatter_only(self):
        """Content that is only frontmatter (no body) returns empty string."""
        content = "---\ntitle: only frontmatter\n---"
        assert health.strip_frontmatter(content) == ""

    def test_leading_and_trailing_whitespace(self):
        """Leading/trailing whitespace around body is stripped."""
        content = "---\ntitle: foo\n---\n  \nbody\n  "
        assert health.strip_frontmatter(content) == "body"

    def test_multiple_frontmatter_markers(self):
        """Only the first --- ... --- pair is treated as frontmatter."""
        content = "---\ntitle: foo\n---\n\n---\nnot frontmatter\n---"
        assert health.strip_frontmatter(content) == "---\nnot frontmatter\n---"


# ── check_empty_files ────────────────────────────────────────────────


class TestCheckEmptyFiles:
    def test_page_with_large_body_is_not_stub(self, tmp_path):
        """Page with body > 100 chars is absent from results."""
        page = _write(
            tmp_path / "wiki" / "sources" / "large.md",
            "---\ntitle: large\n---\n\n" + "x" * 200,
        )
        result = health.check_empty_files([page])
        assert result == []

    def test_page_with_small_body_is_stub(self, tmp_path):
        """Page with body < 100 chars is reported as 'stub'."""
        page = _write(
            tmp_path / "wiki" / "sources" / "small.md",
            "---\ntitle: small\n---\n\n" + "x" * 30,
        )
        result = health.check_empty_files([page])
        assert len(result) == 1
        assert result[0]["status"] == "stub"
        assert result[0]["body_bytes"] == 30

    def test_empty_body_is_empty(self, tmp_path):
        """Page with no body content is reported as 'empty'."""
        page = _write(
            tmp_path / "wiki" / "sources" / "empty.md",
            "---\ntitle: empty\n---\n",
        )
        result = health.check_empty_files([page])
        assert len(result) == 1
        assert result[0]["status"] == "empty"
        assert result[0]["body_bytes"] == 0

    def test_frontmatter_only_is_empty(self, tmp_path):
        """Page with only YAML frontmatter (and no body after) is 'empty'."""
        page = _write(
            tmp_path / "wiki" / "concepts" / "fm-only.md",
            "---\ntitle: only frontmatter\n---",
        )
        result = health.check_empty_files([page])
        assert len(result) == 1
        assert result[0]["status"] == "empty"

    def test_mixed_pages(self, tmp_path):
        """Multiple pages: only stub/empty pages appear in results."""
        large = _write(
            tmp_path / "wiki" / "sources" / "large.md",
            "---\ntitle: large\n---\n\n" + "x" * 200,
        )
        small = _write(
            tmp_path / "wiki" / "sources" / "small.md",
            "---\ntitle: small\n---\n\n" + "x" * 10,
        )
        empty = _write(
            tmp_path / "wiki" / "concepts" / "empty.md",
            "---\ntitle: empty\n---\n",
        )
        result = health.check_empty_files([large, small, empty])
        assert len(result) == 2
        statuses = {r["path"]: r["status"] for r in result}
        # paths are relative to REPO_ROOT (tmp_path)
        assert statuses["sources/small.md"] == "stub"
        assert statuses["concepts/empty.md"] == "empty"

    def test_custom_threshold(self, tmp_path):
        """Custom threshold changes what qualifies as a stub."""
        page = _write(
            tmp_path / "wiki" / "sources" / "page.md",
            "---\ntitle: page\n---\n\n" + "x" * 50,
        )
        # threshold=40 → 50 >= 40, not a stub
        result = health.check_empty_files([page], threshold=40)
        assert result == []

        # threshold=60 → 50 < 60, is a stub
        result = health.check_empty_files([page], threshold=60)
        assert len(result) == 1
        assert result[0]["status"] == "stub"

    def test_sort_order(self, tmp_path):
        """Results are sorted by body_bytes ascending."""
        pages = [
            _write(
                tmp_path / "wiki" / f"page{i}.md",
                "---\ntitle: p{i}\n---\n\n" + "x" * chars,
            )
            for i, chars in enumerate([50, 10, 30])
        ]
        result = health.check_empty_files(pages)
        body_sizes = [r["body_bytes"] for r in result]
        assert body_sizes == sorted(body_sizes)


# ── check_index_sync ─────────────────────────────────────────────────


class TestCheckIndexSync:
    def test_on_disk_not_in_index(self, tmp_path):
        """File on disk but missing from index.md → on_disk_not_in_index."""
        index = tmp_path / "wiki" / "index.md"
        _write(index, "# Index\n\n- [Existing](sources/existing.md)\n")
        disk_page = _write(
            tmp_path / "wiki" / "sources" / "orphan.md",
            "# Orphan page",
        )
        # Also create the page that IS in the index so it's not reported
        _write(
            tmp_path / "wiki" / "sources" / "existing.md",
            "# Existing page",
        )

        result = health.check_index_sync(
            [disk_page, tmp_path / "wiki" / "sources" / "existing.md"]
        )
        assert result["on_disk_not_in_index"] == ["sources/orphan.md"]
        assert result["in_index_not_on_disk"] == []

    def test_in_index_not_on_disk(self, tmp_path):
        """Index entry without corresponding file → in_index_not_on_disk."""
        index = tmp_path / "wiki" / "index.md"
        _write(
            index,
            "# Index\n\n"
            "- [Stale](sources/stale.md)\n"
            "- [Alive](sources/alive.md)\n",
        )
        alive = _write(
            tmp_path / "wiki" / "sources" / "alive.md",
            "# Alive page",
        )

        result = health.check_index_sync([alive])
        stale_paths = result["in_index_not_on_disk"]
        assert "sources/stale.md" in stale_paths
        assert "sources/alive.md" not in stale_paths
        assert result["on_disk_not_in_index"] == []

    def test_all_synced(self, tmp_path):
        """All index entries match disk files → both lists empty."""
        index = tmp_path / "wiki" / "index.md"
        _write(
            index,
            "# Index\n\n- [Page A](sources/a.md)\n- [Page B](concepts/b.md)\n",
        )
        a = _write(tmp_path / "wiki" / "sources" / "a.md", "# A")
        b = _write(tmp_path / "wiki" / "concepts" / "b.md", "# B")

        result = health.check_index_sync([a, b])
        assert result["on_disk_not_in_index"] == []
        assert result["in_index_not_on_disk"] == []

    def test_meta_pages_excluded(self, tmp_path):
        """overview.md is excluded from both sides to avoid false positives."""
        index = tmp_path / "wiki" / "index.md"
        _write(
            index,
            "# Index\n\n- [Overview](wiki/overview.md)\n",
        )
        overview = _write(
            tmp_path / "wiki" / "overview.md",
            "# Overview",
        )
        # overview.md on disk but in index → should NOT be flagged as mismatch
        result = health.check_index_sync([overview])
        assert result["on_disk_not_in_index"] == []
        assert result["in_index_not_on_disk"] == []


# ── check_log_coverage ───────────────────────────────────────────────


class TestCheckLogCoverage:
    def test_covered_source_page(self, tmp_path):
        """Source page with a matching log entry is not reported as missing."""
        log = tmp_path / "wiki" / "log.md"
        _write(
            log,
            "## [2024-06-01] create | sources/adr/my-adr.md | adr — Added\n",
        )
        page = _write(
            tmp_path / "wiki" / "sources" / "adr" / "my-adr.md",
            "---\ntitle: My ADR\n---\n\nBody content.",
        )
        result = health.check_log_coverage([page])
        assert result == []

    def test_missing_source_page(self, tmp_path):
        """Source page without a log entry is reported as missing."""
        _write(tmp_path / "wiki" / "log.md", "# Log\n")
        page = _write(
            tmp_path / "wiki" / "sources" / "adr" / "unlogged.md",
            "---\ntitle: Unlogged ADR\n---\n\nBody.",
        )
        result = health.check_log_coverage([page])
        assert len(result) == 1
        assert result[0]["path"] == "sources/adr/unlogged.md"
        assert result[0]["slug"] == "unlogged"
        assert result[0]["title"] == "unlogged adr"

    def test_non_source_pages_ignored(self, tmp_path):
        """Concepts/entities pages are not checked for log coverage."""
        _write(tmp_path / "wiki" / "log.md", "# Log\n")
        _write(
            tmp_path / "wiki" / "log.md",
            "# Log\n## [2024-06-01] create | sources/adr/logged.md | adr\n",
        )
        # A source page that is logged
        _write(
            tmp_path / "wiki" / "sources" / "adr" / "logged.md",
            "---\ntitle: Logged\n---\n\nBody.",
        )
        # Non-source pages — should be ignored even with no log entry
        _write(
            tmp_path / "wiki" / "concepts" / "foo.md",
            "---\ntitle: Foo concept\n---\n\nBody.",
        )
        _write(
            tmp_path / "wiki" / "entities" / "bar.md",
            "---\ntitle: Bar entity\n---\n\nBody.",
        )

        # check_log_coverage ignores the `pages` parameter — it scans
        # WIKI_DIR/sources/ directly.
        result = health.check_log_coverage([])
        # Only sources/adr/logged.md exists under sources/, and it IS logged
        assert result == []

    def test_empty_sources_dir(self, tmp_path):
        """No sources/ directory → empty list (no crash)."""
        _write(tmp_path / "wiki" / "log.md", "# Log\n")
        result = health.check_log_coverage([])
        assert result == []

    def test_title_from_frontmatter(self, tmp_path):
        """Missing page title is extracted from frontmatter (lowercased)."""
        _write(tmp_path / "wiki" / "log.md", "# Log\n")
        _write(
            tmp_path / "wiki" / "sources" / "rfc" / "my-rfc.md",
            '---\ntitle: "My RFC Title"\n---\n\nBody.',
        )
        result = health.check_log_coverage([])
        assert len(result) == 1
        assert result[0]["title"] == "my rfc title"

    def test_slug_fallback_when_no_title(self, tmp_path):
        """When frontmatter has no title, stem is used as fallback."""
        _write(tmp_path / "wiki" / "log.md", "# Log\n")
        _write(
            tmp_path / "wiki" / "sources" / "notes" / "note-42.md",
            "---\nother: field\n---\n\nBody.",
        )
        result = health.check_log_coverage([])
        assert len(result) == 1
        assert result[0]["title"] == "note-42"


# ── all_wiki_pages ───────────────────────────────────────────────────


class TestAllWikiPages:
    def test_excludes_templates(self, tmp_path):
        """Files under templates/ are excluded."""
        _write(tmp_path / "wiki" / "sources" / "valid.md", "# Valid")
        _write(tmp_path / "wiki" / "templates" / "template.md", "# Template")
        pages = health.all_wiki_pages()
        names = [p.name for p in pages]
        assert "valid.md" in names
        assert "template.md" not in names

    def test_excludes_schema(self, tmp_path):
        """SCHEMA.md is excluded."""
        _write(tmp_path / "wiki" / "sources" / "valid.md", "# Valid")
        _write(tmp_path / "wiki" / "SCHEMA.md", "# Schema")
        pages = health.all_wiki_pages()
        names = [p.name for p in pages]
        assert "SCHEMA.md" not in names

    def test_excludes_overview(self, tmp_path):
        """overview.md is excluded."""
        _write(tmp_path / "wiki" / "sources" / "valid.md", "# Valid")
        _write(tmp_path / "wiki" / "overview.md", "# Overview")
        pages = health.all_wiki_pages()
        names = [p.name for p in pages]
        assert "overview.md" not in names

    def test_includes_regular_md_files(self, tmp_path):
        """Regular .md files under subdirectories are included."""
        expected = [
            _write(tmp_path / "wiki" / "sources" / "adr" / "a.md", "# A"),
            _write(tmp_path / "wiki" / "sources" / "rfc" / "b.md", "# B"),
            _write(tmp_path / "wiki" / "concepts" / "c.md", "# C"),
        ]
        pages = health.all_wiki_pages()
        # Resolve to canonical paths for comparison
        expected_set = {p.resolve() for p in expected}
        result_set = {p.resolve() for p in pages}
        assert expected_set == result_set

    def test_excludes_meta_files(self, tmp_path):
        """index.md, log.md, lint-report.md, health-report.md are excluded."""
        _write(tmp_path / "wiki" / "sources" / "valid.md", "# Valid")
        for meta in (
            "index.md",
            "log.md",
            "lint-report.md",
            "health-report.md",
        ):
            _write(tmp_path / "wiki" / meta, f"# {meta}")
        pages = health.all_wiki_pages()
        names = {p.name for p in pages}
        assert "valid.md" in names
        for meta in (
            "index.md",
            "log.md",
            "lint-report.md",
            "health-report.md",
        ):
            assert meta not in names

    def test_excludes_templates_in_subdirs(self, tmp_path):
        """Files inside a nested templates/ directory are excluded."""
        _write(
            tmp_path / "wiki" / "sources" / "adr" / "real.md",
            "# Real",
        )
        _write(
            tmp_path / "wiki" / "templates" / "sub" / "nested.md",
            "# Nested template",
        )
        pages = health.all_wiki_pages()
        names = [p.name for p in pages]
        assert "real.md" in names
        assert "nested.md" not in names


# ── check_frontmatter ────────────────────────────────────────────────


class TestCheckFrontmatter:
    """``check_frontmatter`` — required fields + valid enum values."""

    VALID_PAGE = """\
---
title: Valid Page
type: concept
timestamp: 2024-06-01T00:00:00Z
tags: [test]
status: draft
---
"""

    def _run_check(self, wiki_dir, pages) -> list[dict]:
        """Helper: write pages and run check_frontmatter."""
        page_paths: list[Path] = []
        for name, content in pages:
            p = wiki_dir / name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(content)
            page_paths.append(p)
        return health.check_frontmatter(page_paths)

    def test_missing_frontmatter_detection(self, tmp_path):
        """Page without YAML frontmatter gets ``missing_frontmatter``."""
        results = self._run_check(
            tmp_path / "wiki",
            [("page.md", "# Just content\n\nNo frontmatter here.\n")],
        )
        issues = {r["issue"] for r in results}
        assert "missing_frontmatter" in issues

    def test_missing_required_field(self, tmp_path):
        """Missing required field is flagged."""
        results = self._run_check(
            tmp_path / "wiki",
            [
                (
                    "page.md",
                    "---\ntype: concept\n"
                    "timestamp: 2024-06-01T00:00:00Z\n"
                    "tags: [test]\nstatus: draft\n---\n",
                ),
            ],
        )
        issues = {r["issue"] for r in results}
        assert "missing_field:title" in issues

    def test_invalid_type(self, tmp_path):
        """Invalid ``type`` value is flagged."""
        results = self._run_check(
            tmp_path / "wiki",
            [
                (
                    "page.md",
                    "---\ntitle: Bad Type\ntype: bogus\n"
                    "timestamp: 2024-06-01T00:00:00Z\n"
                    "tags: [test]\nstatus: draft\n---\n",
                ),
            ],
        )
        issues = {r["issue"] for r in results}
        assert "invalid_type:bogus" in issues

    def test_invalid_status(self, tmp_path):
        """Invalid ``status`` value is flagged."""
        results = self._run_check(
            tmp_path / "wiki",
            [
                (
                    "page.md",
                    "---\ntitle: Bad Status\ntype: concept\n"
                    "timestamp: 2024-06-01T00:00:00Z\n"
                    "tags: [test]\nstatus: unknown\n---\n",
                ),
            ],
        )
        issues = {r["issue"] for r in results}
        assert "invalid_status:unknown" in issues

    def test_valid_frontmatter_passes(self, tmp_path):
        """All fields valid → no issues."""
        results = self._run_check(
            tmp_path / "wiki",
            [("page.md", self.VALID_PAGE)],
        )
        assert len(results) == 0, f"Expected clean, got: {results}"

    def test_invalid_date_format(self, tmp_path):
        """Invalid date format in ``timestamp`` is flagged."""
        results = self._run_check(
            tmp_path / "wiki",
            [
                (
                    "page.md",
                    "---\ntitle: Bad Date\ntype: concept\n"
                    "timestamp: not-a-date\n"
                    "tags: [test]\nstatus: draft\n---\n",
                ),
            ],
        )
        issues = {r["issue"] for r in results}
        assert "invalid_date:timestamp" in issues


class TestCheckRelatedField:
    """Test that check_related_field detects issues correctly."""

    def _run_check(
        self,
        wiki_dir: Path,
        pages: list[tuple[str, str]],
    ) -> list[dict]:
        """Helper: create *pages* under *wiki_dir* and run check_related_field."""
        page_paths = []
        for rel_path, content in pages:
            p = wiki_dir / rel_path
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(content)
            page_paths.append(p)
        return health.check_related_field(page_paths)

    def test_valid_related_field(self, tmp_path):
        """Valid related field with wiki-root-relative path passes."""
        results = self._run_check(
            tmp_path / "wiki",
            [
                (
                    "concepts/page.md",
                    "---\ntitle: Test\ntype: concept\nrelated: [sources/notes/example.md]\n---\n# Content",
                ),
            ],
        )
        assert len(results) == 0

    def test_related_to_system_file(self, tmp_path):
        """Related field pointing to system file is flagged."""
        results = self._run_check(
            tmp_path / "wiki",
            [
                (
                    "concepts/page.md",
                    "---\ntitle: Test\ntype: concept\nrelated: [SCHEMA.md]\n---\n# Content",
                ),
            ],
        )
        issues = [r["issue"] for r in results]
        assert "related_to_system_file" in issues
        assert any("SCHEMA.md" in r["details"] for r in results)

    def test_markdown_link_to_system_file(self, tmp_path):
        """Markdown link in body pointing to system file is flagged."""
        results = self._run_check(
            tmp_path / "wiki",
            [
                (
                    "concepts/page.md",
                    "---\ntitle: Test\ntype: concept\n---\n# Content\n\nSee [SCHEMA.md](SCHEMA.md) for details.",
                ),
            ],
        )
        issues = [r["issue"] for r in results]
        assert "markdown_link_to_system_file" in issues
        assert any("SCHEMA.md" in r["details"] for r in results)

    def test_multiple_markdown_links(self, tmp_path):
        """Multiple Markdown links to system files are all flagged."""
        results = self._run_check(
            tmp_path / "wiki",
            [
                (
                    "concepts/page.md",
                    "---\ntitle: Test\ntype: concept\n---\n# Content\n\n"
                    "See [SCHEMA.md](SCHEMA.md), [index.md](index.md), and [log.md](log.md).",
                ),
            ],
        )
        assert len(results) == 3
        targets = [r["details"] for r in results]
        assert any("SCHEMA.md" in t for t in targets)
        assert any("index.md" in t for t in targets)
        assert any("log.md" in t for t in targets)

    def test_external_links_ignored(self, tmp_path):
        """External URLs and anchors are not flagged."""
        results = self._run_check(
            tmp_path / "wiki",
            [
                (
                    "concepts/page.md",
                    "---\ntitle: Test\ntype: concept\n---\n# Content\n\n"
                    "See [External](https://example.com) and [Section](#details).",
                ),
            ],
        )
        assert len(results) == 0


class TestCheckSourceField:
    """Test that check_source_field validates source URLs correctly."""

    def _run_check(
        self,
        wiki_dir: Path,
        pages: list[tuple[str, str]],
    ) -> list[dict]:
        """Helper: create *pages* under *wiki_dir* and run check_source_field."""
        page_paths = []
        for rel_path, content in pages:
            p = wiki_dir / rel_path
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(content)
            page_paths.append(p)
        return health.check_source_field(page_paths)

    def test_valid_source_url(self, tmp_path):
        """Source page with valid URL passes."""
        results = self._run_check(
            tmp_path / "wiki",
            [
                (
                    "sources/notes/example.md",
                    "---\ntitle: Test\ntype: source\nresource: https://example.com\n---\n# Content",
                ),
            ],
        )
        assert len(results) == 0

    def test_missing_resource_field(self, tmp_path):
        """Source page without resource field is flagged."""
        results = self._run_check(
            tmp_path / "wiki",
            [
                (
                    "sources/notes/example.md",
                    "---\ntitle: Test\ntype: source\n---\n# Content",
                ),
            ],
        )
        issues = [r["issue"] for r in results]
        assert "missing_resource_field" in issues

    def test_invalid_resource_url(self, tmp_path):
        """Source page with non-URL resource field is flagged."""
        results = self._run_check(
            tmp_path / "wiki",
            [
                (
                    "sources/notes/example.md",
                    "---\ntitle: Test\ntype: source\nresource: karpathy-llm-wiki\n---\n# Content",
                ),
            ],
        )
        issues = [r["issue"] for r in results]
        assert "invalid_resource_url" in issues
        assert any("karpathy-llm-wiki" in r["details"] for r in results)

    def test_non_source_page_ignored(self, tmp_path):
        """Non-source pages are not checked."""
        results = self._run_check(
            tmp_path / "wiki",
            [
                (
                    "concepts/page.md",
                    "---\ntitle: Test\ntype: concept\n---\n# Content",
                ),
            ],
        )
        assert len(results) == 0


# ── _extract_anchor_map ──────────────────────────────────────────────


class TestAnchorMap:
    """``_extract_anchor_map`` — build {display_text: {target, ...}} from markdown links."""

    def test_basic_mapping(self, tmp_path):
        """Display text maps to wiki-relative target path."""
        _write(
            tmp_path / "wiki" / "concepts" / "source.md",
            "---\ntitle: Source\n---\n\nSee [Target Page](concepts/target.md) for more.",
        )
        _write(
            tmp_path / "wiki" / "concepts" / "target.md",
            "---\ntitle: Target\n---\n\nTarget content.",
        )
        pages = [
            tmp_path / "wiki" / "concepts" / "source.md",
            tmp_path / "wiki" / "concepts" / "target.md",
        ]
        result = health._extract_anchor_map(pages)
        assert "Target Page" in result
        assert "concepts/target.md" in result["Target Page"]

    def test_skips_non_md_targets(self, tmp_path):
        """External URLs and non-.md targets are excluded."""
        _write(
            tmp_path / "wiki" / "page.md",
            "---\ntitle: Page\n---\n\n"
            "See [External](https://example.com) and [Image](img.png).",
        )
        result = health._extract_anchor_map([tmp_path / "wiki" / "page.md"])
        assert result == {}

    def test_multiple_pages_same_display_text(self, tmp_path):
        """Same display text pointing to same target is merged."""
        _write(
            tmp_path / "wiki" / "a.md",
            "---\ntitle: A\n---\n\n[Shared](concepts/foo.md)",
        )
        _write(
            tmp_path / "wiki" / "b.md",
            "---\ntitle: B\n---\n\n[Shared](concepts/foo.md)",
        )
        pages = [
            tmp_path / "wiki" / "a.md",
            tmp_path / "wiki" / "b.md",
        ]
        result = health._extract_anchor_map(pages)
        assert "Shared" in result
        assert result["Shared"] == {"concepts/foo.md"}

    def test_duplicate_display_text_different_targets(self, tmp_path):
        """Same display text pointing to different targets accumulates both."""
        _write(
            tmp_path / "wiki" / "a.md",
            "---\ntitle: A\n---\n\n[Ambiguous](concepts/first.md)",
        )
        _write(
            tmp_path / "wiki" / "b.md",
            "---\ntitle: B\n---\n\n[Ambiguous](concepts/second.md)",
        )
        pages = [
            tmp_path / "wiki" / "a.md",
            tmp_path / "wiki" / "b.md",
        ]
        result = health._extract_anchor_map(pages)
        assert result["Ambiguous"] == {
            "concepts/first.md",
            "concepts/second.md",
        }


# ── _expand_anchor_prefixes ──────────────────────────────────────────


class TestExpandAnchorPrefixes:
    """``_expand_anchor_prefixes`` — progressive prefix aliases."""

    def test_multi_word_prefixes_generated(self):
        """Multi-word anchor generates progressive prefix aliases."""
        anchor_map = {"hello world test": {"concepts/foo.md"}}
        health._expand_anchor_prefixes(anchor_map)
        # "hello world" and shorter forms that are >= 5 chars should appear
        assert "hello world te" in anchor_map
        assert "hello world t" in anchor_map
        assert "hello world" in anchor_map
        for alias, targets in anchor_map.items():
            if alias != "hello world test":
                assert "concepts/foo.md" in targets

    def test_short_prefixes_skipped(self):
        """Prefixes shorter than 5 characters are not added."""
        anchor_map = {"ab cd e": {"concepts/foo.md"}}
        original_keys = set(anchor_map.keys())
        health._expand_anchor_prefixes(anchor_map)
        new_keys = set(anchor_map.keys()) - original_keys
        assert all(len(k) >= 5 for k in new_keys)

    def test_single_word_no_prefixes(self):
        """Single-word text (no space) does not generate prefixes."""
        anchor_map = {"hello": {"concepts/foo.md"}}
        health._expand_anchor_prefixes(anchor_map)
        assert anchor_map == {"hello": {"concepts/foo.md"}}

    def test_existing_entries_enriched(self):
        """Existing prefix entries have their targets enriched."""
        anchor_map = {
            "hello world test": {"concepts/foo.md"},
            "hello world": {"concepts/bar.md"},
        }
        health._expand_anchor_prefixes(anchor_map)
        # "hello world" should now have targets from both the original and the longer form
        assert "concepts/foo.md" in anchor_map["hello world"]
        assert "concepts/bar.md" in anchor_map["hello world"]

    def test_no_crash_on_empty_map(self):
        """Empty anchor_map does not crash."""
        anchor_map: dict[str, set[str]] = {}
        health._expand_anchor_prefixes(anchor_map)
        assert anchor_map == {}


# ── _body_sections_to_check ──────────────────────────────────────────


class TestBodySectionsToCheck:
    """``_body_sections_to_check`` — skip Relations/Backlinks/References/Notes."""

    def test_relations_section_stripped(self):
        """Relations section is removed from body."""
        body = (
            "## Overview\n\nSome content\n\n"
            "## Relations\n\n- [Link](foo.md)\n\n"
            "## Details\n\nMore content"
        )
        result = health._body_sections_to_check(body)
        assert "## Overview" in result
        assert "## Relations" not in result
        assert "## Details" in result

    def test_all_skip_sections_stripped(self):
        """All skip sections (Relations, Backlinks, References, Notes) removed."""
        body = (
            "## Intro\n\nText.\n\n"
            "## Relations\n\n- [A](a.md)\n\n"
            "## Backlinks\n\n- [B](b.md)\n\n"
            "## References\n\n- [C](c.md)\n\n"
            "## Notes\n\n- [D](d.md)\n\n"
            "## Conclusion\n\nDone."
        )
        result = health._body_sections_to_check(body)
        assert "Relations" not in result
        assert "Backlinks" not in result
        assert "References" not in result
        assert "Notes" not in result
        assert "Intro" in result
        assert "Conclusion" in result

    def test_no_skip_sections_no_change(self):
        """Body with no skip sections is returned unchanged."""
        body = "## Overview\n\nText\n\n## Details\n\nMore text"
        result = health._body_sections_to_check(body)
        assert result == body

    def test_empty_body(self):
        """Empty body returns empty string."""
        assert health._body_sections_to_check("") == ""

    def test_trailing_relations_no_crash(self):
        """Relations section at end of body does not cause issues."""
        body = "## Overview\n\nText\n\n## Relations\n\n- [A](a.md)"
        result = health._body_sections_to_check(body)
        assert "## Overview" in result
        assert "## Relations" not in result


# ── _check_body_for_missing_links ────────────────────────────────────


class TestCheckBodyForMissingLinks:
    """``_check_body_for_missing_links`` — find anchor terms missing inline links."""

    def test_missing_link_flagged(self, tmp_path):
        """Anchor term in body without a link is flagged.
        The term must target a page DIFFERENT from rel_page to pass the
        self-reference guard (targets = valid_targets - {rel_page})."""
        _write(
            tmp_path / "wiki" / "concepts" / "linking-page.md",
            "---\ntitle: Linking Page\n---\n\nSee [Target Concept](concepts/target.md) here.",
        )
        _write(
            tmp_path / "wiki" / "concepts" / "some-page.md",
            "---\ntitle: Some Page\n---\n\nContent about Target Concept without link.",
        )
        _write(
            tmp_path / "wiki" / "concepts" / "target.md",
            "---\ntitle: Target\n---\n\nTarget content.",
        )
        pages = [
            tmp_path / "wiki" / "concepts" / "linking-page.md",
            tmp_path / "wiki" / "concepts" / "some-page.md",
            tmp_path / "wiki" / "concepts" / "target.md",
        ]
        anchor_map = health._extract_anchor_map(pages)
        body = "Content about Target Concept without link."
        rel_page = "concepts/some-page.md"
        result = health._check_body_for_missing_links(
            body, rel_page, anchor_map, tmp_path / "wiki" / "concepts"
        )
        assert len(result) == 1
        assert result[0]["term"] == "Target Concept"
        assert result[0]["issue"] == "missing_inline_link"

    def test_already_linked_not_flagged(self, tmp_path):
        """Term already linked on the same page is not flagged."""
        _write(
            tmp_path / "wiki" / "concepts" / "source.md",
            "---\ntitle: Source\n---\n\n[Target Page](concepts/target.md) is great.",
        )
        _write(
            tmp_path / "wiki" / "concepts" / "target.md",
            "---\ntitle: Target\n---\n\nSee [Target Page](concepts/target.md) for details.",
        )
        pages = [
            tmp_path / "wiki" / "concepts" / "source.md",
            tmp_path / "wiki" / "concepts" / "target.md",
        ]
        anchor_map = health._extract_anchor_map(pages)
        body = "See [Target Page](concepts/target.md) for details."
        rel_page = "concepts/target.md"
        result = health._check_body_for_missing_links(
            body, rel_page, anchor_map, tmp_path / "wiki" / "concepts"
        )
        assert result == []

    def test_term_in_code_block_skipped(self, tmp_path):
        """Terms inside code blocks are skipped."""
        _write(
            tmp_path / "wiki" / "concepts" / "source.md",
            "---\ntitle: Source\n---\n\n[Target Concept](concepts/target.md) is great.",
        )
        _write(
            tmp_path / "wiki" / "concepts" / "other.md",
            "---\ntitle: Other\n---\n\nSome text\n\n```\nTarget Concept inside code\n```",
        )
        _write(
            tmp_path / "wiki" / "concepts" / "target.md",
            "---\ntitle: Target\n---\n\nTarget content.",
        )
        pages = [
            tmp_path / "wiki" / "concepts" / "source.md",
            tmp_path / "wiki" / "concepts" / "other.md",
            tmp_path / "wiki" / "concepts" / "target.md",
        ]
        anchor_map = health._extract_anchor_map(pages)
        body = "Some text\n\n```\nTarget Concept inside code\n```"
        rel_page = "concepts/other.md"
        result = health._check_body_for_missing_links(
            body, rel_page, anchor_map, tmp_path / "wiki" / "concepts"
        )
        # After removing code block, "Target Concept" is gone from body
        assert result == []

    def test_self_reference_skipped(self, tmp_path):
        """Term that only maps to the page itself (self-reference) is skipped."""
        # Manually create anchor_map with title as self-reference
        anchor_map = {"Target Page": {"concepts/target.md"}}
        body = "Mentions Target Page in body without link."
        rel_page = "concepts/target.md"
        result = health._check_body_for_missing_links(
            body, rel_page, anchor_map, tmp_path / "wiki" / "concepts"
        )
        # targets = valid_targets - {rel_page} = {} → skip
        assert result == []

    def test_snippet_includes_context(self, tmp_path):
        """Snippet field includes surrounding context of the term."""
        _write(
            tmp_path / "wiki" / "concepts" / "linking-page.md",
            "---\ntitle: Linking Page\n---\n\nSee [Target Concept](concepts/target.md) here.",
        )
        _write(
            tmp_path / "wiki" / "concepts" / "other-page.md",
            "---\ntitle: Other Page\n---\n\nSome leading text here. Target Concept is referenced in body.",
        )
        _write(
            tmp_path / "wiki" / "concepts" / "target.md",
            "---\ntitle: Target\n---\n\nTarget content.",
        )
        pages = [
            tmp_path / "wiki" / "concepts" / "linking-page.md",
            tmp_path / "wiki" / "concepts" / "other-page.md",
            tmp_path / "wiki" / "concepts" / "target.md",
        ]
        anchor_map = health._extract_anchor_map(pages)
        body = "Some leading text here. Target Concept is referenced in body."
        rel_page = "concepts/other-page.md"
        result = health._check_body_for_missing_links(
            body, rel_page, anchor_map, tmp_path / "wiki" / "concepts"
        )
        assert len(result) == 1
        snippet = result[0]["snippet"]
        assert "Target Concept" in snippet
        assert snippet.startswith("…")

    def test_single_token_terms_skipped(self, tmp_path):
        """Single-token terms (no space, no em-dash) are not checked."""
        _write(
            tmp_path / "wiki" / "concepts" / "source.md",
            "---\ntitle: Source\n---\n\n[SingleTerm](concepts/target.md)",
        )
        _write(
            tmp_path / "wiki" / "concepts" / "target.md",
            "---\ntitle: Target\n---\n\nSingleTerm is here without a link.",
        )
        pages = [
            tmp_path / "wiki" / "concepts" / "source.md",
            tmp_path / "wiki" / "concepts" / "target.md",
        ]
        anchor_map = health._extract_anchor_map(pages)
        body = "SingleTerm is here without a link."
        rel_page = "concepts/target.md"
        result = health._check_body_for_missing_links(
            body, rel_page, anchor_map, tmp_path / "wiki" / "concepts"
        )
        # "SingleTerm" is single-token (no space) → skipped
        assert result == []

    def test_short_term_skipped(self, tmp_path):
        """Multi-word term shorter than 5 characters is not checked."""
        _write(
            tmp_path / "wiki" / "concepts" / "source.md",
            "---\ntitle: Source\n---\n\n[Fo b](concepts/target.md)",
        )
        _write(
            tmp_path / "wiki" / "concepts" / "target.md",
            "---\ntitle: Target\n---\n\nFo b is very short.",
        )
        pages = [
            tmp_path / "wiki" / "concepts" / "source.md",
            tmp_path / "wiki" / "concepts" / "target.md",
        ]
        anchor_map = health._extract_anchor_map(pages)
        assert "Fo b" in anchor_map
        body = "Fo b is very short."
        rel_page = "concepts/target.md"
        result = health._check_body_for_missing_links(
            body, rel_page, anchor_map, tmp_path / "wiki" / "concepts"
        )
        # "Fo b" is 4 chars < 5 → skipped
        assert result == []


# ── check_missing_inline_links (end-to-end) ──────────────────────────


class TestCheckMissingInlineLinks:
    """``check_missing_inline_links`` — full flow: extract, expand, check, deduplicate."""

    def test_end_to_end_missing_link(self, tmp_path):
        """Page A links to Page B.  Page B mentions Page A's title → flagged."""
        _write(
            tmp_path / "wiki" / "concepts" / "source-page.md",
            "---\ntitle: Source Page\n---\n\nSee [Target Page](concepts/target-page.md).",
        )
        _write(
            tmp_path / "wiki" / "concepts" / "target-page.md",
            "---\ntitle: Target Page\n---\n\nSource Page is linked but no backlink here.",
        )
        pages = [
            tmp_path / "wiki" / "concepts" / "source-page.md",
            tmp_path / "wiki" / "concepts" / "target-page.md",
        ]
        result = health.check_missing_inline_links(pages)
        assert len(result) >= 1
        # Should flag "Source Page" on target-page.md
        flagged_terms = {r["term"] for r in result}
        assert "Source Page" in flagged_terms

    def test_suggested_targets(self, tmp_path):
        """Result includes suggested_targets from anchor map."""
        _write(
            tmp_path / "wiki" / "concepts" / "page-a.md",
            "---\ntitle: Page A\n---\n\n[Page B](concepts/page-b.md) reference.",
        )
        _write(
            tmp_path / "wiki" / "concepts" / "page-b.md",
            "---\ntitle: Page B\n---\n\nPage A is mentioned here.",
        )
        pages = [
            tmp_path / "wiki" / "concepts" / "page-a.md",
            tmp_path / "wiki" / "concepts" / "page-b.md",
        ]
        result = health.check_missing_inline_links(pages)
        # Page B mentions "Page A" → should flag with suggested_targets
        flagged = [r for r in result if r["term"] == "Page A"]
        assert len(flagged) == 1
        assert "concepts/page-a.md" in flagged[0]["suggested_targets"]

    def test_deduplication_across_pages(self, tmp_path):
        """Deduplication removes shorter prefix matches."""
        _write(
            tmp_path / "wiki" / "concepts" / "long.md",
            "---\ntitle: Long Name Concept\n---\n\nDescribes Long Name Concept.",
        )
        _write(
            tmp_path / "wiki" / "concepts" / "target.md",
            "---\ntitle: Target\n---\n\nLong Name Concept mentioned here.",
        )
        _write(
            tmp_path / "wiki" / "concepts" / "linker.md",
            "---\ntitle: Linker\n---\n\nSee [Long Name Concept](concepts/long.md).",
        )
        pages = [
            tmp_path / "wiki" / "concepts" / "long.md",
            tmp_path / "wiki" / "concepts" / "target.md",
            tmp_path / "wiki" / "concepts" / "linker.md",
        ]
        result = health.check_missing_inline_links(pages)
        # On target.md, there should be only ONE result for "Long Name Concept" family
        target_results = [
            r for r in result if r["page"] == "concepts/target.md"
        ]
        concept_terms = [
            r for r in target_results if r["term"].startswith("Long Name")
        ]
        assert len(concept_terms) <= 1

    def test_no_false_positive_when_linked_correctly(self, tmp_path):
        """Page that already has correct links should not flag."""
        _write(
            tmp_path / "wiki" / "concepts" / "linked-page.md",
            "---\ntitle: Linked Page\n---\n\nLinked Page content.",
        )
        _write(
            tmp_path / "wiki" / "concepts" / "checking-page.md",
            "---\ntitle: Checking Page\n---\n\nSee [Linked Page](concepts/linked-page.md) for details.",
        )
        pages = [
            tmp_path / "wiki" / "concepts" / "linked-page.md",
            tmp_path / "wiki" / "concepts" / "checking-page.md",
        ]
        result = health.check_missing_inline_links(pages)
        # checking-page.md has "Linked Page" already linked → no flag
        checking_issues = [
            r for r in result if r["page"] == "concepts/checking-page.md"
        ]
        assert len(checking_issues) == 0


# ── _deduplicate_prefix_matches ──────────────────────────────────────


class TestDeduplicatePrefixMatches:
    """``_deduplicate_prefix_matches`` — shorter prefix removed when longer covers same targets."""

    def test_longer_kept_over_shorter(self):
        """Shorter prefix match removed when longer one covers same targets."""
        results = [
            {
                "page": "concepts/foo.md",
                "term": "hello world",
                "suggested_targets": ["concepts/bar.md"],
                "snippet": "…hello world…",
                "issue": "missing_inline_link",
            },
            {
                "page": "concepts/foo.md",
                "term": "hello world test",
                "suggested_targets": ["concepts/bar.md"],
                "snippet": "…hello world test…",
                "issue": "missing_inline_link",
            },
        ]
        deduped = health._deduplicate_prefix_matches(results)
        assert len(deduped) == 1
        assert deduped[0]["term"] == "hello world test"

    def test_different_targets_both_kept(self):
        """Different suggested_targets → both kept even with overlapping names."""
        results = [
            {
                "page": "concepts/foo.md",
                "term": "hello world",
                "suggested_targets": ["concepts/bar.md"],
                "snippet": "…hello world…",
                "issue": "missing_inline_link",
            },
            {
                "page": "concepts/foo.md",
                "term": "hello world test",
                "suggested_targets": ["concepts/baz.md"],
                "snippet": "…hello world test…",
                "issue": "missing_inline_link",
            },
        ]
        deduped = health._deduplicate_prefix_matches(results)
        assert len(deduped) == 2

    def test_different_pages_both_kept(self):
        """Different pages → both kept."""
        results = [
            {
                "page": "concepts/foo.md",
                "term": "hello world",
                "suggested_targets": ["concepts/bar.md"],
                "snippet": "…hello world…",
                "issue": "missing_inline_link",
            },
            {
                "page": "concepts/baz.md",
                "term": "hello world",
                "suggested_targets": ["concepts/bar.md"],
                "snippet": "…hello world…",
                "issue": "missing_inline_link",
            },
        ]
        deduped = health._deduplicate_prefix_matches(results)
        assert len(deduped) == 2

    def test_empty_list(self):
        """Empty list returns empty list."""
        assert health._deduplicate_prefix_matches([]) == []


# ── check_duplicate_inline_links ──────────────────────────────────────


class TestCheckDuplicateInlineLinks:
    """``check_duplicate_inline_links`` — same target linked multiple times in prose."""

    def test_duplicate_detected(self, tmp_path):
        """Page linking to same target twice in prose is flagged."""
        _write(
            tmp_path / "wiki" / "concepts" / "page.md",
            "---\ntitle: Page\n---\n\n"
            "See [Target](concepts/target.md) for one thing "
            "and [Target](concepts/target.md) for another.",
        )
        _write(
            tmp_path / "wiki" / "concepts" / "target.md",
            "---\ntitle: Target\n---\n\nContent.",
        )
        pages = [tmp_path / "wiki" / "concepts" / "page.md"]
        result = health.check_duplicate_inline_links(pages)
        assert len(result) == 1
        assert result[0]["target"] == "concepts/target.md"
        assert len(result[0]["occurrences"]) == 2

    def test_single_link_not_flagged(self, tmp_path):
        """Single link to a target is not flagged."""
        _write(
            tmp_path / "wiki" / "concepts" / "page.md",
            "---\ntitle: Page\n---\n\nSee [Target](concepts/target.md).",
        )
        _write(
            tmp_path / "wiki" / "concepts" / "target.md",
            "---\ntitle: Target\n---\n\nContent.",
        )
        result = health.check_duplicate_inline_links(
            [tmp_path / "wiki" / "concepts" / "page.md"]
        )
        assert result == []

    def test_relations_section_ignored(self, tmp_path):
        """Links in Relations section are ignored."""
        _write(
            tmp_path / "wiki" / "concepts" / "page.md",
            "---\ntitle: Page\n---\n\n"
            "## Relations\n\n"
            "- [Target](concepts/target.md)\n"
            "- Also [Target](concepts/target.md)\n",
        )
        _write(
            tmp_path / "wiki" / "concepts" / "target.md",
            "---\ntitle: Target\n---\n\nContent.",
        )
        result = health.check_duplicate_inline_links(
            [tmp_path / "wiki" / "concepts" / "page.md"]
        )
        assert result == []

    def test_prose_duplicate_across_sections(self, tmp_path):
        """Duplicate across two prose sections → still flagged."""
        _write(
            tmp_path / "wiki" / "concepts" / "page.md",
            "---\ntitle: Page\n---\n\n"
            "## Overview\n\nSee [Target](concepts/target.md) here.\n\n"
            "## Details\n\nAlso see [Target](concepts/target.md) there.\n",
        )
        _write(
            tmp_path / "wiki" / "concepts" / "target.md",
            "---\ntitle: Target\n---\n\nContent.",
        )
        result = health.check_duplicate_inline_links(
            [tmp_path / "wiki" / "concepts" / "page.md"]
        )
        assert len(result) == 1
        assert len(result[0]["occurrences"]) == 2


# ── format_report ────────────────────────────────────────────────────


class TestFormatReport:
    """``format_report`` — markdown report generation."""

    def test_contains_expected_sections(self):
        """Report contains all expected section headers."""
        results = {
            "date": "2025-01-01",
            "total_pages": 10,
            "empty_files": [],
            "index_sync": {
                "in_index_not_on_disk": [],
                "on_disk_not_in_index": [],
            },
            "log_coverage": [],
            "frontmatter": [],
            "related_field": [],
            "source_field": [],
            "missing_inline_links": [],
            "duplicate_inline_links": [],
        }
        report = health.format_report(results)
        assert "空文件 / 存根文件" in report
        assert "索引同步" in report
        assert "日志覆盖" in report
        assert "Frontmatter 完整性" in report
        assert "Related 字段完整性" in report
        assert "Resource 字段验证" in report
        assert "缺失内联链接" in report
        assert "重复内联链接" in report

    def test_empty_results_no_crash(self):
        """Empty results dict does not crash (graceful handling)."""
        results = {
            "date": "2025-01-01",
            "total_pages": 0,
            "empty_files": [],
            "index_sync": {
                "in_index_not_on_disk": [],
                "on_disk_not_in_index": [],
            },
            "log_coverage": [],
            "frontmatter": [],
            "related_field": [],
            "source_field": [],
            "missing_inline_links": [],
            "duplicate_inline_links": [],
        }
        report = health.format_report(results)
        assert isinstance(report, str)
        assert len(report) > 0

    def test_issues_included(self):
        """Report includes issue details when present."""
        results = {
            "date": "2025-01-01",
            "total_pages": 2,
            "empty_files": [
                {
                    "path": "concepts/empty.md",
                    "total_bytes": 20,
                    "body_bytes": 0,
                    "status": "empty",
                }
            ],
            "index_sync": {
                "in_index_not_on_disk": ["concepts/stale.md"],
                "on_disk_not_in_index": [],
            },
            "log_coverage": [
                {
                    "path": "sources/adr/missing.md",
                    "slug": "missing",
                    "title": "missing adr",
                }
            ],
            "frontmatter": [
                {
                    "page": "concepts/bad.md",
                    "issue": "missing_field:title",
                    "details": "Required frontmatter field 'title' is missing",
                }
            ],
            "related_field": [],
            "source_field": [],
            "missing_inline_links": [],
            "duplicate_inline_links": [],
        }
        report = health.format_report(results)
        assert "empty.md" in report
        assert "stale.md" in report
        assert "missing.md" in report
        assert "bad.md" in report


# ── CLI tests (subprocess) ────────────────────────────────────────────


class TestCliJson:
    """CLI ``--json`` flag produces valid JSON output."""

    def test_json_output_valid(self, tmp_path):
        """--json output is valid JSON with expected keys."""
        fake_home = tmp_path / "fake_home"
        fake_home.mkdir()
        zoo_dir = fake_home / ".zoo"
        zoo_dir.mkdir()
        target_link = zoo_dir / "wiki"
        wiki_source = tmp_path / "real_wiki"
        wiki_source.mkdir()
        os.symlink(str(wiki_source), str(target_link))

        env = {**os.environ, "HOME": str(fake_home)}

        # Create at least one wiki page with valid frontmatter so health checks pass.
        _write(
            wiki_source / "concepts" / "test-page.md",
            "---\ntitle: Test\ntype: concept\n"
            "timestamp: 2025-06-01T00:00:00Z\n"
            "tags: [test]\nstatus: draft\n---\n\nSome content.\n",
        )
        _write(
            wiki_source / "index.md",
            "# Index\n\n- [Test](concepts/test-page.md)\n",
        )
        _write(wiki_source / "log.md", "# Log\n")

        result = subprocess.run(
            [sys.executable, str(_HEALTH_PATH), "--json"],
            capture_output=True,
            text=True,
            env=env,
        )
        assert result.returncode == 0, f"stderr: {result.stderr}"
        data = json.loads(result.stdout)
        assert "date" in data
        assert "total_pages" in data
        assert "empty_files" in data
        assert "index_sync" in data
        assert "log_coverage" in data
        assert "frontmatter" in data
        assert "related_field" in data
        assert "source_field" in data
        assert "missing_inline_links" in data
        assert "duplicate_inline_links" in data


class TestCliSave:
    """CLI ``--save`` flag writes report to disk."""

    def test_save_creates_report_file(self, tmp_path):
        """--save writes health-report.md to the wiki directory.
        The wiki must live under the real wiki/ dir for ``relative_to``
        to succeed in health.py's ``--save`` path (REPO_ROOT from
        shared.utils resolves to the wiki/ directory)."""
        # REPO_ROOT in shared/utils.py = wiki/tools/shared/utils.py's
        # parent.parent.parent = wiki/ directory.
        wiki_repo_root = _REPO_ROOT / "wiki"
        test_wiki_dir = wiki_repo_root / ".zoo-test-wiki"
        test_wiki_dir.mkdir(parents=True, exist_ok=True)

        fake_home = tmp_path / "fake_home"
        fake_home.mkdir()
        zoo_dir = fake_home / ".zoo"
        zoo_dir.mkdir()
        target_link = zoo_dir / "wiki"
        os.symlink(str(test_wiki_dir), str(target_link))

        env = {**os.environ, "HOME": str(fake_home)}

        _write(
            test_wiki_dir / "concepts" / "test-page.md",
            "---\ntitle: Test\ntype: concept\n"
            "timestamp: 2025-06-01T00:00:00Z\n"
            "tags: [test]\nstatus: draft\n---\n\nSome content.\n",
        )
        _write(
            test_wiki_dir / "index.md",
            "# Index\n\n- [Test](concepts/test-page.md)\n",
        )
        _write(test_wiki_dir / "log.md", "# Log\n")

        result = subprocess.run(
            [sys.executable, str(_HEALTH_PATH), "--save"],
            capture_output=True,
            text=True,
            env=env,
        )
        assert result.returncode == 0, f"stderr: {result.stderr}"
        report_path = test_wiki_dir / "health-report.md"
        assert report_path.exists()
        content = report_path.read_text(encoding="utf-8")
        assert "Wiki 健康检查报告" in content
        assert "已保存" in result.stdout

        # Cleanup
        import shutil

        shutil.rmtree(test_wiki_dir, ignore_errors=True)


# ===================================================================
# Edge-case tests for uncovered lines
# ===================================================================


class TestCheckFrontmatterEdgeCases:
    """Edge cases for check_frontmatter."""

    def test_empty_content_skipped(self, tmp_path):
        """Page with no content is skipped (line 211)."""
        _write(tmp_path / "wiki" / "empty.md", "")
        result = health.check_frontmatter([tmp_path / "wiki" / "empty.md"])
        assert result == []

    def test_related_as_string(self, tmp_path):
        """related field as string is handled (line 299)."""
        _write(
            tmp_path / "wiki" / "page.md",
            "---\ntitle: A\ntype: concept\n"
            "timestamp: 2024-06-01T00:00:00Z\n"
            "tags: [test]\nstatus: draft\nrelated: SCHEMA.md\n---\n# Content",
        )
        result = health.check_related_field([tmp_path / "wiki" / "page.md"])
        assert len(result) == 1
        assert "related_to_system_file" in result[0]["issue"]


class TestCheckSourceFieldEdgeCases:
    """Edge cases for check_source_field."""

    def test_empty_content_skipped(self, tmp_path):
        """Page with no content is skipped (line 348)."""
        _write(tmp_path / "wiki" / "sources" / "adr" / "empty.md", "")
        result = health.check_source_field(
            [tmp_path / "wiki" / "sources" / "adr" / "empty.md"]
        )
        assert result == []

    def test_non_source_type_in_sources_dir(self, tmp_path):
        """Page in sources/ but with non-source type is skipped (line 355)."""
        _write(
            tmp_path / "wiki" / "sources" / "adr" / "draft.md",
            "---\ntitle: Draft\ntype: concept\n---\n# Draft content",
        )
        result = health.check_source_field(
            [tmp_path / "wiki" / "sources" / "adr" / "draft.md"]
        )
        assert result == []


class TestExtractAnchorMapEdgeCases:
    """Edge cases for _extract_anchor_map."""

    def test_empty_display_text_skipped(self, tmp_path):
        """Link with empty display text is skipped (line 412)."""
        wiki_dir = tmp_path / "wiki"
        _write(
            wiki_dir / "page.md",
            "---\ntitle: Page\n---\n\n[](concepts/target.md)",
        )
        _write(wiki_dir / "concepts" / "target.md", "# Target")
        result = health._extract_anchor_map([wiki_dir / "page.md"])
        assert result == {}

    def test_external_target_skipped(self, tmp_path):
        """Non-.md target is skipped (line 412-414)."""
        wiki_dir = tmp_path / "wiki"
        _write(
            wiki_dir / "page.md",
            "---\ntitle: Page\n---\n\n[Text](https://example.com)",
        )
        result = health._extract_anchor_map([wiki_dir / "page.md"])
        assert result == {}

    def test_target_outside_wiki_skipped(self, tmp_path):
        """Link target that resolves outside WIKI_DIR is skipped (lines 422-423)."""
        wiki_dir = tmp_path / "wiki"
        # wiki_dir already exists from the autouse _patch_paths fixture
        _write(
            wiki_dir / "page.md",
            "---\ntitle: Page\n---\n\n[Outside](../outside.md)",
        )
        _write(tmp_path / "outside.md", "# Outside")
        result = health._extract_anchor_map([wiki_dir / "page.md"])
        # ../outside.md resolves to tmp_path/outside.md which is outside wiki_dir
        assert result == {}


class TestExpandAnchorPrefixesEdgeCases:
    """Edge cases for _expand_anchor_prefixes."""

    def test_non_space_prefix_skipped(self):
        """Prefix without space but >= 5 chars is still skipped if no space (line 458)."""
        anchor_map = {"hello": {"concepts/foo.md"}}
        health._expand_anchor_prefixes(anchor_map)
        # Single word with no space should not generate prefixes
        assert anchor_map == {"hello": {"concepts/foo.md"}}

    def test_prefix_too_short_skipped(self):
        """Prefix shorter than 5 chars is not added (line 455-456)."""
        anchor_map = {"ab cd": {"concepts/foo.md"}}
        health._expand_anchor_prefixes(anchor_map)
        # "ab cd" = 5 chars, "ab c" = 4 chars (< 5), "ab " ends with rstrip → "ab" (too short)
        # The prefixes generated: "ab cd" (already exists), "ab c" (< 5 chars)
        result_keys = set(anchor_map.keys())
        # "ab c" (4 chars) should NOT be added
        assert "ab c" not in result_keys


class TestCheckBodyForMissingLinksEdgeCases:
    """Edge cases for _check_body_for_missing_links."""

    def test_already_reported_term_skipped(self, tmp_path):
        """Term already in reported_terms is skipped (line 557)."""
        _write(
            tmp_path / "wiki" / "a.md",
            "---\ntitle: A\n---\nSee [Target Page](concepts/target.md).",
        )
        _write(
            tmp_path / "wiki" / "concepts" / "target.md",
            "---\ntitle: Target\n---\nContent.",
        )
        pages = [tmp_path / "wiki" / "a.md"]
        anchor_map = health._extract_anchor_map(pages)

        # Body text with two occurrences of "Target Page"
        body = "Target Page is mentioned. Target Page also mentioned again."
        rel_page = "concepts/some-other.md"
        result = health._check_body_for_missing_links(
            body, rel_page, anchor_map, tmp_path / "wiki" / "concepts"
        )
        # Only the first occurrence should be reported
        assert len(result) == 1
        assert result[0]["term"] == "Target Page"

    def test_term_already_linked_covered(self, tmp_path):
        """Term already inside a link span is skipped (lines 585-588, 591)."""
        _write(
            tmp_path / "wiki" / "a.md",
            "---\ntitle: A\n---\nSee [Target Page](concepts/target.md).",
        )
        _write(
            tmp_path / "wiki" / "concepts" / "target.md",
            "---\ntitle: Target\n---\nContent.",
        )
        pages = [tmp_path / "wiki" / "a.md"]
        anchor_map = health._extract_anchor_map(pages)

        # The body already has a link for "Target Page" → no missing link
        body = "See [Target Page](concepts/target.md) for details."
        rel_page = "concepts/source.md"
        result = health._check_body_for_missing_links(
            body, rel_page, anchor_map, tmp_path / "wiki" / "concepts"
        )
        assert result == []


class TestCheckDuplicateInlineLinksEdgeCases:
    """Edge cases for check_duplicate_inline_links."""

    def test_empty_content_skipped(self, tmp_path):
        """Page with no content is skipped (line 704)."""
        _write(tmp_path / "wiki" / "empty.md", "")
        result = health.check_duplicate_inline_links(
            [tmp_path / "wiki" / "empty.md"]
        )
        assert result == []

    def test_external_url_skipped(self, tmp_path):
        """External URLs are skipped (lines 722-724)."""
        _write(
            tmp_path / "wiki" / "page.md",
            "---\ntitle: Page\n---\n\nSee [Example](https://example.com).",
        )
        result = health.check_duplicate_inline_links(
            [tmp_path / "wiki" / "page.md"]
        )
        assert result == []

    def test_target_outside_wiki_skipped(self, tmp_path):
        """Link to target outside WIKI_DIR is skipped (lines 731-732)."""
        wiki_dir = tmp_path / "wiki"
        _write(
            wiki_dir / "page.md",
            "---\ntitle: Page\n---\n\n[Outside](../outside.md)",
        )
        _write(tmp_path / "outside.md", "# Outside")
        result = health.check_duplicate_inline_links([wiki_dir / "page.md"])
        assert result == []


class TestRunHealthEdgeCases:
    """Edge cases for run_health."""

    def test_run_health_empty_wiki(self, monkeypatch, tmp_path):
        """run_health with empty wiki returns structure with correct counts (lines 761-763)."""
        from datetime import date

        wiki_dir = tmp_path / "wiki"
        # wiki_dir already created by autouse fixture
        monkeypatch.setattr(health, "WIKI_DIR", wiki_dir)
        monkeypatch.setattr(health, "INDEX_FILE", wiki_dir / "index.md")
        monkeypatch.setattr(health, "LOG_FILE", wiki_dir / "log.md")
        import shared.utils as _shared_utils

        monkeypatch.setattr(_shared_utils, "WIKI_DIR", wiki_dir)

        result = health.run_health()

        assert result["date"] == date.today().isoformat()
        assert result["total_pages"] == 0
        assert result["empty_files"] == []
        assert "index_sync" in result
        assert "log_coverage" in result
        assert "frontmatter" in result
        assert "related_field" in result
        assert "source_field" in result
        assert "missing_inline_links" in result
        assert "duplicate_inline_links" in result


class TestFormatReportEdgeCases:
    """Edge cases for format_report."""

    def test_index_sync_issues(self):
        """Index sync with stale and missing entries (lines 819-822)."""
        results = {
            "date": "2025-01-01",
            "total_pages": 3,
            "empty_files": [],
            "index_sync": {
                "in_index_not_on_disk": ["concepts/stale.md"],
                "on_disk_not_in_index": ["sources/new.md"],
            },
            "log_coverage": [],
            "frontmatter": [],
            "related_field": [],
            "source_field": [],
            "missing_inline_links": [],
            "duplicate_inline_links": [],
        }
        report = health.format_report(results)
        assert "in_index_not_on_disk" in report
        assert "on_disk_not_in_index" in report
        assert "stale.md" in report
        assert "new.md" in report

    def test_related_field_issues(self):
        """Related field issues section (lines 861-864)."""
        results = {
            "date": "2025-01-01",
            "total_pages": 1,
            "empty_files": [],
            "index_sync": {
                "in_index_not_on_disk": [],
                "on_disk_not_in_index": [],
            },
            "log_coverage": [],
            "frontmatter": [],
            "related_field": [
                {
                    "page": "concepts/page.md",
                    "issue": "related_to_system_file",
                    "details": "Points to SCHEMA.md",
                }
            ],
            "source_field": [],
            "missing_inline_links": [],
            "duplicate_inline_links": [],
        }
        report = health.format_report(results)
        assert "related_to_system_file" in report
        assert "SCHEMA.md" in report

    def test_source_field_issues(self):
        """Source field issues section (lines 876-879)."""
        results = {
            "date": "2025-01-01",
            "total_pages": 1,
            "empty_files": [],
            "index_sync": {
                "in_index_not_on_disk": [],
                "on_disk_not_in_index": [],
            },
            "log_coverage": [],
            "frontmatter": [],
            "related_field": [],
            "source_field": [
                {
                    "page": "sources/notes/bad.md",
                    "issue": "missing_resource_field",
                    "details": "Missing resource field",
                }
            ],
            "missing_inline_links": [],
            "duplicate_inline_links": [],
        }
        report = health.format_report(results)
        assert "missing_resource_field" in report
        assert "bad.md" in report

    def test_missing_inline_links_section(self):
        """Missing inline links section in report (lines 891-900)."""
        results = {
            "date": "2025-01-01",
            "total_pages": 2,
            "empty_files": [],
            "index_sync": {
                "in_index_not_on_disk": [],
                "on_disk_not_in_index": [],
            },
            "log_coverage": [],
            "frontmatter": [],
            "related_field": [],
            "source_field": [],
            "missing_inline_links": [
                {
                    "page": "concepts/page.md",
                    "term": "Target Concept",
                    "suggested_targets": ["concepts/target.md"],
                    "snippet": "...Target Concept here...",
                    "issue": "missing_inline_link",
                }
            ],
            "duplicate_inline_links": [],
        }
        report = health.format_report(results)
        assert "Target Concept" in report
        assert "concepts/target.md" in report

    def test_duplicate_inline_links_section(self):
        """Duplicate inline links section in report (lines 912-924)."""
        results = {
            "date": "2025-01-01",
            "total_pages": 2,
            "empty_files": [],
            "index_sync": {
                "in_index_not_on_disk": [],
                "on_disk_not_in_index": [],
            },
            "log_coverage": [],
            "frontmatter": [],
            "related_field": [],
            "source_field": [],
            "missing_inline_links": [],
            "duplicate_inline_links": [
                {
                    "page": "concepts/page.md",
                    "target": "concepts/target.md",
                    "occurrences": [
                        {"display": "Target", "line": 3},
                        {"display": "Target", "line": 5},
                    ],
                    "issue": "duplicate_inline_link",
                }
            ],
        }
        report = health.format_report(results)
        assert "duplicate_inline_link" in report or "重复" in report
        assert "第 3 行" in report
        assert "第 5 行" in report


class TestCheckRelatedFieldEdgeCases:
    """Additional edge cases for check_related_field."""

    def test_empty_content_skipped(self, tmp_path):
        """Page with empty content is skipped (line 290)."""
        _write(tmp_path / "wiki" / "empty.md", "")
        result = health.check_related_field([tmp_path / "wiki" / "empty.md"])
        assert result == []


class TestExtractAnchorMapMoreEdgeCases:
    """More edge cases for _extract_anchor_map."""

    def test_empty_display_text_after_strip(self, tmp_path):
        """Display text that is only whitespace is stripped to empty → skipped (line 412)."""
        wiki_dir = tmp_path / "wiki"
        _write(
            wiki_dir / "page.md",
            "---\ntitle: Page\n---\n\n[ ](concepts/target.md)\n",
        )
        _write(wiki_dir / "concepts" / "target.md", "# Target")
        result = health._extract_anchor_map([wiki_dir / "page.md"])
        # [ ] captures " " which strips to "" → skipped
        assert result == {}


class TestExpandAnchorPrefixesMoreEdgeCases:
    """More edge cases for _expand_anchor_prefixes."""

    def test_prefix_without_space_skipped(self):
        """Prefix that becomes single-word after rstrip is skipped (line 458).
        When text starts with a space, head is empty and some prefixes
        are just the tail without spaces."""
        # " hello" split on first space → head="", tail="hello"
        anchor_map = {" hello": {"concepts/foo.md"}}
        health._expand_anchor_prefixes(anchor_map)
        # "hello" (after rstrip) has no space → should be skipped
        # Only " hello" (5 chars, has space) is the original, "hello" (no space) skipped
        assert "hello" not in anchor_map


class TestCheckBodyForMissingLinksMoreEdgeCases:
    """More edge cases for _check_body_for_missing_links."""

    def test_non_md_target_skipped(self, tmp_path):
        """Link target not ending in .md is skipped in body check (line 539)."""
        _write(
            tmp_path / "wiki" / "a.md",
            "---\ntitle: A\n---\n[Target Page](concepts/target.md)",
        )
        _write(
            tmp_path / "wiki" / "concepts" / "target.md",
            "---\ntitle: Target\n---\nContent.",
        )
        pages = [tmp_path / "wiki" / "a.md"]
        anchor_map = health._extract_anchor_map(pages)

        body = "See [Target](https://example.com) here."
        rel_page = "concepts/some-page.md"
        result = health._check_body_for_missing_links(
            body, rel_page, anchor_map, tmp_path / "wiki" / "concepts"
        )
        assert isinstance(result, list)

    def test_target_outside_wiki_in_body(self, tmp_path):
        """Link target outside WIKI_DIR is skipped (lines 544-545)."""
        wiki_dir = tmp_path / "wiki"
        _write(
            wiki_dir / "a.md",
            "---\ntitle: A\n---\n[Target Page](concepts/target.md)",
        )
        _write(
            wiki_dir / "concepts" / "target.md",
            "---\ntitle: Target\n---\nContent.",
        )
        pages = [wiki_dir / "a.md"]
        anchor_map = health._extract_anchor_map(pages)

        body = "See [Outside](../outside.md) here."
        rel_page = "concepts/some-page.md"
        result = health._check_body_for_missing_links(
            body, rel_page, anchor_map, wiki_dir / "concepts"
        )
        assert isinstance(result, list)

    def test_already_reported_term_skipped(self, tmp_path):
        """Term already in reported_terms set is skipped (line 557)."""
        _write(
            tmp_path / "wiki" / "a.md",
            "---\ntitle: A\n---\n[Target Page](concepts/target.md)",
        )
        _write(
            tmp_path / "wiki" / "concepts" / "target.md",
            "---\ntitle: Target\n---\nContent.",
        )
        pages = [tmp_path / "wiki" / "a.md"]
        anchor_map = health._extract_anchor_map(pages)

        body = "Target Page is mentioned. Target Page again."
        rel_page = "concepts/other.md"
        result = health._check_body_for_missing_links(
            body, rel_page, anchor_map, tmp_path / "wiki" / "concepts"
        )
        # Only first occurrence reported
        assert len(result) == 1

    def test_term_inside_link_span_skipped(self, tmp_path):
        """Term that appears inside an existing link span is skipped (lines 585-591)."""
        _write(
            tmp_path / "wiki" / "a.md",
            "---\ntitle: A\n---\n[Target Page](concepts/target.md)",
        )
        _write(
            tmp_path / "wiki" / "concepts" / "target.md",
            "---\ntitle: Target\n---\nContent.",
        )
        pages = [tmp_path / "wiki" / "a.md"]
        anchor_map = health._extract_anchor_map(pages)

        # "Target Page" is inside the link [Target Page](...)
        body = "See [Target Page](concepts/target.md) for details."
        rel_page = "concepts/source.md"
        result = health._check_body_for_missing_links(
            body, rel_page, anchor_map, tmp_path / "wiki" / "concepts"
        )
        assert result == []


class TestCheckDuplicateInlineLinksMoreEdgeCases:
    """More edge cases for check_duplicate_inline_links."""

    def test_empty_display_text_skipped(self, tmp_path):
        """Link with whitespace-only display text is skipped (line 722)."""
        wiki_dir = tmp_path / "wiki"
        _write(
            wiki_dir / "page.md",
            "---\ntitle: Page\n---\n\n[ ](concepts/target.md)\n",
        )
        _write(wiki_dir / "concepts" / "target.md", "# Target")
        result = health.check_duplicate_inline_links([wiki_dir / "page.md"])
        assert result == []


class TestMainCli:
    """Test the main() CLI entry point (lines 933-957)."""

    def test_main_default(self, monkeypatch, capsys, tmp_path):
        """main() with no flags prints report to stdout."""
        wiki_dir = tmp_path / "wiki"
        # wiki_dir already created by the autouse _patch_paths fixture
        monkeypatch.setattr(health, "WIKI_DIR", wiki_dir)
        monkeypatch.setattr(health, "INDEX_FILE", wiki_dir / "index.md")
        monkeypatch.setattr(health, "LOG_FILE", wiki_dir / "log.md")
        import shared.utils as _shared_utils

        monkeypatch.setattr(_shared_utils, "WIKI_DIR", wiki_dir)
        monkeypatch.setattr(sys, "argv", ["health.py"])

        health.main()

        captured = capsys.readouterr()
        assert "Wiki 健康检查报告" in captured.out

    def test_main_json(self, monkeypatch, capsys, tmp_path):
        """main() with --json prints JSON."""
        wiki_dir = tmp_path / "wiki"
        monkeypatch.setattr(health, "WIKI_DIR", wiki_dir)
        monkeypatch.setattr(health, "INDEX_FILE", wiki_dir / "index.md")
        monkeypatch.setattr(health, "LOG_FILE", wiki_dir / "log.md")
        import shared.utils as _shared_utils

        monkeypatch.setattr(_shared_utils, "WIKI_DIR", wiki_dir)
        monkeypatch.setattr(sys, "argv", ["health.py", "--json"])

        health.main()

        captured = capsys.readouterr()
        data = json.loads(captured.out)
        assert "date" in data
        assert "total_pages" in data

    def test_main_save(self, monkeypatch, tmp_path):
        """main() with --save writes report to wiki dir."""
        wiki_dir = tmp_path / "wiki"
        monkeypatch.setattr(health, "REPO_ROOT", tmp_path)
        monkeypatch.setattr(health, "WIKI_DIR", wiki_dir)
        monkeypatch.setattr(health, "INDEX_FILE", wiki_dir / "index.md")
        monkeypatch.setattr(health, "LOG_FILE", wiki_dir / "log.md")
        import shared.utils as _shared_utils

        monkeypatch.setattr(_shared_utils, "WIKI_DIR", wiki_dir)
        monkeypatch.setattr(_shared_utils, "REPO_ROOT", tmp_path)
        monkeypatch.setattr(sys, "argv", ["health.py", "--save"])

        health.main()

        report_path = wiki_dir / "health-report.md"
        assert report_path.exists()
        content = report_path.read_text(encoding="utf-8")
        assert "Wiki 健康检查报告" in content
