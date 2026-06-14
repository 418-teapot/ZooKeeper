"""Unit tests for tools/_trace_builder.py — pure-function tests.

All tests are zero-LLM-cost, no external file dependencies.
File-based tests use tmp_path fixtures to avoid touching real logs.
"""

from __future__ import annotations

import sys
from pathlib import Path

# tools/ is not on sys.path during test runs
sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "tools"))


import pytest  # noqa: E402

from _trace_builder import (  # noqa: E402
    _build_session_agents,
    _build_session_agents_from_entries,
    _classify_opencode,
    _classify_zoo,
    _discover_child_sessions_from_entries,
    _group_entries_by_session,
    _normalize_timestamp,
    _parse_opencode_all,
    _parse_opencode_multi_session,
    _tool_type_and_icon,
    build_stats,
)

# ── Fixtures ─────────────────────────────────────────────────────────────


@pytest.fixture
def sample_entries() -> list[dict]:
    """Return a reusable list of parsed opencode log entries."""
    return [
        {
            "message": "created",
            "id": "root-session",
            "run": "run-root",
            "slug": "main",
            "agent": "build",
            "model_id": "gpt-4",
            "model_providerID": "openai",
            "title": "Root session",
            "parent_id": "",
            "timestamp": "2024-01-01T00:00:00Z",
        },
        {
            "message": "created",
            "id": "child-a",
            "run": "run-child-a",
            "slug": "sub",
            "agent": "explore",
            "parentID": "root-session",
            "timestamp": "2024-01-01T00:01:00Z",
        },
        {
            "message": "created",
            "id": "child-b",
            "run": "run-child-b",
            "slug": "sub2",
            "agent": "general",
            "parent_id": "root-session",
            "timestamp": "2024-01-01T00:02:00Z",
        },
        {
            "message": "created",
            "id": "grandchild",
            "run": "run-grandchild",
            "slug": "deep",
            "agent": "spider",
            "parentID": "child-a",
            "timestamp": "2024-01-01T00:03:00Z",
        },
        {
            "message": "loop",
            "step": "1",
            "session_id": "root-session",
            "timestamp": "2024-01-01T00:04:00Z",
        },
        {
            "message": "evaluated",
            "permission": "read",
            "pattern": "src/main.py",
            "action_action": "allow",
            "session_id": "root-session",
            "run": "run-root",
            "timestamp": "2024-01-01T00:05:00Z",
        },
        {
            "message": "evaluated",
            "permission": "bash",
            "pattern": "ls -la",
            "action_action": "deny",
            "session_id": "child-a",
            "run": "run-child-a",
            "timestamp": "2024-01-01T00:06:00Z",
        },
    ]


# ── _normalize_timestamp ─────────────────────────────────────────────────


class TestNormalizeTimestamp:
    """Tests for ``_normalize_timestamp()``."""

    @pytest.mark.parametrize(
        ("ts", "expected"),
        [
            ("", ""),
            ("2024-01-01T00:00:00Z", "2024-01-01T00:00:00Z"),
            (
                "2024-01-01T00:00:00",
                "2024-01-01T00:00:00.000000Z",
            ),
            (
                "2024-06-15T12:30:45.123456",
                "2024-06-15T12:30:45.123456Z",
            ),
        ],
    )
    def test_valid_normalization(self, ts: str, expected: str) -> None:
        """Verify timestamps are normalized to Z-suffixed ISO 8601."""
        assert _normalize_timestamp(ts) == expected

    def test_invalid_format_returns_as_is(self) -> None:
        """Invalid timestamps that cannot be parsed are returned unchanged."""
        assert _normalize_timestamp("not-a-date") == "not-a-date"
        assert _normalize_timestamp("2024/01/01") == "2024/01/01"
        assert _normalize_timestamp("garbage!!!") == "garbage!!!"


# ── _tool_type_and_icon ──────────────────────────────────────────────────


class TestToolTypeAndIcon:
    """Tests for ``_tool_type_and_icon()``."""

    @pytest.mark.parametrize(
        ("permission", "expected_type", "expected_icon"),
        [
            ("read", "tool_read", "■"),
            ("grep", "tool_read", "■"),
            ("glob", "tool_read", "■"),
            ("edit", "tool_write", "■"),
            ("write", "tool_write", "■"),
            ("bash", "tool_exec", "■"),
            ("task", "tool_orch", "◈"),
            ("webfetch", "tool_other", "■"),
            ("websearch", "tool_other", "■"),
            ("unknown_tool", "tool_other", "■"),
            ("", "tool_other", "■"),
        ],
    )
    def test_mapping(
        self, permission: str, expected_type: str, expected_icon: str
    ) -> None:
        """Verify permission string maps to correct type and icon."""
        type_, icon = _tool_type_and_icon(permission)
        assert type_ == expected_type
        assert icon == expected_icon


# ── _classify_opencode ───────────────────────────────────────────────────


