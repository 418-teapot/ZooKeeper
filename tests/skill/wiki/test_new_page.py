"""Tests for wiki/tools/new_page.py.

All tests use subprocess to exercise the real CLI entry point, covering
auto-derived path generation, placeholder replacement, source-type
validation, and kebab-case conversion.

Because the script now resolves the wiki directory via Path.home() / ".zoo" / "wiki",
test automatically sets up a temporary HOME directory with a symlink
~/.zoo/wiki -> <REPO_ROOT>/wiki so that template resolution works.
"""

from __future__ import annotations

import os
import subprocess
import sys
from datetime import date
from pathlib import Path

import pytest

# -- Paths ------------------------------------------------------------------

REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent
SCRIPT = REPO_ROOT / "wiki" / "tools" / "new_page.py"

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
