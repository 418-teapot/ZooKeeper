"""Tests for tools/_parser.py shared log parsing utilities.

All functions tested here are pure functions that process log files
in ZooKeeper's JSONL or opencode key=value formats.
"""

import os
import sys
from datetime import datetime
from pathlib import Path

import pytest

sys.path.insert(
    0, str(Path(__file__).resolve().parent.parent.parent / "tools")
)

from _parser import (
    list_sessions,
    parse_opencode_line,
    parse_opencode_log,
    parse_zoo_log,
    resolve_log_path,
    resolve_session_path,
)

# ── Helpers ──────────────────────────────────────────────────────────────────


def _write(path: Path, lines: list[str]) -> None:
    """Write lines to a file, each terminated by a newline.

    Args:
        path: Target file path.
        lines: List of lines to write. An empty list produces an empty file.
    """
    path.write_text(
        "\n".join(lines) + ("\n" if lines else ""), encoding="utf-8"
    )


# ── Tests: parse_zoo_log ────────────────────────────────────────────────────


class TestParseZooLog:
    """Tests for parse_zoo_log()."""

    def test_valid_jsonl(self, tmp_path: Path) -> None:
        """Parse a file with multiple valid JSON lines."""
        p = tmp_path / "events.jsonl"
        _write(p, ['{"event": "start"}', '{"event": "end", "duration": 1.5}'])
        result = parse_zoo_log(str(p))
        assert result == [
            {"event": "start"},
            {"event": "end", "duration": 1.5},
        ]

    def test_empty_file(self, tmp_path: Path) -> None:
        """Return an empty list for an empty file."""
        p = tmp_path / "empty.jsonl"
        _write(p, [])
        assert parse_zoo_log(str(p)) == []

    def test_file_not_found(self) -> None:
        """Raise FileNotFoundError when the file does not exist."""
        with pytest.raises(FileNotFoundError, match="Log file not found"):
            parse_zoo_log("/nonexistent/path/file.jsonl")

    def test_invalid_json(self, tmp_path: Path) -> None:
        """Skip bad JSON lines instead of raising."""
        p = tmp_path / "bad.jsonl"
        _write(p, ['{"valid": true}', "this is not json"])
        result = parse_zoo_log(str(p))
        assert result == [{"valid": True}]

    def test_skip_empty_lines(self, tmp_path: Path) -> None:
        """Skip blank lines and parse only non-empty lines."""
        p = tmp_path / "mixed.jsonl"
        _write(p, ['{"a": 1}', "", '{"b": 2}', "  ", ""])
        result = parse_zoo_log(str(p))
        assert result == [{"a": 1}, {"b": 2}]

    def test_whitespace_only_line(self, tmp_path: Path) -> None:
        """Whitespace-only lines are treated as empty and skipped."""
        p = tmp_path / "ws.jsonl"
        _write(p, ['{"a":1}', "   ", "\t", '{"b":2}'])
        result = parse_zoo_log(str(p))
        assert result == [{"a": 1}, {"b": 2}]


# ── Tests: parse_opencode_line ──────────────────────────────────────────────


class TestParseOpenCodeLine:
    """Tests for parse_opencode_line()."""

    def test_valid_line(self) -> None:
        """Parse a standard key=value log line with quoted value."""
        line = 'timestamp=2025-01-01 level=info msg="hello world"'
        result = parse_opencode_line(line)
        assert result == {
            "timestamp": "2025-01-01",
            "level": "info",
            "msg": "hello world",
        }

    def test_empty_line(self) -> None:
        """Return None for an empty string."""
        assert parse_opencode_line("") is None

    @pytest.mark.parametrize("line", ["   ", "\t", "  \t  "])
    def test_whitespace_only(self, line: str) -> None:
        """Return None for whitespace-only strings."""
        assert parse_opencode_line(line) is None

    def test_quoted_values(self) -> None:
        """Strip surrounding double quotes from values."""
        result = parse_opencode_line('name="John Doe" role="developer"')
        assert result == {"name": "John Doe", "role": "developer"}

    def test_dots_in_keys(self) -> None:
        """Replace dots in key names with underscores."""
        result = parse_opencode_line("session.id=abc123 event.type=click")
        assert result == {"session_id": "abc123", "event_type": "click"}

    def test_unparseable_line(self) -> None:
        """Return None for a line with unbalanced quotes (shlex failure)."""
        assert parse_opencode_line('key="unclosed quote') is None

    def test_no_equal_sign(self) -> None:
        """Return None when no token contains an '=' sign."""
        assert parse_opencode_line("just some words without equals") is None

    def test_mixed_tokens(self) -> None:
        """Skip tokens without '=' but still parse valid key=value tokens."""
        result = parse_opencode_line("dropme key=value alsoignore")
        assert result == {"key": "value"}

    def test_empty_value(self) -> None:
        """Handle keys with empty values (key=)."""
        result = parse_opencode_line("key= flag=")
        assert result == {"key": "", "flag": ""}

    def test_duplicate_key(self) -> None:
        """Last occurrence of a duplicate key wins."""
        result = parse_opencode_line("key=first key=second")
        assert result == {"key": "second"}

    def test_value_containing_equals(self) -> None:
        """Preserve '=' characters inside the value (partition splits on first)."""
        result = parse_opencode_line("key=value=with=equals")
        assert result == {"key": "value=with=equals"}

    def test_tokens_with_only_equals(self) -> None:
        """Handle degenerate token '=' (empty key and empty value)."""
        result = parse_opencode_line("= key=val")
        # partition splits "=" into ("", "=", "") so key="" and value=""
        assert "" in result  # empty-string key is present
        assert result["key"] == "val"