class TestClassifyOpencode:
    """Tests for ``_classify_opencode()``."""

    def test_created_session(self) -> None:
        """message=created yields type=session with full detail."""
        entry = {
            "message": "created",
            "id": "sess-1",
            "slug": "build-agent",
            "agent": "build",
            "model_id": "claude-3",
            "model_providerID": "anthropic",
            "title": "Build Agent Session",
            "parent_id": "",
            "projectID": "proj-123",
            "cost": "0.05",
            "tokens_input": "500",
            "tokens_output": "300",
            "timestamp": "2024-01-01T00:00:00Z",
        }
        ev = _classify_opencode(entry)
        assert ev is not None
        assert ev["type"] == "session"
        assert ev["source"] == "opencode"
        assert ev["icon"] == "◆"
        # When parts list is non-empty, summary uses slug+parts format (no title)
        assert "build-agent" in ev["summary"]
        assert "claude-3" in ev["summary"]
        assert ev["detail"]["id"] == "sess-1"
        assert ev["detail"]["agent"] == "build"
        assert ev["detail"]["model_id"] == "claude-3"
        assert ev["detail"]["model_provider"] == "anthropic"
        assert ev["detail"]["project_id"] == "proj-123"
        assert ev["detail"]["cost"] == "0.05"
        assert ev["detail"]["tokens_input"] == "500"
        assert ev["detail"]["tokens_output"] == "300"

    def test_created_session_no_title(self) -> None:
        """When title equals slug the summary is simplified."""
        entry = {
            "message": "created",
            "id": "sess-2",
            "slug": "minimal",
            "timestamp": "2024-01-01T00:00:00Z",
        }
        ev = _classify_opencode(entry)
        assert ev is not None
        assert ev["type"] == "session"
        assert "minimal" in ev["summary"]

    def test_created_session_no_parts(self) -> None:
        """When slug/agent/model are all empty the summary is short."""
        entry = {
            "message": "created",
            "id": "sess-3",
            "timestamp": "2024-01-01T00:00:00Z",
        }
        ev = _classify_opencode(entry)
        assert ev is not None
        assert ev["type"] == "session"
        assert ev["detail"]["slug"] == ""
        assert ev["detail"]["agent"] == ""

    def test_loop_step(self) -> None:
        """message=loop yields type=session with step detail."""
        entry = {
            "message": "loop",
            "step": "3",
            "session_id": "sess-1",
            "timestamp": "2024-01-01T00:01:00Z",
        }
        ev = _classify_opencode(entry)
        assert ev is not None
        assert ev["type"] == "session"
        assert ev["icon"] == "◆"
        assert ev["summary"] == "Loop step=3"
        assert ev["detail"]["step"] == "3"

    def test_process_message(self) -> None:
        """message=process yields type=session with message_id."""
        entry = {
            "message": "process",
            "messageID": "msg-42",
            "session_id": "sess-1",
            "timestamp": "2024-01-01T00:02:00Z",
        }
        ev = _classify_opencode(entry)
        assert ev is not None
        assert ev["type"] == "session"
        assert ev["icon"] == "💬"
        assert ev["summary"] == "Process message"
        assert ev["detail"]["message_id"] == "msg-42"

    def test_exiting_loop(self) -> None:
        """message='exiting loop' yields type=session."""
        entry = {
            "message": "exiting loop",
            "session_id": "sess-1",
            "timestamp": "2024-01-01T00:03:00Z",
        }
        ev = _classify_opencode(entry)
        assert ev is not None
        assert ev["type"] == "session"
        assert ev["summary"] == "Exiting loop"

    def test_llm_runtime_selected(self) -> None:
        """message='llm runtime selected' yields type=llm with provider/model."""
        entry = {
            "message": "llm runtime selected",
            "llm_provider": "openai",
            "llm_model": "gpt-4o",
            "llm_runtime": "openai-2024",
            "timestamp": "2024-01-01T00:04:00Z",
        }
        ev = _classify_opencode(entry)
        assert ev is not None
        assert ev["type"] == "llm"
        assert ev["icon"] == "▲"
        assert "openai/gpt-4o" in ev["summary"]
        assert ev["detail"]["provider"] == "openai"
        assert ev["detail"]["model"] == "gpt-4o"
        assert ev["detail"]["runtime"] == "openai-2024"

    def test_llm_runtime_selected_missing_fields(self) -> None:
        """Missing llm fields default to '?'."""
        entry = {
            "message": "llm runtime selected",
            "timestamp": "2024-01-01T00:04:00Z",
        }
        ev = _classify_opencode(entry)
        assert ev is not None
        assert ev["type"] == "llm"
        assert ev["detail"]["provider"] == "?"
        assert ev["detail"]["model"] == "?"

    def test_stream(self) -> None:
        """message=stream yields type=llm_stream with provider/model/agent/mode."""
        entry = {
            "message": "stream",
            "providerID": "anthropic",
            "modelID": "claude-opus",
            "agent": "build",
            "mode": "full",
            "timestamp": "2024-01-01T00:05:00Z",
        }
        ev = _classify_opencode(entry)
        assert ev is not None
        assert ev["type"] == "llm_stream"
        assert ev["icon"] == "▲"
        assert "anthropic/claude-opus" in ev["summary"]
        assert "agent=build" in ev["summary"]
        assert ev["detail"]["mode"] == "full"

    def test_stream_missing_fields(self) -> None:
        """Missing stream fields default to '?'."""
        entry = {
            "message": "stream",
            "timestamp": "2024-01-01T00:05:00Z",
        }
        ev = _classify_opencode(entry)
        assert ev is not None
        assert ev["type"] == "llm_stream"
        assert ev["detail"]["provider"] == "?"
        assert ev["detail"]["model"] == "?"
        assert ev["detail"]["agent"] == "?"
        assert ev["detail"]["mode"] == "?"

    def test_evaluated_deny(self) -> None:
        """evaluated + action=deny yields type=permission."""
        entry = {
            "message": "evaluated",
            "permission": "bash",
            "pattern": "rm -rf /",
            "action_action": "deny",
            "session_id": "sess-1",
            "timestamp": "2024-01-01T00:06:00Z",
        }
        ev = _classify_opencode(entry)
        assert ev is not None
        assert ev["type"] == "permission"
        assert ev["icon"] == "▼"
        assert "deny" in ev["summary"]

    def test_evaluated_allow_read(self) -> None:
        """evaluated + allow + read permission yields type=tool_read."""
        entry = {
            "message": "evaluated",
            "permission": "read",
            "pattern": "src/main.py",
            "action_action": "allow",
            "session_id": "sess-1",
            "timestamp": "2024-01-01T00:07:00Z",
        }
        ev = _classify_opencode(entry)
        assert ev is not None
        assert ev["type"] == "tool_read"
        assert ev["icon"] == "■"

    def test_evaluated_allow_edit(self) -> None:
        """evaluated + allow + edit permission yields type=tool_write."""
        entry = {
            "message": "evaluated",
            "permission": "edit",
            "pattern": "src/main.py",
            "action_action": "allow",
            "session_id": "sess-1",
            "timestamp": "2024-01-01T00:08:00Z",
        }
        ev = _classify_opencode(entry)
        assert ev is not None
        assert ev["type"] == "tool_write"

    def test_evaluated_allow_task(self) -> None:
        """evaluated + allow + task permission yields type=tool_orch."""
        entry = {
            "message": "evaluated",
            "permission": "task",
            "pattern": "delegate to subagent",
            "action_action": "allow",
            "session_id": "sess-1",
            "timestamp": "2024-01-01T00:09:00Z",
        }
        ev = _classify_opencode(entry)
        assert ev is not None
        assert ev["type"] == "tool_orch"
        assert ev["icon"] == "◈"

    def test_evaluated_allow_unknown(self) -> None:
        """evaluated + allow + unknown permission yields type=tool_other."""
        entry = {
            "message": "evaluated",
            "permission": "webfetch",
            "pattern": "https://example.com",
            "action_action": "allow",
            "timestamp": "2024-01-01T00:10:00Z",
        }
        ev = _classify_opencode(entry)
        assert ev is not None
        assert ev["type"] == "tool_other"

    def test_evaluated_default_action(self) -> None:
        """evaluated without action_action defaults to tool classification."""
        entry = {
            "message": "evaluated",
            "permission": "bash",
            "pattern": "echo hi",
            "timestamp": "2024-01-01T00:11:00Z",
        }
        ev = _classify_opencode(entry)
        assert ev is not None
        # action_action defaults to '?', which is not "deny", so tool type
        assert ev["type"] == "tool_exec"
        assert ev["detail"]["action"] == "?"

    def test_touching_file(self) -> None:
        """message='touching file' yields type=file with path and action."""
        entry = {
            "message": "touching file",
            "file": "src/main.py",
            "action": "edit",
            "timestamp": "2024-01-01T00:12:00Z",
        }
        ev = _classify_opencode(entry)
        assert ev is not None
        assert ev["type"] == "file"
        assert ev["icon"] == "■"
        assert "src/main.py" in ev["summary"]
        assert ev["detail"]["file"] == "src/main.py"
        assert ev["detail"]["action"] == "edit"

    def test_touching_file_default_action(self) -> None:
        """'touching file' defaults action to 'edit' when missing."""
        entry = {
            "message": "touching file",
            "file": "README.md",
            "timestamp": "2024-01-01T00:13:00Z",
        }
        ev = _classify_opencode(entry)
        assert ev is not None
        assert ev["type"] == "file"
        assert ev["detail"]["action"] == "edit"

    def test_unknown_message_fallback(self) -> None:
        """An unrecognized message yields type=hook with the full entry as detail."""
        entry = {
            "message": "some_random_event",
            "custom_field": "value",
            "timestamp": "2024-01-01T00:14:00Z",
        }
        ev = _classify_opencode(entry)
        assert ev is not None
        assert ev["type"] == "hook"
        assert ev["source"] == "opencode"
        assert ev["icon"] == "◈"
        assert "some_random_event" in ev["summary"]
        # detail contains the full entry
        assert ev["detail"]["custom_field"] == "value"
        assert ev["detail"]["message"] == "some_random_event"

    def test_missing_message_fallback(self) -> None:
        """An entry with no 'message' key still produces a fallback hook event."""
        entry = {"some_key": "value", "timestamp": "2024-01-01T00:15:00Z"}
        ev = _classify_opencode(entry)
        assert ev is not None
        assert ev["type"] == "hook"
        assert ev["summary"] == "opencode event"

    def test_timestamp_normalized(self) -> None:
        """Timestamps without Z suffix are normalized."""
        entry = {
            "message": "loop",
            "step": "1",
            "timestamp": "2024-01-01T00:00:00",
        }
        ev = _classify_opencode(entry)
        assert ev is not None
        assert ev["timestamp"].endswith("Z")

    def test_empty_timestamp(self) -> None:
        """Empty timestamp returns empty string."""
        entry = {
            "message": "loop",
            "step": "1",
            "timestamp": "",
        }
        ev = _classify_opencode(entry)
        assert ev is not None
        assert ev["timestamp"] == ""


