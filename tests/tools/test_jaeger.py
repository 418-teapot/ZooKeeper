"""Tests for tools/_jaeger.py — timeline-to-trace converters."""

from __future__ import annotations

import hashlib
import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent.parent / "tools"))

from _jaeger import (
    _add_detail_tags,
    _agent_category_tid,
    _build_logs,
    _build_tags,
    _find_root_agent,
    _find_root_session_detail,
    _get_operation_name,
    _to_epoch_us,
    build_chrome_trace,
    build_jaeger_doc,
)

# ── Helpers ────────────────────────────────────────────────────────────────


def _event(
    etype: str,
    detail: dict | None = None,
    timestamp: str = "",
    source: str = "",
    session_id: str = "",
    summary: str = "",
    content: str = "",
    depth: int = 0,
    session_agent: str = "",
    **extra: str,
) -> dict:
    """Build a minimal unified timeline event dict."""
    ev: dict = {
        "type": etype,
        "timestamp": timestamp,
        "source": source,
        "session_id": session_id,
        "summary": summary,
        "depth": depth,
        "session_agent": session_agent,
        "detail": detail or {},
    }
    if content:
        ev["content"] = content
    ev.update(extra)
    return ev


# ── _to_epoch_us ──────────────────────────────────────────────────────────


class TestToEpochUs:
    """Conversion of ISO 8601 timestamps to epoch microseconds."""

    def test_with_z_suffix(self) -> None:
        """Parse timestamp ending with Z."""
        result = _to_epoch_us("2025-06-14T12:00:00Z")
        assert result == 1_749_902_400_000_000

    def test_without_z_suffix(self) -> None:
        """Parse timestamp without Z (explicit +00:00)."""
        result = _to_epoch_us("2025-06-14T12:00:00+00:00")
        assert result == 1_749_902_400_000_000

    def test_with_timezone_offset(self) -> None:
        """Parse timestamp with non-UTC offset."""
        # 2025-06-14T14:00:00+02:00 = same instant as 12:00:00Z
        result = _to_epoch_us("2025-06-14T14:00:00+02:00")
        assert result == 1_749_902_400_000_000

    def test_epoch_zero(self) -> None:
        """Parse the Unix epoch."""
        result = _to_epoch_us("1970-01-01T00:00:00Z")
        assert result == 0

    def test_microsecond_precision(self) -> None:
        """Preserve sub-second microseconds."""
        result = _to_epoch_us("1970-01-01T00:00:00.123456Z")
        assert result == 123_456


# ── _get_operation_name ───────────────────────────────────────────────────


class TestGetOperationName:
    """Derivation of Jaeger operationName from event type and detail."""

    @pytest.mark.parametrize(
        "detail,expected",
        [
            ({"slug": "test"}, "session.create"),
            ({"step": 1}, "session.loop"),
            ({"message_id": "msg-1"}, "session.process"),
            ({}, "session.exit"),
            ({"other": "val"}, "session.exit"),
        ],
    )
    def test_session_types(self, detail: dict, expected: str) -> None:
        """Map session events based on detail keys."""
        assert _get_operation_name({"type": "session", "detail": detail}) == expected

    def test_zoo_hook(self) -> None:
        """Zoo hook uses detail.hook name."""
        event = {"type": "hook", "source": "zoo", "detail": {"hook": "post-task"}}
        assert _get_operation_name(event) == "zoo.post-task"

    def test_zoo_hook_missing_name(self) -> None:
        """Zoo hook defaults to 'unknown' when no hook name in detail."""
        event = {"type": "hook", "source": "zoo", "detail": {}}
        assert _get_operation_name(event) == "zoo.unknown"

    def test_opencode_hook(self) -> None:
        """OpenCode source hook maps to 'opencode.hook'."""
        event = {"type": "hook", "source": "opencode", "detail": {}}
        assert _get_operation_name(event) == "opencode.hook"

    @pytest.mark.parametrize(
        "etype,expected",
        [
            ("llm", "llm.select"),
            ("llm_stream", "llm.stream"),
            ("permission", "permission.deny"),
            ("tool_read", "tool.read"),
            ("tool_write", "tool.write"),
            ("tool_exec", "tool.exec"),
            ("tool_orch", "tool.orch"),
            ("tool_other", "tool.other"),
            ("file", "file.touch"),
            ("user_msg", "user.message"),
            ("assistant_reply", "assistant.reply"),
            ("assistant_reasoning", "assistant.reasoning"),
        ],
    )
    def test_mapped_types(self, etype: str, expected: str) -> None:
        """All known event types map to the expected operation name."""
        assert _get_operation_name({"type": etype, "detail": {}}) == expected

    def test_unknown_type(self) -> None:
        """Unknown event types pass through as-is."""
        assert (
            _get_operation_name({"type": "custom_event", "detail": {}})
            == "custom_event"
        )


