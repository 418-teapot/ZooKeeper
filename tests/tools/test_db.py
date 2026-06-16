"""Tests for tools/_db.py's query_db_messages function.

All tests use in-memory or temporary SQLite databases constructed
with the same schema as the opencode SQLite database.
"""

from __future__ import annotations

import sys
from pathlib import Path

# Allow import from the tools/ directory (not on sys.path by default).
sys.path.insert(
    0, str(Path(__file__).resolve().parent.parent.parent / "tools")
)

import json
import sqlite3

from _db import (  # noqa: E402
    _safe_json_loads,
    query_db_messages,
    query_message_by_ids,
    query_message_parts,
    query_recent_sessions,
    query_sessions,
    query_sessions_all,
    query_sessions_exact,
    query_step_data,
    query_step_data_batch,
    query_tool_durations,
    query_tool_durations_batch,
)

# ── Test helpers ──────────────────────────────────────────────────────────


def _create_db(
    db_path: str,
    messages: list[dict] | None = None,
    parts: list[dict] | None = None,
    sessions: list[dict] | None = None,
) -> None:
    """Create an opencode-style SQLite database at ``db_path``.

    Args:
        db_path: Absolute path for the database file.
        messages: List of message row dicts with keys
            ``id``, ``session_id``, ``time_created``, ``data`` (JSON string).
        parts: List of part row dicts with keys
            ``id``, ``message_id``, ``time_created``, ``data`` (JSON string).
            May also include ``session_id`` and ``time_updated``.
        sessions: List of session row dicts (all columns from the session
            table schema). When provided, a ``session`` table is created.
    """
    conn = sqlite3.connect(db_path)
    conn.execute(
        "CREATE TABLE message ("
        "  id TEXT PRIMARY KEY,"
        "  session_id TEXT,"
        "  time_created INTEGER,"
        "  time_updated INTEGER,"
        "  data TEXT"
        ")"
    )
    conn.execute(
        "CREATE TABLE part ("
        "  id TEXT PRIMARY KEY,"
        "  message_id TEXT,"
        "  session_id TEXT,"
        "  time_created INTEGER,"
        "  time_updated INTEGER,"
        "  data TEXT"
        ")"
    )
    if sessions is not None:
        conn.execute(
            "CREATE TABLE session ("
            "  id TEXT PRIMARY KEY,"
            "  project_id TEXT NOT NULL,"
            "  parent_id TEXT,"
            "  slug TEXT NOT NULL,"
            "  directory TEXT NOT NULL,"
            "  title TEXT NOT NULL,"
            "  version TEXT NOT NULL,"
            "  time_created INTEGER NOT NULL,"
            "  time_updated INTEGER NOT NULL,"
            "  cost REAL DEFAULT 0,"
            "  tokens_input INTEGER DEFAULT 0,"
            "  tokens_output INTEGER DEFAULT 0,"
            "  tokens_reasoning INTEGER DEFAULT 0,"
            "  tokens_cache_read INTEGER DEFAULT 0,"
            "  tokens_cache_write INTEGER DEFAULT 0,"
            "  agent TEXT,"
            "  model TEXT"
            ")"
        )
        for sess in sessions:
            # Build INSERT dynamically to allow omitting optional fields.
            cols = [
                "id",
                "project_id",
                "parent_id",
                "slug",
                "directory",
                "title",
                "version",
                "time_created",
                "time_updated",
            ]
            optional_cols = [
                "cost",
                "tokens_input",
                "tokens_output",
                "tokens_reasoning",
                "tokens_cache_read",
                "tokens_cache_write",
                "agent",
                "model",
            ]
            vals = [sess.get(c) for c in cols]
            for c in optional_cols:
                if c in sess:
                    cols.append(c)
                    vals.append(sess[c])
            placeholders = ",".join("?" * len(cols))
            col_names = ",".join(cols)
            conn.execute(
                f"INSERT INTO session ({col_names}) VALUES ({placeholders})",
                vals,
            )
    if messages:
        for msg in messages:
            cols = ["id", "session_id", "time_created", "data"]
            vals = [
                msg["id"],
                msg["session_id"],
                msg["time_created"],
                msg["data"],
            ]
            if "time_updated" in msg:
                cols.append("time_updated")
                vals.append(msg["time_updated"])
            placeholders = ",".join("?" * len(cols))
            col_names = ",".join(cols)
            conn.execute(
                f"INSERT INTO message ({col_names}) VALUES ({placeholders})",
                vals,
            )
    if parts:
        for part in parts:
            cols = ["id", "message_id", "time_created", "data"]
            vals = [
                part["id"],
                part["message_id"],
                part["time_created"],
                part["data"],
            ]
            for extra_col in ("session_id", "time_updated"):
                if extra_col in part:
                    cols.append(extra_col)
                    vals.append(part[extra_col])
            placeholders = ",".join("?" * len(cols))
            col_names = ",".join(cols)
            conn.execute(
                f"INSERT INTO part ({col_names}) VALUES ({placeholders})",
                vals,
            )
    conn.commit()
    conn.close()


def _msg_data(
    role: str,
    agent: str = "",
    model_id: str | None = None,
) -> str:
    """Build a JSON ``data`` string for a message row.

    Args:
        role: ``"user"`` or ``"assistant"``.
        agent: Agent name.
        model_id: Model ID (only meaningful for assistant messages).

    Returns:
        JSON string.
    """
    d: dict[str, str] = {"role": role, "agent": agent}
    if model_id is not None:
        d["modelID"] = model_id
    return json.dumps(d)


def _part_data(
    type_: str,
    text: str,
    synthetic: bool = False,
) -> str:
    """Build a JSON ``data`` string for a part row.

    Args:
        type_: Part type (``"text"`` or ``"reasoning"``).
        text: Part content text.
        synthetic: Whether the part is auto-generated.

    Returns:
        JSON string.
    """
    d: dict[str, str | bool] = {"type": type_, "text": text}
    if synthetic:
        d["synthetic"] = True
    return json.dumps(d)


def _session_data(
    id_: str,
    title: str,
    parent_id: str | None = None,
    slug: str = "test-slug",
    directory: str = "/tmp/project",
    version: str = "1.0",
    time_created: int = 1_700_000_000_000,
    time_updated: int = 1_700_000_000_001,
    cost: float = 0.0,
    tokens_input: int = 0,
    tokens_output: int = 0,
    tokens_reasoning: int = 0,
    tokens_cache_read: int = 0,
    tokens_cache_write: int = 0,
    agent: str = "test-agent",
    model: str = "",
    project_id: str = "proj-1",
) -> dict:
    """Build a dict for a session table row.

    Args:
        id_: Session ID.
        title: Session title.
        parent_id: Parent session ID (for child sessions).
        slug: URL slug.
        directory: Project directory.
        version: OpenCode version.
        time_created: Epoch ms created time.
        time_updated: Epoch ms updated time.
        cost: Total cost.
        tokens_input: Total input tokens.
        tokens_output: Total output tokens.
        tokens_reasoning: Total reasoning tokens.
        tokens_cache_read: Total cache read tokens.
        tokens_cache_write: Total cache write tokens.
        agent: Agent name.
        model: Model name or JSON string.
        project_id: Project ID.

    Returns:
        Dict suitable for ``_create_db(sessions=[...])``.
    """
    return {
        "id": id_,
        "project_id": project_id,
        "parent_id": parent_id,
        "slug": slug,
        "directory": directory,
        "title": title,
        "version": version,
        "time_created": time_created,
        "time_updated": time_updated,
        "cost": cost,
        "tokens_input": tokens_input,
        "tokens_output": tokens_output,
        "tokens_reasoning": tokens_reasoning,
        "tokens_cache_read": tokens_cache_read,
        "tokens_cache_write": tokens_cache_write,
        "agent": agent,
        "model": model,
    }


def _step_finish_data(
    cost: float = 0.0,
    reason: str = "stop",
    tokens_input: int = 78,
    tokens_output: int = 28,
    cache_read: int = 510,
    cache_write: int = 10792,
) -> str:
    """Build a JSON ``data`` string for a step-finish part.

    Args:
        cost: Step cost.
        reason: Finish reason (``"stop"``, ``"tool_use"``, etc.).
        tokens_input: Input tokens.
        tokens_output: Output tokens.
        cache_read: Cache read tokens.
        cache_write: Cache write tokens.

    Returns:
        JSON string with nested ``tokens`` object.
    """
    return json.dumps(
        {
            "type": "step-finish",
            "cost": cost,
            "reason": reason,
            "tokens": {
                "input": tokens_input,
                "output": tokens_output,
                "cache": {"read": cache_read, "write": cache_write},
            },
        }
    )


