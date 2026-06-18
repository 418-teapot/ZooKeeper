"""Tests for wiki/tools/wiki_log.py.

All file-system tests use ``tmp_path`` with monkeypatched module-level
constants (``WIKI_DIR``, ``LOG_FILE``).  Argparse validation tests use
monkeypatched ``sys.argv`` with ``pytest.raises(SystemExit)``.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path

import pytest

# ── Load wiki_log.py via importlib ─────────────────────────────────

_REPO_ROOT = Path(__file__).resolve().parent.parent.parent.parent
_WIKI_LOG_PATH = _REPO_ROOT / "wiki" / "tools" / "wiki_log.py"

_spec = importlib.util.spec_from_file_location("wiki_log", _WIKI_LOG_PATH)
wiki_log = importlib.util.module_from_spec(_spec)
sys.modules["wiki_log"] = wiki_log
_spec.loader.exec_module(wiki_log)


# ── Helpers ──────────────────────────────────────────────────────────


def _format_date() -> str:
    """Return today's date as ``YYYY-MM-DD``."""
    from datetime import date

    return date.today().isoformat()


def _write(path: Path, text: str) -> Path:
    """Write *text* to *path*, creating parent directories."""
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


# ── Fixtures ─────────────────────────────────────────────────────────


@pytest.fixture(autouse=True)
def _patch_paths(monkeypatch, tmp_path):
    """Redirect ``WIKI_DIR`` and ``LOG_FILE`` to *tmp_path*.

    Every test automatically gets::

        WIKI_DIR  -> tmp_path / "wiki"
        LOG_FILE  -> tmp_path / "wiki" / "log.md"
    """
    wiki_dir = tmp_path / "wiki"
    wiki_dir.mkdir()
    monkeypatch.setattr(wiki_log, "WIKI_DIR", wiki_dir)
    monkeypatch.setattr(wiki_log, "LOG_FILE", wiki_dir / "log.md")


# ── _normalize_path ──────────────────────────────────────────────────


class TestNormalizePath:
    """``_normalize_path`` — wiki/ prefix stripping."""

    def test_strips_wiki_prefix(self) -> None:
        """Path starting with ``wiki/`` has prefix stripped."""
        assert (
            wiki_log._normalize_path("wiki/concepts/foo.md")
            == "concepts/foo.md"
        )

    def test_passes_through_without_prefix(self) -> None:
        """Path without ``wiki/`` prefix is returned unchanged."""
        assert wiki_log._normalize_path("concepts/foo.md") == "concepts/foo.md"

    def test_em_dash_passes_through(self) -> None:
        """Em dash ``—`` is returned unchanged (non-page event)."""
        assert wiki_log._normalize_path("—") == "—"


# ── _truncate_note ───────────────────────────────────────────────────


class TestTruncateNote:
    """``_truncate_note`` — note length enforcement."""

    def test_short_note_unchanged(self) -> None:
        """Note under 60 chars is returned as-is."""
        assert wiki_log._truncate_note("short note") == "short note"

    def test_exactly_60_chars(self) -> None:
        """Note exactly 60 chars is returned unchanged (no truncation)."""
        note = "a" * 60
        assert wiki_log._truncate_note(note) == "a" * 60

    def test_truncation_at_60(self) -> None:
        """Note over 60 chars is truncated to 59 chars + ``…`` (60 total)."""
        note = "a" * 65
        result = wiki_log._truncate_note(note)
        assert len(result) == 60
        assert result == "a" * 59 + "…"


# ── _format_entry ────────────────────────────────────────────────────


class TestFormatEntry:
    """``_format_entry`` — entry string formatting."""

    def test_basic_format(self) -> None:
        """Format matches ``## [YYYY-MM-DD] op | path | action — note``."""
        today = _format_date()
        result = wiki_log._format_entry(
            "ingest", "concepts/test.md", "create", "test note"
        )
        assert (
            result
            == f"## [{today}] ingest | concepts/test.md | create — test note"
        )

    def test_em_dash_path(self) -> None:
        """Non-page event uses ``—`` as path."""
        today = _format_date()
        result = wiki_log._format_entry("health", "—", "pass", "all checks ok")
        assert result == f"## [{today}] health | — | pass — all checks ok"


# ── add_entry (core logic) ───────────────────────────────────────────