# ── _add_detail_tags ──────────────────────────────────────────────────────


class TestAddDetailTags:
    """Appending non-empty tags from detail or event fallback."""

    def test_from_detail(self) -> None:
        """Keys present in detail are appended as tags."""
        tags: list[dict] = []
        _add_detail_tags(tags, {"model": "gpt-4", "count": "3"}, ("model", "count"))
        assert len(tags) == 2
        assert {"key": "model", "type": "string", "value": "gpt-4"} in tags
        assert {"key": "count", "type": "string", "value": "3"} in tags

    def test_fallback_to_event(self) -> None:
        """When a key is missing from detail, falls back to event top-level."""
        tags: list[dict] = []
        _add_detail_tags(tags, {}, ("agent",), {"agent": "build"})
        assert tags == [{"key": "agent", "type": "string", "value": "build"}]

    def test_skip_empty_values(self) -> None:
        """Empty or falsy values are not added."""
        tags: list[dict] = []
        _add_detail_tags(
            tags,
            {"model": "", "tokens": 0, "agent": None, "name": "valid"},
            ("model", "tokens", "agent", "name"),
        )
        assert len(tags) == 1
        assert tags[0]["key"] == "name"

    def test_empty_keys_tuple(self) -> None:
        """No keys means no tags appended."""
        tags: list[dict] = [{"existing": "tag"}]
        _add_detail_tags(tags, {"a": "b"}, ())
        assert len(tags) == 1

    def test_detail_overrides_event(self) -> None:
        """Detail value takes precedence over event top-level fallback."""
        tags: list[dict] = []
        _add_detail_tags(
            tags,
            {"agent": "explore"},
            ("agent",),
            {"agent": "build"},
        )
        assert tags[0]["value"] == "explore"


# ── _agent_category_tid ───────────────────────────────────────────────────


class TestAgentCategoryTid:
    """Mapping event types to Chrome trace thread IDs."""

    @pytest.mark.parametrize(
        "etype,tid",
        [
            ("tool_read", 1),
            ("tool_write", 2),
            ("tool_exec", 3),
            ("tool_orch", 4),
            ("tool_other", 5),
            ("llm", 6),
            ("llm_stream", 6),
            ("user_msg", 7),
            ("assistant_reply", 8),
            ("assistant_reasoning", 9),
            ("hook", 10),
        ],
    )
    def test_known_types(self, etype: str, tid: int) -> None:
        """Known event types return their assigned thread ID."""
        assert _agent_category_tid(etype) == tid

    def test_unknown_type_defaults_to_zero(self) -> None:
        """Unknown event types return 0."""
        assert _agent_category_tid("session") == 0
        assert _agent_category_tid("file") == 0
        assert _agent_category_tid("permission") == 0
        assert _agent_category_tid("unknown_type") == 0


# ── _find_root_session_detail ─────────────────────────────────────────────


class TestFindRootSessionDetail:
    """Locating the first session.create detail in a timeline."""

    def test_finds_first_session_create(self) -> None:
        """Return detail of the first session event containing a slug."""
        timeline = [
            _event("tool_read", timestamp="2025-01-01T00:00:00Z"),
            _event(
                "session",
                detail={"slug": "root", "agent": "build"},
                timestamp="2025-01-01T00:00:01Z",
            ),
            _event(
                "session",
                detail={"slug": "child", "agent": "explore"},
                timestamp="2025-01-01T00:00:02Z",
            ),
        ]
        result = _find_root_session_detail(timeline)
        assert result == {"slug": "root", "agent": "build"}

    def test_empty_timeline(self) -> None:
        """Empty timeline returns empty dict."""
        assert _find_root_session_detail([]) == {}

    def test_no_session_create(self) -> None:
        """Timeline without session.create returns empty dict."""
        timeline = [
            _event("llm", detail={"model": "gpt-4"}),
            _event("tool_read", detail={}),
        ]
        assert _find_root_session_detail(timeline) == {}

    def test_session_without_slug(self) -> None:
        """Session events without slug are skipped."""
        timeline = [
            _event("session", detail={"step": 1}),
            _event("session", detail={"slug": "real", "agent": "build"}),
        ]
        result = _find_root_session_detail(timeline)
        assert result == {"slug": "real", "agent": "build"}