def _tool_data(
    tool_name: str = "read",
    call_id: str = "call_001",
    state: dict | None = None,
) -> str:
    """Build a JSON ``data`` string for a tool part.

    Args:
        tool_name: Tool name (``"read"``, ``"edit"``, etc.).
        call_id: Tool call ID.
        state: Optional state dict.

    Returns:
        JSON string.
    """
    d: dict = {"type": "tool", "tool": tool_name, "callID": call_id}
    if state is not None:
        d["state"] = state
    return json.dumps(d)


# ── _safe_json_loads tests ────────────────────────────────────────────────


class TestSafeJsonLoads:
    """Tests for ``_safe_json_loads()``."""

    def test_valid_dict(self) -> None:
        """Valid JSON 字典返回解析后的 dict。"""
        result = _safe_json_loads('{"key": "value"}')
        assert result == {"key": "value"}
        assert isinstance(result, dict)

    def test_valid_list(self) -> None:
        """Valid JSON 列表返回解析后的 list。"""
        result = _safe_json_loads("[1, 2, 3]")
        assert result == [1, 2, 3]
        assert isinstance(result, list)

    def test_invalid_json_returns_none(self) -> None:
        """无效 JSON 返回 None，不抛异常。"""
        result = _safe_json_loads("{invalid json}")
        assert result is None

    def test_empty_string_returns_none(self) -> None:
        """空字符串返回 None。"""
        result = _safe_json_loads("")
        assert result is None

    def test_none_input_returns_none(self) -> None:
        """None 输入返回 None（TypeError 被捕获）。"""
        result = _safe_json_loads(None)  # type: ignore[arg-type]
        assert result is None


# ── Tests ─────────────────────────────────────────────────────────────────


def test_empty_session_ids(tmp_path: Path) -> None:
    """Empty session_ids list returns an empty list."""
    db_path = str(tmp_path / "test.db")
    _create_db(db_path)
    result = query_db_messages([], db_path)
    assert result == []


def test_db_file_not_exists(tmp_path: Path) -> None:
    """Non-existent DB file returns an empty list."""
    db_path = str(tmp_path / "nonexistent.db")
    result = query_db_messages(["sess-1"], db_path)
    assert result == []


def test_no_matching_sessions(tmp_path: Path) -> None:
    """DB with no matching session IDs returns an empty list."""
    db_path = str(tmp_path / "test.db")
    _create_db(
        db_path,
        messages=[
            {
                "id": "m1",
                "session_id": "other-sess",
                "time_created": 1_700_000_000_000,
                "data": _msg_data("user", agent="test"),
            },
        ],
        parts=[
            {
                "id": "p1",
                "message_id": "m1",
                "time_created": 1_700_000_000_000,
                "data": _part_data("text", "hello"),
            },
        ],
    )
    result = query_db_messages(["sess-1", "sess-2"], db_path)
    assert result == []


def test_single_user_message(tmp_path: Path) -> None:
    """Single user text message returns one event with type user_msg."""
    db_path = str(tmp_path / "test.db")
    ts = 1_700_000_000_000
    _create_db(
        db_path,
        messages=[
            {
                "id": "m1",
                "session_id": "sess-1",
                "time_created": ts,
                "data": _msg_data("user", agent="build"),
            },
        ],
        parts=[
            {
                "id": "p1",
                "message_id": "m1",
                "time_created": ts,
                "data": _part_data("text", "Hello, can you help?"),
            },
        ],
    )
    result = query_db_messages(["sess-1"], db_path)
    assert len(result) == 1
    ev = result[0]
    assert ev["type"] == "user_msg"
    assert ev["source"] == "db"
    assert ev["icon"] == "👤"
    assert ev["content"] == "Hello, can you help?"
    assert ev["summary"] == "Hello, can you help?"
    assert ev["agent"] == "build"
    assert ev["session_id"] == "sess-1"
    # model should be empty for user messages
    assert ev["model"] == ""


def test_single_assistant_reply(tmp_path: Path) -> None:
    """Single assistant text message returns one event with type
    assistant_reply and includes the model ID."""
    db_path = str(tmp_path / "test.db")
    ts = 1_700_000_000_000
    _create_db(
        db_path,
        messages=[
            {
                "id": "m1",
                "session_id": "sess-1",
                "time_created": ts,
                "data": _msg_data(
                    "assistant", agent="build", model_id="gpt-4"
                ),
            },
        ],
        parts=[
            {
                "id": "p1",
                "message_id": "m1",
                "time_created": ts,
                "data": _part_data("text", "Sure, I can help!"),
            },
        ],
    )
    result = query_db_messages(["sess-1"], db_path)
    assert len(result) == 1
    ev = result[0]
    assert ev["type"] == "assistant_reply"
    assert ev["source"] == "db"
    assert ev["icon"] == "🤖"
    assert ev["content"] == "Sure, I can help!"
    assert ev["summary"] == "Sure, I can help!"
    assert ev["model"] == "gpt-4"
    assert ev["agent"] == "build"
    assert ev["session_id"] == "sess-1"


def test_single_assistant_reasoning(tmp_path: Path) -> None:
    """Single assistant reasoning part returns one event with type
    assistant_reasoning and a 'Reasoning:' prefix in the summary."""
    db_path = str(tmp_path / "test.db")
    ts = 1_700_000_000_000
    _create_db(
        db_path,
        messages=[
            {
                "id": "m1",
                "session_id": "sess-1",
                "time_created": ts,
                "data": _msg_data(
                    "assistant", agent="build", model_id="claude-3"
                ),
            },
        ],
        parts=[
            {
                "id": "p1",
                "message_id": "m1",
                "time_created": ts,
                "data": _part_data("reasoning", "Let me think step by step."),
            },
        ],
    )
    result = query_db_messages(["sess-1"], db_path)
    assert len(result) == 1
    ev = result[0]
    assert ev["type"] == "assistant_reasoning"
    assert ev["icon"] == "🧠"
    assert ev["content"] == "Let me think step by step."
    assert ev["summary"] == "Reasoning: Let me think step by step."
    assert ev["model"] == "claude-3"


def test_synthetic_user_parts_excluded(tmp_path: Path) -> None:
    """User parts with synthetic=true are excluded from results."""
    db_path = str(tmp_path / "test.db")
    ts = 1_700_000_000_000
    _create_db(
        db_path,
        messages=[
            {
                "id": "m1",
                "session_id": "sess-1",
                "time_created": ts,
                "data": _msg_data("user", agent="build"),
            },
        ],
        parts=[
            {
                "id": "p1",
                "message_id": "m1",
                "time_created": ts,
                "data": _part_data("text", "Real user message"),
            },
            {
                "id": "p2",
                "message_id": "m1",
                "time_created": ts + 1,
                "data": _part_data(
                    "text", "Auto-generated tool result", synthetic=True
                ),
            },
        ],
    )
    result = query_db_messages(["sess-1"], db_path)
    # Only the non-synthetic part should appear
    assert len(result) == 1
    assert result[0]["content"] == "Real user message"


def test_empty_text_parts_excluded(tmp_path: Path) -> None:
    """Parts with empty text are excluded from results."""
    db_path = str(tmp_path / "test.db")
    ts = 1_700_000_000_000
    _create_db(
        db_path,
        messages=[
            {
                "id": "m1",
                "session_id": "sess-1",
                "time_created": ts,
                "data": _msg_data("user", agent="build"),
            },
        ],
        parts=[
            {
                "id": "p1",
                "message_id": "m1",
                "time_created": ts,
                "data": _part_data("text", ""),
            },
            {
                "id": "p2",
                "message_id": "m1",
                "time_created": ts + 1,
                "data": _part_data("text", "Non-empty text"),
            },
        ],
    )
    result = query_db_messages(["sess-1"], db_path)
    assert len(result) == 1
    assert result[0]["content"] == "Non-empty text"


def test_non_user_assistant_role_excluded(tmp_path: Path) -> None:
    """Messages with role other than 'user' or 'assistant' are excluded
    (e.g. system messages)."""
    db_path = str(tmp_path / "test.db")
    ts = 1_700_000_000_000
    _create_db(
        db_path,
        messages=[
            {
                "id": "m1",
                "session_id": "sess-1",
                "time_created": ts,
                "data": json.dumps({"role": "system", "agent": ""}),
            },
        ],
        parts=[
            {
                "id": "p1",
                "message_id": "m1",
                "time_created": ts,
                "data": _part_data("text", "System message content"),
            },
        ],
    )
    result = query_db_messages(["sess-1"], db_path)
    assert result == []