class TestAddEntry:
    """Core ``add_entry`` function — file mutation logic."""

    # ── 1. Happy path ────────────────────────────────────────────────

    def test_happy_path_creates_correct_entry(self) -> None:
        """Valid op/path/action/note creates the correct log line."""
        result = wiki_log.add_entry(
            "ingest", "concepts/test.md", "create", "test note"
        )
        today = _format_date()
        expected = (
            f"## [{today}] ingest | concepts/test.md | create — test note"
        )
        assert result == expected

        content = wiki_log.LOG_FILE.read_text(encoding="utf-8")
        assert expected in content

    # ── 2. Path normalization ────────────────────────────────────────

    def test_path_normalization_strips_wiki_prefix(self) -> None:
        """Path with ``wiki/`` prefix is stored as wiki-root-relative."""
        result = wiki_log.add_entry(
            "ingest", "wiki/concepts/test.md", "create", "normalized"
        )
        today = _format_date()
        expected = (
            f"## [{today}] ingest | concepts/test.md | create — normalized"
        )
        assert result == expected

        content = wiki_log.LOG_FILE.read_text(encoding="utf-8")
        assert "concepts/test.md" in content
        assert "wiki/concepts/test.md" not in content

    # ── 3. Path without wiki/ prefix ─────────────────────────────────

    def test_path_without_prefix_passes_through(self) -> None:
        """Path without ``wiki/`` prefix is stored as-is."""
        result = wiki_log.add_entry(
            "update", "sources/adr/foo.md", "edit", "no prefix"
        )
        today = _format_date()
        expected = (
            f"## [{today}] update | sources/adr/foo.md | edit — no prefix"
        )
        assert result == expected

        content = wiki_log.LOG_FILE.read_text(encoding="utf-8")
        assert expected in content

    # ── 4. Non-page event ────────────────────────────────────────────

    def test_em_dash_path_accepted(self) -> None:
        """Em dash ``—`` is accepted as path for non-page events."""
        result = wiki_log.add_entry("health", "—", "pass", "all healthy")
        today = _format_date()
        expected = f"## [{today}] health | — | pass — all healthy"
        assert result == expected

        content = wiki_log.LOG_FILE.read_text(encoding="utf-8")
        assert expected in content

    # ── 5. Note truncation ───────────────────────────────────────────

    def test_note_truncated_at_60_chars(self) -> None:
        """Note exceeding 60 chars is truncated to 59 + ``…``."""
        long_note = "a" * 65
        result = wiki_log.add_entry(
            "ingest", "concepts/long.md", "create", long_note
        )
        today = _format_date()
        truncated_note = "a" * 59 + "…"
        expected = f"## [{today}] ingest | concepts/long.md | create — {truncated_note}"
        assert result == expected
        assert len(expected.split(" — ")[1]) == 60

        content = wiki_log.LOG_FILE.read_text(encoding="utf-8")
        assert expected in content
        assert "a" * 65 not in content

    # ── 6. Note exactly 60 chars ─────────────────────────────────────

    def test_note_exactly_60_chars_no_truncation(self) -> None:
        """Note exactly 60 chars is stored without truncation."""
        note = "b" * 60
        result = wiki_log.add_entry(
            "update", "concepts/exact.md", "edit", note
        )
        today = _format_date()
        expected = (
            f"## [{today}] update | concepts/exact.md | edit — {'b' * 60}"
        )
        assert result == expected
        assert len(result.split(" — ")[1]) == 60

        content = wiki_log.LOG_FILE.read_text(encoding="utf-8")
        assert expected in content

    # ── 7. Prepend behaviour ─────────────────────────────────────────

    def test_prepend_behaviour(self) -> None:
        """Second entry appears above the first entry (most recent first)."""
        # Add first entry
        wiki_log.add_entry("ingest", "first.md", "create", "first entry")
        # Add second entry
        wiki_log.add_entry("ingest", "second.md", "create", "second entry")

        content = wiki_log.LOG_FILE.read_text(encoding="utf-8")

        # Find positions of each entry in the file
        pos_first = content.index("first.md")
        pos_second = content.index("second.md")

        # Second entry (newer) should appear BEFORE first entry (older)
        assert pos_second < pos_first, (
            "Second entry must appear above first entry in log.md"
        )

        # Both entries should be after the --- separator
        sep_pos = content.index("---")
        assert pos_first > sep_pos
        assert pos_second > sep_pos

    # ── 11. Log file doesn't exist ───────────────────────────────────

    def test_no_log_file_creates_header_and_entry(self) -> None:
        """When log.md does not exist, header + entry is created."""
        # Ensure log.md does not exist
        log_file = wiki_log.LOG_FILE
        if log_file.exists():
            log_file.unlink()

        assert not log_file.exists()

        result = wiki_log.add_entry(
            "delete", "concepts/old.md", "delete", "removed stale"
        )

        # File should now exist
        assert log_file.exists()

        content = log_file.read_text(encoding="utf-8")

        # Header should be present
        assert "# Wiki Change Log" in content
        assert "---" in content

        # Entry should be present
        assert result in content

        # The entry should appear after the separator
        sep_pos = content.index("---")
        entry_pos = content.index(result)
        assert entry_pos > sep_pos


# ── CLI argument parsing ─────────────────────────────────────────────