# ── _find_root_agent ──────────────────────────────────────────────────────


class TestFindRootAgent:
    """Extract root session agent name from timeline."""

    def test_finds_root_agent(self) -> None:
        """Return agent from the first session.create event."""
        timeline = [
            _event("session", detail={"slug": "s1", "agent": "build"}),
        ]
        assert _find_root_agent(timeline) == "build"

    def test_empty_timeline(self) -> None:
        """Empty timeline returns empty string."""
        assert _find_root_agent([]) == ""

    def test_no_session_create(self) -> None:
        """Timeline without session.create returns empty string."""
        timeline = [_event("llm")]
        assert _find_root_agent(timeline) == ""


# ── _build_tags ───────────────────────────────────────────────────────────


class TestBuildTags:
    """Construction of Jaeger span tag lists from events."""

    COMMON_KEYS = {"source", "event.type", "session_id", "depth", "summary"}

    def _common_checks(self, tags: list[dict], etype: str) -> None:
        """Verify all common tags are present with expected values."""
        tag_keys = {t["key"] for t in tags}
        assert self.COMMON_KEYS.issubset(tag_keys), (
            f"Missing common tags: {self.COMMON_KEYS - tag_keys}"
        )

    def _tag_value(self, tags: list[dict], key: str) -> str | int:
        """Extract a tag value by key."""
        for t in tags:
            if t["key"] == key:
                return t["value"]
        raise AssertionError(f"Tag '{key}' not found")

    def test_common_tags(self) -> None:
        """All events produce source, event.type, session_id, depth, summary."""
        event = _event(
            "llm",
            timestamp="2025-06-14T12:00:00Z",
            source="opencode",
            session_id="sid-1",
            summary="LLM call",
            depth=0,
        )
        tags = _build_tags(event)
        self._common_checks(tags, "llm")
        assert self._tag_value(tags, "source") == "opencode"
        assert self._tag_value(tags, "event.type") == "llm"
        assert self._tag_value(tags, "session_id") == "sid-1"
        assert self._tag_value(tags, "depth") == 0
        assert self._tag_value(tags, "summary") == "LLM call"

    def test_summary_truncated(self) -> None:
        """Summary tag is truncated to 256 characters."""
        long_summary = "x" * 300
        tags = _build_tags(_event("llm", summary=long_summary))
        val = self._tag_value(tags, "summary")
        assert isinstance(val, str) and len(val) == 256

    def test_depth_greater_than_zero_adds_session_agent(self) -> None:
        """depth > 0 adds a session_agent tag."""
        tags = _build_tags(_event("llm", depth=1, session_agent="explore"))
        assert self._tag_value(tags, "session_agent") == "explore"

    def test_depth_zero_no_session_agent(self) -> None:
        """depth == 0 does not add session_agent tag."""
        tags = _build_tags(_event("llm", depth=0, session_agent="build"))
        assert all(t["key"] != "session_agent" for t in tags)

    # ── Type-specific tags ──

    def test_session_tags(self) -> None:
        """Session events include slug, agent, model_id, etc."""
        detail = {
            "slug": "root",
            "agent": "build",
            "model_id": "gpt-4",
            "model_provider": "openai",
            "parent_id": "",
            "project_id": "proj-1",
            "cost": "0.02",
            "tokens_input": "500",
            "tokens_output": "200",
        }
        tags = _build_tags(_event("session", detail=detail))
        self._common_checks(tags, "session")
        assert self._tag_value(tags, "slug") == "root"
        assert self._tag_value(tags, "agent") == "build"
        assert self._tag_value(tags, "model_id") == "gpt-4"
        assert self._tag_value(tags, "model_provider") == "openai"
        assert self._tag_value(tags, "project_id") == "proj-1"
        assert self._tag_value(tags, "cost") == "0.02"
        assert self._tag_value(tags, "tokens_input") == "500"
        assert self._tag_value(tags, "tokens_output") == "200"
        # parent_id is empty so should not appear
        assert all(t["key"] != "parent_id" for t in tags)

    def test_llm_tags(self) -> None:
        """LLM events include provider, model, runtime, agent, mode."""
        detail = {
            "provider": "openai",
            "model": "gpt-4",
            "runtime": "2.5",
            "agent": "build",
            "mode": "chat",
        }
        tags = _build_tags(_event("llm", detail=detail))
        assert self._tag_value(tags, "provider") == "openai"
        assert self._tag_value(tags, "model") == "gpt-4"
        assert self._tag_value(tags, "runtime") == "2.5"
        assert self._tag_value(tags, "agent") == "build"
        assert self._tag_value(tags, "mode") == "chat"

    def test_llm_stream_tags(self) -> None:
        """llm_stream events get the same tags as llm."""
        detail = {
            "provider": "anthropic",
            "model": "claude-3",
            "runtime": "1.2",
            "agent": "build",
            "mode": "stream",
        }
        tags = _build_tags(_event("llm_stream", detail=detail))
        assert self._tag_value(tags, "provider") == "anthropic"
        assert self._tag_value(tags, "model") == "claude-3"

    def test_tool_tags(self) -> None:
        """Tool events include permission, pattern, action."""
        for etype in (
            "permission",
            "tool_read",
            "tool_write",
            "tool_exec",
            "tool_orch",
            "tool_other",
        ):
            detail = {"permission": "allow", "pattern": "src/**", "action": "read"}
            tags = _build_tags(_event(etype, detail=detail))
            assert self._tag_value(tags, "permission") == "allow"
            assert self._tag_value(tags, "pattern") == "src/**"
            assert self._tag_value(tags, "action") == "read"

    def test_file_tags(self) -> None:
        """File events include file and action."""
        detail = {"file": "main.py", "action": "touch"}
        tags = _build_tags(_event("file", detail=detail))
        assert self._tag_value(tags, "file") == "main.py"
        assert self._tag_value(tags, "action") == "touch"

    def test_zoo_hook_tags(self) -> None:
        """Zoo hooks include hook, event, level."""
        detail = {"hook": "post-task", "event": "after", "level": "info"}
        tags = _build_tags(_event("hook", source="zoo", detail=detail))
        assert self._tag_value(tags, "hook") == "post-task"
        assert self._tag_value(tags, "event") == "after"
        assert self._tag_value(tags, "level") == "info"

    def test_opencode_hook_tags(self) -> None:
        """Non-zoo hooks include message from detail."""
        detail = {"message": "hook fired", "hook": "ignored-in-tags"}
        tags = _build_tags(_event("hook", source="opencode", detail=detail))
        # message is added as a tag via _add_detail_tags (not in detail keys)
        # Actually looking at the code: for hook with source != "zoo", it adds ("message",).
        # But opencode hook was adding ("message",) — wait, the code says:
        # ```
        # elif etype == "hook" and source != "zoo":
        #     _add_detail_tags(tags, detail, ("message",))
        # ```
        # So it looks for "message" in detail.
        # In my test data, "message" is in detail so it should be added.
        assert self._tag_value(tags, "message") == "hook fired"

    def test_user_msg_tags(self) -> None:
        """User message events include agent tag (via fallback to event top-level)."""
        tags = _build_tags(_event("user_msg", detail={}, agent="explore"))
        # _add_detail_tags falls back to event.get("agent") when detail lacks it
        assert self._tag_value(tags, "agent") == "explore"

    def test_assistant_reply_tags(self) -> None:
        """Assistant reply events include model and agent."""
        detail = {"model": "gpt-4"}
        tags = _build_tags(_event("assistant_reply", detail=detail, agent="build"))
        assert self._tag_value(tags, "model") == "gpt-4"
        assert self._tag_value(tags, "agent") == "build"

    def test_assistant_reasoning_tags(self) -> None:
        """Assistant reasoning events include model and agent."""
        detail = {"model": "claude-3"}
        tags = _build_tags(
            _event("assistant_reasoning", detail=detail, agent="explore")
        )
        assert self._tag_value(tags, "model") == "claude-3"
        assert self._tag_value(tags, "agent") == "explore"