def test_multiple_sessions(tmp_path: Path) -> None:
    """Events from multiple sessions are all returned."""
    db_path = str(tmp_path / "test.db")
    ts = 1_700_000_000_000
    _create_db(
        db_path,
        messages=[
            {
                "id": "m1",
                "session_id": "sess-a",
                "time_created": ts,
                "data": _msg_data("user", agent="build"),
            },
            {
                "id": "m2",
                "session_id": "sess-b",
                "time_created": ts + 1000,
                "data": _msg_data("user", agent="explore"),
            },
        ],
        parts=[
            {
                "id": "p1",
                "message_id": "m1",
                "time_created": ts,
                "data": _part_data("text", "Message from session A"),
            },
            {
                "id": "p2",
                "message_id": "m2",
                "time_created": ts + 1000,
                "data": _part_data("text", "Message from session B"),
            },
        ],
    )
    result = query_db_messages(["sess-a", "sess-b"], db_path)
    assert len(result) == 2
    session_ids = {ev["session_id"] for ev in result}
    assert session_ids == {"sess-a", "sess-b"}


def test_content_truncation(tmp_path: Path) -> None:
    """Text longer than 80 characters has a summary ending with '...'."""
    db_path = str(tmp_path / "test.db")
    ts = 1_700_000_000_000
    long_text = "A" * 100
    _create_db(
        db_path,
        messages=[
            {
                "id": "m1",
                "session_id": "sess-1",
                "time_created": ts,
                "data": _msg_data("user", agent="build"),
            },
        ],
        parts=[
            {
                "id": "p1",
                "message_id": "m1",
                "time_created": ts,
                "data": _part_data("text", long_text),
            },
        ],
    )
    result = query_db_messages(["sess-1"], db_path)
    assert len(result) == 1
    ev = result[0]
    # Full content is preserved
    assert ev["content"] == long_text
    # Summary is truncated
    assert ev["summary"] == "A" * 80 + "..."
    assert len(ev["summary"]) == 83


def test_timestamp_conversion(tmp_path: Path) -> None:
    """Timestamp is converted to ISO 8601 format with Z suffix.

    Verifies the output matches the format produced by
    ``datetime.fromtimestamp(ts_ms / 1000, tz=timezone.utc).strftime(...)``
    with a trailing ``Z``.
    """
    from datetime import datetime, timezone

    db_path = str(tmp_path / "test.db")
    ts_ms = 1_705_312_245_123
    expected_dt = datetime.fromtimestamp(ts_ms / 1000.0, tz=timezone.utc)
    expected_ts = (
        expected_dt.strftime("%Y-%m-%dT%H:%M:%S.")
        + f"{expected_dt.microsecond:06d}Z"
    )

    _create_db(
        db_path,
        messages=[
            {
                "id": "m1",
                "session_id": "sess-1",
                "time_created": ts_ms,
                "data": _msg_data("user", agent="build"),
            },
        ],
        parts=[
            {
                "id": "p1",
                "message_id": "m1",
                "time_created": ts_ms,
                "data": _part_data("text", "Hello"),
            },
        ],
    )
    result = query_db_messages(["sess-1"], db_path)
    assert len(result) == 1
    timestamp = result[0]["timestamp"]
    # Must end with Z
    assert timestamp.endswith("Z"), (
        f"Timestamp {timestamp!r} does not end with Z"
    )
    # Must contain a 'T' separator
    assert "T" in timestamp
    assert timestamp == expected_ts, (
        f"Timestamp {timestamp!r} != expected {expected_ts!r}"
    )


def test_agent_field_on_user_messages(tmp_path: Path) -> None:
    """Agent field is present on user messages."""
    db_path = str(tmp_path / "test.db")
    ts = 1_700_000_000_000
    _create_db(
        db_path,
        messages=[
            {
                "id": "m1",
                "session_id": "sess-1",
                "time_created": ts,
                "data": _msg_data("user", agent="spider"),
            },
        ],
        parts=[
            {
                "id": "p1",
                "message_id": "m1",
                "time_created": ts,
                "data": _part_data("text", "User from spider agent"),
            },
        ],
    )
    result = query_db_messages(["sess-1"], db_path)
    assert len(result) == 1
    assert result[0]["agent"] == "spider"
    assert result[0]["type"] == "user_msg"


def test_model_id_on_assistant_not_on_user(tmp_path: Path) -> None:
    """model field is populated for assistant messages but empty for user
    messages."""
    db_path = str(tmp_path / "test.db")
    ts = 1_700_000_000_000
    _create_db(
        db_path,
        messages=[
            {
                "id": "m1",
                "session_id": "sess-1",
                "time_created": ts,
                "data": _msg_data("user", agent="build"),
            },
            {
                "id": "m2",
                "session_id": "sess-1",
                "time_created": ts + 1000,
                "data": _msg_data(
                    "assistant", agent="build", model_id="gpt-4"
                ),
            },
        ],
        parts=[
            {
                "id": "p1",
                "message_id": "m1",
                "time_created": ts,
                "data": _part_data("text", "User says hi"),
            },
            {
                "id": "p2",
                "message_id": "m2",
                "time_created": ts + 1000,
                "data": _part_data("text", "Assistant replies"),
            },
        ],
    )
    result = query_db_messages(["sess-1"], db_path)
    assert len(result) == 2

    user_ev = next(ev for ev in result if ev["type"] == "user_msg")
    assistant_ev = next(ev for ev in result if ev["type"] == "assistant_reply")

    assert user_ev["model"] == "", "User messages should have empty model"
    assert assistant_ev["model"] == "gpt-4", (
        f"Assistant messages should have model set, got {assistant_ev['model']!r}"
    )


def test_reasoning_truncation_still_has_prefix(tmp_path: Path) -> None:
    """Even when reasoning text is truncated, the 'Reasoning:' prefix is
    preserved in the summary."""
    db_path = str(tmp_path / "test.db")
    ts = 1_700_000_000_000
    long_reasoning = "B" * 100
    _create_db(
        db_path,
        messages=[
            {
                "id": "m1",
                "session_id": "sess-1",
                "time_created": ts,
                "data": _msg_data(
                    "assistant", agent="build", model_id="claude-3"
                ),
            },
        ],
        parts=[
            {
                "id": "p1",
                "message_id": "m1",
                "time_created": ts,
                "data": _part_data("reasoning", long_reasoning),
            },
        ],
    )
    result = query_db_messages(["sess-1"], db_path)
    assert len(result) == 1
    ev = result[0]
    assert ev["type"] == "assistant_reasoning"
    assert ev["content"] == long_reasoning
    # Summary starts with "Reasoning: " prefix
    assert ev["summary"].startswith("Reasoning: ")
    # The truncated part is 80 chars of the reasoning text
    assert ev["summary"] == "Reasoning: " + "B" * 80 + "..."
    assert len(ev["summary"]) == 11 + 83  # "Reasoning: " (11) + 83


def test_multiple_parts_same_message(tmp_path: Path) -> None:
    """A single message with multiple parts produces multiple events."""
    db_path = str(tmp_path / "test.db")
    ts = 1_700_000_000_000
    _create_db(
        db_path,
        messages=[
            {
                "id": "m1",
                "session_id": "sess-1",
                "time_created": ts,
                "data": _msg_data(
                    "assistant", agent="build", model_id="claude-3"
                ),
            },
        ],
        parts=[
            {
                "id": "p1",
                "message_id": "m1",
                "time_created": ts,
                "data": _part_data("reasoning", "Chain of thought..."),
            },
            {
                "id": "p2",
                "message_id": "m1",
                "time_created": ts + 1,
                "data": _part_data("text", "Final answer"),
            },
        ],
    )
    result = query_db_messages(["sess-1"], db_path)
    assert len(result) == 2
    types = [ev["type"] for ev in result]
    assert "assistant_reasoning" in types
    assert "assistant_reply" in types


def test_tilde_expansion(tmp_path: Path) -> None:
    """The function expands ~ in db_path via os.path.expanduser."""
    # We cannot easily test this in isolation because it depends on the
    # real home directory. Instead we verify that a non-existent tilde
    # path returns [] without crashing.
    result = query_db_messages(["sess-1"], "~/__nonexistent_zoo_test_db__.db")
    assert result == []


def test_default_db_path_is_tilde_expanded() -> None:
    """The default db_path argument is provided but we only verify
    that calling with no db_path does not crash when the default
    path does not exist (no real DB in CI)."""
    result = query_db_messages(["sess-1"])
    assert result == []


def test_assistant_reasoning_no_model_gives_empty_string(
    tmp_path: Path,
) -> None:
    """When modelID is missing from assistant reasoning event, model is
    empty string (not None)."""
    db_path = str(tmp_path / "test.db")
    ts = 1_700_000_000_000
    _create_db(
        db_path,
        messages=[
            {
                "id": "m1",
                "session_id": "sess-1",
                "time_created": ts,
                "data": _msg_data("assistant", agent="build"),  # no model_id
            },
        ],
        parts=[
            {
                "id": "p1",
                "message_id": "m1",
                "time_created": ts,
                "data": _part_data("reasoning", "Thinking..."),
            },
        ],
    )
    result = query_db_messages(["sess-1"], db_path)
    assert len(result) == 1
    assert result[0]["model"] == ""


