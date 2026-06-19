"""Tests for wiki/tools/new_page.py.

Contains two groups of tests:

1. **Direct-import tests** (count toward coverage): exercise the extracted
   functions ``to_kebab_case``, ``_compute_output_path``, and
   ``_apply_template`` directly via ``tmp_path`` with patched ``WIKI_DIR``.

2. **Subprocess CLI tests** (integration, do not count toward coverage):
   exercise the real CLI entry point with a temporary ``HOME`` directory.
"""

from __future__ import annotations

import os
import subprocess
import sys
from contextlib import ExitStack, contextmanager
from datetime import date
from pathlib import Path
from unittest.mock import patch

import pytest

# -- Paths ------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent
SCRIPT = REPO_ROOT / "wiki" / "tools" / "new_page.py"

# Allow direct import of new_page.py for coverage-counted tests.
_TOOLS_DIR = str(REPO_ROOT / "wiki" / "tools")
if _TOOLS_DIR not in sys.path:
    sys.path.insert(0, _TOOLS_DIR)

import new_page as _new_page  # noqa: E402
import shared.utils as _shared_utils  # noqa: E402

# Files that may be created by the test suite; cleaned up after each test.
_TEST_FILES: list[Path] = [
    REPO_ROOT / "wiki" / "concepts" / "permission-model.md",
    REPO_ROOT / "wiki" / "entities" / "buildagent.md",
    REPO_ROOT / "wiki" / "sources" / "adr" / "adr-001.md",
    REPO_ROOT / "wiki" / "analysis" / "analysis-test.md",
    REPO_ROOT / "wiki" / "syntheses" / "synthesis-test.md",
    REPO_ROOT / "wiki" / "concepts" / "special-case-test.md",
    REPO_ROOT / "wiki" / "concepts" / "evil.md",
    REPO_ROOT / "wiki" / "concepts" / "testconcept.md",
    REPO_ROOT / "wiki" / "concepts" / "drafttest.md",
    REPO_ROOT / "wiki" / "concepts" / "three-layer-architecture.md",
    REPO_ROOT / "wiki" / "concepts" / "renamed-page.md",
]


# -- Helpers for direct-import tests ----------------------------------------


@contextmanager
def _patch_wiki_dir(wiki_dir: Path):
    """Context manager that patches ``WIKI_DIR`` in both ``new_page`` and
    ``shared.utils`` so that imported functions see the patched values."""
    patchers = [
        patch.object(_new_page, "WIKI_DIR", wiki_dir),
        patch.object(_shared_utils, "WIKI_DIR", wiki_dir),
    ]
    with ExitStack() as stack:
        for p in patchers:
            stack.enter_context(p)
        yield


# ===================================================================
# 1. to_kebab_case (direct-import)
# ===================================================================


class TestToKebabCaseDirect:
    """``to_kebab_case`` — title-to-slug conversion (direct import)."""

    def test_basic(self) -> None:
        """Spaces become hyphens, all lowercase."""
        assert (
            _new_page.to_kebab_case("Permission Model") == "permission-model"
        )

    def test_underscores_to_hyphens(self) -> None:
        """Underscores are treated the same as spaces."""
        assert (
            _new_page.to_kebab_case("Special_Case Test!")
            == "special-case-test"
        )

    def test_traversal_safe(self) -> None:
        """Dots and slashes are stripped (no path traversal)."""
        assert _new_page.to_kebab_case("../evil") == "evil"

    def test_multiple_hyphens_collapsed(self) -> None:
        """Multiple consecutive hyphens are collapsed to one."""
        assert _new_page.to_kebab_case("foo---bar") == "foo-bar"

    def test_leading_trailing_hyphens_stripped(self) -> None:
        """Leading and trailing hyphens are removed."""
        assert _new_page.to_kebab_case("--hello-world--") == "hello-world"

    def test_non_alphanumeric_stripped(self) -> None:
        """Non-alphanumeric characters (except hyphens) are stripped."""
        assert (
            _new_page.to_kebab_case("Hello! @World #2024")
            == "hello-world-2024"
        )

    def test_chinese_title_empty_slug(self) -> None:
        """Chinese-only title produces empty string (needs --slug)."""
        assert _new_page.to_kebab_case("三层架构") == ""