class TestCliArgs:
    """CLI argument validation via ``main()``."""

    def _run_main(self, monkeypatch, tmp_path, args: list[str]) -> None:
        """Set up paths and call ``main()`` with given args.

        Args:
            monkeypatch: Pytest monkeypatch fixture.
            tmp_path: Pytest tmp_path fixture.
            args: Argument list (without program name — it is prepended).
        """
        monkeypatch.setattr(wiki_log, "LOG_FILE", tmp_path / "wiki" / "log.md")
        monkeypatch.setattr(wiki_log, "WIKI_DIR", tmp_path / "wiki")
        monkeypatch.setattr(sys, "argv", ["wiki_log.py", *args])

    # ── 8. Invalid op ────────────────────────────────────────────────

    def test_invalid_op_exits_with_error(self, monkeypatch, tmp_path) -> None:
        """An unrecognised ``--op`` value triggers sys.exit(2)."""
        self._run_main(
            monkeypatch,
            tmp_path,
            [
                "--op",
                "invalid",
                "--path",
                "test.md",
                "--action",
                "create",
                "--note",
                "test",
            ],
        )
        with pytest.raises(SystemExit) as exc_info:
            wiki_log.main()
        assert exc_info.value.code == 2

    # ── 9. Invalid action ────────────────────────────────────────────

    def test_invalid_action_exits_with_error(
        self, monkeypatch, tmp_path
    ) -> None:
        """An unrecognised ``--action`` value triggers sys.exit(2)."""
        self._run_main(
            monkeypatch,
            tmp_path,
            [
                "--op",
                "ingest",
                "--path",
                "test.md",
                "--action",
                "invalid",
                "--note",
                "test",
            ],
        )
        with pytest.raises(SystemExit) as exc_info:
            wiki_log.main()
        assert exc_info.value.code == 2

    # ── 10. Missing required args ────────────────────────────────────

    def test_missing_op_exits_with_error(self, monkeypatch, tmp_path) -> None:
        """Missing ``--op`` triggers sys.exit(2)."""
        self._run_main(
            monkeypatch,
            tmp_path,
            ["--path", "test.md", "--action", "create", "--note", "test"],
        )
        with pytest.raises(SystemExit) as exc_info:
            wiki_log.main()
        assert exc_info.value.code == 2

    def test_missing_path_exits_with_error(
        self, monkeypatch, tmp_path
    ) -> None:
        """Missing ``--path`` triggers sys.exit(2)."""
        self._run_main(
            monkeypatch,
            tmp_path,
            ["--op", "ingest", "--action", "create", "--note", "test"],
        )
        with pytest.raises(SystemExit) as exc_info:
            wiki_log.main()
        assert exc_info.value.code == 2

    def test_missing_action_exits_with_error(
        self, monkeypatch, tmp_path
    ) -> None:
        """Missing ``--action`` triggers sys.exit(2)."""
        self._run_main(
            monkeypatch,
            tmp_path,
            ["--op", "ingest", "--path", "test.md", "--note", "test"],
        )
        with pytest.raises(SystemExit) as exc_info:
            wiki_log.main()
        assert exc_info.value.code == 2

    def test_missing_note_exits_with_error(
        self, monkeypatch, tmp_path
    ) -> None:
        """Missing ``--note`` triggers sys.exit(2)."""
        self._run_main(
            monkeypatch,
            tmp_path,
            ["--op", "ingest", "--path", "test.md", "--action", "create"],
        )
        with pytest.raises(SystemExit) as exc_info:
            wiki_log.main()
        assert exc_info.value.code == 2


# ── All valid enum values ────────────────────────────────────────────


class TestValidEnumValues:
    """Every valid ``--op`` and ``--action`` value works."""

    # ── 12. All 9 valid --op values ─────────────────────────────────

    @pytest.mark.parametrize(
        "op",
        [
            "ingest",
            "update",
            "delete",
            "query",
            "health",
            "lint",
            "heal",
            "refresh",
            "tool",
        ],
    )
    def test_all_valid_ops(self, op: str) -> None:
        """All valid ``--op`` values produce a correct entry."""
        result = wiki_log.add_entry(
            op, "concepts/test.md", "create", f"op {op}"
        )
        assert f"] {op} | " in result
        assert f" — op {op}" in result

        content = wiki_log.LOG_FILE.read_text(encoding="utf-8")
        assert result in content

    # ── 13. All 5 valid --action values ─────────────────────────────

    @pytest.mark.parametrize(
        "action",
        ["create", "edit", "delete", "pass", "fail"],
    )
    def test_all_valid_actions(self, action: str) -> None:
        """All valid ``--action`` values produce a correct entry."""
        result = wiki_log.add_entry(
            "ingest", "concepts/test.md", action, f"action {action}"
        )
        assert f" | {action} — " in result
        assert f" — action {action}" in result

        content = wiki_log.LOG_FILE.read_text(encoding="utf-8")
        assert result in content