# ── query_sessions tests ─────────────────────────────────────────────────


def test_query_sessions_happy_path(tmp_path: Path) -> None:
    """Keyword search finds matching top-level sessions."""
    db_path = str(tmp_path / "test.db")
    _create_db(
        db_path,
        sessions=[
            _session_data("sess-a", title="Build the project"),
            _session_data("sess-b", title="Deploy the app"),
        ],
    )
    results = query_sessions("Build", db_path)
    assert len(results) == 1
    assert results[0]["id"] == "sess-a"
    assert results[0]["title"] == "Build the project"


def test_query_sessions_no_match(tmp_path: Path) -> None:
    """Non-matching keyword returns empty list."""
    db_path = str(tmp_path / "test.db")
    _create_db(
        db_path,
        sessions=[_session_data("sess-a", title="Build the project")],
    )
    results = query_sessions("Nonexistent", db_path)
    assert results == []


def test_query_sessions_db_not_exists(tmp_path: Path) -> None:
    """Non-existent DB file returns empty list."""
    results = query_sessions("test", str(tmp_path / "nope.db"))
    assert results == []


def test_query_sessions_only_top_level(tmp_path: Path) -> None:
    """Child sessions (parent_id IS NOT NULL) are excluded."""
    db_path = str(tmp_path / "test.db")
    _create_db(
        db_path,
        sessions=[
            _session_data("parent", title="Parent session"),
            _session_data("child", title="Child session", parent_id="parent"),
        ],
    )
    results = query_sessions("session", db_path)
    assert len(results) == 1
    assert results[0]["id"] == "parent"


def test_query_sessions_limit(tmp_path: Path) -> None:
    """Limit parameter caps the number of returned sessions."""
    db_path = str(tmp_path / "test.db")
    sessions = [
        _session_data(
            f"sess-{i}",
            title=f"Session {i}",
            time_updated=1_700_000_000_000 + i,
        )
        for i in range(5)
    ]
    _create_db(db_path, sessions=sessions)
    results = query_sessions("Session", db_path, limit=2)
    assert len(results) == 2


def test_query_sessions_empty_keyword(tmp_path: Path) -> None:
    """Empty keyword matches all top-level sessions."""
    db_path = str(tmp_path / "test.db")
    _create_db(
        db_path,
        sessions=[
            _session_data("sess-a", title="First"),
            _session_data("sess-b", title="Second"),
        ],
    )
    results = query_sessions("", db_path)
    assert len(results) == 2


# ── query_sessions_all tests ──────────────────────────────────────────────


def test_query_sessions_all_top_level_only(tmp_path: Path) -> None:
    """Default (include_children=False) returns only top-level sessions."""
    db_path = str(tmp_path / "test.db")
    _create_db(
        db_path,
        sessions=[
            _session_data("parent", title="Parent"),
            _session_data("child", title="Child", parent_id="parent"),
        ],
    )
    results = query_sessions_all(db_path)
    assert len(results) == 1
    assert results[0]["id"] == "parent"


def test_query_sessions_all_include_children(tmp_path: Path) -> None:
    """include_children=True returns all sessions including children."""
    db_path = str(tmp_path / "test.db")
    _create_db(
        db_path,
        sessions=[
            _session_data("parent", title="Parent"),
            _session_data("child", title="Child", parent_id="parent"),
        ],
    )
    results = query_sessions_all(db_path, include_children=True)
    assert len(results) == 2
    ids = {r["id"] for r in results}
    assert ids == {"parent", "child"}


def test_query_sessions_all_limit(tmp_path: Path) -> None:
    """Limit parameter caps the number of returned sessions."""
    db_path = str(tmp_path / "test.db")
    sessions = [
        _session_data(
            f"s-{i}",
            title=f"S{i}",
            time_updated=1_700_000_000_000 + i,
        )
        for i in range(10)
    ]
    _create_db(db_path, sessions=sessions)
    results = query_sessions_all(db_path, limit=3)
    assert len(results) == 3


def test_query_sessions_all_empty_db(tmp_path: Path) -> None:
    """Empty database returns empty list."""
    db_path = str(tmp_path / "empty.db")
    _create_db(db_path, sessions=[])
    results = query_sessions_all(db_path)
    assert results == []


def test_query_sessions_all_db_not_exists(tmp_path: Path) -> None:
    """Non-existent DB file returns empty list."""
    results = query_sessions_all(str(tmp_path / "nope.db"))
    assert results == []


# ── query_sessions_exact tests ────────────────────────────────────────────


def test_query_sessions_exact_match(tmp_path: Path) -> None:
    """Exact title match returns the correct session."""
    db_path = str(tmp_path / "test.db")
    _create_db(
        db_path,
        sessions=[
            _session_data("sess-a", title="My Exact Title"),
            _session_data("sess-b", title="Different Title"),
        ],
    )
    results = query_sessions_exact("My Exact Title", db_path)
    assert len(results) == 1
    assert results[0]["id"] == "sess-a"


def test_query_sessions_exact_no_match(tmp_path: Path) -> None:
    """No exact match returns empty list."""
    db_path = str(tmp_path / "test.db")
    _create_db(
        db_path,
        sessions=[_session_data("sess-a", title="Some Title")],
    )
    results = query_sessions_exact("Nonexistent", db_path)
    assert results == []


def test_query_sessions_exact_multiple_matches(tmp_path: Path) -> None:
    """Multiple sessions with the same title are all returned."""
    db_path = str(tmp_path / "test.db")
    _create_db(
        db_path,
        sessions=[
            _session_data("sess-a", title="Duplicate Title", time_created=100),
            _session_data("sess-b", title="Duplicate Title", time_created=200),
        ],
    )
    results = query_sessions_exact("Duplicate Title", db_path)
    assert len(results) == 2


def test_query_sessions_exact_db_not_exists(tmp_path: Path) -> None:
    """Non-existent DB file returns empty list."""
    results = query_sessions_exact("title", str(tmp_path / "nope.db"))
    assert results == []


# ── query_recent_sessions tests ───────────────────────────────────────────


def test_query_recent_sessions_happy_path(tmp_path: Path) -> None:
    """Returns N most recently updated sessions."""
    db_path = str(tmp_path / "test.db")
    sessions = [
        _session_data(
            f"s-{i}",
            title=f"S{i}",
            time_updated=1_700_000_000_000 + i,
        )
        for i in range(5)
    ]
    _create_db(db_path, sessions=sessions)
    results = query_recent_sessions(3, db_path)
    # Most recent 3 by time_updated DESC: s-4, s-3, s-2
    assert len(results) == 3
    assert results[0]["id"] == "s-4"
    assert results[1]["id"] == "s-3"
    assert results[2]["id"] == "s-2"


def test_query_recent_sessions_include_children(tmp_path: Path) -> None:
    """include_children=True includes child sessions."""
    db_path = str(tmp_path / "test.db")
    _create_db(
        db_path,
        sessions=[
            _session_data("parent", title="Parent", time_updated=100),
            _session_data(
                "child",
                title="Child",
                parent_id="parent",
                time_updated=200,
            ),
        ],
    )
    results_default = query_recent_sessions(5, db_path)
    assert len(results_default) == 1
    results_with = query_recent_sessions(5, db_path, include_children=True)
    assert len(results_with) == 2


def test_query_recent_sessions_empty_db(tmp_path: Path) -> None:
    """Empty database returns empty list."""
    db_path = str(tmp_path / "empty.db")
    _create_db(db_path, sessions=[])
    results = query_recent_sessions(5, db_path)
    assert results == []


def test_query_recent_sessions_db_not_exists(tmp_path: Path) -> None:
    """Non-existent DB file returns empty list."""
    results = query_recent_sessions(5, str(tmp_path / "nope.db"))
    assert results == []


# ── query_message_by_ids tests ────────────────────────────────────────────


def test_query_message_by_ids_with_session(tmp_path: Path) -> None:
    """Known message IDs with session_id scope return correct messages."""
    db_path = str(tmp_path / "test.db")
    ts = 1_700_000_000_000
    _create_db(
        db_path,
        messages=[
            {
                "id": "m1",
                "session_id": "sess-1",
                "time_created": ts,
                "data": _msg_data("user", agent="build"),
            },
            {
                "id": "m2",
                "session_id": "sess-1",
                "time_created": ts + 1000,
                "data": _msg_data("assistant", agent="build"),
            },
        ],
        parts=[
            {
                "id": "p1",
                "message_id": "m1",
                "time_created": ts,
                "data": _part_data("text", "Hello"),
            },
            {
                "id": "p2",
                "message_id": "m2",
                "time_created": ts + 1000,
                "data": _part_data("text", "World"),
            },
        ],
    )
    results = query_message_by_ids(
        ["m1", "m2"], session_id="sess-1", db_path=db_path
    )
    assert len(results) == 2
    msg_ids = {r["id"] for r in results}
    assert msg_ids == {"m1", "m2"}
    assert results[0]["role"] == "user"
    assert results[1]["role"] == "assistant"