# ===================================================================
# 2. _compute_output_path (direct-import)
# ===================================================================


class TestComputeOutputPathDirect:
    """``_compute_output_path`` — path computation (direct import)."""

    def test_concept_path(self, tmp_path: Path) -> None:
        """Concept type produces path under concepts/."""
        wiki_dir = tmp_path / "wiki"
        wiki_dir.mkdir()
        with _patch_wiki_dir(wiki_dir):
            result = _new_page._compute_output_path(
                "concept", "Permission Model"
            )
        assert result.name == "permission-model.md"
        assert "concepts" in result.parts

    def test_source_with_source_type(self, tmp_path: Path) -> None:
        """Source type with source-type produces path under sources/adr/."""
        wiki_dir = tmp_path / "wiki"
        wiki_dir.mkdir()
        with _patch_wiki_dir(wiki_dir):
            result = _new_page._compute_output_path(
                "source", "ADR-001", args_source_type="adr"
            )
        assert result.name == "adr-001.md"
        assert "sources" in result.parts
        assert "adr" in result.parts

    def test_slug_override(self, tmp_path: Path) -> None:
        """Explicit slug overrides auto-derived slug."""
        wiki_dir = tmp_path / "wiki"
        wiki_dir.mkdir()
        with _patch_wiki_dir(wiki_dir):
            result = _new_page._compute_output_path(
                "concept", "Original Title", args_slug="renamed-page"
            )
        assert result.name == "renamed-page.md"

    def test_entity_path(self, tmp_path: Path) -> None:
        """Entity type produces path under entities/."""
        wiki_dir = tmp_path / "wiki"
        wiki_dir.mkdir()
        with _patch_wiki_dir(wiki_dir):
            result = _new_page._compute_output_path("entity", "BuildAgent")
        assert result.name == "buildagent.md"
        assert "entities" in result.parts

    def test_analysis_path(self, tmp_path: Path) -> None:
        """Analysis type produces path under analysis/."""
        wiki_dir = tmp_path / "wiki"
        wiki_dir.mkdir()
        with _patch_wiki_dir(wiki_dir):
            result = _new_page._compute_output_path(
                "analysis", "Analysis Test"
            )
        assert result.name == "analysis-test.md"
        assert "analysis" in result.parts

    def test_synthesis_path(self, tmp_path: Path) -> None:
        """Synthesis type produces path under syntheses/."""
        wiki_dir = tmp_path / "wiki"
        wiki_dir.mkdir()
        with _patch_wiki_dir(wiki_dir):
            result = _new_page._compute_output_path(
                "synthesis", "Synthesis Test"
            )
        assert result.name == "synthesis-test.md"
        assert "syntheses" in result.parts

    # -- Error paths: slug validation -- #

    def test_empty_slug_exits(self, tmp_path: Path) -> None:
        """Empty slug (Chinese title without --slug) exits with code 2."""
        wiki_dir = tmp_path / "wiki"
        wiki_dir.mkdir()
        with (
            _patch_wiki_dir(wiki_dir),
            pytest.raises(SystemExit) as exc,
        ):
            _new_page._compute_output_path("concept", "三层架构")
        assert exc.value.code == 2

    def test_slug_with_dotdot_exits(self, tmp_path: Path) -> None:
        """Slug with '..' exits with code 2."""
        wiki_dir = tmp_path / "wiki"
        wiki_dir.mkdir()
        with (
            _patch_wiki_dir(wiki_dir),
            pytest.raises(SystemExit) as exc,
        ):
            _new_page._compute_output_path(
                "concept", "../evil", args_slug="../evil"
            )
        assert exc.value.code == 2

    def test_slug_with_slash_exits(self, tmp_path: Path) -> None:
        """Slug with '/' exits with code 2."""
        wiki_dir = tmp_path / "wiki"
        wiki_dir.mkdir()
        with (
            _patch_wiki_dir(wiki_dir),
            pytest.raises(SystemExit) as exc,
        ):
            _new_page._compute_output_path("concept", "a/b", args_slug="a/b")
        assert exc.value.code == 2

    def test_slug_with_backslash_exits(self, tmp_path: Path) -> None:
        """Slug with '\\' exits with code 2."""
        wiki_dir = tmp_path / "wiki"
        wiki_dir.mkdir()
        with (
            _patch_wiki_dir(wiki_dir),
            pytest.raises(SystemExit) as exc,
        ):
            _new_page._compute_output_path("concept", "a\\b", args_slug="a\\b")
        assert exc.value.code == 2


