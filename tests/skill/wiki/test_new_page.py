"""Tests for core/skills/wiki-maintain/tools/new_page.py.

All tests use subprocess to exercise the real CLI entry point, covering
path traversal guards, valid page creation, placeholder replacement, and
invalid argument handling.
"""

from __future__ import annotations

import subprocess
import sys
from datetime import date
from pathlib import Path

import pytest

# ── Paths ────────────────────────────────────────────────────────────────

REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent
SCRIPT = (
    REPO_ROOT / "core" / "skills" / "wiki-maintain" / "tools" / "new_page.py"
)

# Temporary output file used by creation tests; cleaned up after each test.
_TEMP_OUTPUT = "wiki/concepts/_test_new_page_temp.md"


# ── Helpers ──────────────────────────────────────────────────────────────


def _run(*args: str) -> subprocess.CompletedProcess:
    """Run new_page.py with the given CLI arguments.

    Args:
        *args: Arguments to forward to the script (e.g. ``"--type", "concept"``).

    Returns:
        A CompletedProcess with ``returncode``, ``stdout``, and ``stderr``.
    """
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args],
        capture_output=True,
        text=True,
    )


@pytest.fixture(autouse=True)
def _cleanup_temp_page() -> None:
    """Remove the temporary test page after every test.

    This is a no-op for most tests; only the creation tests actually
    produce the file.
    """
    yield
    p = REPO_ROOT / _TEMP_OUTPUT
    if p.exists():
        p.unlink()


# ── Path traversal guards ────────────────────────────────────────────────


class TestPathTraversal:
    """Reject unsafe output paths before any file I/O."""

    def test_rejects_absolute_path(self) -> None:
        """--output /tmp/outside.md → exit 1, stderr contains "绝对路径"."""
        result = _run(
            "--type",
            "concept",
            "--title",
            "Test",
            "--output",
            "/tmp/outside.md",
        )
        assert result.returncode == 1
        assert "绝对路径" in result.stderr

    def test_rejects_dotdot_prefix(self) -> None:
        """--output ../outside.md → exit 1, stderr mentions ".."."""
        result = _run(
            "--type",
            "concept",
            "--title",
            "Test",
            "--output",
            "../outside.md",
        )
        assert result.returncode == 1
        assert "../" in result.stderr

    def test_rejects_path_outside_wiki(self) -> None:
        """--output wiki/../../outside.md → exit 1, stderr says "wiki/ 目录下"."""
        result = _run(
            "--type",
            "concept",
            "--title",
            "Test",
            "--output",
            "wiki/../../outside.md",
        )
        assert result.returncode == 1
        assert "必须在 wiki/ 目录下" in result.stderr


# ── Valid page creation ──────────────────────────────────────────────────


class TestValidCreation:
    """Successful page creation into ``wiki/concepts/`` with cleanup."""

    def test_creates_valid_page(self) -> None:
        """Creates a page with correct title, heading, and date."""
        result = _run(
            "--type",
            "concept",
            "--title",
            "TestConcept",
            "--output",
            _TEMP_OUTPUT,
        )
        assert result.returncode == 0
        assert "已创建页面" in result.stdout

        output_file = REPO_ROOT / _TEMP_OUTPUT
        assert output_file.is_file()

        content = output_file.read_text(encoding="utf-8")
        assert "title: TestConcept" in content
        assert "# TestConcept" in content
        assert date.today().isoformat() in content

    def test_status_defaults_to_draft(self) -> None:
        """Verify the ``draft|review|stable|deprecated`` placeholder is replaced
        with just ``draft``."""
        result = _run(
            "--type",
            "concept",
            "--title",
            "DraftTest",
            "--output",
            _TEMP_OUTPUT,
        )
        assert result.returncode == 0

        output_file = REPO_ROOT / _TEMP_OUTPUT
        content = output_file.read_text(encoding="utf-8")

        # The pipe-separated placeholder must not survive.
        assert "draft|review|stable|deprecated" not in content

        # The resulting line should be exactly "status: draft".
        assert any(
            line.strip() == "status: draft" for line in content.splitlines()
        )


# ── Invalid type ─────────────────────────────────────────────────────────


def test_invalid_type_exits_with_error() -> None:
    """An unrecognised ``--type`` value triggers an argparse error (exit 2)."""
    result = _run(
        "--type",
        "invalid",
        "--title",
        "Test",
        "--output",
        "wiki/concepts/x.md",
    )
    assert result.returncode == 2
    assert "invalid choice" in result.stderr
