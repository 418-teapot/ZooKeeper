"""Tests for core/skills/wiki-maintain/tools/health.py.

All tests use tmp_path to create temporary wiki structures and monkeypatch
health.py module-level constants (REPO_ROOT, WIKI_DIR, INDEX_FILE, LOG_FILE)
to point into tmp_path.  No side effects on the real wiki directory.
"""

import importlib.util
import sys
from pathlib import Path

import pytest

# ── Load health.py via importlib (hyphen in "wiki-maintain" blocks
# standard ``import``) ────────────────────────────────────────────────

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent
_HEALTH_PATH = (
    _REPO_ROOT / "core" / "skills" / "wiki-maintain" / "tools" / "health.py"
)

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
        assert statuses["wiki/sources/small.md"] == "stub"
        assert statuses["wiki/concepts/empty.md"] == "empty"

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
        _write(index, "# Index\n\n- [Existing](wiki/sources/existing.md)\n")
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
        assert result["on_disk_not_in_index"] == ["wiki/sources/orphan.md"]
        assert result["in_index_not_on_disk"] == []

    def test_in_index_not_on_disk(self, tmp_path):
        """Index entry without corresponding file → in_index_not_on_disk."""
        index = tmp_path / "wiki" / "index.md"
        _write(
            index,
            "# Index\n\n"
            "- [Stale](wiki/sources/stale.md)\n"
            "- [Alive](wiki/sources/alive.md)\n",
        )
        alive = _write(
            tmp_path / "wiki" / "sources" / "alive.md",
            "# Alive page",
        )

        result = health.check_index_sync([alive])
        stale_paths = result["in_index_not_on_disk"]
        assert "wiki/sources/stale.md" in stale_paths
        assert "wiki/sources/alive.md" not in stale_paths
        assert result["on_disk_not_in_index"] == []

    def test_all_synced(self, tmp_path):
        """All index entries match disk files → both lists empty."""
        index = tmp_path / "wiki" / "index.md"
        _write(
            index,
            "# Index\n\n"
            "- [Page A](wiki/sources/a.md)\n"
            "- [Page B](wiki/concepts/b.md)\n",
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
            "## [2024-06-01] create | wiki/sources/adr/my-adr.md | adr — Added\n",
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
        assert result[0]["path"] == "wiki/sources/adr/unlogged.md"
        assert result[0]["slug"] == "unlogged"
        assert result[0]["title"] == "unlogged adr"

    def test_non_source_pages_ignored(self, tmp_path):
        """Concepts/entities pages are not checked for log coverage."""
        _write(tmp_path / "wiki" / "log.md", "# Log\n")
        _write(
            tmp_path / "wiki" / "log.md",
            "# Log\n## [2024-06-01] create | wiki/sources/adr/logged.md | adr\n",
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