# ===================================================================


class TestApplyTemplateDirect:
    """``_apply_template`` — placeholder replacement (direct import)."""

    def test_date_replaced(self) -> None:
        """Created/updated YYYY-MM-DD is replaced with today's date."""
        content = "created: YYYY-MM-DD\nupdated: YYYY-MM-DD\n"
        result = _new_page._apply_template(content, "Test Title", "2025-06-19")
        assert "created: 2025-06-19" in result
        assert "updated: 2025-06-19" in result

    def test_status_defaulted(self) -> None:
        """Status placeholder is replaced with 'draft'."""
        content = "status: draft|review|stable|deprecated\n"
        result = _new_page._apply_template(content, "Test", "2025-06-19")
        assert "status: draft" in result
        assert "draft|review" not in result

    def test_title_replaced_in_frontmatter(self) -> None:
        """title: <...> is replaced with the actual title."""
        content = "title: <Page Title>\n"
        result = _new_page._apply_template(content, "My Page", "2025-06-19")
        assert "title: My Page" in result

    def test_title_replaced_in_heading(self) -> None:
        """# <...> is replaced with the actual title."""
        content = "# <Page Title>\n"
        result = _new_page._apply_template(content, "My Page", "2025-06-19")
        assert "# My Page" in result

    def test_no_placeholders_no_change(self) -> None:
        """Content without placeholders is returned unchanged."""
        content = "static content here\n"
        result = _new_page._apply_template(content, "Test", "2025-06-19")
        assert result == content

    def test_empty_content(self) -> None:
        """Empty content returns empty string."""
        assert _new_page._apply_template("", "Test", "2025-06-19") == ""

    def test_multiple_replaces(self) -> None:
        """Multiple substitutions work together."""
        content = (
            "---\n"
            "title: <Page Title>\n"
            "created: YYYY-MM-DD\n"
            "updated: YYYY-MM-DD\n"
            "status: draft|review|stable|deprecated\n"
            "---\n"
            "# <Page Title>\n"
        )
        result = _new_page._apply_template(content, "My Page", "2025-06-19")
        assert "title: My Page" in result
        assert "created: 2025-06-19" in result
        assert "updated: 2025-06-19" in result
        assert "status: draft" in result
        assert "# My Page" in result


# -- Helpers ----------------------------------------------------------------


def _run(
    *args: str, env: dict[str, str] | None = None
) -> subprocess.CompletedProcess:
    """Run new_page.py with the given CLI arguments.

    Args:
        *args: Arguments to forward to the script (e.g. ``"--type", "concept"``).
        env: Optional environment overrides (defaults to current env + HOME override).

    Returns:
        A CompletedProcess with ``returncode``, ``stdout``, and ``stderr``.
    """
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        capture_output=True,
        text=True,
        env=env,
    )


@pytest.fixture(autouse=True)
def _fake_home_and_symlink(tmp_path) -> dict[str, str]:
    """Set HOME to tmp_path and create tmp_path/.zoo/wiki -> REPO_ROOT/wiki.

    This ensures the subprocess resolves ``Path.home() / ".zoo" / "wiki"``
    to the real wiki directory (via the symlink), without touching the real
    ``~/.zoo/``.
    """
    fake_home = tmp_path / "fake_home"
    fake_home.mkdir()
    zoo_dir = fake_home / ".zoo"
    zoo_dir.mkdir()
    target_link = zoo_dir / "wiki"
    source_wiki = REPO_ROOT / "wiki"
    os.symlink(str(source_wiki), str(target_link))

    # Build env with HOME pointing to fake_home
    env = os.environ.copy()
    env["HOME"] = str(fake_home)
    return env