# ── _classify_zoo ────────────────────────────────────────────────────────


class TestClassifyZoo:
    """Tests for ``_classify_zoo()``."""

    def test_normal_entry(self) -> None:
        """A normal ZooKeeper log entry is classified as hook with source=zoo."""
        entry = {
            "hook": "task-prompt-validate",
            "event": "trigger",
            "level": "info",
            "timestamp": "2024-01-01T00:00:00Z",
            "extra": "data",
        }
        ev = _classify_zoo(entry)
        assert ev is not None
        assert ev["source"] == "zoo"
        assert ev["type"] == "hook"
        assert ev["icon"] == "◈"
        assert ev["summary"] == "task-prompt-validate/trigger"
        assert ev["level"] == "info"
        assert ev["detail"]["extra"] == "data"
        assert ev["detail"]["hook"] == "task-prompt-validate"

    def test_missing_fields(self) -> None:
        """Missing hook/event fields default to '?' and level to 'info'."""
        entry = {"timestamp": "2024-01-01T00:00:00Z"}
        ev = _classify_zoo(entry)
        assert ev is not None
        assert ev["type"] == "hook"
        assert ev["summary"] == "?/?"
        assert ev["level"] == "info"
        # detail is dict(entry); missing keys do not appear in it
        assert "hook" not in ev["detail"]
        assert "event" not in ev["detail"]

    def test_timestamp_normalized(self) -> None:
        """Timestamps without Z are normalized."""
        entry = {
            "hook": "test",
            "event": "done",
            "timestamp": "2024-06-01T12:00:00",
        }
        ev = _classify_zoo(entry)
        assert ev is not None
        assert ev["timestamp"].endswith("Z")


