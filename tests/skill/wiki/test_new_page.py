"""Tests for core/skills/wiki-maintain/tools/new_page.py.

All tests use subprocess to exercise the real CLI entry point, covering
path traversal guards, valid page creation, placeholder replacement, and
invalid argument handling.

Because the script now resolves the wiki directory via Path.home() / ".zoo" / "wiki",
test automatically sets up a temporary HOME directory with a symlink
~/.zoo/wiki → <REPO_ROOT>/wiki so that template resolution works.
"""

from __future__ import annotations

import os
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
    """Set HOME to tmp_path and create tmp_path/.zoo/wiki → REPO_ROOT/wiki.

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

    def test_rejects_absolute_path(self, _fake_home_and_symlink) -> None:
        """--output /tmp/outside.md → exit 1, stderr contains "绝对路径"."""
        result = _run(
            "--type",
            "concept",
            "--title",
            "Test",
            "--output",
            "/tmp/outside.md",
            env=_fake_home_and_symlink,
        )
        assert result.returncode == 1
        assert "绝对路径" in result.stderr

    def test_rejects_dotdot_prefix(self, _fake_home_and_symlink) -> None:
        """--output ../outside.md → exit 1, stderr mentions ".."."""
        result = _run(
            "--type",
            "concept",
            "--title",
            "Test",
            "--output",
            "../outside.md",
            env=_fake_home_and_symlink,
        )
        assert result.returncode == 1
        assert "../" in result.stderr

    def test_rejects_path_outside_wiki(self, _fake_home_and_symlink) -> None:
        """--output wiki/../../outside.md → exit 1, stderr says "wiki/ 目录下"."""
        result = _run(
            "--type",
            "concept",
            "--title",
            "Test",
            "--output",
            "wiki/../../outside.md",
            env=_fake_home_and_symlink,
        )
        assert result.returncode == 1
        assert "必须在 wiki/ 目录下" in result.stderr


# ── Valid page creation ──────────────────────────────────────────────────


class TestValidCreation:
    """Successful page creation into ``wiki/concepts/`` with cleanup."""

    def test_creates_valid_page(self, _fake_home_and_symlink) -> None:
        """Creates a page with correct title, heading, and date."""
        result = _run(
            "--type",
            "concept",
            "--title",
            "TestConcept",
            "--output",
            _TEMP_OUTPUT,
            env=_fake_home_and_symlink,
        )
        assert result.returncode == 0
        assert "已创建页面" in result.stdout

        output_file = REPO_ROOT / _TEMP_OUTPUT
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
            "--output",
            _TEMP_OUTPUT,
            env=_fake_home_and_symlink,
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


def test_invalid_type_exits_with_error(_fake_home_and_symlink) -> None:
    """An unrecognised ``--type`` value triggers an argparse error (exit 2)."""
    result = _run(
        "--type",
        "invalid",
        "--title",
        "Test",
        "--output",
        "wiki/concepts/x.md",
        env=_fake_home_and_symlink,
    )
    assert result.returncode == 2
    assert "invalid choice" in result.stderr