def test_query_message_by_ids_empty_ids(tmp_path: Path) -> None:
    """Empty msg_ids list returns empty list."""
    db_path = str(tmp_path / "test.db")
    _create_db(db_path)
    results = query_message_by_ids([], db_path=db_path)
    assert results == []


def test_query_message_by_ids_no_match(tmp_path: Path) -> None:
    """IDs not present in the DB return empty list."""
    db_path = str(tmp_path / "test.db")
    _create_db(db_path)
    results = query_message_by_ids(
        ["nonexistent"], session_id="sess-1", db_path=db_path
    )
    assert results == []


def test_query_message_by_ids_prefix_match(tmp_path: Path) -> None:
    """Truncated message ID prefix finds the full message via LIKE fallback."""
    db_path = str(tmp_path / "test.db")
    ts = 1_700_000_000_000
    _create_db(
        db_path,
        messages=[
            {
                "id": "msg_abcdef123456",
                "session_id": "sess-pre",
                "time_created": ts,
                "data": _msg_data("user", agent="build"),
            },
        ],
        parts=[
            {
                "id": "p1",
                "message_id": "msg_abcdef123456",
                "time_created": ts,
                "data": _part_data("text", "Prefix match test"),
            },
        ],
    )
    # Exact query for truncated ID should return nothing, then LIKE
    # fallback matches.
    results = query_message_by_ids(
        ["msg_abc"], session_id="sess-pre", db_path=db_path
    )
    assert len(results) == 1
    assert results[0]["id"] == "msg_abcdef123456"


def test_query_message_by_ids_prefix_match_no_session(
    tmp_path: Path,
) -> None:
    """Prefix matching also works without session_id scope."""
    db_path = str(tmp_path / "test.db")
    ts = 1_700_000_000_000
    _create_db(
        db_path,
        sessions=[_session_data("sess-scan-pre", title="Prefix scan")],
        messages=[
            {
                "id": "msg_xyz789",
                "session_id": "sess-scan-pre",
                "time_created": ts,
                "data": _msg_data("user", agent="explore"),
            },
        ],
        parts=[
            {
                "id": "p1",
                "message_id": "msg_xyz789",
                "time_created": ts,
                "data": _part_data("text", "No session scope"),
            },
        ],
    )
    results = query_message_by_ids(["msg_xyz"], db_path=db_path)
    assert len(results) == 1
    assert results[0]["id"] == "msg_xyz789"


def test_query_message_by_ids_db_not_exists(tmp_path: Path) -> None:
    """Non-existent DB file returns empty list."""
    results = query_message_by_ids(
        ["m1"], session_id="sess-1", db_path=str(tmp_path / "nope.db")
    )
    assert results == []


def test_query_message_by_ids_no_session_scope(tmp_path: Path) -> None:
    """Without session_id, it scans recent sessions from session table."""
    db_path = str(tmp_path / "test.db")
    ts = 1_700_000_000_000
    _create_db(
        db_path,
        sessions=[_session_data("sess-scan", title="Scan target")],
        messages=[
            {
                "id": "m-scan",
                "session_id": "sess-scan",
                "time_created": ts,
                "data": _msg_data("user", agent="build"),
            },
        ],
        parts=[
            {
                "id": "p-scan",
                "message_id": "m-scan",
                "time_created": ts,
                "data": _part_data("text", "Scanned message"),
            },
        ],
    )
    results = query_message_by_ids(["m-scan"], db_path=db_path)
    assert len(results) == 1
    assert results[0]["id"] == "m-scan"


def test_query_message_by_ids_tokens_from_step_finish(tmp_path: Path) -> None:
    """Tokens are extracted from step-finish when message.data has none."""
    db_path = str(tmp_path / "test.db")
    ts = 1_700_000_000_000
    _create_db(
        db_path,
        messages=[
            {
                "id": "m1",
                "session_id": "sess-1",
                "time_created": ts,
                # No tokens in msg_data
                "data": json.dumps({"role": "assistant", "agent": "build"}),
            },
        ],
        parts=[
            {
                "id": "p1",
                "message_id": "m1",
                "time_created": ts,
                "data": _step_finish_data(tokens_input=50, tokens_output=25),
            },
        ],
    )
    results = query_message_by_ids(
        ["m1"], session_id="sess-1", db_path=db_path
    )
    assert len(results) == 1
    assert results[0]["tokens"] == 75  # input(50) + output(25)


def test_query_message_by_ids_tokens_from_message_data(
    tmp_path: Path,
) -> None:
    """Tokens are extracted from message.data.tokens when present."""
    db_path = str(tmp_path / "test.db")
    ts = 1_700_000_000_000
    _create_db(
        db_path,
        messages=[
            {
                "id": "m1",
                "session_id": "sess-1",
                "time_created": ts,
                "data": json.dumps(
                    {
                        "role": "assistant",
                        "agent": "build",
                        "tokens": {"input": 200, "output": 100},
                    }
                ),
            },
        ],
        parts=[
            {
                "id": "p1",
                "message_id": "m1",
                "time_created": ts,
                "data": _part_data("text", "Has tokens in msg data"),
            },
        ],
    )
    results = query_message_by_ids(
        ["m1"], session_id="sess-1", db_path=db_path
    )
    assert len(results) == 1
    # input(200) + output(100) = 300
    assert results[0]["tokens"] == 300


def test_query_message_by_ids_multiple_parts(tmp_path: Path) -> None:
    """Message with multiple parts returns all parts in order."""
    db_path = str(tmp_path / "test.db")
    ts = 1_700_000_000_000
    _create_db(
        db_path,
        messages=[
            {
                "id": "m1",
                "session_id": "sess-1",
                "time_created": ts,
                "data": _msg_data("assistant", agent="build"),
            },
        ],
        parts=[
            {
                "id": "p1",
                "message_id": "m1",
                "time_created": ts,
                "data": _part_data("reasoning", "Let me think"),
            },
            {
                "id": "p2",
                "message_id": "m1",
                "time_created": ts + 1,
                "data": _part_data("text", "Final answer"),
            },
        ],
    )
    results = query_message_by_ids(
        ["m1"], session_id="sess-1", db_path=db_path
    )
    assert len(results) == 1
    parts = results[0]["parts"]
    assert len(parts) == 2
    assert parts[0]["type"] == "reasoning"
    assert parts[1]["type"] == "text"


# ── query_step_data tests ─────────────────────────────────────────────────


def test_query_step_data_happy_path(tmp_path: Path) -> None:
    """Step-finish and tool parts are associated by message_id."""
    db_path = str(tmp_path / "test.db")
    ts = 1_700_000_000_000
    _create_db(
        db_path,
        parts=[
            {
                "id": "p1",
                "message_id": "m1",
                "session_id": "sess-step",
                "time_created": ts,
                "time_updated": ts + 100,
                "data": _step_finish_data(
                    cost=0.005,
                    reason="stop",
                    tokens_input=100,
                    tokens_output=50,
                    cache_read=200,
                    cache_write=300,
                ),
            },
            {
                "id": "p2",
                "message_id": "m1",
                "session_id": "sess-step",
                "time_created": ts + 1,
                "data": _tool_data("read", "call_001"),
            },
            {
                "id": "p3",
                "message_id": "m2",
                "session_id": "sess-step",
                "time_created": ts + 200,
                "time_updated": ts + 300,
                "data": _step_finish_data(
                    cost=0.003,
                    reason="tool_use",
                    tokens_input=50,
                    tokens_output=25,
                    cache_read=100,
                    cache_write=150,
                ),
            },
            {
                "id": "p4",
                "message_id": "m2",
                "session_id": "sess-step",
                "time_created": ts + 201,
                "data": _tool_data("edit", "call_002"),
            },
            {
                "id": "p5",
                "message_id": "m2",
                "session_id": "sess-step",
                "time_created": ts + 202,
                "data": _tool_data("read", "call_003"),
            },
            # Part from a different session — should not appear
            {
                "id": "p99",
                "message_id": "m99",
                "session_id": "other-sess",
                "time_created": ts,
                "data": _step_finish_data(),
            },
        ],
    )
    results = query_step_data("sess-step", db_path)
    assert len(results) == 2

    # First step
    s1 = results[0]
    assert s1["step_index"] == 1
    assert s1["message_id"] == "m1"
    assert s1["input_tokens"] == 100
    assert s1["output_tokens"] == 50
    assert s1["cache_read"] == 200
    assert s1["cache_write"] == 300
    assert s1["cost"] == 0.005
    assert s1["reason"] == "stop"
    assert s1["tools"] == ["read"]
    assert s1["time_created"].endswith("Z")
    assert s1["time_updated"].endswith("Z")

    # Second step
    s2 = results[1]
    assert s2["step_index"] == 2
    assert s2["message_id"] == "m2"
    assert s2["input_tokens"] == 50
    assert s2["output_tokens"] == 25
    assert s2["cost"] == 0.003
    assert s2["reason"] == "tool_use"
    # Two tools: edit and read (ordered by time_created)
    assert s2["tools"] == ["edit", "read"]