@pytest.fixture(autouse=True)
def _cleanup_temp_page() -> None:
    """Remove any temporary test pages after every test."""
    yield
    for p in _TEST_FILES:
        if p.exists():
            p.unlink()


# -- Auto-derived path tests ------------------------------------------------


class TestAutoDerivedPath:
    """Verify that paths are automatically derived from --type and --title."""

    def test_concept_auto_path(self, _fake_home_and_symlink) -> None:
        """--type concept --title "Permission Model" -> wiki/concepts/permission-model.md."""
        result = _run(
            "--type",
            "concept",
            "--title",
            "Permission Model",
            env=_fake_home_and_symlink,
        )
        assert result.returncode == 0
        assert "已创建页面" in result.stdout
        assert "wiki/concepts/permission-model.md" in result.stdout

        output_file = REPO_ROOT / "wiki" / "concepts" / "permission-model.md"
        assert output_file.is_file()

    def test_entity_auto_path(self, _fake_home_and_symlink) -> None:
        """--type entity --title "BuildAgent" -> wiki/entities/buildagent.md."""
        result = _run(
            "--type",
            "entity",
            "--title",
            "BuildAgent",
            env=_fake_home_and_symlink,
        )
        assert result.returncode == 0
        output_file = REPO_ROOT / "wiki" / "entities" / "buildagent.md"
        assert output_file.is_file()
        assert str(output_file.relative_to(REPO_ROOT)) in result.stdout

    def test_source_with_source_type(self, _fake_home_and_symlink) -> None:
        """--type source --title "ADR-001" --source-type adr
        -> wiki/sources/adr/adr-001.md."""
        result = _run(
            "--type",
            "source",
            "--title",
            "ADR-001",
            "--source-type",
            "adr",
            env=_fake_home_and_symlink,
        )
        assert result.returncode == 0
        output_file = REPO_ROOT / "wiki" / "sources" / "adr" / "adr-001.md"
        assert output_file.is_file()

    def test_source_without_source_type(self, _fake_home_and_symlink) -> None:
        """--type source without --source-type exits with error."""
        result = _run(
            "--type",
            "source",
            "--title",
            "ADR-001",
            env=_fake_home_and_symlink,
        )
        assert result.returncode == 2
        assert "source-type" in result.stderr

    def test_analysis_auto_path(self, _fake_home_and_symlink) -> None:
        """--type analysis --title "Analysis Test"
        -> wiki/analysis/analysis-test.md."""
        result = _run(
            "--type",
            "analysis",
            "--title",
            "Analysis Test",
            env=_fake_home_and_symlink,
        )
        assert result.returncode == 0
        output_file = REPO_ROOT / "wiki" / "analysis" / "analysis-test.md"
        assert output_file.is_file()

    def test_synthesis_auto_path(self, _fake_home_and_symlink) -> None:
        """--type synthesis --title "Synthesis Test"
        -> wiki/syntheses/synthesis-test.md."""
        result = _run(
            "--type",
            "synthesis",
            "--title",
            "Synthesis Test",
            env=_fake_home_and_symlink,
        )
        assert result.returncode == 0
        output_file = REPO_ROOT / "wiki" / "syntheses" / "synthesis-test.md"
        assert output_file.is_file()

    def test_title_special_chars(self, _fake_home_and_symlink) -> None:
        """Title with spaces and underscores gets cleaned to kebab-case."""
        result = _run(
            "--type",
            "concept",
            "--title",
            "Special_Case Test!",
            env=_fake_home_and_symlink,
        )
        assert result.returncode == 0
        output_file = REPO_ROOT / "wiki" / "concepts" / "special-case-test.md"
        assert output_file.is_file()

    def test_title_traversal_safe(self, _fake_home_and_symlink) -> None:
        """Title with ``../`` is cleaned to safe kebab-case, no escape.

        Because kebab-case stripping removes dots and slashes, a title like
        ``../evil`` becomes just ``evil`` and stays safely under wiki/.
        """
        result = _run(
            "--type",
            "concept",
            "--title",
            "../evil",
            env=_fake_home_and_symlink,
        )
        assert result.returncode == 0
        output_file = REPO_ROOT / "wiki" / "concepts" / "evil.md"
        assert output_file.is_file()

    def test_creates_valid_page(self, _fake_home_and_symlink) -> None:
        """Creates a page with correct title, heading, and date."""
        result = _run(
            "--type",
            "concept",
            "--title",
            "TestConcept",
            env=_fake_home_and_symlink,
        )
        assert result.returncode == 0
        assert "已创建页面" in result.stdout

        output_file = REPO_ROOT / "wiki" / "concepts" / "testconcept.md"
        assert output_file.is_file()

        content = output_file.read_text(encoding="utf-8")
        assert "title: TestConcept" in content
        assert "# TestConcept" in content
        assert date.today().isoformat() in content

    def test_status_defaults_to_draft(self, _fake_home_and_symlink) -> None:
        """Verify the ``draft|review|stable|deprecated`` placeholder is replaced
        with just ``draft``."""
        result = _run(
            "--type",
            "concept",
            "--title",
            "DraftTest",
            env=_fake_home_and_symlink,
        )
        assert result.returncode == 0

        output_file = REPO_ROOT / "wiki" / "concepts" / "drafttest.md"
        content = output_file.read_text(encoding="utf-8")

        # The pipe-separated placeholder must not survive.
        assert "draft|review|stable|deprecated" not in content

        # The resulting line should be exactly "status: draft".
        assert any(
            line.strip() == "status: draft" for line in content.splitlines()
        )