# ── _build_logs ────────────────────────────────────────────────────────────


class TestBuildLogs:
    """Construction of Jaeger span logs for content-heavy events."""

    def test_user_msg_with_content(self) -> None:
        """user_msg events produce a log entry with the content field."""
        event = _event(
            "user_msg", content="Hello, assistant!", timestamp="2025-06-14T12:00:00Z"
        )
        logs = _build_logs(event)
        assert len(logs) == 1
        assert logs[0]["timestamp"] == 1_749_902_400_000_000
        fields = logs[0]["fields"]
        assert len(fields) == 1
        assert fields[0] == {
            "key": "content",
            "type": "string",
            "value": "Hello, assistant!",
        }

    def test_user_msg_empty_content(self) -> None:
        """user_msg events with empty content produce no logs."""
        event = _event("user_msg", content="", timestamp="2025-06-14T12:00:00Z")
        assert _build_logs(event) == []

    def test_assistant_reply_with_content(self) -> None:
        """assistant_reply events produce a log entry with the content field."""
        event = _event(
            "assistant_reply",
            content="Here is the code.",
            timestamp="2025-06-14T12:00:00Z",
        )
        logs = _build_logs(event)
        assert len(logs) == 1
        assert logs[0]["fields"][0]["value"] == "Here is the code."

    def test_assistant_reasoning_with_content(self) -> None:
        """assistant_reasoning events produce a log entry with the content field."""
        event = _event(
            "assistant_reasoning",
            content="Thinking step by step...",
            timestamp="2025-06-14T12:00:00Z",
        )
        logs = _build_logs(event)
        assert len(logs) == 1
        assert logs[0]["fields"][0]["value"] == "Thinking step by step..."

    def test_opencode_hook_logs(self) -> None:
        """OpenCode hook events dump entire detail as JSON."""
        detail = {"hook": "task-prompt", "valid": False}
        event = _event(
            "hook", source="opencode", detail=detail, timestamp="2025-06-14T12:00:00Z"
        )
        logs = _build_logs(event)
        assert len(logs) == 1
        assert logs[0]["fields"][0]["key"] == "detail"
        import json

        assert json.loads(logs[0]["fields"][0]["value"]) == {
            "hook": "task-prompt",
            "valid": False,
        }

    def test_zoo_hook_no_logs(self) -> None:
        """Zoo source hooks produce no logs."""
        event = _event("hook", source="zoo", detail={"hook": "post-task"})
        assert _build_logs(event) == []

    def test_other_events_no_logs(self) -> None:
        """Events without content or not matching special types produce no logs."""
        event = _event("llm")
        assert _build_logs(event) == []
        event = _event("tool_read")
        assert _build_logs(event) == []

    def test_no_timestamp_returns_zero_epoch(self) -> None:
        """Events without timestamp produce logs with timestamp 0."""
        event = _event("user_msg", content="hello")
        logs = _build_logs(event)
        assert logs[0]["timestamp"] == 0