# ── _parse_opencode_multi_session ────────────────────────────────────────


class TestParseOpencodeMultiSession:
    """Tests for ``_parse_opencode_multi_session()`` (file-based)."""

    def test_file_not_found(self) -> None:
        """Non-existent file raises FileNotFoundError."""
        with pytest.raises(FileNotFoundError):
            _parse_opencode_multi_session("/nonexistent/path.log", {"sess-1"})

    def test_empty_sids(self, tmp_path: Path) -> None:
        """An empty set of session IDs returns an empty dict."""
        log_file = tmp_path / "opencode.log"
        log_file.write_text(
            "timestamp=2024-01-01T00:00:00Z message=created id=sess-1 slug=main\n"
        )
        result = _parse_opencode_multi_session(str(log_file), set())
        assert result == {}

    def test_multiple_sessions_grouped(self, tmp_path: Path) -> None:
        """Entries are correctly grouped by session_id."""
        log_file = tmp_path / "opencode.log"
        log_file.write_text(
            "timestamp=2024-01-01T00:00:00Z message=created id=sess-a slug=a\n"
            "timestamp=2024-01-01T00:01:00Z message=loop step=1 session_id=sess-a\n"
            "timestamp=2024-01-01T00:02:00Z message=created id=sess-b slug=b\n"
            "timestamp=2024-01-01T00:03:00Z message=loop step=1 session_id=sess-b\n"
        )
        result = _parse_opencode_multi_session(str(log_file), {"sess-a", "sess-b"})
        assert len(result) == 2
        assert len(result["sess-a"]) == 2
        assert len(result["sess-b"]) == 2

    def test_run_based_mapping(self, tmp_path: Path) -> None:
        """Evaluated lines without session_id are mapped via run field."""
        log_file = tmp_path / "opencode.log"
        log_file.write_text(
            "timestamp=2024-01-01T00:00:00Z message=created id=sess-a run=run-a\n"
            "timestamp=2024-01-01T00:01:00Z message=evaluated permission=read "
            "pattern=foo run=run-a\n"
        )
        result = _parse_opencode_multi_session(str(log_file), {"sess-a"})
        assert len(result["sess-a"]) == 2

    def test_unmatched_sids_have_empty_list(self, tmp_path: Path) -> None:
        """Session IDs not present in the log get an empty list."""
        log_file = tmp_path / "opencode.log"
        log_file.write_text(
            "timestamp=2024-01-01T00:00:00Z message=created id=sess-a slug=a\n"
        )
        result = _parse_opencode_multi_session(
            str(log_file), {"sess-a", "sess-missing"}
        )
        assert len(result["sess-a"]) == 1
        assert result["sess-missing"] == []


# ── _build_session_agents ────────────────────────────────────────────────


