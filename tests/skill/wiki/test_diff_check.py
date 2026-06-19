"""Tests for wiki/tools/diff_check.py.

All tests use ``tmp_path`` with patched ``WIKI_DIR`` to avoid side effects
on the real wiki.  Functions that call ``subprocess.run`` are mocked where
appropriate; CLI subprocess tests create a real git repository in tmp_path.
"""

from __future__ import annotations

import os
import subprocess
import sys
from pathlib import Path
from unittest.mock import patch

import pytest

# ── Load diff_check.py via sys.path ─────────────────────────────────

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent
_TOOLS_DIR = str(_REPO_ROOT / "wiki" / "tools")
if _TOOLS_DIR not in sys.path:
    sys.path.insert(0, _TOOLS_DIR)

import diff_check as _diff  # noqa: E402
import shared.utils as _shared_utils  # noqa: E402 — for patching WIKI_DIR

# ── Helpers ──────────────────────────────────────────────────────────


def _write(path: Path, text: str) -> Path:
    """Write *text* to *path*, creating parent directories."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


# ── _is_prose_page ───────────────────────────────────────────────────


class TestIsProsePage:
    """``_is_prose_page`` — skip meta files and non-prose dirs."""

    def test_prose_md_passes(self):
        """Regular .md wiki page passes."""
        assert _diff._is_prose_page("concepts/foo.md") is True

    def test_index_md_rejected(self):
        """index.md is not a prose page."""
        assert _diff._is_prose_page("index.md") is False

    def test_log_md_rejected(self):
        """log.md is not a prose page."""
        assert _diff._is_prose_page("log.md") is False

    def test_templates_dir_rejected(self):
        """Files under templates/ are not prose pages."""
        assert _diff._is_prose_page("templates/page-tpl.md") is False

    def test_tools_dir_rejected(self):
        """Files under tools/ are not prose pages."""
        assert _diff._is_prose_page("tools/some-tool.py") is False

    def test_raw_dir_rejected(self):
        """Files under raw/ are not prose pages."""
        assert _diff._is_prose_page("raw/notes.txt") is False

    def test_overview_md_rejected(self):
        """overview.md is not a prose page."""
        assert _diff._is_prose_page("overview.md") is False

    def test_schema_md_rejected(self):
        """SCHEMA.md is not a prose page."""
        assert _diff._is_prose_page("SCHEMA.md") is False

    def test_health_report_rejected(self):
        """health-report.md is not a prose page."""
        assert _diff._is_prose_page("health-report.md") is False

    def test_lint_report_rejected(self):
        """lint-report.md is not a prose page."""
        assert _diff._is_prose_page("lint-report.md") is False


# ── _parse_added_lines ───────────────────────────────────────────────


class TestParseAddedLines:
    """``_parse_added_lines`` — extract added lines from unified diff."""

    def test_parses_added_lines(self):
        """Added lines with ``+`` prefix are extracted, prefix stripped."""
        diff = (
            "diff --git a/wiki/concepts/foo.md b/wiki/concepts/foo.md\n"
            "@@ -0,0 +1,2 @@\n"
            "+Line one\n"
            "+Line two\n"
        )
        result = _diff._parse_added_lines(diff)
        # Key includes the wiki/ prefix from the git diff path
        assert "wiki/concepts/foo.md" in result
        assert "Line one\nLine two" in result["wiki/concepts/foo.md"]

    def test_skips_context_and_deleted_lines(self):
        """Lines starting without ``+`` are not included."""
        diff = (
            "diff --git a/wiki/concepts/foo.md b/wiki/concepts/foo.md\n"
            "@@ -1,3 +1,4 @@\n"
            " unchanged\n"
            "-removed\n"
            "+added\n"
        )
        result = _diff._parse_added_lines(diff)
        assert "added" in result["wiki/concepts/foo.md"]
        assert "unchanged" not in result["wiki/concepts/foo.md"]
        assert "removed" not in result["wiki/concepts/foo.md"]

    def test_skips_plus_plus_plus(self):
        """``+++`` file header lines are excluded."""
        diff = (
            "diff --git a/wiki/foo.md b/wiki/foo.md\n"
            "--- a/wiki/foo.md\n"
            "+++ b/wiki/foo.md\n"
            "@@ -1 +1,2 @@\n"
            "+new content\n"
        )
        result = _diff._parse_added_lines(diff)
        assert result["wiki/foo.md"] == "new content"

    def test_multiple_files(self):
        """Diff spanning multiple files extracts added lines per file."""
        diff = (
            "diff --git a/wiki/a.md b/wiki/a.md\n"
            "@@ -1 +1,2 @@\n"
            "+a added\n"
            "diff --git a/wiki/b.md b/wiki/b.md\n"
            "@@ -1 +1,2 @@\n"
            "+b added\n"
        )
        result = _diff._parse_added_lines(diff)
        assert result["wiki/a.md"] == "a added"
        assert result["wiki/b.md"] == "b added"

    def test_empty_diff(self):
        """Empty diff returns empty dict."""
        result = _diff._parse_added_lines("")
        assert result == {}

    def test_no_added_lines(self):
        """Diff with only context/delete lines returns empty dict."""
        diff = (
            "diff --git a/wiki/foo.md b/wiki/foo.md\n"
            "@@ -1 +1 @@\n"
            "-old line\n"
            " unchanged\n"
        )
        result = _diff._parse_added_lines(diff)
        assert result == {}


# ── _git_root ────────────────────────────────────────────────────────


class TestGitRoot:
    """``_git_root`` — find git repository root."""

    def test_found(self, tmp_path):
        """Git root found returns Path to the root."""
        # Create a minimal git repo
        repo = tmp_path / "repo"
        repo.mkdir()
        subprocess.run(["git", "init"], cwd=str(repo), capture_output=True)
        wiki_dir = repo / "wiki"
        wiki_dir.mkdir()

        with patch.object(_diff, "WIKI_DIR", wiki_dir):
            result = _diff._git_root()

        assert result is not None
        assert result.resolve() == repo.resolve()

    def test_not_found(self):
        """No git repo → returns None."""
        # Use a non-existent directory that's definitely not in a git repo
        with patch.object(
            _diff, "WIKI_DIR", Path("/tmp/nonexistent-zoo-test-dir")
        ):
            result = _diff._git_root()
        assert result is None


# ── run_diff (with mocked git) ───────────────────────────────────────


class TestRunDiff:
    """``run_diff`` — main entry point with mocked subprocess."""

    def _make_namespace(self, cached: bool = False, commit: str | None = None):
        """Create a mock argparse.Namespace."""
        from argparse import Namespace

        return Namespace(cached=cached, commit=commit)

    def _make_page(self, wiki_dir: Path, rel_path: str, content: str) -> Path:
        """Create a wiki page under *wiki_dir*."""
        p = wiki_dir / rel_path
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(content)
        return p

    def test_no_changes_returns_0(self, tmp_path):
        """No changes in wiki → exit code 0."""
        wiki_dir = tmp_path / "wiki"
        wiki_dir.mkdir()
        repo_dir = tmp_path / "repo"
        repo_dir.mkdir()

        # Create a minimal git repo at repo_dir
        subprocess.run(["git", "init"], cwd=str(repo_dir), capture_output=True)
        # Point wiki_dir inside repo
        wiki_sym = repo_dir / "wiki"
        wiki_sym.mkdir()

        with (
            patch.object(_diff, "WIKI_DIR", wiki_sym),
            patch.object(_shared_utils, "WIKI_DIR", wiki_sym),
            patch.object(_diff, "_git_root", return_value=repo_dir.resolve()),
            patch(
                "subprocess.run",
                return_value=subprocess.CompletedProcess(
                    args=[], returncode=0, stdout="", stderr=""
                ),
            ) as mock_run,
        ):
            args = self._make_namespace(cached=False, commit=None)
            rc = _diff.run_diff(args)

        assert rc == 0
        # Verify the mock was called for the diff (not git-root since it's patched)
        mock_run.assert_called_once()

    def test_missing_links_returns_1(self, tmp_path):
        """Missing links found → exit code 1.
        The anchor term must point to a page DIFFERENT from the one being
        checked, otherwise the self-reference guard skips it."""
        wiki_dir = tmp_path / "wiki"
        wiki_dir.mkdir()
        # source.md has a self-link: the display text "Source Page" maps to source.md itself
        _write(
            wiki_dir / "concepts" / "source.md",
            "---\ntitle: Source\n---\n\n[Source Page](concepts/source.md) is here.",
        )
        _write(
            wiki_dir / "concepts" / "target.md",
            "---\ntitle: Target\n---\n\nContent.",
        )

        # Mock git diff to return added lines for target.md that mention
        # "Source Page" without linking to it.
        diff_output = (
            "diff --git a/wiki/concepts/target.md b/wiki/concepts/target.md\n"
            "@@ -1 +1,2 @@\n"
            "+Source Page is mentioned here without a link.\n"
        )

        with (
            patch.object(_diff, "WIKI_DIR", wiki_dir),
            patch.object(_shared_utils, "WIKI_DIR", wiki_dir),
            patch.object(
                _diff, "_git_root", return_value=wiki_dir.parent.resolve()
            ),
            patch(
                "subprocess.run",
                return_value=subprocess.CompletedProcess(
                    args=[], returncode=0, stdout=diff_output, stderr=""
                ),
            ),
        ):
            args = self._make_namespace(cached=False, commit=None)
            rc = _diff.run_diff(args)

        assert rc == 1

    def test_git_error_returns_2(self, tmp_path):
        """Git diff fails → exit code 2."""
        with (
            patch.object(_diff, "WIKI_DIR", tmp_path / "wiki"),
            patch.object(_diff, "_git_root", return_value=tmp_path.resolve()),
            patch(
                "subprocess.run",
                return_value=subprocess.CompletedProcess(
                    args=[],
                    returncode=128,
                    stdout="",
                    stderr="fatal: not a git repository",
                ),
            ),
        ):
            args = self._make_namespace(cached=False, commit=None)
            rc = _diff.run_diff(args)

        assert rc == 2

    def test_cached_flag(self, tmp_path):
        """--cached flag is passed to git diff."""
        wiki_dir = tmp_path / "wiki"
        wiki_dir.mkdir()

        with (
            patch.object(_diff, "WIKI_DIR", wiki_dir),
            patch.object(_diff, "_git_root", return_value=tmp_path.resolve()),
            patch(
                "subprocess.run",
                return_value=subprocess.CompletedProcess(
                    args=[], returncode=0, stdout="", stderr=""
                ),
            ) as mock_run,
        ):
            args = self._make_namespace(cached=True, commit=None)
            _diff.run_diff(args)

        # Verify --cached was in the command
        call_args = mock_run.call_args[0][0]
        assert "--cached" in call_args

    def test_commit_arg(self, tmp_path):
        """Commit argument is passed to git diff."""
        wiki_dir = tmp_path / "wiki"
        wiki_dir.mkdir()

        with (
            patch.object(_diff, "WIKI_DIR", wiki_dir),
            patch.object(_diff, "_git_root", return_value=tmp_path.resolve()),
            patch(
                "subprocess.run",
                return_value=subprocess.CompletedProcess(
                    args=[], returncode=0, stdout="", stderr=""
                ),
            ) as mock_run,
        ):
            args = self._make_namespace(cached=False, commit="HEAD~1")
            _diff.run_diff(args)

        call_args = mock_run.call_args[0][0]
        assert "HEAD~1" in call_args


# ── CLI subprocess tests ─────────────────────────────────────────────


@pytest.fixture
def _git_repo_and_home(tmp_path):
    """Create a real git repo with a wiki directory, set HOME to tmp_path.

    Returns a dict with:
        ``repo``: Path to the git repository.
        ``wiki``: Path to the wiki directory inside the repo.
        ``env``: Environment with HOME pointing to tmp_path/fake_home.
    """
    fake_home = tmp_path / "fake_home"
    fake_home.mkdir()
    zoo_dir = fake_home / ".zoo"
    zoo_dir.mkdir()

    repo = tmp_path / "repo"
    repo.mkdir()
    subprocess.run(["git", "init"], cwd=str(repo), capture_output=True)
    subprocess.run(
        ["git", "config", "user.email", "test@test.com"],
        cwd=str(repo),
        capture_output=True,
    )
    subprocess.run(
        ["git", "config", "user.name", "Test"],
        cwd=str(repo),
        capture_output=True,
    )

    wiki = repo / "wiki"
    wiki.mkdir()

    # Symlink ~/.zoo/wiki -> repo/wiki
    target_link = zoo_dir / "wiki"
    os.symlink(str(wiki), str(target_link))

    # Initial commit so we have a baseline
    readme = repo / "README.md"
    readme.write_text("# Repo")
    subprocess.run(
        ["git", "add", "."],
        cwd=str(repo),
        capture_output=True,
    )
    subprocess.run(
        ["git", "commit", "-m", "initial"],
        cwd=str(repo),
        capture_output=True,
    )

    env = {**os.environ, "HOME": str(fake_home)}
    return {"repo": repo, "wiki": wiki, "env": env}


class TestCliSubprocess:
    """CLI entry point via subprocess with real git repo."""

    DIFF_SCRIPT = _REPO_ROOT / "wiki" / "tools" / "diff_check.py"

    def test_no_changes(self, _git_repo_and_home):
        """No changes → exit code 0."""
        result = subprocess.run(
            [sys.executable, str(self.DIFF_SCRIPT)],
            capture_output=True,
            text=True,
            env=_git_repo_and_home["env"],
        )
        assert result.returncode == 0

    def test_cached_flag(self, _git_repo_and_home):
        """--cached with no staged changes → exit code 0."""
        result = subprocess.run(
            [sys.executable, str(self.DIFF_SCRIPT), "--cached"],
            capture_output=True,
            text=True,
            env=_git_repo_and_home["env"],
        )
        assert result.returncode == 0

    def test_commit_arg(self, _git_repo_and_home):
        """Commit argument with diff against HEAD → exit code 0."""
        result = subprocess.run(
            [sys.executable, str(self.DIFF_SCRIPT), "HEAD"],
            capture_output=True,
            text=True,
            env=_git_repo_and_home["env"],
        )
        assert result.returncode == 0


# ===================================================================
# Edge-case tests for uncovered lines
# ===================================================================


class TestGitRootEdgeCases:
    """``_git_root`` — edge cases."""

    def test_git_not_installed(self):
        """FileNotFoundError (git not found) returns None (lines 113-114)."""
        with (
            patch.object(_diff, "WIKI_DIR", Path("/tmp")),
            patch(
                "subprocess.run",
                side_effect=FileNotFoundError("git not found"),
            ),
        ):
            result = _diff._git_root()
        assert result is None


class TestRunDiffEdgeCases:
    """``run_diff`` — edge cases for uncovered branches."""

    def _make_namespace(self, cached: bool = False, commit: str | None = None):
        from argparse import Namespace

        return Namespace(cached=cached, commit=commit)

    def test_git_root_none_returns_2(self, tmp_path):
        """git_root is None → exit code 2 (lines 123-124)."""
        with (
            patch.object(_diff, "WIKI_DIR", tmp_path / "wiki"),
            patch.object(_diff, "_git_root", return_value=None),
        ):
            rc = _diff.run_diff(self._make_namespace())
        assert rc == 2

    def test_wiki_not_under_git_root(self, tmp_path):
        """wiki_dir.relative_to(git_root) raises ValueError → fallback (lines 129-130)."""
        wiki_dir = tmp_path / "wiki"
        wiki_dir.mkdir()
        git_root = tmp_path / "other-repo"
        git_root.mkdir()

        with (
            patch.object(_diff, "WIKI_DIR", wiki_dir),
            patch.object(_diff, "_git_root", return_value=git_root.resolve()),
            patch(
                "subprocess.run",
                return_value=subprocess.CompletedProcess(
                    args=[], returncode=0, stdout="", stderr=""
                ),
            ),
        ):
            rc = _diff.run_diff(self._make_namespace())
        # No diff output → exit code 0 (no changes)
        assert rc == 0

    def test_no_markdown_files_changed(self, tmp_path):
        """Diff with changes but no .md files → exit 0 (lines 174-175)."""
        wiki_dir = tmp_path / "wiki"
        wiki_dir.mkdir()
        diff_output = (
            "diff --git a/wiki/data.json b/wiki/data.json\n"
            "@@ -1 +1,2 @@\n"
            '+{"key": "value"}\n'
        )

        with (
            patch.object(_diff, "WIKI_DIR", wiki_dir),
            patch.object(_shared_utils, "WIKI_DIR", wiki_dir),
            patch.object(_diff, "_git_root", return_value=tmp_path.resolve()),
            patch(
                "subprocess.run",
                return_value=subprocess.CompletedProcess(
                    args=[], returncode=0, stdout=diff_output, stderr=""
                ),
            ),
        ):
            rc = _diff.run_diff(self._make_namespace())
        assert rc == 0

    def test_skip_non_prose_page(self, tmp_path):
        """Non-prose page in diff is skipped (line 189)."""
        wiki_dir = tmp_path / "wiki"
        wiki_dir.mkdir()
        diff_output = (
            "diff --git a/wiki/index.md b/wiki/index.md\n"
            "@@ -1 +1,2 @@\n"
            "+## New section\n"
        )

        with (
            patch.object(_diff, "WIKI_DIR", wiki_dir),
            patch.object(_shared_utils, "WIKI_DIR", wiki_dir),
            patch.object(_diff, "_git_root", return_value=tmp_path.resolve()),
            patch(
                "subprocess.run",
                return_value=subprocess.CompletedProcess(
                    args=[], returncode=0, stdout=diff_output, stderr=""
                ),
            ),
        ):
            rc = _diff.run_diff(self._make_namespace())
        # index.md is skipped as non-prose → no added files → exit 0
        assert rc == 0

    def test_no_issues_found_returns_0(self, tmp_path):
        """Diff with changes but no missing inline links → exit 0 (lines 202-203)."""
        wiki_dir = tmp_path / "wiki"
        wiki_dir.mkdir()
        # The anchor check would need terms matching — with empty wiki no anchors exist
        diff_output = (
            "diff --git a/wiki/concepts/new-page.md b/wiki/concepts/new-page.md\n"
            "@@ -0,0 +1,2 @@\n"
            "+# New Page\n"
            "+Some content here.\n"
        )

        with (
            patch.object(_diff, "WIKI_DIR", wiki_dir),
            patch.object(_shared_utils, "WIKI_DIR", wiki_dir),
            patch.object(_diff, "_git_root", return_value=tmp_path.resolve()),
            patch(
                "subprocess.run",
                return_value=subprocess.CompletedProcess(
                    args=[], returncode=0, stdout=diff_output, stderr=""
                ),
            ),
        ):
            rc = _diff.run_diff(self._make_namespace())
        assert rc == 0
