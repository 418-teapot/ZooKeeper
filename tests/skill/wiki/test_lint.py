"""Tests for lint.py — Wiki deep structural checks.

All tests use ``tmp_path`` with patched ``WIKI_DIR`` and ``REPO_ROOT`` to
avoid side effects on the real wiki.  Every check function is tested with
both positive (issue present) and negative (no issue) cases.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
from contextlib import ExitStack, contextmanager
from datetime import date, timedelta
from pathlib import Path
from unittest.mock import patch

# Allow import of the lint module (not on sys.path by default).
sys.path.insert(
    0,
    str(
        Path(__file__).resolve().parent.parent.parent.parent / "wiki" / "tools"
    ),
)

import lint as _lint  # noqa: E402  (needed for patching module globals)
import shared.utils as _shared_utils  # noqa: E402 — needed for patching globals in imported functions
from lint import (  # noqa: E402
    SPARSE_BODY_CHARS,
    STALE_DAYS,
    all_wiki_pages,
    check_broken_links,
    check_orphan_pages,
    check_sparse_pages,
    check_stale_pages,
)
from shared.utils import (
    parse_frontmatter as _parse_frontmatter,  # noqa: E402, F811 — under shared/ test helper
)


@contextmanager
def _patch_paths(wiki_dir: Path, repo_root: Path | None = None):
    """Context manager that patches WIKI_DIR (and optionally REPO_ROOT) in
    both the local ``lint`` module and ``shared.utils``.

    Imported functions like ``all_wiki_pages`` reference
    ``shared.utils.WIKI_DIR``, so both must be patched.
    """
    patchers = [patch.object(_lint, "WIKI_DIR", wiki_dir)]
    patchers.append(patch.object(_shared_utils, "WIKI_DIR", wiki_dir))
    if repo_root is not None:
        patchers.append(patch.object(_shared_utils, "REPO_ROOT", repo_root))
    with ExitStack() as stack:
        for p in patchers:
            stack.enter_context(p)
        yield


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _make_page_cache(
    wiki_dir: Path,
    pages: list[Path],
) -> dict[str, tuple[str, dict]]:
    """Build a ``page_cache`` dict matching ``lint.main()`` internal format.

    Keys are wiki-relative paths, values are ``(raw_content, frontmatter_dict)``
    tuples.
    """
    cache: dict[str, tuple[str, dict]] = {}
    for p in pages:
        rel = str(p.relative_to(wiki_dir))
        content = p.read_text(encoding="utf-8")
        fm = _parse_frontmatter(content)
        cache[rel] = (content, fm)
    return cache


# ===================================================================
# 1. Broken links
# ===================================================================


class TestBrokenLinks:
    """``check_broken_links`` — Markdown links and frontmatter ``related``."""

    def test_detection(self, tmp_path: Path) -> None:
        """Markdown link to nonexistent + frontmatter ``related`` to
        nonexistent → flagged.  Link to existing page → not flagged."""
        wiki_dir = tmp_path / "wiki"
        concepts = wiki_dir / "concepts"
        concepts.mkdir(parents=True)

        # Existing target (so links to it are NOT broken)
        (concepts / "existing.md").write_text("# Existing\n\nContent here.\n")

        # Page with a broken markdown link
        md_broken = wiki_dir / "md-broken.md"
        md_broken.write_text(
            "---\ntitle: A\n---\n\n[broken](concepts/nonexistent.md)\n"
        )

        # Page with a valid markdown link (should NOT appear in results)
        md_valid = wiki_dir / "md-valid.md"
        md_valid.write_text(
            "---\ntitle: B\n---\n\n[valid](concepts/existing.md)\n"
        )

        # Page with a broken frontmatter ``related`` entry
        rel_broken = wiki_dir / "rel-broken.md"
        rel_broken.write_text(
            "---\ntitle: C\nrelated: [wiki/concepts/nonexistent.md]\n---\n\nBody.\n"
        )

        with _patch_paths(wiki_dir, tmp_path):
            pages = [
                md_broken,
                md_valid,
                rel_broken,
                concepts / "existing.md",
            ]
            cache = _make_page_cache(wiki_dir, pages)
            results = check_broken_links(pages, cache)

        assert len(results) == 2, (
            f"Expected 2 broken links, got {len(results)}"
        )
        targets = {r["link_target"] for r in results}
        assert targets == {
            "concepts/nonexistent.md",
            "wiki/concepts/nonexistent.md",
        }, f"Unexpected link targets: {targets}"
        for r in results:
            assert r["issue"] == "target_not_found"


# ===================================================================
# 2. Orphan pages
# ===================================================================


class TestOrphanPages:
    """``check_orphan_pages`` — inbound-link graph and index.md listing."""

    def test_orphan_detection(self, tmp_path: Path) -> None:
        """Page with zero inbound links and not in index → orphan.
        Page listed in index → not orphan (even with zero inbound).
        Page with an inbound link → not orphan."""
        wiki_dir = tmp_path / "wiki"
        concepts = wiki_dir / "concepts"
        concepts.mkdir(parents=True)

        # index.md — lists in-index.md and has-link.md
        (wiki_dir / "index.md").write_text(
            "[In Index](in-index.md)\n[Has Link](has-link.md)\n"
        )

        # in-index.md — listed in index → NOT orphan
        in_index = wiki_dir / "in-index.md"
        in_index.write_text("# In Index\n\nIndexed page.\n")

        # has-link.md — listed in index AND links to linked-to → NOT orphan
        has_link = wiki_dir / "has-link.md"
        has_link.write_text("[Linked To](concepts/linked-to.md)\n")

        # orphan-page.md — NOT in index, zero inbound → orphan
        orphan = concepts / "orphan-page.md"
        orphan.write_text("# Orphan\n\nNobody links here.\n")

        # linked-to.md — NOT in index but HAS inbound from has-link → NOT orphan
        linked_to = concepts / "linked-to.md"
        linked_to.write_text("# Linked To\n\nHas one inbound.\n")

        with _patch_paths(wiki_dir, tmp_path):
            pages = [in_index, has_link, orphan, linked_to]
            cache = _make_page_cache(wiki_dir, pages)
            results = check_orphan_pages(pages, cache)

        assert len(results) == 1, (
            f"Expected exactly 1 orphan, got {len(results)}: {results}"
        )
        assert results[0]["page"] == "concepts/orphan-page.md"
        assert results[0]["inbound_links"] == 0
        assert results[0]["in_index"] is False


# ===================================================================
# 3. Sparse pages
# ===================================================================


class TestSparsePages:
    """``check_sparse_pages`` — body text length threshold."""

    def test_sparse_flagged(self, tmp_path: Path) -> None:
        """Body < 50 chars after stripping frontmatter → sparse."""
        wiki_dir = tmp_path / "wiki"
        wiki_dir.mkdir(parents=True)
        page = wiki_dir / "sparse.md"
        page.write_text("---\ntitle: Sparse\n---\nShort body.\n")

        with (
            patch.object(_lint, "WIKI_DIR", wiki_dir),
            patch.object(_shared_utils, "WIKI_DIR", wiki_dir),
        ):
            pages = [page]
            cache = _make_page_cache(wiki_dir, pages)
            results = check_sparse_pages(pages, cache)

        assert len(results) == 1
        assert results[0]["page"] == "sparse.md"
        assert results[0]["body_length"] < SPARSE_BODY_CHARS

    def test_not_sparse(self, tmp_path: Path) -> None:
        """Body >= 50 chars after stripping frontmatter → not sparse."""
        wiki_dir = tmp_path / "wiki"
        wiki_dir.mkdir(parents=True)
        page = wiki_dir / "full.md"
        body = "A" * SPARSE_BODY_CHARS  # exactly 50 chars
        page.write_text(f"---\ntitle: Full\n---\n{body}\n")

        with (
            patch.object(_lint, "WIKI_DIR", wiki_dir),
            patch.object(_shared_utils, "WIKI_DIR", wiki_dir),
        ):
            pages = [page]
            cache = _make_page_cache(wiki_dir, pages)
            results = check_sparse_pages(pages, cache)

        assert len(results) == 0, f"Expected no sparse issues, got: {results}"

    def test_empty_body(self, tmp_path: Path) -> None:
        """Empty body after frontmatter → sparse (0 < 50)."""
        wiki_dir = tmp_path / "wiki"
        wiki_dir.mkdir(parents=True)
        page = wiki_dir / "empty.md"
        page.write_text("---\ntitle: Empty\n---\n")

        with (
            patch.object(_lint, "WIKI_DIR", wiki_dir),
            patch.object(_shared_utils, "WIKI_DIR", wiki_dir),
        ):
            pages = [page]
            cache = _make_page_cache(wiki_dir, pages)
            results = check_sparse_pages(pages, cache)

        assert len(results) == 1
        assert results[0]["page"] == "empty.md"
        assert results[0]["body_length"] == 0


# ===================================================================
# 4. Stale pages
# ===================================================================


class TestStalePages:
    """``check_stale_pages`` — ``updated`` date older than ``STALE_DAYS``."""

    REFERENCE_DATE = date(2025, 1, 1)
    # STALE_DAYS = 90 days → cutoff = 2024-10-03
    CUTOFF = REFERENCE_DATE - timedelta(days=STALE_DAYS)

    def _write_and_check(
        self,
        wiki_dir: Path,
        pages: list[tuple[str, str]],
    ) -> list[dict]:
        """Helper: write pages, build cache, run check_stale_pages."""
        page_paths: list[Path] = []
        for name, content in pages:
            p = wiki_dir / name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(content)
            page_paths.append(p)

        with (
            patch.object(_lint, "WIKI_DIR", wiki_dir),
            patch.object(_shared_utils, "WIKI_DIR", wiki_dir),
        ):
            cache = _make_page_cache(wiki_dir, page_paths)
            return check_stale_pages(
                page_paths, cache, reference_date=self.REFERENCE_DATE
            )

    def test_stale_flagged(self, tmp_path: Path) -> None:
        """Updated > 90 days ago, status != deprecated → stale."""
        old_date = self.CUTOFF - timedelta(days=1)  # 2024-10-02
        results = self._write_and_check(
            tmp_path / "wiki",
            [
                (
                    "stale.md",
                    f"---\ntitle: Stale\ntype: concept\ncreated: 2024-01-01\n"
                    f"updated: {old_date}\ntags: [test]\nstatus: draft\n---\n",
                ),
            ],
        )
        assert len(results) == 1
        assert results[0]["page"] == "stale.md"
        assert results[0]["status"] == "draft"

    def test_deprecated_not_stale(self, tmp_path: Path) -> None:
        """Status = deprecated → not stale regardless of age."""
        old_date = self.CUTOFF - timedelta(days=1)
        results = self._write_and_check(
            tmp_path / "wiki",
            [
                (
                    "dep.md",
                    f"---\ntitle: Dep\ntype: concept\ncreated: 2024-01-01\n"
                    f"updated: {old_date}\ntags: [test]\nstatus: deprecated\n---\n",
                ),
            ],
        )
        assert len(results) == 0

    def test_recent_update_not_stale(self, tmp_path: Path) -> None:
        """Updated within 90 days → not stale."""
        recent_date = self.CUTOFF + timedelta(days=1)  # 2024-10-04
        results = self._write_and_check(
            tmp_path / "wiki",
            [
                (
                    "recent.md",
                    f"---\ntitle: Recent\ntype: concept\ncreated: 2024-01-01\n"
                    f"updated: {recent_date}\ntags: [test]\nstatus: draft\n---\n",
                ),
            ],
        )
        assert len(results) == 0

    def test_no_updated_field(self, tmp_path: Path) -> None:
        """No ``updated`` field → skipped (not stale)."""
        results = self._write_and_check(
            tmp_path / "wiki",
            [
                (
                    "no-upd.md",
                    "---\ntitle: No Updated\ntype: concept\ncreated: 2024-01-01\n"
                    "tags: [test]\nstatus: draft\n---\n",
                ),
            ],
        )
        assert len(results) == 0


# ===================================================================
# 5. Page discovery (_pages)
# ===================================================================


class TestPageDiscovery:
    """``all_wiki_pages()`` — page discovery with exclusions."""

    def test_excludes_templates_and_meta(self, tmp_path: Path) -> None:
        """Templates, SCHEMA.md, and other meta pages are excluded."""
        wiki_dir = tmp_path / "wiki"
        (wiki_dir / "templates").mkdir(parents=True)
        # Regular page (should be included)
        (wiki_dir / "regular-page.md").write_text("# Regular\n")
        # Meta pages (should be excluded)
        (wiki_dir / "index.md").write_text("# Index\n")
        (wiki_dir / "SCHEMA.md").write_text("# Schema\n")
        (wiki_dir / "log.md").write_text("# Log\n")
        (wiki_dir / "lint-report.md").write_text("# Report\n")
        (wiki_dir / "health-report.md").write_text("# Health\n")
        (wiki_dir / "overview.md").write_text("# Overview\n")
        # Template file (should be excluded via path component)
        (wiki_dir / "templates" / "page-tpl.md").write_text("# Tpl\n")

        with (
            patch.object(_lint, "WIKI_DIR", wiki_dir),
            patch.object(_shared_utils, "WIKI_DIR", wiki_dir),
        ):
            result = all_wiki_pages()

        assert len(result) == 1, (
            f"Expected exactly 1 page, got {len(result)}: {result}"
        )
        assert result[0].name == "regular-page.md", (
            f"Unexpected page: {result[0].name}"
        )

    def test_includes_regular_pages(self, tmp_path: Path) -> None:
        """Regular wiki content pages are included."""
        wiki_dir = tmp_path / "wiki"
        wiki_dir.mkdir(parents=True)
        (wiki_dir / "concepts").mkdir()
        (wiki_dir / "page1.md").write_text("# Page 1\n")
        (wiki_dir / "concepts" / "page2.md").write_text("# Page 2\n")

        with (
            patch.object(_lint, "WIKI_DIR", wiki_dir),
            patch.object(_shared_utils, "WIKI_DIR", wiki_dir),
        ):
            result = all_wiki_pages()

        names = {p.name for p in result}
        assert names == {"page1.md", "page2.md"}, f"Unexpected pages: {names}"


# ===================================================================
# 6. format_markdown
# ===================================================================


class TestFormatMarkdown:
    """``format_markdown`` — markdown report formatting."""

    def test_contains_check_names(self):
        """Report contains all four check names."""
        results = {
            "broken_links": [],
            "orphan_pages": [],
            "sparse_pages": [],
            "stale_pages": [],
        }
        report = _lint.format_markdown(results)
        assert "断裂链接" in report
        assert "孤立页面" in report
        assert "稀疏页面" in report
        assert "过时页面" in report

    def test_tables_included_for_issues(self):
        """Report includes tables when issues are present."""
        results = {
            "broken_links": [
                {
                    "page": "concepts/broken.md",
                    "link_text": "Missing",
                    "link_target": "concepts/nonexistent.md",
                    "issue": "target_not_found",
                }
            ],
            "orphan_pages": [
                {
                    "page": "concepts/orphan.md",
                    "inbound_links": 0,
                    "in_index": False,
                }
            ],
            "sparse_pages": [
                {
                    "page": "concepts/sparse.md",
                    "body_length": 10,
                    "threshold": 50,
                }
            ],
            "stale_pages": [
                {
                    "page": "concepts/stale.md",
                    "updated": "2024-01-01",
                    "status": "draft",
                    "days_since_update": 100,
                    "threshold_days": 90,
                }
            ],
        }
        report = _lint.format_markdown(results)
        assert "broken.md" in report
        assert "orphan.md" in report
        assert "sparse.md" in report
        assert "stale.md" in report
        assert "共发现" in report
        assert "**总计" in report

    def test_empty_results_no_crash(self):
        """Empty results dict does not crash."""
        results = {
            "broken_links": [],
            "orphan_pages": [],
            "sparse_pages": [],
            "stale_pages": [],
        }
        report = _lint.format_markdown(results)
        assert isinstance(report, str)
        assert len(report) > 0

    def test_summary_count(self):
        """Summary shows total issue count."""
        results = {
            "broken_links": [
                {
                    "page": "a.md",
                    "link_text": "x",
                    "link_target": "y.md",
                    "issue": "target_not_found",
                }
            ],
            "orphan_pages": [],
            "sparse_pages": [],
            "stale_pages": [],
        }
        report = _lint.format_markdown(results)
        assert "**总计：1 个问题**" in report


# ===================================================================
# CLI tests (subprocess)
# ===================================================================


class TestCliJson:
    """CLI ``--json`` flag produces valid JSON output."""

    def test_json_output_valid(self, tmp_path):
        """--json output is valid JSON with expected keys."""
        _REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent
        _LINT_PATH = _REPO_ROOT / "wiki" / "tools" / "lint.py"

        fake_home = tmp_path / "fake_home"
        fake_home.mkdir()
        zoo_dir = fake_home / ".zoo"
        zoo_dir.mkdir()
        target_link = zoo_dir / "wiki"
        wiki_source = tmp_path / "real_wiki"
        wiki_source.mkdir()
        os.symlink(str(wiki_source), str(target_link))

        env = {**os.environ, "HOME": str(fake_home)}

        # Create a valid wiki page so lint has something to scan
        (wiki_source / "concepts" / "test.md").parent.mkdir(
            parents=True, exist_ok=True
        )
        (wiki_source / "concepts" / "test.md").write_text(
            "---\ntitle: Test\ntype: concept\ncreated: 2025-01-01\n"
            "updated: 2025-06-01\ntags: [test]\nstatus: draft\n---\n\nContent."
        )
        (wiki_source / "index.md").write_text(
            "# Index\n\n- [Test](concepts/test.md)\n"
        )

        result = subprocess.run(
            [sys.executable, str(_LINT_PATH), "--json"],
            capture_output=True,
            text=True,
            env=env,
        )
        assert result.returncode == 0
        data = json.loads(result.stdout)
        assert "summary" in data
        assert "results" in data
        assert "broken_links" in data["results"]
        assert "orphan_pages" in data["results"]
        assert "sparse_pages" in data["results"]
        assert "stale_pages" in data["results"]
        assert "total" in data["summary"]


class TestCliSave:
    """CLI ``--save`` flag writes report to disk."""

    def test_save_creates_report_file(self, tmp_path):
        """--save writes lint-report.md to the wiki directory."""
        _REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent
        _LINT_PATH = _REPO_ROOT / "wiki" / "tools" / "lint.py"

        fake_home = tmp_path / "fake_home"
        fake_home.mkdir()
        zoo_dir = fake_home / ".zoo"
        zoo_dir.mkdir()
        target_link = zoo_dir / "wiki"
        wiki_source = tmp_path / "real_wiki"
        wiki_source.mkdir()
        os.symlink(str(wiki_source), str(target_link))

        env = {**os.environ, "HOME": str(fake_home)}

        (wiki_source / "concepts" / "test.md").parent.mkdir(
            parents=True, exist_ok=True
        )
        (wiki_source / "concepts" / "test.md").write_text(
            "---\ntitle: Test\ntype: concept\ncreated: 2025-01-01\n"
            "updated: 2025-06-01\ntags: [test]\nstatus: draft\n---\n\nContent."
        )
        (wiki_source / "index.md").write_text(
            "# Index\n\n- [Test](concepts/test.md)\n"
        )

        result = subprocess.run(
            [sys.executable, str(_LINT_PATH), "--save"],
            capture_output=True,
            text=True,
            env=env,
        )
        assert result.returncode == 0
        report_path = wiki_source / "lint-report.md"
        assert report_path.exists()
        content = report_path.read_text(encoding="utf-8")
        assert "Wiki Lint Report" in content
        assert "报告已写入" in result.stdout


# ===================================================================
# Edge-case tests for uncovered lines
# ===================================================================


class TestResolveTargetEdgeCases:
    """``_resolve_target`` — edge cases."""

    def test_absolute_path_returns_none(self, tmp_path: Path) -> None:
        """Absolute path returns None (line 71)."""
        wiki_dir = tmp_path / "wiki"
        wiki_dir.mkdir()
        with (
            patch.object(_lint, "WIKI_DIR", wiki_dir),
            patch.object(_shared_utils, "WIKI_DIR", wiki_dir),
        ):
            result = _lint._resolve_target(str(tmp_path / "outside.md"))
        assert result is None

    def test_wiki_prefixed_path_resolved(self, tmp_path: Path) -> None:
        """Legacy wiki/ prefix is stripped (line 115)."""
        wiki_dir = tmp_path / "wiki"
        wiki_dir.mkdir()
        (wiki_dir / "concepts").mkdir()
        (wiki_dir / "concepts" / "foo.md").write_text("# Foo")

        with (
            patch.object(_lint, "WIKI_DIR", wiki_dir),
            patch.object(_shared_utils, "WIKI_DIR", wiki_dir),
        ):
            result = _lint._resolve_target("wiki/concepts/foo.md")
        assert result is not None
        assert result.name == "foo.md"


class TestLinksInPageEdgeCases:
    """``_links_in_page`` — edge cases."""

    def test_related_as_string(self, tmp_path: Path) -> None:
        """Frontmatter ``related`` as a string is handled (line 98)."""
        content = "---\ntitle: A\nrelated: foo.md\n---\nBody.\n"
        page_path = tmp_path / "wiki" / "page.md"

        with (
            patch.object(_lint, "WIKI_DIR", tmp_path / "wiki"),
            patch.object(_shared_utils, "WIKI_DIR", tmp_path / "wiki"),
        ):
            links = _lint._links_in_page(content, page_path)

        related_links = [t for _, t in links if t == "foo.md"]
        assert len(related_links) == 1


class TestCheckBrokenLinksEdgeCases:
    """``check_broken_links`` — edge cases."""

    def test_empty_content_skipped(self, tmp_path: Path) -> None:
        """Page with empty content is skipped (line 139)."""
        wiki_dir = tmp_path / "wiki"
        wiki_dir.mkdir()
        page = wiki_dir / "empty.md"
        page.write_text("")

        with (
            patch.object(_lint, "WIKI_DIR", wiki_dir),
            patch.object(_shared_utils, "WIKI_DIR", wiki_dir),
        ):
            cache = {}
            results = _lint.check_broken_links([page], cache)

        assert results == []


class TestCheckOrphanPagesEdgeCases:
    """``check_orphan_pages`` — edge cases."""

    def test_empty_content_skipped_in_inbound_build(
        self, tmp_path: Path
    ) -> None:
        """Page with empty content is skipped during inbound link build (line 178).
        The orphan check still processes the page (it's unreferenced), but
        the empty content doesn't cause a crash."""
        wiki_dir = tmp_path / "wiki"
        wiki_dir.mkdir()
        page = wiki_dir / "empty.md"
        page.write_text("")

        with (
            patch.object(_lint, "WIKI_DIR", wiki_dir),
            patch.object(_shared_utils, "WIKI_DIR", wiki_dir),
        ):
            cache = {}
            results = _lint.check_orphan_pages([page], cache)

        # Empty page has no inbound links and is not in index → appears as orphan
        assert len(results) == 1
        assert results[0]["page"] == "empty.md"
        assert results[0]["inbound_links"] == 0
        assert results[0]["in_index"] is False

    def test_link_target_outside_wiki(self, tmp_path: Path) -> None:
        """Link target that raises ValueError during wiki_rel is ignored (lines 189-190)."""
        wiki_dir = tmp_path / "wiki"
        wiki_dir.mkdir()
        # Create a page that links to a target outside wiki
        page = wiki_dir / "page.md"
        page.write_text("---\ntitle: A\n---\n[Outside](../outside.md)\n")
        target = tmp_path / "outside.md"
        target.write_text("# Outside")

        with (
            patch.object(_lint, "WIKI_DIR", wiki_dir),
            patch.object(_shared_utils, "WIKI_DIR", wiki_dir),
        ):
            from shared.utils import wiki_rel

            cache = {wiki_rel(page): (page.read_text(), {})}
            results = _lint.check_orphan_pages([page], cache)

        # Should not crash — the outside link's resolved target isn't under WIKI_DIR
        assert isinstance(results, list)

    def test_index_with_wiki_prefix(self, tmp_path: Path) -> None:
        """Legacy ``wiki/`` prefix in index.md links is stripped (line 115)."""
        wiki_dir = tmp_path / "wiki"
        wiki_dir.mkdir()
        # Use wiki/ prefixed paths in index
        (wiki_dir / "index.md").write_text("[Test](wiki/concepts/foo.md)\n")
        (wiki_dir / "concepts").mkdir()
        (wiki_dir / "concepts" / "foo.md").write_text(
            "---\ntitle: Foo\ntype: concept\ncreated: 2024-01-01\n"
            "updated: 2024-06-01\ntags: [test]\nstatus: draft\n---\n# Foo"
        )

        with (
            patch.object(_lint, "WIKI_DIR", wiki_dir),
            patch.object(_shared_utils, "WIKI_DIR", wiki_dir),
        ):
            referenced = _lint._pages_referenced_in_index()

        assert "concepts/foo.md" in referenced


class TestCheckSparsePagesEdgeCases:
    """``check_sparse_pages`` — edge cases."""

    def test_empty_content_skipped(self, tmp_path: Path) -> None:
        """Page with empty content is skipped (line 224)."""
        wiki_dir = tmp_path / "wiki"
        wiki_dir.mkdir()
        page = wiki_dir / "empty.md"
        page.write_text("")

        with (
            patch.object(_lint, "WIKI_DIR", wiki_dir),
            patch.object(_shared_utils, "WIKI_DIR", wiki_dir),
        ):
            cache = {}
            results = _lint.check_sparse_pages([page], cache)

        assert results == []


class TestCheckStalePagesEdgeCases:
    """``check_stale_pages`` — edge cases."""

    def test_default_reference_date(self, tmp_path: Path) -> None:
        """When reference_date is None, uses date.today() (line 249)."""
        wiki_dir = tmp_path / "wiki"
        wiki_dir.mkdir()
        page = wiki_dir / "page.md"
        page.write_text(
            "---\ntitle: A\ntype: concept\ncreated: 2024-01-01\n"
            "updated: 2024-01-01\ntags: [test]\nstatus: draft\n---\n"
        )

        with (
            patch.object(_lint, "WIKI_DIR", wiki_dir),
            patch.object(_shared_utils, "WIKI_DIR", wiki_dir),
        ):
            cache = {}
            results = _lint.check_stale_pages([page], cache)

        # reference_date is None → uses date.today()
        assert isinstance(results, list)

    def test_empty_frontmatter_skipped(self, tmp_path: Path) -> None:
        """Page with no frontmatter is skipped (line 256)."""
        wiki_dir = tmp_path / "wiki"
        wiki_dir.mkdir()
        page = wiki_dir / "page.md"
        page.write_text("---\n---\n# No frontmatter\n")  # empty frontmatter

        with (
            patch.object(_lint, "WIKI_DIR", wiki_dir),
            patch.object(_shared_utils, "WIKI_DIR", wiki_dir),
        ):
            rel = str(page.relative_to(wiki_dir))
            cache = {rel: (page.read_text(), {})}
            results = _lint.check_stale_pages([page], cache)

        assert results == []

    def test_invalid_date_skipped(self, tmp_path: Path) -> None:
        """Page with invalid updated date is skipped (line 265)."""
        wiki_dir = tmp_path / "wiki"
        wiki_dir.mkdir()
        page = wiki_dir / "page.md"
        page.write_text(
            "---\ntitle: A\ntype: concept\ncreated: 2024-01-01\n"
            "updated: not-a-date\ntags: [test]\nstatus: draft\n---\n"
        )

        with (
            patch.object(_lint, "WIKI_DIR", wiki_dir),
            patch.object(_shared_utils, "WIKI_DIR", wiki_dir),
        ):
            rel = str(page.relative_to(wiki_dir))
            fm = {"title": "A", "type": "concept", "updated": "not-a-date"}
            cache = {rel: (page.read_text(), fm)}
            results = _lint.check_stale_pages([page], cache)

        assert results == []


class TestMainCliLint:
    """Test the lint.py main() CLI entry point (lines 366-422)."""

    def _create_page(self, wiki_dir: Path) -> None:
        """Create a minimal wiki page so page_cache building loop runs."""
        (wiki_dir / "concepts").mkdir(parents=True, exist_ok=True)
        (wiki_dir / "concepts" / "test.md").write_text(
            "---\ntitle: Test\ntype: concept\ncreated: 2025-01-01\n"
            "updated: 2025-06-01\ntags: [test]\nstatus: draft\n---\n# Test"
        )

    def test_main_default(self, monkeypatch, capsys, tmp_path):
        """main() with no flags prints report to stdout."""
        wiki_dir = tmp_path / "wiki"
        wiki_dir.mkdir()
        self._create_page(wiki_dir)
        monkeypatch.setattr(_lint, "WIKI_DIR", wiki_dir)
        monkeypatch.setattr(_shared_utils, "WIKI_DIR", wiki_dir)
        monkeypatch.setattr(sys, "argv", ["lint.py"])

        _lint.main()

        captured = capsys.readouterr()
        assert "Wiki Lint Report" in captured.out

    def test_main_json(self, monkeypatch, capsys, tmp_path):
        """main() with --json prints JSON output."""
        wiki_dir = tmp_path / "wiki"
        wiki_dir.mkdir()
        self._create_page(wiki_dir)
        monkeypatch.setattr(_lint, "WIKI_DIR", wiki_dir)
        monkeypatch.setattr(_shared_utils, "WIKI_DIR", wiki_dir)
        monkeypatch.setattr(sys, "argv", ["lint.py", "--json"])

        _lint.main()

        captured = capsys.readouterr()
        data = json.loads(captured.out)
        assert "summary" in data
        assert "results" in data

    def test_main_save(self, monkeypatch, tmp_path):
        """main() with --save writes report to wiki dir."""
        wiki_dir = tmp_path / "wiki"
        wiki_dir.mkdir()
        self._create_page(wiki_dir)
        monkeypatch.setattr(_lint, "WIKI_DIR", wiki_dir)
        monkeypatch.setattr(_shared_utils, "WIKI_DIR", wiki_dir)
        monkeypatch.setattr(sys, "argv", ["lint.py", "--save"])

        _lint.main()

        report_path = wiki_dir / "lint-report.md"
        assert report_path.exists()
        content = report_path.read_text(encoding="utf-8")
        assert "Wiki Lint Report" in content