# ── build_chrome_trace ─────────────────────────────────────────────────────


class TestBuildChromeTrace:
    """Conversion of timeline to Chrome Trace Event Format."""

    def test_empty_timeline(self) -> None:
        """Empty timeline returns an empty list."""
        assert build_chrome_trace([]) == []

    def test_events_without_timestamp_skipped(self) -> None:
        """Events missing a timestamp are skipped."""
        timeline = [
            _event("llm", timestamp=""),
            _event("llm", timestamp="2025-06-14T12:00:00Z"),
        ]
        result = build_chrome_trace(timeline)
        assert len(result) == 1

    def test_pid_assignment_per_session_id(self) -> None:
        """Each unique session_id gets a different pid."""
        timeline = [
            _event("llm", timestamp="2025-06-14T12:00:00Z", session_id="root"),
            _event("llm", timestamp="2025-06-14T12:00:01Z", session_id="child-1"),
            _event("llm", timestamp="2025-06-14T12:00:02Z", session_id="child-2"),
        ]
        result = build_chrome_trace(timeline)
        pids = [ev["pid"] for ev in result]
        assert pids == [1, 2, 3]

    def test_tid_from_event_type(self) -> None:
        """tid is derived from event type category."""
        timeline = [
            _event("tool_read", timestamp="2025-06-14T12:00:00Z"),
            _event("llm", timestamp="2025-06-14T12:00:01Z"),
            _event("session", timestamp="2025-06-14T12:00:02Z"),
        ]
        result = build_chrome_trace(timeline)
        assert result[0]["tid"] == 1  # tool_read
        assert result[1]["tid"] == 6  # llm
        assert result[2]["tid"] == 0  # session (unknown)

    def test_duration_delta_to_next_event(self) -> None:
        """Duration is the delta in µs to the next event (min 1000)."""
        timeline = [
            _event("llm", timestamp="2025-06-14T12:00:00.000Z"),
            _event("llm", timestamp="2025-06-14T12:00:00.005Z"),  # 5000 µs later
        ]
        result = build_chrome_trace(timeline)
        assert len(result) == 2
        # First event: delta = 5000 µs
        assert result[0]["dur"] == 5000
        # Last event: fallback to 1000 µs
        assert result[1]["dur"] == 1000

    def test_duration_minimum_1000(self) -> None:
        """Duration is never less than 1000 µs."""
        timeline = [
            _event("llm", timestamp="2025-06-14T12:00:00.000Z"),
            _event("llm", timestamp="2025-06-14T12:00:00.000200Z"),  # only 200 µs later
        ]
        result = build_chrome_trace(timeline)
        assert result[0]["dur"] == 1000

    def test_duration_with_missing_next_timestamp(self) -> None:
        """When next event lacks a timestamp, current event uses 1000 µs."""
        timeline = [
            _event("llm", timestamp="2025-06-14T12:00:00.000Z"),
            _event("llm", timestamp=""),  # no timestamp
        ]
        result = build_chrome_trace(timeline)
        assert result[0]["dur"] == 1000

    def test_name_truncated_at_120_chars(self) -> None:
        """Event summary is truncated to 120 characters."""
        long_summary = "a" * 200
        timeline = [
            _event("llm", summary=long_summary, timestamp="2025-06-14T12:00:00Z")
        ]
        result = build_chrome_trace(timeline)
        assert len(result[0]["name"]) == 120

    def test_name_empty_when_no_summary(self) -> None:
        """Event with empty summary gets an empty name."""
        timeline = [_event("llm", summary="", timestamp="2025-06-14T12:00:00Z")]
        result = build_chrome_trace(timeline)
        assert result[0]["name"] == ""

    def test_child_session_prefix(self) -> None:
        """Events with depth > 0 get a [子:agent] prefix."""
        timeline = [
            _event(
                "tool_read",
                depth=1,
                session_agent="explore",
                summary="read file",
                timestamp="2025-06-14T12:00:00Z",
            )
        ]
        result = build_chrome_trace(timeline)
        assert result[0]["name"] == "[子:explore] read file"

    def test_child_session_prefix_fallback_question_mark(self) -> None:
        """Child events without session_agent use '?' as label."""
        timeline = [
            _event(
                "tool_read",
                depth=1,
                session_agent="",
                summary="read file",
                timestamp="2025-06-14T12:00:00Z",
            )
        ]
        result = build_chrome_trace(timeline)
        assert result[0]["name"] == "[子:?] read file"

    def test_args_contain_agent(self) -> None:
        """args always contain agent field."""
        timeline = [
            _event("llm", timestamp="2025-06-14T12:00:00Z", session_agent="build")
        ]
        result = build_chrome_trace(timeline)
        assert result[0]["args"]["agent"] == "build"

    def test_args_agent_falls_back_to_root(self) -> None:
        """When no session_agent, agent falls back to root session agent."""
        timeline = [
            _event(
                "session",
                detail={"slug": "s1", "agent": "build"},
                timestamp="2025-06-14T12:00:00Z",
            ),
            _event("llm", timestamp="2025-06-14T12:00:01Z"),
        ]
        result = build_chrome_trace(timeline)
        assert result[1]["args"]["agent"] == "build"

    def test_args_content_for_message_types(self) -> None:
        """user_msg/assistant_reply/assistant_reasoning include truncated content."""
        timeline = [
            _event("user_msg", content="Hello world", timestamp="2025-06-14T12:00:00Z"),
        ]
        result = build_chrome_trace(timeline)
        assert result[0]["args"]["content"] == "Hello world"

    def test_args_content_truncated_to_500(self) -> None:
        """Content in args is truncated to 500 characters."""
        long_content = "x" * 1000
        timeline = [
            _event("user_msg", content=long_content, timestamp="2025-06-14T12:00:00Z")
        ]
        result = build_chrome_trace(timeline)
        assert len(result[0]["args"]["content"]) == 500

    def test_args_detail_keys(self) -> None:
        """Detail keys are copied to args for non-message events."""
        detail = {"model": "gpt-4", "provider": "openai", "permission": "allow"}
        timeline = [_event("llm", detail=detail, timestamp="2025-06-14T12:00:00Z")]
        result = build_chrome_trace(timeline)
        assert result[0]["args"]["model"] == "gpt-4"
        assert result[0]["args"]["provider"] == "openai"

    def test_ph_x_complete_event(self) -> None:
        """Each chrome trace event has ph='X' (complete event)."""
        timeline = [_event("llm", timestamp="2025-06-14T12:00:00Z")]
        result = build_chrome_trace(timeline)
        assert result[0]["ph"] == "X"

    def test_cat_equals_event_type(self) -> None:
        """cat field equals the event type."""
        timeline = [_event("tool_read", timestamp="2025-06-14T12:00:00Z")]
        result = build_chrome_trace(timeline)
        assert result[0]["cat"] == "tool_read"


