"""SQLite database helpers for ZooKeeper tools."""

from __future__ import annotations

import json
import os
import sqlite3
from datetime import datetime, timezone


def query_db_messages(
    session_ids: list[str],
    db_path: str = "~/.local/share/opencode/opencode.db",
) -> list[dict]:
    """Query opencode SQLite database for user messages and assistant replies.

    For each session:
    1. Find user messages: ``message.data.role='user'`` + ``part.data.type='text'``
       (excluding synthetic parts like auto-generated tool call descriptions)
    2. Find assistant replies: ``message.data.role='assistant'`` +
       ``part.data.type='text'``
    3. Find assistant reasoning: ``message.data.role='assistant'`` +
       ``part.data.type='reasoning'`` (chain-of-thought)

    Uses a single JOIN query instead of N+1 per-message part queries.

    Args:
        session_ids: List of session IDs to query.
        db_path: Path to the SQLite database file
            (default: ``~/.local/share/opencode/opencode.db``).

    Returns:
        List of event dicts with keys: ``timestamp``, ``source`` (``"db"``),
        ``type`` (``user_msg`` / ``assistant_reply`` / ``assistant_reasoning``),
        ``content`` (full text), ``icon``, ``summary`` (truncated), ``model``,
        ``agent``, ``session_id``.
    """
    db_path = os.path.expanduser(db_path)
    if not os.path.isfile(db_path):
        return []

    if not session_ids:
        return []

    events: list[dict] = []

    with sqlite3.connect(db_path) as conn:
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()

        # Single JOIN query: eliminates N+1 part lookups
        placeholders = ",".join("?" * len(session_ids))
        cursor.execute(
            "SELECT m.id AS msg_id, m.time_created AS msg_time, "
            "m.data AS msg_data, m.session_id, "
            "p.data AS part_data "
            "FROM message m "
            "JOIN part p ON p.message_id = m.id "
            f"WHERE m.session_id IN ({placeholders}) "
            "ORDER BY m.session_id, m.time_created ASC, p.time_created ASC",
            tuple(session_ids),
        )
        rows = cursor.fetchall()

    # Group by message_id in Python
    messages: dict[str, list[sqlite3.Row]] = {}
    for row in rows:
        messages.setdefault(row["msg_id"], []).append(row)

    for msg_id, part_rows in messages.items():
        first = part_rows[0]
        msg_data = json.loads(first["msg_data"])
        role = msg_data.get("role", "")
        if role not in ("user", "assistant"):
            continue

        ts_ms = first["msg_time"]
        dt = datetime.fromtimestamp(ts_ms / 1000.0, tz=timezone.utc)
        timestamp = (
            dt.strftime("%Y-%m-%dT%H:%M:%S.") + f"{dt.microsecond:06d}Z"
        )

        agent = msg_data.get("agent", "")
        model = msg_data.get("modelID", "") if role == "assistant" else ""
        sid = first["session_id"]

        for part_row in part_rows:
            part_data = json.loads(part_row["part_data"])
            part_type = part_data.get("type", "")
            text = part_data.get("text", "")

            if not text:
                continue

            is_synthetic = part_data.get("synthetic", False)

            if role == "user" and part_type == "text" and not is_synthetic:
                _truncated = text[:80] + "..." if len(text) > 80 else text
                events.append(
                    {
                        "timestamp": timestamp,
                        "source": "db",
                        "type": "user_msg",
                        "icon": "👤",
                        "summary": _truncated,
                        "content": text,
                        "model": "",
                        "agent": agent,
                        "session_id": sid,
                    }
                )
            elif role == "assistant" and part_type == "text":
                _truncated = text[:80] + "..." if len(text) > 80 else text
                events.append(
                    {
                        "timestamp": timestamp,
                        "source": "db",
                        "type": "assistant_reply",
                        "icon": "🤖",
                        "summary": _truncated,
                        "content": text,
                        "model": model,
                        "agent": agent,
                        "session_id": sid,
                    }
                )
            elif role == "assistant" and part_type == "reasoning":
                _truncated = text[:80] + "..." if len(text) > 80 else text
                events.append(
                    {
                        "timestamp": timestamp,
                        "source": "db",
                        "type": "assistant_reasoning",
                        "icon": "🧠",
                        "summary": f"Reasoning: {_truncated}",
                        "content": text,
                        "model": model,
                        "agent": agent,
                        "session_id": sid,
                    }
                )

    return events
