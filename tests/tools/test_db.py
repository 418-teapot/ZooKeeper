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

from _db import query_db_messages  # noqa: E402

# ── Test helpers ──────────────────────────────────────────────────────────


def _create_db(
    db_path: str,
    messages: list[dict] | None = None,
    parts: list[dict] | None = None,
) -> None:
    """Create an opencode-style SQLite database at ``db_path``.

    Args:
        db_path: Absolute path for the database file.
        messages: List of message row dicts with keys
            ``id``, ``session_id``, ``time_created``, ``data`` (JSON string).
        parts: List of part row dicts with keys
            ``id``, ``message_id``, ``time_created``, ``data`` (JSON string).
    """
    conn = sqlite3.connect(db_path)
    conn.execute(
        "CREATE TABLE message ("
        "  id TEXT PRIMARY KEY,"
        "  session_id TEXT,"
        "  time_created INTEGER,"
        "  data TEXT"
        ")"
    )
    conn.execute(
        "CREATE TABLE part ("
        "  id TEXT PRIMARY KEY,"
        "  message_id TEXT,"
        "  time_created INTEGER,"
        "  data TEXT"
        ")"
    )
    if messages:
        for msg in messages:
            conn.execute(
                "INSERT INTO message (id, session_id, time_created, data) "
                "VALUES (:id, :session_id, :time_created, :data)",
                msg,
            )
    if parts:
        for part in parts:
            conn.execute(
                "INSERT INTO part (id, message_id, time_created, data) "
                "VALUES (:id, :message_id, :time_created, :data)",
                part,
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