class TestBuildSessionAgents:
    """Tests for ``_build_session_agents()`` (file-based)."""

    def test_file_not_found(self) -> None:
        """Non-existent file returns {}."""
        result = _build_session_agents("/nonexistent/path.log", {"sess-1"})
        assert result == {}

    def test_empty_session_ids(self, tmp_path: Path) -> None:
        """An empty set of session IDs returns {}."""
        log_file = tmp_path / "opencode.log"
        log_file.write_text(
            "timestamp=2024-01-01T00:00:00Z message=created id=sess-1 agent=build\n"
        )
        result = _build_session_agents(str(log_file), set())
        assert result == {}

    def test_agent_field(self, tmp_path: Path) -> None:
        """Agent is taken from the 'agent' field when available."""
        log_file = tmp_path / "opencode.log"
        log_file.write_text(
            "timestamp=2024-01-01T00:00:00Z message=created id=sess-1 agent=build\n"
        )
        result = _build_session_agents(str(log_file), {"sess-1"})
        assert result == {"sess-1": "build"}

    def test_fallback_to_slug(self, tmp_path: Path) -> None:
        """When agent is empty, slug is used as fallback."""
        log_file = tmp_path / "opencode.log"
        log_file.write_text(
            "timestamp=2024-01-01T00:00:00Z message=created id=sess-1 slug=my-agent\n"
        )
        result = _build_session_agents(str(log_file), {"sess-1"})
        assert result == {"sess-1": "my-agent"}

    def test_not_in_session_ids(self, tmp_path: Path) -> None:
        """Entries with IDs not in session_ids set are ignored."""
        log_file = tmp_path / "opencode.log"
        log_file.write_text(
            "timestamp=2024-01-01T00:00:00Z message=created id=sess-1 agent=build\n"
            "timestamp=2024-01-01T00:01:00Z message=created id=sess-2 agent=explore\n"
        )
        result = _build_session_agents(str(log_file), {"sess-1"})
        assert result == {"sess-1": "build"}

    def test_non_created_messages_ignored(self, tmp_path: Path) -> None:
        """Only message=created lines are considered."""
        log_file = tmp_path / "opencode.log"
        log_file.write_text(
            "timestamp=2024-01-01T00:00:00Z message=created id=sess-1 agent=build\n"
            "timestamp=2024-01-01T00:01:00Z message=loop step=1 session_id=sess-1\n"
        )
        result = _build_session_agents(str(log_file), {"sess-1"})
        assert result == {"sess-1": "build"}

    def test_empty_agent_and_slug(self, tmp_path: Path) -> None:
        """When both agent and slug are empty, value is empty string."""
        log_file = tmp_path / "opencode.log"
        log_file.write_text(
            "timestamp=2024-01-01T00:00:00Z message=created id=sess-1\n"
        )
        result = _build_session_agents(str(log_file), {"sess-1"})
        assert result == {"sess-1": ""}


# ── _parse_opencode_all ──────────────────────────────────────────────────


class TestParseOpencodeAll:
    """Tests for ``_parse_opencode_all()`` (file-based)."""

    def test_file_not_found(self) -> None:
        """Non-existent file raises FileNotFoundError."""
        with pytest.raises(FileNotFoundError):
            _parse_opencode_all("/nonexistent/path.log")

    def test_all_entries_parsed(self, tmp_path: Path) -> None:
        """All parseable lines are returned."""
        log_file = tmp_path / "opencode.log"
        log_file.write_text(
            "timestamp=2024-01-01T00:00:00Z message=created id=sess-1\n"
            "timestamp=2024-01-01T00:01:00Z message=loop step=1\n"
            "unparseable line here\n"
        )
        entries = _parse_opencode_all(str(log_file))
        assert len(entries) == 2

    def test_empty_file(self, tmp_path: Path) -> None:
        """An empty log file returns an empty list."""
        log_file = tmp_path / "empty.log"
        log_file.write_text("")
        entries = _parse_opencode_all(str(log_file))
        assert entries == []


# ── _discover_child_sessions_from_entries ────────────────────────────────