def test_query_step_data_no_step_finish(tmp_path: Path) -> None:
    """Session with no step-finish parts returns empty list."""
    db_path = str(tmp_path / "test.db")
    _create_db(
        db_path,
        parts=[
            {
                "id": "p1",
                "message_id": "m1",
                "session_id": "sess-empty",
                "time_created": 1_700_000_000_000,
                "data": _tool_data("read"),
            },
        ],
    )
    results = query_step_data("sess-empty", db_path)
    assert results == []


def test_query_step_data_db_not_exists(tmp_path: Path) -> None:
    """Non-existent DB file returns empty list."""
    results = query_step_data("sess-1", str(tmp_path / "nope.db"))
    assert results == []


def test_query_step_data_no_matching_session(tmp_path: Path) -> None:
    """Session ID with no parts returns empty list."""
    db_path = str(tmp_path / "test.db")
    _create_db(db_path)
    results = query_step_data("nonexistent", db_path)
    assert results == []


def test_query_step_data_missing_timestamps(tmp_path: Path) -> None:
    """Step-finish with NULL time_updated returns empty string for it."""
    db_path = str(tmp_path / "test.db")
    ts = 1_700_000_000_000
    _create_db(
        db_path,
        parts=[
            {
                "id": "p1",
                "message_id": "m1",
                "session_id": "sess-ts",
                "time_created": ts,
                # time_updated omitted → NULL
                "data": _step_finish_data(cost=0.001, reason="stop"),
            },
        ],
    )
    results = query_step_data("sess-ts", db_path)
    assert len(results) == 1
    # time_updated is NULL → converted to ""
    assert results[0]["time_updated"] == ""


def test_query_step_data_msg_time_fields(tmp_path: Path) -> None:
    """Step dicts include msg_time_created/msg_time_completed from
    the parent message's data.time."""

    def _msg_data_with_time(
        role: str,
        agent: str = "",
        model_id: str | None = None,
        time_created: int | None = None,
        time_completed: int | None = None,
    ) -> str:
        d: dict = {"role": role, "agent": agent}
        if model_id is not None:
            d["modelID"] = model_id
        if time_created is not None or time_completed is not None:
            d["time"] = {}
            if time_created is not None:
                d["time"]["created"] = time_created
            if time_completed is not None:
                d["time"]["completed"] = time_completed
        return json.dumps(d)

    db_path = str(tmp_path / "test.db")
    ts = 1_700_000_000_000
    _create_db(
        db_path,
        messages=[
            {
                "id": "m1",
                "session_id": "sess-msg-time",
                "time_created": ts,
                "data": _msg_data_with_time(
                    "assistant",
                    agent="build",
                    time_created=1_000_000,
                    time_completed=1_009_000,
                ),
            },
            {
                "id": "m2",
                "session_id": "sess-msg-time",
                "time_created": ts + 200,
                "data": _msg_data_with_time(
                    "assistant",
                    agent="build",
                    # No time data on this message
                ),
            },
        ],
        parts=[
            {
                "id": "p1",
                "message_id": "m1",
                "session_id": "sess-msg-time",
                "time_created": ts,
                "time_updated": ts + 100,
                "data": _step_finish_data(
                    cost=0.005,
                    reason="stop",
                    tokens_input=100,
                    tokens_output=50,
                ),
            },
            {
                "id": "p2",
                "message_id": "m2",
                "session_id": "sess-msg-time",
                "time_created": ts + 200,
                "time_updated": ts + 300,
                "data": _step_finish_data(
                    cost=0.003,
                    reason="tool_use",
                    tokens_input=50,
                    tokens_output=25,
                ),
            },
        ],
    )
    results = query_step_data("sess-msg-time", db_path)
    assert len(results) == 2

    # Step 1: has time data in message
    s1 = results[0]
    assert s1["message_id"] == "m1"
    assert s1["msg_time_created"] == 1_000_000
    assert s1["msg_time_completed"] == 1_009_000

    # Step 2: no time data in message → None
    s2 = results[1]
    assert s2["message_id"] == "m2"
    assert s2["msg_time_created"] is None
    assert s2["msg_time_completed"] is None


def test_query_step_data_batch_happy_path(tmp_path: Path) -> None:
    """批量查询返回与逐个查询相同的结果。"""
    db_path = str(tmp_path / "test.db")
    ts = 1_700_000_000_000
    _create_db(
        db_path,
        parts=[
            # Session A: 2 steps
            {
                "id": "p1",
                "message_id": "m1",
                "session_id": "sess-a",
                "time_created": ts,
                "time_updated": ts + 100,
                "data": _step_finish_data(
                    cost=0.005,
                    reason="stop",
                    tokens_input=100,
                    tokens_output=50,
                    cache_read=200,
                    cache_write=300,
                ),
            },
            {
                "id": "p2",
                "message_id": "m1",
                "session_id": "sess-a",
                "time_created": ts + 1,
                "data": _tool_data("read", "call_001"),
            },
            {
                "id": "p3",
                "message_id": "m2",
                "session_id": "sess-a",
                "time_created": ts + 200,
                "time_updated": ts + 300,
                "data": _step_finish_data(
                    cost=0.003,
                    reason="tool_use",
                    tokens_input=50,
                    tokens_output=25,
                    cache_read=100,
                    cache_write=150,
                ),
            },
            {
                "id": "p4",
                "message_id": "m2",
                "session_id": "sess-a",
                "time_created": ts + 201,
                "data": _tool_data("edit", "call_002"),
            },
            {
                "id": "p5",
                "message_id": "m2",
                "session_id": "sess-a",
                "time_created": ts + 202,
                "data": _tool_data("read", "call_003"),
            },
            # Session B: 1 step
            {
                "id": "p6",
                "message_id": "m3",
                "session_id": "sess-b",
                "time_created": ts + 500,
                "time_updated": ts + 600,
                "data": _step_finish_data(
                    cost=0.001,
                    reason="stop",
                    tokens_input=30,
                    tokens_output=10,
                    cache_read=50,
                    cache_write=80,
                ),
            },
            # Session C: no step-finish parts
            {
                "id": "p7",
                "message_id": "m4",
                "session_id": "sess-c",
                "time_created": ts + 700,
                "data": _tool_data("bash", "call_004"),
            },
        ],
    )

    # Batch query for all sessions
    batch_results = query_step_data_batch(
        ["sess-a", "sess-b", "sess-c"], db_path
    )

    # Verify structure and counts
    # sess-a: 2 steps, sess-b: 1 step, sess-c: 0 steps = 3 total
    assert len(batch_results) == 3

    # Each result should have session_id field
    for r in batch_results:
        assert "session_id" in r, f"Missing session_id in {r}"

    # Group by session_id
    by_sid: dict[str, list[dict]] = {}
    for r in batch_results:
        by_sid.setdefault(r["session_id"], []).append(r)

    assert set(by_sid.keys()) == {"sess-a", "sess-b"}
    assert len(by_sid["sess-a"]) == 2
    assert len(by_sid["sess-b"]) == 1

    # Verify individual step data matches query_step_data
    for sid in ("sess-a", "sess-b"):
        expected = query_step_data(sid, db_path)
        actual = by_sid[sid]
        assert len(expected) == len(actual)
        for e, a in zip(expected, actual):
            for key in e:
                assert a[key] == e[key], (
                    f"Mismatch for {sid} step key {key!r}: "
                    f"expected {e[key]!r}, got {a[key]!r}"
                )

    # sess-a step 1
    a1 = by_sid["sess-a"][0]
    assert a1["step_index"] == 1
    assert a1["message_id"] == "m1"
    assert a1["input_tokens"] == 100
    assert a1["output_tokens"] == 50
    assert a1["cache_read"] == 200
    assert a1["cache_write"] == 300
    assert a1["cost"] == 0.005
    assert a1["reason"] == "stop"
    assert a1["tools"] == ["read"]

    # sess-a step 2
    a2 = by_sid["sess-a"][1]
    assert a2["step_index"] == 2
    assert a2["message_id"] == "m2"
    assert a2["tools"] == ["edit", "read"]

    # sess-b step 1
    b1 = by_sid["sess-b"][0]
    assert b1["step_index"] == 1
    assert b1["message_id"] == "m3"
    assert b1["input_tokens"] == 30
    assert b1["output_tokens"] == 10