# ── Tests: parse_opencode_log ───────────────────────────────────────────────


class TestParseOpenCodeLog:
    """Tests for parse_opencode_log()."""

    def test_all_entries(self, tmp_path: Path) -> None:
        """Parse all valid entries from a log file."""
        p = tmp_path / "opencode.log"
        _write(
            p,
            [
                "timestamp=1 level=info session.id=s1 event=start",
                "timestamp=2 level=warn session.id=s2 event=done",
            ],
        )
        result = parse_opencode_log(str(p))
        assert len(result) == 2
        assert result[0]["session_id"] == "s1"
        assert result[1]["session_id"] == "s2"

    def test_filter_by_session_id(self, tmp_path: Path) -> None:
        """Return only entries matching the given session_id."""
        p = tmp_path / "opencode.log"
        _write(
            p,
            [
                "timestamp=1 session.id=s1 event=a",
                "timestamp=2 session.id=s2 event=b",
                "timestamp=3 session.id=s1 event=c",
            ],
        )
        result = parse_opencode_log(str(p), session_id="s1")
        assert len(result) == 2
        assert all(e["session_id"] == "s1" for e in result)

    def test_empty_file(self, tmp_path: Path) -> None:
        """Return an empty list for an empty file."""
        p = tmp_path / "empty.log"
        _write(p, [])
        assert parse_opencode_log(str(p)) == []

    def test_file_not_found(self) -> None:
        """Raise FileNotFoundError when the file does not exist."""
        with pytest.raises(FileNotFoundError, match="Log file not found"):
            parse_opencode_log("/nonexistent/file.log")

    def test_skip_unparseable_lines(self, tmp_path: Path) -> None:
        """Skip lines that fail to parse (e.g. unstructured text)."""
        p = tmp_path / "mixed.log"
        _write(p, ["key=value", "this is garbage", "key2=val2"])
        result = parse_opencode_log(str(p))
        assert result == [{"key": "value"}, {"key2": "val2"}]

    def test_no_session_id_match(self, tmp_path: Path) -> None:
        """Return empty list when no entries match the session_id."""
        p = tmp_path / "no_match.log"
        _write(p, ["session.id=s1 event=a"])
        result = parse_opencode_log(str(p), session_id="nonexistent")
        assert result == []

    def test_skip_no_key_value_lines(self, tmp_path: Path) -> None:
        """Lines without any key=value tokens are silently skipped."""
        p = tmp_path / "no_kv.log"
        _write(p, ["has=value", "plain text with no equals"])
        result = parse_opencode_log(str(p))
        assert result == [{"has": "value"}]


# ── Tests: resolve_log_path ─────────────────────────────────────────────────


class TestResolveLogPath:
    """Tests for resolve_log_path()."""

    def test_default_dir(self) -> None:
        """Use ~/.zoo/log as the default directory."""
        path = resolve_log_path("test-session")
        assert path.endswith("opencode-test-session.log")
        assert path.startswith(os.path.expanduser("~/.zoo/log"))

    def test_custom_dir(self) -> None:
        """Use a custom log directory."""
        path = resolve_log_path("mysession", "/custom/path")
        assert path == os.path.join("/custom/path", "opencode-mysession.log")

    def test_expands_user(self) -> None:
        """Expand user home directory in the log_dir."""
        path = resolve_log_path("s1", "~/logs")
        assert path == os.path.join(
            os.path.expanduser("~/logs"), "opencode-s1.log"
        )

    def test_session_id_with_special_chars(self) -> None:
        """Session IDs with dots or dashes are used as-is in the filename."""
        path = resolve_log_path("session-v2.1")
        assert path.endswith("opencode-session-v2.1.log")


# ── Tests: list_sessions ────────────────────────────────────────────────────