# ── build_jaeger_doc ──────────────────────────────────────────────────────


class TestBuildJaegerDoc:
    """Conversion of timeline to Jaeger JSON trace document."""

    def test_empty_timeline(self) -> None:
        """Empty timeline returns {'data': []}."""
        assert build_jaeger_doc("session-id", []) == {"data": []}

    def test_trace_id_is_sha256_of_session_id(self) -> None:
        """traceID is the first 32 hex chars of SHA-256(session_id)."""
        session_id = "test-session-uuid"
        expected_hash = hashlib.sha256(session_id.encode()).hexdigest()[:32]
        timeline = [
            _event("session", detail={"slug": "s1"}, timestamp="2025-06-14T12:00:00Z")
        ]
        result = build_jaeger_doc(session_id, timeline)
        assert result["data"][0]["traceID"] == expected_hash

    def test_root_span_structure(self) -> None:
        """Root span has traceID, spanID, operationName, startTime, duration, tags, logs, processID."""
        timeline = [
            _event(
                "session", detail={"slug": "s1"}, timestamp="2025-06-14T12:00:00.000Z"
            ),
            _event("llm", timestamp="2025-06-14T12:00:00.005Z"),
        ]
        result = build_jaeger_doc("sid", timeline)
        root = result["data"][0]["spans"][0]
        assert root["spanID"] == "0000000000000001"
        assert root["operationName"] == "session"
        assert root["startTime"] == 1_749_902_400_000_000
        assert root["duration"] == 5000  # delta of 5ms = 5000 µs
        assert root["processID"] == "p1"
        assert len(root["tags"]) == 2
        assert root["tags"][0] == {
            "key": "source",
            "type": "string",
            "value": "opencode",
        }
        assert root["tags"][1] == {
            "key": "session_id",
            "type": "string",
            "value": "sid",
        }

    def test_root_duration_min_1(self) -> None:
        """Root span duration is at least 1 µs even for single event."""
        timeline = [
            _event(
                "session", detail={"slug": "s1"}, timestamp="2025-06-14T12:00:00.000Z"
            )
        ]
        result = build_jaeger_doc("sid", timeline)
        root = result["data"][0]["spans"][0]
        assert root["duration"] == 1

    def test_each_event_becomes_child_of_span(self) -> None:
        """Each timeline event becomes a CHILD_OF span referencing the root."""
        timeline = [
            _event(
                "session", detail={"slug": "s1"}, timestamp="2025-06-14T12:00:00.000Z"
            ),
            _event("llm", timestamp="2025-06-14T12:00:00.001Z"),
            _event("tool_read", timestamp="2025-06-14T12:00:00.002Z"),
        ]
        result = build_jaeger_doc("sid", timeline)
        spans = result["data"][0]["spans"]
        # skip root (index 0)
        for span in spans[1:]:
            refs = span["references"]
            assert len(refs) == 1
            assert refs[0]["refType"] == "CHILD_OF"
            assert refs[0]["spanID"] == "0000000000000001"

    def test_span_id_sequential_hex(self) -> None:
        """Event spanIDs are sequential 16-char hex strings starting at 2."""
        timeline = [
            _event(
                "session", detail={"slug": "s1"}, timestamp="2025-06-14T12:00:00.000Z"
            ),
            _event("llm", timestamp="2025-06-14T12:00:00.001Z"),
            _event("tool_read", timestamp="2025-06-14T12:00:00.002Z"),
        ]
        result = build_jaeger_doc("sid", timeline)
        spans = result["data"][0]["spans"]
        # Root span (0) + 3 event spans = 4 total
        assert len(spans) == 4
        assert spans[1]["spanID"] == "0000000000000002"  # session.create
        assert spans[2]["spanID"] == "0000000000000003"  # llm.select
        assert spans[3]["spanID"] == "0000000000000004"  # tool.read

    def test_process_tags_from_root_session(self) -> None:
        """Process tags include agent, model_id, model_provider from root session."""
        timeline = [
            _event(
                "session",
                detail={
                    "slug": "s1",
                    "agent": "build",
                    "model_id": "gpt-4",
                    "model_provider": "openai",
                },
                timestamp="2025-06-14T12:00:00Z",
            ),
        ]
        result = build_jaeger_doc("sid", timeline)
        processes = result["data"][0]["processes"]
        assert "p1" in processes
        assert processes["p1"]["serviceName"] == "opencode"
        process_tags = {t["key"]: t["value"] for t in processes["p1"]["tags"]}
        assert process_tags == {
            "agent": "build",
            "model_id": "gpt-4",
            "model_provider": "openai",
        }

    def test_process_tags_empty_when_no_root_session(self) -> None:
        """Process tags are empty list when no root session detail found."""
        timeline = [_event("llm", timestamp="2025-06-14T12:00:00Z")]
        result = build_jaeger_doc("sid", timeline)
        processes = result["data"][0]["processes"]
        assert processes["p1"]["tags"] == []

    def test_span_logs_for_content_events(self) -> None:
        """Span logs contain content for message-type events."""
        timeline = [
            _event(
                "session", detail={"slug": "s1"}, timestamp="2025-06-14T12:00:00.000Z"
            ),
            _event("user_msg", content="Hello!", timestamp="2025-06-14T12:00:00.001Z"),
        ]
        result = build_jaeger_doc("sid", timeline)
        spans = result["data"][0]["spans"]
        # spans[0] = root, spans[1] = session.create (no logs), spans[2] = user_msg
        assert len(spans) == 3
        user_msg_span = spans[2]
        assert len(user_msg_span["logs"]) == 1
        assert user_msg_span["logs"][0]["fields"][0]["value"] == "Hello!"

    def test_span_duration_delta_to_next(self) -> None:
        """Event span duration is max(1000, delta to next)."""
        timeline = [
            _event(
                "session", detail={"slug": "s1"}, timestamp="2025-06-14T12:00:00.000Z"
            ),
            _event("llm", timestamp="2025-06-14T12:00:00.003Z"),  # 3000 µs later
            _event(
                "tool_read", timestamp="2025-06-14T12:00:00.003200Z"
            ),  # 200 µs later
        ]
        result = build_jaeger_doc("sid", timeline)
        spans = result["data"][0]["spans"]
        # first event span: delta 3000 µs
        assert spans[1]["duration"] == 3000
        # second event span: delta 200 µs → min 1000
        assert spans[2]["duration"] == 1000

    def test_last_event_duration_1_second(self) -> None:
        """Last event duration falls back to 1_000_000 µs."""
        timeline = [
            _event(
                "session", detail={"slug": "s1"}, timestamp="2025-06-14T12:00:00.000Z"
            ),
            _event("llm", timestamp="2025-06-14T12:00:00.001Z"),
        ]
        result = build_jaeger_doc("sid", timeline)
        spans = result["data"][0]["spans"]
        assert spans[-1]["duration"] == 1_000_000

    def test_skip_events_without_timestamp(self) -> None:
        """Events without timestamp are skipped in span generation."""
        timeline = [
            _event("session", detail={"slug": "s1"}, timestamp="2025-06-14T12:00:00Z"),
            _event("llm", timestamp=""),
            _event("tool_read", timestamp="2025-06-14T12:00:01Z"),
        ]
        result = build_jaeger_doc("sid", timeline)
        # Root (0) + session (1) + tool_read (idx=2, skipped llm at idx=1) = 3 spans
        spans = result["data"][0]["spans"]
        assert len(spans) == 3
        span_ids = [s["spanID"] for s in spans]
        # llm at idx=1 is skipped (no timestamp), so tool_read at idx=2 gets idx+2 = spanID 4
        assert span_ids == [
            "0000000000000001",  # root
            "0000000000000002",  # session
            "0000000000000004",  # tool_read (idx 2 → spanID 4)
        ]

    def test_total_field(self) -> None:
        """Top-level 'total' is always 1 when timeline is non-empty."""
        timeline = [
            _event("session", detail={"slug": "s1"}, timestamp="2025-06-14T12:00:00Z")
        ]
        result = build_jaeger_doc("sid", timeline)
        assert result["total"] == 1

    def test_operation_name_on_event_spans(self) -> None:
        """Event spans use _get_operation_name for their operationName."""
        timeline = [
            _event("session", detail={"slug": "s1"}, timestamp="2025-06-14T12:00:00Z"),
            _event("llm", timestamp="2025-06-14T12:00:01Z"),
            _event("tool_read", timestamp="2025-06-14T12:00:02Z"),
        ]
        result = build_jaeger_doc("sid", timeline)
        spans = result["data"][0]["spans"]
        # spans[0] = root (session), spans[1] = first event (session.create),
        # spans[2] = second event (llm.select), spans[3] = third event (tool.read)
        assert spans[1]["operationName"] == "session.create"
        assert spans[2]["operationName"] == "llm.select"
        assert spans[3]["operationName"] == "tool.read"