def test_query_step_data_batch_empty_ids(tmp_path: Path) -> None:
    """空 session ID 列表返回空列表。"""
    db_path = str(tmp_path / "test.db")
    _create_db(db_path)
    results = query_step_data_batch([], db_path)
    assert results == []


def test_query_step_data_batch_db_not_exists(tmp_path: Path) -> None:
    """不存在的 DB 文件返回空列表。"""
    results = query_step_data_batch(["sess-a"], str(tmp_path / "nope.db"))
    assert results == []


def test_query_step_data_batch_no_matching_sessions(tmp_path: Path) -> None:
    """不存在的 session ID 返回空列表。"""
    db_path = str(tmp_path / "test.db")
    _create_db(db_path)
    results = query_step_data_batch(["nonexistent"], db_path)
    assert results == []


def test_query_step_data_batch_msg_time_fields(tmp_path: Path) -> None:
    """批量查询中 msg_time_created/msg_time_completed 字段正确。"""

    def _msg_data_with_time(
        role: str,
        agent: str = "",
        time_created: int | None = None,
        time_completed: int | None = None,
    ) -> str:
        d: dict = {"role": role, "agent": agent}
        if time_created is not None or time_completed is not None:
            d["time"] = {}
            if time_created is not None:
                d["time"]["created"] = time_created
            if time_completed is not None:
                d["time"]["completed"] = time_completed
        return json.dumps(d)

    db_path = str(tmp_path / "test.db")
    ts = 1_700_000_000_000
    _create_db(
        db_path,
        messages=[
            {
                "id": "m1",
                "session_id": "sess-msg",
                "time_created": ts,
                "data": _msg_data_with_time(
                    "assistant",
                    agent="build",
                    time_created=1_000_000,
                    time_completed=1_009_000,
                ),
            },
            {
                "id": "m2",
                "session_id": "sess-msg",
                "time_created": ts + 200,
                "data": _msg_data_with_time(
                    "assistant",
                    agent="build",
                ),
            },
        ],
        parts=[
            {
                "id": "p1",
                "message_id": "m1",
                "session_id": "sess-msg",
                "time_created": ts,
                "time_updated": ts + 100,
                "data": _step_finish_data(
                    cost=0.005,
                    reason="stop",
                    tokens_input=100,
                    tokens_output=50,
                ),
            },
            {
                "id": "p2",
                "message_id": "m2",
                "session_id": "sess-msg",
                "time_created": ts + 200,
                "time_updated": ts + 300,
                "data": _step_finish_data(
                    cost=0.003,
                    reason="tool_use",
                    tokens_input=50,
                    tokens_output=25,
                ),
            },
        ],
    )

    results = query_step_data_batch(["sess-msg"], db_path)
    assert len(results) == 2

    s1 = results[0]
    assert s1["message_id"] == "m1"
    assert s1["msg_time_created"] == 1_000_000
    assert s1["msg_time_completed"] == 1_009_000

    s2 = results[1]
    assert s2["message_id"] == "m2"
    assert s2["msg_time_created"] is None
    assert s2["msg_time_completed"] is None


# ── query_tool_durations tests ───────────────────────────────────────────


def test_query_tool_durations_happy_path(tmp_path: Path) -> None:
    """Tool parts with state.time.start and state.time.end return durations."""
    db_path = str(tmp_path / "test.db")
    ts = 1_700_000_000_000
    _create_db(
        db_path,
        parts=[
            {
                "id": "p1",
                "message_id": "m1",
                "session_id": "sess-dur",
                "time_created": ts,
                "data": _tool_data(
                    "read",
                    "call_001",
                    state={"time": {"start": 1_000_000, "end": 1_005_000}},
                ),
            },
        ],
    )
    results = query_tool_durations("sess-dur", db_path)
    assert len(results) == 1
    r = results[0]
    assert r["tool_name"] == "read"
    assert r["time_start"] == 1_000_000
    assert r["time_end"] == 1_005_000
    # duration_sec = (end - start) / 1000.0
    assert r["duration_sec"] == 5.0


def test_query_tool_durations_skips_without_state_time(
    tmp_path: Path,
) -> None:
    """Tool parts without state.time are skipped (empty result)."""
    db_path = str(tmp_path / "test.db")
    ts = 1_700_000_000_000
    _create_db(
        db_path,
        parts=[
            {
                "id": "p1",
                "message_id": "m1",
                "session_id": "sess-dur",
                "time_created": ts,
                # No state at all
                "data": _tool_data("read", "call_001"),
            },
            {
                "id": "p2",
                "message_id": "m2",
                "session_id": "sess-dur",
                "time_created": ts + 100,
                # state present but no time
                "data": _tool_data(
                    "edit",
                    "call_002",
                    state={"status": "running"},
                ),
            },
        ],
    )
    results = query_tool_durations("sess-dur", db_path)
    assert results == []


def test_query_tool_durations_skips_none_tool_name(tmp_path: Path) -> None:
    """Parts with null/empty tool_name are skipped."""
    db_path = str(tmp_path / "test.db")
    ts = 1_700_000_000_000
    _create_db(
        db_path,
        parts=[
            {
                "id": "p1",
                "message_id": "m1",
                "session_id": "sess-dur",
                "time_created": ts,
                # tool is null in JSON
                "data": json.dumps(
                    {
                        "type": "tool",
                        "tool": None,
                        "callID": "call_001",
                        "state": {
                            "time": {"start": 1_000_000, "end": 1_005_000}
                        },
                    }
                ),
            },
            {
                "id": "p2",
                "message_id": "m2",
                "session_id": "sess-dur",
                "time_created": ts + 100,
                # tool is empty string
                "data": json.dumps(
                    {
                        "type": "tool",
                        "tool": "",
                        "callID": "call_002",
                        "state": {
                            "time": {"start": 2_000_000, "end": 2_003_000}
                        },
                    }
                ),
            },
        ],
    )
    results = query_tool_durations("sess-dur", db_path)
    assert results == []


def test_query_tool_durations_negative_time_allowed_and_warns(
    tmp_path: Path,
) -> None:
    """Parts where end < start are still returned (negative duration_sec).

    The function does not filter out reversed timestamps; it computes
    (end - start) / 1000.0 which may be negative.
    """
    db_path = str(tmp_path / "test.db")
    ts = 1_700_000_000_000
    _create_db(
        db_path,
        parts=[
            {
                "id": "p1",
                "message_id": "m1",
                "session_id": "sess-dur",
                "time_created": ts,
                "data": _tool_data(
                    "read",
                    "call_001",
                    state={"time": {"start": 1_000_000, "end": 999_000}},
                ),
            },
        ],
    )
    results = query_tool_durations("sess-dur", db_path)
    # The entry IS returned even with reversed time (behavior not filtered)
    assert len(results) == 1
    assert results[0]["duration_sec"] == -1.0


def test_query_tool_durations_multiple_parts(tmp_path: Path) -> None:
    """Multiple tool parts with valid time are all returned."""
    db_path = str(tmp_path / "test.db")
    ts = 1_700_000_000_000
    _create_db(
        db_path,
        parts=[
            {
                "id": "p1",
                "message_id": "m1",
                "session_id": "sess-dur",
                "time_created": ts,
                "data": _tool_data(
                    "read",
                    "call_001",
                    state={"time": {"start": 1_000_000, "end": 1_005_000}},
                ),
            },
            {
                "id": "p2",
                "message_id": "m1",
                "session_id": "sess-dur",
                "time_created": ts + 100,
                "data": _tool_data(
                    "edit",
                    "call_002",
                    state={"time": {"start": 2_000_000, "end": 2_010_000}},
                ),
            },
            {
                "id": "p3",
                "message_id": "m2",
                "session_id": "sess-dur",
                "time_created": ts + 200,
                "data": _tool_data(
                    "bash",
                    "call_003",
                    state={"time": {"start": 3_000_000, "end": 3_002_500}},
                ),
            },
        ],
    )
    results = query_tool_durations("sess-dur", db_path)
    assert len(results) == 3
    assert results[0]["tool_name"] == "read"
    assert results[0]["duration_sec"] == 5.0
    assert results[1]["tool_name"] == "edit"
    assert results[1]["duration_sec"] == 10.0
    assert results[2]["tool_name"] == "bash"
    assert results[2]["duration_sec"] == 2.5