# -- Invalid type -----------------------------------------------------------


def test_invalid_type_exits_with_error(_fake_home_and_symlink) -> None:
    """An unrecognised ``--type`` value triggers an argparse error (exit 2)."""
    result = _run(
        "--type",
        "invalid",
        "--title",
        "Test",
        env=_fake_home_and_symlink,
    )
    assert result.returncode == 2
    assert "invalid choice" in result.stderr


# -- --slug parameter tests --------------------------------------------------


class TestSlugParameter:
    """Verify the ``--slug`` parameter overrides auto-derivation."""

    def test_slug_overrides_auto(self, _fake_home_and_symlink) -> None:
        """--slug "renamed-page" overrides --title "Original Title"."""
        result = _run(
            "--type",
            "concept",
            "--title",
            "Original Title",
            "--slug",
            "renamed-page",
            env=_fake_home_and_symlink,
        )
        assert result.returncode == 0
        assert "已创建页面" in result.stdout
        assert "wiki/concepts/renamed-page.md" in result.stdout

        output_file = REPO_ROOT / "wiki" / "concepts" / "renamed-page.md"
        assert output_file.is_file()

    def test_chinese_title_without_slug_fails(
        self, _fake_home_and_symlink
    ) -> None:
        """Chinese title without --slug exits with error (empty slug)."""
        result = _run(
            "--type",
            "concept",
            "--title",
            "三层架构",
            env=_fake_home_and_symlink,
        )
        assert result.returncode == 2
        assert "--slug" in result.stderr

    def test_chinese_title_with_slug_works(
        self, _fake_home_and_symlink
    ) -> None:
        """--title "三层架构" --slug "three-layer-architecture" creates the page."""
        result = _run(
            "--type",
            "concept",
            "--title",
            "三层架构",
            "--slug",
            "three-layer-architecture",
            env=_fake_home_and_symlink,
        )
        assert result.returncode == 0
        assert "已创建页面" in result.stdout
        assert "wiki/concepts/three-layer-architecture.md" in result.stdout

        output_file = (
            REPO_ROOT / "wiki" / "concepts" / "three-layer-architecture.md"
        )
        assert output_file.is_file()
        content = output_file.read_text(encoding="utf-8")
        assert "title: 三层架构" in content
        assert "# 三层架构" in content