class TestDiscoverChildSessionsFromEntries:
    """Tests for ``_discover_child_sessions_from_entries()``."""

    def test_no_children(self, sample_entries: list[dict]) -> None:
        """An entry without children yields only root (depth 0)."""
        result = _discover_child_sessions_from_entries(sample_entries, "orphan")
        assert result == [("orphan", 0)]

    def test_direct_child(self, sample_entries: list[dict]) -> None:
        """Direct child of root appears at depth 1."""
        result = _discover_child_sessions_from_entries(sample_entries, "root-session")
        sids = {sid for sid, _ in result}
        assert "child-a" in sids
        assert "child-b" in sids
        for sid, depth in result:
            if sid == "child-a":
                assert depth == 1
            if sid == "child-b":
                assert depth == 1

    def test_grandchild(self, sample_entries: list[dict]) -> None:
        """Grandchild appears at depth 2."""
        result = _discover_child_sessions_from_entries(sample_entries, "root-session")
        for sid, depth in result:
            if sid == "grandchild":
                assert depth == 2

    def test_bfs_includes_root(self, sample_entries: list[dict]) -> None:
        """Root session is first in the result list with depth 0."""
        result = _discover_child_sessions_from_entries(sample_entries, "root-session")
        assert result[0] == ("root-session", 0)

    def test_circular_reference_protection(self, sample_entries: list[dict]) -> None:
        """Circular parentID references are handled via visited set."""
        entries = list(sample_entries)
        # Add a circular reference: child-a's parent is grandchild
        entries.append(
            {
                "message": "created",
                "id": "loop-back",
                "parentID": "grandchild",
            }
        )
        entries.append(
            {
                "message": "created",
                "id": "child-a",
                "parentID": "loop-back",
            }
        )
        result = _discover_child_sessions_from_entries(entries, "root-session")
        # Should not infinite-loop; check root, children, grandchild found
        sids = {sid for sid, _ in result}
        assert "root-session" in sids
        assert "child-a" in sids
        assert "grandchild" in sids

    def test_no_parentid_ignored(self) -> None:
        """Entries without parentID are not treated as children."""
        entries = [
            {
                "message": "created",
                "id": "root",
            },
            {
                "message": "created",
                "id": "orphan",
            },
        ]
        result = _discover_child_sessions_from_entries(entries, "root")
        assert result == [("root", 0)]

    def test_parentid_undefined_ignored(self) -> None:
        """Entries with parentID='undefined' are not treated as children."""
        entries = [
            {
                "message": "created",
                "id": "root",
            },
            {
                "message": "created",
                "id": "child",
                "parentID": "undefined",
            },
        ]
        result = _discover_child_sessions_from_entries(entries, "root")
        assert result == [("root", 0)]

    def test_parent_id_fallback(self) -> None:
        """Uses parent_id as fallback when parentID is absent."""
        entries = [
            {
                "message": "created",
                "id": "root",
            },
            {
                "message": "created",
                "id": "child",
                "parent_id": "root",
            },
        ]
        result = _discover_child_sessions_from_entries(entries, "root")
        assert ("child", 1) in result

    def test_empty_entries(self) -> None:
        """An empty entries list yields only the root."""
        result = _discover_child_sessions_from_entries([], "root")
        assert result == [("root", 0)]

    def test_only_created_messages_considered(self) -> None:
        """Non-created messages are ignored in parent-child mapping."""
        entries = [
            {"message": "created", "id": "root"},
            {"message": "loop", "id": "child", "parentID": "root"},
        ]
        result = _discover_child_sessions_from_entries(entries, "root")
        assert result == [("root", 0)]

    def test_entry_without_id_skipped(self) -> None:
        """Created entries without an 'id' field are skipped."""
        entries = [
            {"message": "created", "id": "root"},
            {"message": "created", "parentID": "root"},
        ]
        result = _discover_child_sessions_from_entries(entries, "root")
        assert result == [("root", 0)]


# ── _build_session_agents_from_entries ───────────────────────────────────


class TestBuildSessionAgentsFromEntries:
    """Tests for ``_build_session_agents_from_entries()``."""

    def test_normal(self, sample_entries: list[dict]) -> None:
        """Agent from agent field, fallback to slug."""
        result = _build_session_agents_from_entries(
            sample_entries, {"root-session", "child-a"}
        )
        assert result["root-session"] == "build"
        assert result["child-a"] == "explore"

    def test_not_in_sids(self, sample_entries: list[dict]) -> None:
        """Sessions not in the set are excluded."""
        result = _build_session_agents_from_entries(sample_entries, {"root-session"})
        assert "child-a" not in result

    def test_empty_sids(self, sample_entries: list[dict]) -> None:
        """Empty session_ids returns {}."""
        result = _build_session_agents_from_entries(sample_entries, set())
        assert result == {}

    def test_only_created_messages(self, sample_entries: list[dict]) -> None:
        """Non-created messages are ignored."""
        result = _build_session_agents_from_entries(sample_entries, {"root-session"})
        assert result == {"root-session": "build"}

    def test_fallback_to_slug(self) -> None:
        """Missing agent falls back to slug."""
        entries = [{"message": "created", "id": "sess-1", "slug": "my-agent"}]
        result = _build_session_agents_from_entries(entries, {"sess-1"})
        assert result["sess-1"] == "my-agent"

    def test_empty_agent_and_slug(self) -> None:
        """Missing both agent and slug yields empty string."""
        entries = [{"message": "created", "id": "sess-1"}]
        result = _build_session_agents_from_entries(entries, {"sess-1"})
        assert result["sess-1"] == ""


# ── _group_entries_by_session ────────────────────────────────────────────


class TestGroupEntriesBySession:
    """Tests for ``_group_entries_by_session()``."""

    def test_empty_sids(self, sample_entries: list[dict]) -> None:
        """Empty sids set returns {}."""
        result = _group_entries_by_session(sample_entries, set())
        assert result == {}

    def test_normal_grouping(self, sample_entries: list[dict]) -> None:
        """Entries are correctly grouped by session_id/id."""
        result = _group_entries_by_session(sample_entries, {"root-session", "child-a"})
        assert "root-session" in result
        assert "child-a" in result
        # root-session should have: created + loop + evaluated
        assert len(result["root-session"]) == 3
        # child-a should have: created + evaluated (bash deny)
        assert len(result["child-a"]) == 2

    def test_not_matching_excluded(self) -> None:
        """Entries not matching any sid are excluded."""
        entries = [
            {"message": "created", "id": "sess-1"},
            {"message": "loop", "session_id": "sess-2"},
        ]
        result = _group_entries_by_session(entries, {"sess-1"})
        assert len(result["sess-1"]) == 1
        assert "sess-2" not in result

    def test_run_based_mapping(self) -> None:
        """Evaluated lines without session_id are mapped via run field."""
        entries = [
            {"message": "created", "id": "sess-1", "run": "run-1"},
            {
                "message": "evaluated",
                "permission": "read",
                "pattern": "foo",
                "run": "run-1",
            },
            {
                "message": "evaluated",
                "permission": "bash",
                "pattern": "bar",
                "run": "run-2",
            },
        ]
        result = _group_entries_by_session(entries, {"sess-1"})
        # run-1 maps to sess-1, run-2 does not
        assert len(result["sess-1"]) == 2

    def test_include_all_matching_sids(self) -> None:
        """All sids in the set have entries."""
        entries = [
            {"message": "created", "id": "sess-a"},
            {"message": "created", "id": "sess-b"},
        ]
        result = _group_entries_by_session(entries, {"sess-a", "sess-b", "sess-c"})
        assert "sess-c" in result
        assert result["sess-c"] == []