def test_query_tool_durations_no_match(tmp_path: Path) -> None:
    """Session with no tool parts returns empty list."""
    db_path = str(tmp_path / "test.db")
    _create_db(db_path)
    results = query_tool_durations("nonexistent", db_path)
    assert results == []


def test_query_tool_durations_db_not_exists(tmp_path: Path) -> None:
    """Non-existent DB file returns empty list."""
    results = query_tool_durations("sess-1", str(tmp_path / "nope.db"))
    assert results == []


# ── query_tool_durations_batch tests ───────────────────────────────────────


class TestQueryToolDurationsBatch:
    """Tests for ``query_tool_durations_batch()``."""

    def test_happy_path(self, tmp_path: Path) -> None:
        """多 session 包含带时间状态的 tool 部件返回正确的列表。"""
        db_path = str(tmp_path / "test.db")
        ts = 1_700_000_000_000
        _create_db(
            db_path,
            parts=[
                {
                    "id": "p1",
                    "message_id": "m1",
                    "session_id": "sess-a",
                    "time_created": ts,
                    "data": _tool_data(
                        "read",
                        "call_001",
                        state={"time": {"start": 1_000, "end": 5_000}},
                    ),
                },
                {
                    "id": "p2",
                    "message_id": "m2",
                    "session_id": "sess-a",
                    "time_created": ts + 100,
                    "data": _tool_data(
                        "bash",
                        "call_002",
                        state={"time": {"start": 6_000, "end": 12_000}},
                    ),
                },
                {
                    "id": "p3",
                    "message_id": "m3",
                    "session_id": "sess-b",
                    "time_created": ts + 200,
                    "data": _tool_data(
                        "edit",
                        "call_003",
                        state={"time": {"start": 2_000, "end": 4_000}},
                    ),
                },
            ],
        )
        results = query_tool_durations_batch(["sess-a", "sess-b"], db_path)
        assert len(results) == 3
        assert results[0]["tool_name"] == "read"
        assert results[0]["time_start"] == 1_000
        assert results[0]["time_end"] == 5_000
        assert results[0]["duration_sec"] == 4.0
        assert results[1]["tool_name"] == "bash"
        assert results[1]["duration_sec"] == 6.0
        assert results[2]["tool_name"] == "edit"
        assert results[2]["duration_sec"] == 2.0

    def test_empty_session_ids(self, tmp_path: Path) -> None:
        """空 session_ids 列表返回空列表。"""
        db_path = str(tmp_path / "test.db")
        _create_db(db_path)
        results = query_tool_durations_batch([], db_path)
        assert results == []

    def test_non_existent_db(self, tmp_path: Path) -> None:
        """不存在的数据库文件返回空列表。"""
        results = query_tool_durations_batch(
            ["sess-1"], str(tmp_path / "nope.db")
        )
        assert results == []

    def test_session_with_no_tools(self, tmp_path: Path) -> None:
        """没有 tool 部件的 session 返回空列表。"""
        db_path = str(tmp_path / "test.db")
        _create_db(db_path)
        results = query_tool_durations_batch(["sess-no-tools"], db_path)
        assert results == []

    def test_mixed_sessions(self, tmp_path: Path) -> None:
        """部分 session 有工具、部分没有——只返回有工具的 session 的结果。"""
        db_path = str(tmp_path / "test.db")
        ts = 1_700_000_000_000
        _create_db(
            db_path,
            parts=[
                {
                    "id": "p1",
                    "message_id": "m1",
                    "session_id": "sess-has-tools",
                    "time_created": ts,
                    "data": _tool_data(
                        "read",
                        "call_001",
                        state={"time": {"start": 1_000, "end": 3_000}},
                    ),
                },
                {
                    "id": "p2",
                    "message_id": "m2",
                    "session_id": "sess-has-tools",
                    "time_created": ts + 100,
                    "data": _tool_data(
                        "grep",
                        "call_002",
                        state={"time": {"start": 4_000, "end": 7_000}},
                    ),
                },
            ],
        )
        results = query_tool_durations_batch(
            ["sess-has-tools", "sess-no-tools"], db_path
        )
        assert len(results) == 2
        assert results[0]["tool_name"] == "read"
        assert results[0]["duration_sec"] == 2.0
        assert results[1]["tool_name"] == "grep"
        assert results[1]["duration_sec"] == 3.0


# ── query_message_parts tests ─────────────────────────────────────────────


def test_query_message_parts_happy_path(tmp_path: Path) -> None:
    """Messages and their parts are grouped and ordered by time."""
    db_path = str(tmp_path / "test.db")
    ts = 1_700_000_000_000
    _create_db(
        db_path,
        messages=[
            {
                "id": "m1",
                "session_id": "sess-parts",
                "time_created": ts,
                "data": _msg_data("user", agent="build"),
            },
            {
                "id": "m2",
                "session_id": "sess-parts",
                "time_created": ts + 1000,
                "data": _msg_data("assistant", agent="build"),
            },
        ],
        parts=[
            {
                "id": "p1",
                "message_id": "m1",
                "session_id": "sess-parts",
                "time_created": ts,
                "data": _part_data("text", "User says hi"),
            },
            {
                "id": "p2",
                "message_id": "m2",
                "session_id": "sess-parts",
                "time_created": ts + 1000,
                "data": _part_data("reasoning", "Thinking..."),
            },
            {
                "id": "p3",
                "message_id": "m2",
                "session_id": "sess-parts",
                "time_created": ts + 1001,
                "data": _part_data("text", "Final reply"),
            },
        ],
    )
    results = query_message_parts("sess-parts", db_path)
    assert len(results) == 2

    # First message
    assert results[0]["id"] == "m1"
    assert results[0]["role"] == "user"
    assert results[0]["session_id"] == "sess-parts"
    assert len(results[0]["parts"]) == 1
    assert results[0]["parts"][0]["text"] == "User says hi"

    # Second message
    assert results[1]["id"] == "m2"
    assert results[1]["role"] == "assistant"
    assert len(results[1]["parts"]) == 2
    assert results[1]["parts"][0]["type"] == "reasoning"
    assert results[1]["parts"][1]["type"] == "text"


def test_query_message_parts_no_messages(tmp_path: Path) -> None:
    """Session with no messages returns empty list."""
    db_path = str(tmp_path / "test.db")
    _create_db(db_path)
    results = query_message_parts("nonexistent", db_path)
    assert results == []


def test_query_message_parts_db_not_exists(tmp_path: Path) -> None:
    """Non-existent DB file returns empty list."""
    results = query_message_parts("sess-1", str(tmp_path / "nope.db"))
    assert results == []


def test_query_message_parts_part_without_message(tmp_path: Path) -> None:
    """Parts with no corresponding message are not included."""
    db_path = str(tmp_path / "test.db")
    ts = 1_700_000_000_000
    _create_db(
        db_path,
        messages=[
            {
                "id": "m1",
                "session_id": "sess-parts",
                "time_created": ts,
                "data": _msg_data("user", agent="build"),
            },
        ],
        parts=[
            {
                "id": "p1",
                "message_id": "m1",
                "session_id": "sess-parts",
                "time_created": ts,
                "data": _part_data("text", "Has message"),
            },
            {
                "id": "p2",
                "message_id": "orphan",
                "session_id": "sess-parts",
                "time_created": ts + 1,
                "data": _part_data("text", "Orphaned part"),
            },
        ],
    )
    results = query_message_parts("sess-parts", db_path)
    assert len(results) == 1
    assert results[0]["id"] == "m1"
    assert len(results[0]["parts"]) == 1  # orphan not included


# ── Helper function used internally (test private helper) ─────────────────


def test_epoch_ms_to_iso() -> None:
    """_epoch_ms_to_iso converts millisecond timestamps to ISO strings."""
    from _db import _epoch_ms_to_iso  # noqa: E402

    result = _epoch_ms_to_iso(1_705_312_245_123)
    assert result.endswith("Z")
    assert "T" in result


def test_session_row_to_dict_json_model(tmp_path: Path) -> None:
    """_session_row_to_dict parses JSON model strings into dicts."""
    db_path = str(tmp_path / "test.db")
    _create_db(
        db_path,
        sessions=[
            _session_data(
                "sess-json",
                title="JSON Model Session",
                model=json.dumps({"name": "gpt-4", "provider": "openai"}),
            ),
        ],
    )
    from _db import _session_row_to_dict  # noqa: E402

    conn = sqlite3.connect(db_path)
    conn.row_factory = sqlite3.Row
    row = conn.execute(
        "SELECT * FROM session WHERE id = ?", ("sess-json",)
    ).fetchone()
    d = _session_row_to_dict(row)
    assert isinstance(d["model"], dict)
    assert d["model"]["name"] == "gpt-4"
    conn.close()
