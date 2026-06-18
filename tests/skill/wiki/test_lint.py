"""Tests for lint.py — Wiki deep structural checks.

All tests use ``tmp_path`` with patched ``WIKI_DIR`` and ``REPO_ROOT`` to
avoid side effects on the real wiki.  Every check function is tested with
both positive (issue present) and negative (no issue) cases.
"""

from __future__ import annotations

import sys
from datetime import date, timedelta
from pathlib import Path
from unittest.mock import patch

# Allow import of the lint module (not on sys.path by default).
sys.path.insert(
    0,
    str(
        Path(__file__).resolve().parent.parent.parent.parent
        / "core"
        / "skills"
        / "wiki-maintain"
        / "tools"
    ),
)

import lint as _lint  # noqa: E402  (needed for patching module globals)
from lint import (  # noqa: E402
    SPARSE_BODY_CHARS,
    STALE_DAYS,
    _pages,
    _parse_frontmatter,
    check_broken_links,
    check_orphan_pages,
    check_sparse_pages,
    check_stale_pages,
)

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

        with (
            patch.object(_lint, "WIKI_DIR", wiki_dir),
            patch.object(_lint, "REPO_ROOT", tmp_path),
        ):
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

        with (
            patch.object(_lint, "WIKI_DIR", wiki_dir),
            patch.object(_lint, "REPO_ROOT", tmp_path),
        ):
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

        with patch.object(_lint, "WIKI_DIR", wiki_dir):
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

        with patch.object(_lint, "WIKI_DIR", wiki_dir):
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

        with patch.object(_lint, "WIKI_DIR", wiki_dir):
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

        with patch.object(_lint, "WIKI_DIR", wiki_dir):
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
    """``_pages()`` — page discovery with exclusions."""

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

        with patch.object(_lint, "WIKI_DIR", wiki_dir):
            result = _pages()

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

        with patch.object(_lint, "WIKI_DIR", wiki_dir):
            result = _pages()

        names = {p.name for p in result}
        assert names == {"page1.md", "page2.md"}, f"Unexpected pages: {names}"