# ── build_stats ──────────────────────────────────────────────────────────


class TestBuildStats:
    """Tests for ``build_stats()``."""

    def test_empty_timeline(self) -> None:
        """An empty timeline yields all-zero stats."""
        stats = build_stats([])
        assert stats["total_events"] == 0
        assert stats["total_turns"] == 0
        assert stats["llm_calls"] == 0
        assert stats["tool_calls"] == 0
        assert stats["permission_checks"] == 0
        assert stats["zoo_interventions"] == 0
        assert stats["session_events"] == 0
        assert stats["file_events"] == 0
        assert stats["type_distribution"] == {}
        assert stats["source_distribution"] == {}
        assert stats["time_span"] is None
        assert stats["tools"]["total"] == 0
        assert "child_sessions" not in stats

    def test_normal_timeline(self) -> None:
        """A populated timeline produces correct counts."""
        timeline = [
            {
                "type": "session",
                "source": "opencode",
                "timestamp": "2024-01-01T00:00:00Z",
            },
            {
                "type": "llm",
                "source": "opencode",
                "timestamp": "2024-01-01T00:01:00Z",
            },
            {
                "type": "llm_stream",
                "source": "opencode",
                "timestamp": "2024-01-01T00:02:00Z",
            },
            {
                "type": "tool_read",
                "source": "opencode",
                "timestamp": "2024-01-01T00:03:00Z",
            },
            {
                "type": "tool_write",
                "source": "opencode",
                "timestamp": "2024-01-01T00:04:00Z",
            },
            {
                "type": "tool_exec",
                "source": "opencode",
                "timestamp": "2024-01-01T00:05:00Z",
            },
            {
                "type": "tool_orch",
                "source": "opencode",
                "timestamp": "2024-01-01T00:06:00Z",
            },
            {
                "type": "tool_other",
                "source": "opencode",
                "timestamp": "2024-01-01T00:07:00Z",
            },
            {
                "type": "permission",
                "source": "opencode",
                "timestamp": "2024-01-01T00:08:00Z",
            },
            {
                "type": "hook",
                "source": "zoo",
                "timestamp": "2024-01-01T00:09:00Z",
            },
            {
                "type": "file",
                "source": "opencode",
                "timestamp": "2024-01-01T00:10:00Z",
            },
        ]
        stats = build_stats(timeline)
        assert stats["total_events"] == 11
        assert stats["total_turns"] == 1  # one session event
        assert stats["llm_calls"] == 2  # llm + llm_stream
        assert stats["tool_calls"] == 5  # all tool_* types
        assert stats["permission_checks"] == 1
        assert stats["zoo_interventions"] == 1
        assert stats["session_events"] == 1
        assert stats["file_events"] == 1
        assert stats["type_distribution"]["session"] == 1
        assert stats["type_distribution"]["tool_read"] == 1
        assert stats["source_distribution"]["opencode"] == 10
        assert stats["source_distribution"]["zoo"] == 1
        assert stats["tools"]["total"] == 5
        assert stats["tools"]["read"] == 1
        assert stats["tools"]["write"] == 1
        assert stats["tools"]["exec"] == 1
        assert stats["tools"]["orch"] == 1
        assert stats["tools"]["other"] == 1

    def test_time_span(self) -> None:
        """Time span is computed for timeline with 2+ timestamps."""
        timeline = [
            {
                "type": "session",
                "source": "opencode",
                "timestamp": "2024-01-01T00:00:00Z",
            },
            {
                "type": "llm",
                "source": "opencode",
                "timestamp": "2024-01-01T00:05:30Z",
            },
        ]
        stats = build_stats(timeline)
        assert stats["time_span"] is not None
        assert stats["time_span"]["start"] == "2024-01-01T00:00:00Z"
        assert stats["time_span"]["end"] == "2024-01-01T00:05:30Z"
        assert stats["time_span"]["seconds"] == 330

    def test_time_span_single_event(self) -> None:
        """Timeline with one event has no time_span."""
        timeline = [
            {
                "type": "session",
                "source": "opencode",
                "timestamp": "2024-01-01T00:00:00Z",
            },
        ]
        stats = build_stats(timeline)
        assert stats["time_span"] is None

    def test_time_span_no_timestamps(self) -> None:
        """Timeline with events but no timestamps has no time_span."""
        timeline = [
            {"type": "session", "source": "opencode"},
            {"type": "llm", "source": "opencode"},
        ]
        stats = build_stats(timeline)
        assert stats["time_span"] is None

    def test_time_span_invalid_timestamp(self) -> None:
        """Invalid timestamps in the list do not crash time_span computation."""
        timeline = [
            {
                "type": "session",
                "source": "opencode",
                "timestamp": "not-a-date",
            },
            {
                "type": "llm",
                "source": "opencode",
                "timestamp": "2024-01-01T00:01:00Z",
            },
        ]
        stats = build_stats(timeline)
        # The single valid timestamp isn't enough for time_span (needs 2 valid)
        assert stats["time_span"] is None

    def test_with_child_sessions(self) -> None:
        """child_sessions list is included in stats when provided."""
        stats = build_stats(
            [],
            child_sessions=[
                {"session_id": "c1", "depth": 1, "agent": "explore", "event_count": 5}
            ],
        )
        assert "child_sessions" in stats
        assert stats["total_child_sessions"] == 1
        assert stats["total_child_events"] == 5
        assert stats["child_sessions"][0]["session_id"] == "c1"

    def test_child_sessions_empty_list(self) -> None:
        """An empty child_sessions list is still included when provided."""
        stats = build_stats([], child_sessions=[])
        assert "child_sessions" in stats
        assert stats["total_child_sessions"] == 0
        assert stats["total_child_events"] == 0

    def test_type_distribution_counts(self) -> None:
        """type_distribution accurately counts all event types."""
        timeline = [
            {"type": "session", "source": "opencode"},
            {"type": "session", "source": "opencode"},
            {"type": "llm", "source": "opencode"},
            {"type": "tool_read", "source": "opencode"},
        ]
        stats = build_stats(timeline)
        assert stats["type_distribution"]["session"] == 2
        assert stats["type_distribution"]["llm"] == 1
        assert stats["type_distribution"]["tool_read"] == 1

    def test_source_distribution_counts(self) -> None:
        """source_distribution accurately counts all sources."""
        timeline = [
            {"type": "hook", "source": "zoo"},
            {"type": "hook", "source": "zoo"},
            {"type": "session", "source": "opencode"},
        ]
        stats = build_stats(timeline)
        assert stats["source_distribution"]["zoo"] == 2
        assert stats["source_distribution"]["opencode"] == 1