class TestListSessions:
    """Tests for list_sessions()."""

    def test_empty_dir(self, tmp_path: Path) -> None:
        """Return empty list for an empty directory."""
        assert list_sessions(str(tmp_path)) == []

    def test_dir_with_matching_files(self, tmp_path: Path) -> None:
        """Return session info for matching opencode-*.log files."""
        (tmp_path / "opencode-s1.log").write_text(
            '{"event": "a"}\n{"event": "b"}\n', encoding="utf-8"
        )
        (tmp_path / "opencode-s2.log").write_text(
            '{"event": "c"}\n', encoding="utf-8"
        )
        # A non-matching file that should be ignored
        (tmp_path / "other.log").write_text("data\n", encoding="utf-8")

        sessions = list_sessions(str(tmp_path))
        assert len(sessions) == 2

        ids = {s["session_id"] for s in sessions}
        assert ids == {"s1", "s2"}

        for s in sessions:
            assert "path" in s
            assert "size" in s
            assert "mtime" in s
            assert "event_count" in s
            assert isinstance(s["mtime"], datetime)

        by_id = {s["session_id"]: s for s in sessions}
        assert by_id["s1"]["event_count"] == 2
        assert by_id["s2"]["event_count"] == 1

    def test_dir_without_matching_files(self, tmp_path: Path) -> None:
        """Return empty list when no files match the opencode-*.log pattern."""
        (tmp_path / "random.log").write_text("data\n", encoding="utf-8")
        (tmp_path / "notes.txt").write_text("hello\n", encoding="utf-8")
        assert list_sessions(str(tmp_path)) == []

    def test_dir_not_exist(self) -> None:
        """Return empty list when the directory does not exist."""
        assert list_sessions("/nonexistent/directory/path") == []

    def test_empty_files(self, tmp_path: Path) -> None:
        """Handle empty opencode-*.log files (event_count = 0)."""
        (tmp_path / "opencode-empty.log").write_text("", encoding="utf-8")
        sessions = list_sessions(str(tmp_path))
        assert len(sessions) == 1
        assert sessions[0]["session_id"] == "empty"
        assert sessions[0]["event_count"] == 0

    def test_whitespace_only_lines_not_counted(self, tmp_path: Path) -> None:
        """Whitespace-only lines are not counted toward event_count."""
        (tmp_path / "opencode-whitespace.log").write_text(
            "  \n\t\n\n", encoding="utf-8"
        )
        sessions = list_sessions(str(tmp_path))
        assert sessions[0]["event_count"] == 0

    def test_files_sorted(self, tmp_path: Path) -> None:
        """Sessions are returned in sorted order by filename."""
        for sid in ["z", "a", "m"]:
            (tmp_path / f"opencode-{sid}.log").write_text(
                "x=1\n", encoding="utf-8"
            )
        sessions = list_sessions(str(tmp_path))
        assert [s["session_id"] for s in sessions] == ["a", "m", "z"]

    def test_subdirectories_ignored(self, tmp_path: Path) -> None:
        """Subdirectories matching the pattern are skipped (isfile check)."""
        (tmp_path / "opencode-subdir.log").mkdir()
        sessions = list_sessions(str(tmp_path))
        assert len(sessions) == 0


# ── Tests: resolve_session_path ─────────────────────────────────────────────


class TestResolveSessionPath:
    """Tests for resolve_session_path()."""

    def test_unique_match(self, tmp_path: Path) -> None:
        """Return the full path when exactly one file matches."""
        (tmp_path / "opencode-session-123.log").write_text(
            "data\n", encoding="utf-8"
        )
        result = resolve_session_path("session-123", str(tmp_path))
        expected = str(tmp_path / "opencode-session-123.log")
        assert result == expected

    def test_no_match(self, tmp_path: Path) -> None:
        """Return None when no file matches the session_id."""
        (tmp_path / "opencode-other.log").write_text(
            "data\n", encoding="utf-8"
        )
        assert resolve_session_path("nonexistent", str(tmp_path)) is None

    def test_ambiguous_match(self, tmp_path: Path) -> None:
        """Return None when multiple files match the session prefix."""
        (tmp_path / "opencode-s1.log").write_text("data\n", encoding="utf-8")
        (tmp_path / "opencode-s1-extra.log").write_text(
            "data\n", encoding="utf-8"
        )
        assert resolve_session_path("s1", str(tmp_path)) is None

    def test_dir_not_exist(self) -> None:
        """Return None when the log directory does not exist."""
        assert resolve_session_path("s1", "/nonexistent/path") is None

    def test_basename_stripping(self, tmp_path: Path) -> None:
        """Strip directory prefix from session_id (basename only)."""
        (tmp_path / "opencode-myid.log").write_text("data\n", encoding="utf-8")
        result = resolve_session_path(
            os.path.join("some", "dir", "myid"), str(tmp_path)
        )
        expected = str(tmp_path / "opencode-myid.log")
        assert result == expected

    def test_prefix_matching(self, tmp_path: Path) -> None:
        """Match session_id as a prefix (not exact)."""
        (tmp_path / "opencode-build-abc-123.log").write_text(
            "data\n", encoding="utf-8"
        )
        result = resolve_session_path("build-abc", str(tmp_path))
        assert result == str(tmp_path / "opencode-build-abc-123.log")

    def test_ambiguous_prefix_collision(self, tmp_path: Path) -> None:
        """Return None when prefix matches multiple files."""
        (tmp_path / "opencode-build-a.log").write_text(
            "data\n", encoding="utf-8"
        )
        (tmp_path / "opencode-build-ab.log").write_text(
            "data\n", encoding="utf-8"
        )
        assert resolve_session_path("build-a", str(tmp_path)) is None