# ── build_timeline (wrapped in tmp_path) ──────────────────────────────


class TestBuildTimeline:
    """Minimal tests for ``build_timeline()`` using tmp_path.

    This function is inherently integration-oriented (reads opencode log,
    zoo log, sqlite). We test the pure logic paths via mocking or
    synthetic files.
    """

    def test_file_not_found_raises(self, tmp_path: Path) -> None:
        """A missing opencode log file raises FileNotFoundError."""
        from _trace_builder import build_timeline

        missing = str(tmp_path / "no-such-file.log")
        with pytest.raises(FileNotFoundError):
            build_timeline("sess-1", opencode_path=missing)

    def test_single_session_no_children(self, tmp_path: Path) -> None:
        """A minimal log file with one session returns a timeline."""
        from _trace_builder import build_timeline

        oc_path = tmp_path / "opencode.log"
        oc_path.write_text(
            "timestamp=2024-01-01T00:00:00Z message=created id=sess-1 slug=test\n"
            "timestamp=2024-01-01T00:01:00Z message=loop step=1 session_id=sess-1\n"
        )
        timeline = build_timeline("sess-1", opencode_path=str(oc_path))
        # Should have at least the created and loop events
        assert isinstance(timeline, list)
        assert len(timeline) >= 2
        # Every event should have session_id and depth
        for ev in timeline:
            assert "session_id" in ev
            assert "depth" in ev
        # Root session has depth 0
        assert all(ev["depth"] == 0 for ev in timeline)

    def test_include_children(self, tmp_path: Path) -> None:
        """With include_children=True, child session events are included."""
        from _trace_builder import build_timeline

        oc_path = tmp_path / "opencode.log"
        oc_path.write_text(
            "timestamp=2024-01-01T00:00:00Z message=created id=root run=r1 slug=main\n"
            "timestamp=2024-01-01T00:01:00Z message=created id=child parentID=root run=r2 slug=sub\n"
            "timestamp=2024-01-01T00:02:00Z message=loop step=1 session_id=root\n"
            "timestamp=2024-01-01T00:03:00Z message=loop step=1 session_id=child\n"
        )
        timeline = build_timeline(
            "root", opencode_path=str(oc_path), include_children=True
        )
        depths = {ev["depth"] for ev in timeline}
        assert 0 in depths
        assert 1 in depths

    def test_timeline_sorted_by_timestamp(self, tmp_path: Path) -> None:
        """Timeline events are sorted by timestamp ascending."""
        from _trace_builder import build_timeline

        oc_path = tmp_path / "opencode.log"
        oc_path.write_text(
            "timestamp=2024-01-01T00:05:00Z message=created id=sess-1 slug=test\n"
            "timestamp=2024-01-01T00:01:00Z message=loop step=1 session_id=sess-1\n"
            "timestamp=2024-01-01T00:03:00Z message=loop step=2 session_id=sess-1\n"
        )
        timeline = build_timeline("sess-1", opencode_path=str(oc_path))
        timestamps = [ev["timestamp"] for ev in timeline if ev.get("timestamp")]
        assert timestamps == sorted(timestamps)
