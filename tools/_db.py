"""SQLite database helpers for ZooKeeper tools."""

from __future__ import annotations

import json
import logging
import os
import sqlite3
import sys
from datetime import datetime, timezone

from _parser import tool_type_and_icon

logger = logging.getLogger(__name__)


def _safe_json_loads(data: str) -> dict | list | None:
    """Safely parse JSON string, returning None on failure.

    Args:
        data: JSON string to parse.

    Returns:
        Parsed JSON data, or None if parsing fails.
    """
    try:
        return json.loads(data)
    except (json.JSONDecodeError, TypeError) as e:
        logger.warning("Malformed JSON data: %s", e)
        return None


def _truncate(text: str, max_len: int = 80) -> str:
    """Truncate text with ellipsis if it exceeds max_len.

    Args:
        text: Text to truncate.
        max_len: Maximum length before truncation (default 80).

    Returns:
        Truncated text with ``...`` suffix, or original text if short enough.
    """
    return (text[:max_len] + "...") if len(text) > max_len else text


def _estimate_tokens(parts: list[dict]) -> int:
    """Estimate token count from message parts.

    Text/reasoning parts: ``len(text) // 4``.
    Tool parts: ``len(json.dumps(input)) // 4 + len(json.dumps(output)) // 4``.
    Step-finish parts are excluded.

    Args:
        parts: List of parsed part.data dicts.

    Returns:
        Estimated total token count.
    """
    total = 0
    for part in parts:
        ptype = part.get("type", "")
        if ptype == "step-finish":
            continue
        if ptype in ("text", "reasoning"):
            total += len(part.get("text", "")) // 4
        elif ptype == "tool":
            state = part.get("state", {})
            inp = state.get("input", {})
            out = state.get("output", {})
            input_text = (
                json.dumps(inp) if isinstance(inp, (dict, list)) else str(inp)
            )
            output_text = (
                json.dumps(out) if isinstance(out, (dict, list)) else str(out)
            )
            total += len(input_text) // 4 + len(output_text) // 4
    return total


def _setup_logging(verbose: bool = False) -> None:
    """Configure a root logger for ZooKeeper tools.

    By default adds a ``logging.NullHandler`` (no output).
    When *verbose* is ``True``, adds a ``StreamHandler`` writing
    ``DEBUG``-level messages to stderr.

    Call this once at the start of each tool's ``main()``.

    Args:
        verbose: If ``True``, enable debug logging to stderr.
    """
    root = logging.getLogger()
    # Remove any pre-existing handlers to avoid duplicates
    for h in list(root.handlers):
        root.removeHandler(h)
    if verbose:
        handler = logging.StreamHandler(sys.stderr)
        handler.setLevel(logging.DEBUG)
        handler.setFormatter(
            logging.Formatter(
                "%(asctime)s [%(levelname)s] %(name)s: %(message)s"
            )
        )
        root.addHandler(handler)
        root.setLevel(logging.DEBUG)
    else:
        root.addHandler(logging.NullHandler())


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

    with sqlite3.connect(f"file:{db_path}?mode=ro", uri=True) as conn:
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
        msg_data = _safe_json_loads(first["msg_data"])
        if msg_data is None:
            logger.warning("Skipping message %s: invalid JSON data", msg_id)
            continue
        role = msg_data.get("role", "")
        if role not in ("user", "assistant"):
            continue

        ts_ms = first["msg_time"]
        timestamp = _epoch_ms_to_iso(ts_ms) if ts_ms is not None else ""

        agent = msg_data.get("agent", "")
        model = msg_data.get("modelID", "") if role == "assistant" else ""
        sid = first["session_id"]

        for part_row in part_rows:
            part_data = _safe_json_loads(part_row["part_data"])
            if part_data is None:
                logger.warning(
                    "Skipping part for message %s: invalid JSON", msg_id
                )
                continue
            part_type = part_data.get("type", "")
            text = part_data.get("text", "")

            if not text:
                continue

            is_synthetic = part_data.get("synthetic", False)

            if role == "user" and part_type == "text" and not is_synthetic:
                _truncated = _truncate(text)
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
                _truncated = _truncate(text)
                time_info = msg_data.get("time") or {}
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
                        "msg_time_created": time_info.get("created"),
                        "msg_time_completed": time_info.get("completed"),
                    }
                )
            elif role == "assistant" and part_type == "reasoning":
                _truncated = _truncate(text)
                time_info = msg_data.get("time") or {}
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
                        "msg_time_created": time_info.get("created"),
                        "msg_time_completed": time_info.get("completed"),
                    }
                )

    return events


def _format_dt_to_iso(dt: datetime) -> str:
    """Format a datetime to ISO 8601 string with microsecond precision and Z suffix.

    Args:
        dt: A timezone-aware datetime (usually UTC).

    Returns:
        ISO 8601 formatted string like ``2025-01-09T12:34:56.123456Z``.
    """
    return dt.strftime("%Y-%m-%dT%H:%M:%S.%fZ")


def _epoch_ms_to_iso(ms: int) -> str:
    """Convert epoch milliseconds to ISO 8601 string with microsecond precision.

    Args:
        ms: Epoch time in milliseconds.

    Returns:
        ISO 8601 formatted string like ``2025-01-09T12:34:56.123456Z``.
    """
    dt = datetime.fromtimestamp(ms / 1000.0, tz=timezone.utc)
    return _format_dt_to_iso(dt)


def _iso_to_epoch_ms(ts: str) -> int:
    """Convert ISO 8601 timestamp to epoch milliseconds with full precision.

    Uses integer arithmetic (``timedelta.days`` / ``.seconds`` /
    ``.microseconds``) instead of ``datetime.timestamp() * 1000`` to
    avoid floating-point rounding errors.

    Args:
        ts: ISO 8601 string (may end with ``Z``).

    Returns:
        Epoch time in milliseconds, or 0 on failure.
    """
    if not ts:
        return 0
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        epoch = datetime(1970, 1, 1, tzinfo=timezone.utc)
        delta = dt - epoch
        return (
            delta.days * 86_400_000
            + delta.seconds * 1000
            + delta.microseconds // 1000
        )
    except (ValueError, AttributeError, OSError):
        return 0


def _session_row_to_dict(row: sqlite3.Row) -> dict:
    """Convert a session database row to a clean dict.

    Parses ISO timestamps and the model JSON column.

    Args:
        row: A sqlite3.Row from the session table.

    Returns:
        Dict with ISO timestamp strings and parsed model field.
    """
    d = dict(row)
    for key in ("time_created", "time_updated"):
        val = d.get(key)
        if val is not None:
            d[key] = _epoch_ms_to_iso(val)
    if isinstance(d.get("model"), str):
        parsed = _safe_json_loads(d["model"])
        if parsed is not None:
            d["model"] = parsed
    return d


_SESSION_COLS = (
    "id, parent_id, title, slug, agent, model, "
    "directory, time_created, time_updated, cost, "
    "tokens_input, tokens_output, tokens_reasoning, "
    "tokens_cache_read, tokens_cache_write"
)


def query_sessions(
    keyword: str,
    db_path: str = "~/.local/share/opencode/opencode.db",
    limit: int = 5000,
) -> list[dict]:
    """Search sessions whose title contains a keyword.

    Only top-level sessions (parent_id IS NULL) are returned.

    Args:
        keyword: Substring to search for in the session title.
        db_path: Path to the SQLite database file.
        limit: Maximum number of results (default 5000).

    Returns:
        List of session dicts with ISO timestamps and parsed model.
    """
    db_path = os.path.expanduser(db_path)
    if not os.path.isfile(db_path):
        return []

    with sqlite3.connect(f"file:{db_path}?mode=ro", uri=True) as conn:
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute(
            f"SELECT {_SESSION_COLS} FROM session "
            "WHERE parent_id IS NULL AND title LIKE ? "
            "ORDER BY time_updated DESC LIMIT ?",
            (f"%{keyword}%", limit),
        )
        return [_session_row_to_dict(row) for row in cursor.fetchall()]


def query_sessions_all(
    db_path: str = "~/.local/share/opencode/opencode.db",
    include_children: bool = False,
    limit: int = 5000,
) -> list[dict]:
    """List all sessions, optionally including child (fork) sessions.

    Args:
        db_path: Path to the SQLite database file.
        include_children: If True, include child sessions (no parent_id
            filter). If False (default), only top-level sessions are returned.
        limit: Maximum number of results (default 5000).

    Returns:
        List of session dicts ordered by time_updated descending.
    """
    db_path = os.path.expanduser(db_path)
    if not os.path.isfile(db_path):
        return []

    query = f"SELECT {_SESSION_COLS} FROM session "
    if not include_children:
        query += "WHERE parent_id IS NULL "
    query += "ORDER BY time_updated DESC LIMIT ?"

    with sqlite3.connect(f"file:{db_path}?mode=ro", uri=True) as conn:
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute(query, (limit,))
        return [_session_row_to_dict(row) for row in cursor.fetchall()]


def query_sessions_exact(
    title: str,
    db_path: str = "~/.local/share/opencode/opencode.db",
    limit: int = 5000,
) -> list[dict]:
    """Find sessions with an exact title match.

    Args:
        title: Exact session title to match.
        db_path: Path to the SQLite database file.
        limit: Maximum number of results (default 5000).

    Returns:
        List of matching session dicts.
    """
    db_path = os.path.expanduser(db_path)
    if not os.path.isfile(db_path):
        return []

    with sqlite3.connect(f"file:{db_path}?mode=ro", uri=True) as conn:
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute(
            f"SELECT {_SESSION_COLS} FROM session WHERE title = ? "
            "ORDER BY time_updated DESC LIMIT ?",
            (title, limit),
        )
        return [_session_row_to_dict(row) for row in cursor.fetchall()]


def query_recent_sessions(
    n: int,
    db_path: str = "~/.local/share/opencode/opencode.db",
    include_children: bool = False,
) -> list[dict]:
    """Get the *n* most recently updated sessions.

    Args:
        n: Number of sessions to return.
        db_path: Path to the SQLite database file.
        include_children: If True, include child sessions.

    Returns:
        List of session dicts ordered by time_updated descending, limited
        to *n* entries.
    """
    db_path = os.path.expanduser(db_path)
    if not os.path.isfile(db_path):
        return []

    query = f"SELECT {_SESSION_COLS} FROM session "
    if not include_children:
        query += "WHERE parent_id IS NULL "
    query += "ORDER BY time_updated DESC LIMIT ?"

    with sqlite3.connect(f"file:{db_path}?mode=ro", uri=True) as conn:
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute(query, (n,))
        return [_session_row_to_dict(row) for row in cursor.fetchall()]


def query_message_by_ids(
    msg_ids: list[str],
    session_id: str | None = None,
    db_path: str = "~/.local/share/opencode/opencode.db",
    scan_limit: int = 200,
) -> list[dict]:
    """Retrieve messages by their IDs, optionally scoped to a session.

    When *session_id* is provided only that session is searched.
    Otherwise the most recent *scan_limit* sessions are scanned until
    all *msg_ids* are found.

    Args:
        msg_ids: List of message IDs to retrieve.
        session_id: Optional session ID to scope the search.
        db_path: Path to the SQLite database file.
        scan_limit: Maximum number of recent sessions to scan when
            *session_id* is ``None`` (default 200).

    Returns:
        List of message dicts with keys: ``id``, ``session_id``, ``role``,
        ``agent``, ``timestamp`` (ISO), ``tokens``, ``parts`` (list of parsed
        part.data JSON).
    """
    if not msg_ids:
        return []

    db_path = os.path.expanduser(db_path)
    if not os.path.isfile(db_path):
        return []

    placeholders = ",".join("?" * len(msg_ids))
    params: list = list(msg_ids)

    if session_id is not None:
        session_filter = "AND m.session_id = ?"
        params.append(session_id)
    else:
        session_filter = (
            "AND m.session_id IN ("
            "SELECT id FROM session ORDER BY time_updated DESC LIMIT ?"
            ")"
        )
        params.append(scan_limit)

    query = (
        "SELECT m.id, m.session_id, m.time_created, m.data AS msg_data, "
        "p.data AS part_data "
        "FROM message m "
        "JOIN part p ON p.message_id = m.id "
        f"WHERE m.id IN ({placeholders}) {session_filter} "
        "ORDER BY m.time_created ASC, p.time_created ASC"
    )

    with sqlite3.connect(f"file:{db_path}?mode=ro", uri=True) as conn:
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute(query, params)
        rows = cursor.fetchall()

    # Group by message_id
    grouped: dict[str, list[sqlite3.Row]] = {}
    for row in rows:
        grouped.setdefault(row["id"], []).append(row)

    # Fallback to LIKE prefix matching for any IDs not found by exact match.
    # This allows truncated message IDs (e.g. "msg_abc") to match full
    # IDs (e.g. "msg_abcdef123456") without changing the public API.
    found_ids = set(grouped.keys())
    missing_ids = [mid for mid in msg_ids if mid not in found_ids]
    if missing_ids:
        like_placeholders = " OR ".join("m.id LIKE ?" for _ in missing_ids)
        like_params = [f"{mid}%" for mid in missing_ids]

        if session_id is not None:
            like_params.append(session_id)
        else:
            like_params.append(scan_limit)

        like_query = (
            "SELECT m.id, m.session_id, m.time_created, m.data AS msg_data, "
            "p.data AS part_data "
            "FROM message m "
            "JOIN part p ON p.message_id = m.id "
            f"WHERE ({like_placeholders}) {session_filter} "
            "ORDER BY m.time_created ASC, p.time_created ASC"
        )

        with sqlite3.connect(f"file:{db_path}?mode=ro", uri=True) as conn:
            conn.row_factory = sqlite3.Row
            cursor = conn.cursor()
            cursor.execute(like_query, like_params)
            rows = cursor.fetchall()

        # Merge LIKE results into existing grouped data
        for row in rows:
            grouped.setdefault(row["id"], []).append(row)

    results: list[dict] = []
    for msg_id, part_rows in grouped.items():
        first = part_rows[0]
        msg_data = _safe_json_loads(first["msg_data"])
        if msg_data is None:
            logger.warning("Skipping message %s: invalid JSON data", msg_id)
            continue

        ts_ms = first["time_created"]
        timestamp = _epoch_ms_to_iso(ts_ms) if ts_ms is not None else ""

        # Tokens: prefer message.data.tokens, fall back to step-finish tokens.
        # message.data.tokens is a dict: {input, output, cache: {read, write}}.
        tokens_raw = msg_data.get("tokens")
        if isinstance(tokens_raw, dict):
            tokens = tokens_raw.get("input", 0) + tokens_raw.get("output", 0)
        else:
            tokens = 0
        if not tokens:
            for pr in part_rows:
                pdata = _safe_json_loads(pr["part_data"])
                if pdata is None:
                    continue
                if pdata.get("type") == "step-finish":
                    tok = pdata.get("tokens", {})
                    tokens = tok.get("input", 0) + tok.get("output", 0)
                    break

        parts = []
        for pr in part_rows:
            p = _safe_json_loads(pr["part_data"])
            if p is not None:
                parts.append(p)

        results.append(
            {
                "id": msg_id,
                "session_id": first["session_id"],
                "role": msg_data.get("role", ""),
                "agent": msg_data.get("agent", ""),
                "timestamp": timestamp,
                "tokens": tokens,
                "parts": parts,
            }
        )

    return results


def _primary_tool_input(state: dict) -> str:
    """Extract the primary input field from a tool's state for summary.

    Priority: ``filePath`` > ``pattern`` > ``command`` (first 50 chars)
    > ``description`` > first non-empty value > ``""``.

    Args:
        state: The ``state`` dict from a tool part.

    Returns:
        A short string identifying the tool's primary input, or ``""``.
    """
    inp = state.get("input", {})
    if not isinstance(inp, dict):
        return ""
    fp = inp.get("filePath")
    if fp:
        return str(fp)
    pattern = inp.get("pattern")
    if pattern:
        return str(pattern)
    cmd = inp.get("command")
    if cmd:
        return str(cmd)[:50]
    desc = inp.get("description")
    if desc:
        return str(desc)
    for v in inp.values():
        if v is not None and str(v).strip():
            return str(v)
    return ""


def query_db_tool_calls(
    session_ids: list[str],
    db_path: str = "~/.local/share/opencode/opencode.db",
) -> list[dict]:
    """Query completed tool calls from the part table for timeline events.

    Queries ``part`` where ``json_extract(data, '$.type') = 'tool'`` and
    ``status = 'completed'``, returning events compatible with the timeline
    format used by ``build_timeline()`` in ``_trace_builder.py``.

    Args:
        session_ids: List of session IDs to query.
        db_path: Path to the SQLite database file
            (default: ``~/.local/share/opencode/opencode.db``).

    Returns:
        List of event dicts with keys: ``timestamp`` (ISO), ``source``
        (``"db"``), ``type`` (tool_*), ``icon``, ``summary``, ``detail``
        (dict with ``tool_name``, ``status``, ``input_keys``, and optionally
        ``duration_sec``), ``session_id``.
    """
    if not session_ids:
        return []

    db_path = os.path.expanduser(db_path)
    if not os.path.isfile(db_path):
        return []

    events: list[dict] = []
    placeholders = ",".join("?" * len(session_ids))

    with sqlite3.connect(f"file:{db_path}?mode=ro", uri=True) as conn:
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute(
            "SELECT session_id, data "
            "FROM part "
            f"WHERE session_id IN ({placeholders}) "
            "AND json_extract(data, '$.type') = 'tool' "
            "AND json_extract(data, '$.state.status') = 'completed' "
            "ORDER BY time_created ASC",
            tuple(session_ids),
        )
        rows = cursor.fetchall()

    for row in rows:
        data = _safe_json_loads(row["data"])
        if data is None:
            continue
        tool_name = data.get("tool", "")
        if not tool_name:
            continue
        state = data.get("state", {})
        if not isinstance(state, dict):
            continue
        time_info = state.get("time", {})
        if not isinstance(time_info, dict):
            continue
        start_ms = time_info.get("start")
        if start_ms is None:
            continue

        timestamp = _epoch_ms_to_iso(start_ms)
        type_, icon = tool_type_and_icon(tool_name)
        inp = state.get("input", {})
        primary = _primary_tool_input(state)
        summary = f"{tool_name}: {primary}" if primary else tool_name

        detail: dict = {
            "tool_name": tool_name,
            "status": state.get("status", ""),
            "input_keys": list(inp.keys()) if isinstance(inp, dict) else [],
        }
        end_ms = time_info.get("end")
        if end_ms is not None:
            detail["duration_sec"] = (end_ms - start_ms) / 1000.0

        events.append(
            {
                "timestamp": timestamp,
                "source": "db",
                "type": type_,
                "icon": icon,
                "summary": summary,
                "detail": detail,
                "session_id": row["session_id"],
            }
        )

    return events


def query_tool_durations_batch(
    session_ids: list[str],
    db_path: str = "~/.local/share/opencode/opencode.db",
) -> list[dict]:
    """Extract tool execution durations for multiple sessions in one query.

    Uses ``WHERE session_id IN (...)`` to avoid N+1 separate DB connections.

    Args:
        session_ids: List of session IDs to query.
        db_path: Path to the SQLite database file
            (default: ``~/.local/share/opencode/opencode.db``).

    Returns:
        List of dicts with keys: ``tool_name``, ``time_start`` (epoch ms),
        ``time_end`` (epoch ms), ``duration_sec`` (float).  Only rows
        that have both ``state.time.start`` and ``state.time.end`` are
        included.
    """
    if not session_ids:
        return []

    db_path = os.path.expanduser(db_path)
    if not os.path.isfile(db_path):
        return []

    results: list[dict] = []
    placeholders = ",".join("?" * len(session_ids))

    with sqlite3.connect(f"file:{db_path}?mode=ro", uri=True) as conn:
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute(
            "SELECT session_id, data FROM part "
            f"WHERE session_id IN ({placeholders}) "
            "AND json_extract(data, '$.type') = 'tool' "
            "ORDER BY time_created ASC",
            tuple(session_ids),
        )
        rows = cursor.fetchall()

    for row in rows:
        data = _safe_json_loads(row["data"])
        if data is None:
            continue
        tool_name = data.get("tool", "")
        if not tool_name:
            continue
        state = data.get("state", {})
        if not isinstance(state, dict):
            continue
        time_info = state.get("time", {})
        if not isinstance(time_info, dict):
            continue
        start = time_info.get("start")
        end = time_info.get("end")
        if start is not None and end is not None:
            results.append(
                {
                    "tool_name": tool_name,
                    "time_start": start,
                    "time_end": end,
                    "duration_sec": (end - start) / 1000.0,
                }
            )

    return results


def query_tool_durations(
    session_id: str,
    db_path: str = "~/.local/share/opencode/opencode.db",
) -> list[dict]:
    """Extract tool execution durations from the part table.

    Queries all tool-type parts for a session and extracts ``state.time``
    start/end timestamps, computing wall-clock duration.

    Args:
        session_id: Session ID to query.
        db_path: Path to the SQLite database file
            (default: ``~/.local/share/opencode/opencode.db``).

    Returns:
        List of dicts with keys: ``tool_name``, ``time_start`` (epoch ms),
        ``time_end`` (epoch ms), ``duration_sec`` (float).  Only rows
        that have both ``state.time.start`` and ``state.time.end`` are
        included.
    """
    db_path = os.path.expanduser(db_path)
    if not os.path.isfile(db_path):
        return []

    results: list[dict] = []

    with sqlite3.connect(f"file:{db_path}?mode=ro", uri=True) as conn:
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()
        cursor.execute(
            "SELECT data FROM part "
            "WHERE session_id = ? "
            "AND json_extract(data, '$.type') = 'tool' "
            "ORDER BY time_created ASC",
            (session_id,),
        )
        rows = cursor.fetchall()

    for row in rows:
        data = _safe_json_loads(row["data"])
        if data is None:
            continue
        tool_name = data.get("tool", "")
        if not tool_name:
            continue
        state = data.get("state", {})
        if not isinstance(state, dict):
            continue
        time_info = state.get("time", {})
        if not isinstance(time_info, dict):
            continue
        start = time_info.get("start")
        end = time_info.get("end")
        if start is not None and end is not None:
            results.append(
                {
                    "tool_name": tool_name,
                    "time_start": start,
                    "time_end": end,
                    "duration_sec": (end - start) / 1000.0,
                }
            )

    return results


def query_step_data_batch(
    session_ids: list[str],
    db_path: str = "~/.local/share/opencode/opencode.db",
) -> list[dict]:
    """Extract per-step token timeline for multiple sessions in one query.

    使用 ``WHERE session_id IN (...)`` 避免 N+1 次独立 DB 连接。

    Args:
        session_ids: 要查询的 session ID 列表。
        db_path: SQLite 数据库文件路径。

    Returns:
        按 ``time_created`` 升序排列的 step dict 列表，每个 dict 包含
        ``query_step_data`` 的所有字段，并额外附加 ``session_id`` 字段
        标识来源 session。
    """
    if not session_ids:
        return []

    db_path = os.path.expanduser(db_path)
    if not os.path.isfile(db_path):
        return []

    placeholders = ",".join("?" * len(session_ids))

    with sqlite3.connect(f"file:{db_path}?mode=ro", uri=True) as conn:
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()

        # 一次性查询所有 session 的 step-finish parts
        cursor.execute(
            "SELECT id, message_id, session_id, time_created, time_updated, data "
            "FROM part "
            f"WHERE session_id IN ({placeholders}) "
            "AND json_extract(data, '$.type') = 'step-finish' "
            "ORDER BY session_id, time_created ASC",
            tuple(session_ids),
        )
        step_rows = cursor.fetchall()

        # 一次性查询所有 session 的 tool parts
        cursor.execute(
            "SELECT id, message_id, session_id, time_created, data "
            "FROM part "
            f"WHERE session_id IN ({placeholders}) "
            "AND json_extract(data, '$.type') = 'tool' "
            "ORDER BY session_id, time_created ASC",
            tuple(session_ids),
        )
        tool_rows = cursor.fetchall()

        # 获取所有 step-finish 对应的 message data（提取 LLM step 时间）
        msg_ids = list({srow["message_id"] for srow in step_rows})
        msg_time_map: dict[str, tuple[int | None, int | None]] = {}
        if msg_ids:
            msg_placeholders = ",".join("?" * len(msg_ids))
            cursor.execute(
                "SELECT id, data FROM message "
                f"WHERE id IN ({msg_placeholders})",
                tuple(msg_ids),
            )
            for msg_row in cursor.fetchall():
                msg_data = _safe_json_loads(msg_row["data"])
                if msg_data is not None:
                    time_info = msg_data.get("time") or {}
                    msg_time_map[msg_row["id"]] = (
                        time_info.get("created"),
                        time_info.get("completed"),
                    )

    # 按 (session_id, message_id) 构建 tool 名查找表
    tools_by_msg: dict[str, list[str]] = {}
    for trow in tool_rows:
        tdata = _safe_json_loads(trow["data"])
        if tdata is None:
            continue
        tool_name = tdata.get("tool", "")
        if tool_name:
            key = f"{trow['session_id']}:{trow['message_id']}"
            tools_by_msg.setdefault(key, []).append(tool_name)

    # 按 session_id 分组 step-finish rows，每个 session 内自增 step_index
    steps_by_sid: dict[str, list[sqlite3.Row]] = {}
    for srow in step_rows:
        steps_by_sid.setdefault(srow["session_id"], []).append(srow)

    results: list[dict] = []
    for sid in session_ids:
        session_steps = steps_by_sid.get(sid, [])
        for idx, srow in enumerate(session_steps, start=1):
            sdata = _safe_json_loads(srow["data"])
            if sdata is None:
                continue
            msg_id = srow["message_id"]

            ts_created = srow["time_created"]
            ts_updated = srow["time_updated"]

            tokens_obj = sdata.get("tokens", {})
            cache_obj = tokens_obj.get("cache", {})

            msg_times = msg_time_map.get(msg_id, (None, None))

            tool_key = f"{sid}:{msg_id}"
            results.append(
                {
                    "step_index": idx,
                    "session_id": sid,
                    "message_id": msg_id,
                    "time_created": (
                        _epoch_ms_to_iso(ts_created)
                        if ts_created is not None
                        else ""
                    ),
                    "time_updated": (
                        _epoch_ms_to_iso(ts_updated)
                        if ts_updated is not None
                        else ""
                    ),
                    "cache_read": cache_obj.get("read", 0) or 0,
                    "cache_write": cache_obj.get("write", 0) or 0,
                    "input_tokens": tokens_obj.get("input", 0) or 0,
                    "output_tokens": tokens_obj.get("output", 0) or 0,
                    "reasoning_tokens": tokens_obj.get("reasoning", 0) or 0,
                    "cost": sdata.get("cost", 0) or 0,
                    "reason": sdata.get("reason", ""),
                    "tools": tools_by_msg.get(tool_key, []),
                    "msg_time_created": msg_times[0],
                    "msg_time_completed": msg_times[1],
                }
            )

    return results


def query_step_data(
    session_id: str,
    db_path: str = "~/.local/share/opencode/opencode.db",
) -> list[dict]:
    """Extract per-step token timeline for a session.

    Queries step-finish parts and tool parts, then associates tool
    names with their corresponding step by matching ``message_id``.

    Args:
        session_id: Session ID to query.
        db_path: Path to the SQLite database file.

    Returns:
        List of step dicts ordered by ``time_created`` ascending, each
        containing: ``step_index`` (1-based), ``message_id``,
        ``time_created`` (ISO), ``time_updated`` (ISO), ``cache_read``,
        ``cache_write``, ``input_tokens``, ``output_tokens``,
        ``reasoning_tokens``, ``cost``, ``reason``, ``tools`` (list of
        tool names).
    """
    db_path = os.path.expanduser(db_path)
    if not os.path.isfile(db_path):
        return []

    with sqlite3.connect(f"file:{db_path}?mode=ro", uri=True) as conn:
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()

        # Step-finish parts
        cursor.execute(
            "SELECT id, message_id, time_created, time_updated, data "
            "FROM part "
            "WHERE session_id = ? "
            "AND json_extract(data, '$.type') = 'step-finish' "
            "ORDER BY time_created ASC",
            (session_id,),
        )
        step_rows = cursor.fetchall()

        # Tool parts
        cursor.execute(
            "SELECT id, message_id, time_created, data "
            "FROM part "
            "WHERE session_id = ? "
            "AND json_extract(data, '$.type') = 'tool' "
            "ORDER BY time_created ASC",
            (session_id,),
        )
        tool_rows = cursor.fetchall()

        # Fetch parent message data for each step-finish message_id to
        # extract the real LLM step timing from message.data.time.
        msg_ids = list({srow["message_id"] for srow in step_rows})
        msg_time_map: dict[str, tuple[int | None, int | None]] = {}
        if msg_ids:
            placeholders = ",".join("?" * len(msg_ids))
            cursor.execute(
                "SELECT id, data FROM message "
                f"WHERE id IN ({placeholders}) AND session_id = ?",
                (*msg_ids, session_id),
            )
            for msg_row in cursor.fetchall():
                msg_data = _safe_json_loads(msg_row["data"])
                if msg_data is not None:
                    time_info = msg_data.get("time") or {}
                    msg_time_map[msg_row["id"]] = (
                        time_info.get("created"),
                        time_info.get("completed"),
                    )

    # Build tool name lookup keyed by message_id.
    # Tool parts use "tool" key (e.g. {"type": "tool", "tool": "read"}).
    tools_by_msg: dict[str, list[str]] = {}
    for trow in tool_rows:
        tdata = _safe_json_loads(trow["data"])
        if tdata is None:
            continue
        tool_name = tdata.get("tool", "")
        if tool_name:
            tools_by_msg.setdefault(trow["message_id"], []).append(tool_name)

    results: list[dict] = []
    for idx, srow in enumerate(step_rows, start=1):
        sdata = _safe_json_loads(srow["data"])
        if sdata is None:
            continue
        msg_id = srow["message_id"]

        ts_created = srow["time_created"]
        ts_updated = srow["time_updated"]

        # step-finish JSON has nested tokens:
        # {"tokens": {"input": N, "output": N, "cache": {"read": N, "write": N}}}
        tokens_obj = sdata.get("tokens", {})
        cache_obj = tokens_obj.get("cache", {})

        msg_times = msg_time_map.get(msg_id, (None, None))

        results.append(
            {
                "step_index": idx,
                "message_id": msg_id,
                "time_created": (
                    _epoch_ms_to_iso(ts_created)
                    if ts_created is not None
                    else ""
                ),
                "time_updated": (
                    _epoch_ms_to_iso(ts_updated)
                    if ts_updated is not None
                    else ""
                ),
                "cache_read": cache_obj.get("read", 0) or 0,
                "cache_write": cache_obj.get("write", 0) or 0,
                "input_tokens": tokens_obj.get("input", 0) or 0,
                "output_tokens": tokens_obj.get("output", 0) or 0,
                "reasoning_tokens": tokens_obj.get("reasoning", 0) or 0,
                "cost": sdata.get("cost", 0) or 0,
                "reason": sdata.get("reason", ""),
                "tools": tools_by_msg.get(msg_id, []),
                "msg_time_created": msg_times[0],
                "msg_time_completed": msg_times[1],
            }
        )

    return results


def query_message_parts(
    session_id: str,
    db_path: str = "~/.local/share/opencode/opencode.db",
) -> list[dict]:
    """Get all messages and their parts for a session, ordered by time.

    Each returned dict contains the parsed ``message.data`` JSON and a
    list of parsed ``part.data`` JSONs grouped by ``message_id``.

    Args:
        session_id: Session ID to query.
        db_path: Path to the SQLite database file.

    Returns:
        List of message dicts with keys: ``id``, ``session_id``, ``role``,
        ``time_created`` (ISO), ``data`` (parsed JSON), ``parts`` (list of
        parsed part.data JSONs).
    """
    db_path = os.path.expanduser(db_path)
    if not os.path.isfile(db_path):
        return []

    with sqlite3.connect(f"file:{db_path}?mode=ro", uri=True) as conn:
        conn.row_factory = sqlite3.Row
        cursor = conn.cursor()

        cursor.execute(
            "SELECT id, session_id, time_created, data "
            "FROM message WHERE session_id = ? "
            "ORDER BY time_created ASC",
            (session_id,),
        )
        msg_rows = cursor.fetchall()

        cursor.execute(
            "SELECT message_id, session_id, time_created, data "
            "FROM part WHERE session_id = ? "
            "ORDER BY time_created ASC",
            (session_id,),
        )
        part_rows = cursor.fetchall()

    # Group parts by message_id
    parts_by_msg: dict[str, list[dict]] = {}
    for prow in part_rows:
        pdata = _safe_json_loads(prow["data"])
        if pdata is not None:
            parts_by_msg.setdefault(prow["message_id"], []).append(pdata)

    results: list[dict] = []
    for mrow in msg_rows:
        msg_data = _safe_json_loads(mrow["data"])
        if msg_data is None:
            continue
        ts_ms = mrow["time_created"]
        results.append(
            {
                "id": mrow["id"],
                "session_id": mrow["session_id"],
                "role": msg_data.get("role", ""),
                "time_created": (
                    _epoch_ms_to_iso(ts_ms) if ts_ms is not None else ""
                ),
                "data": msg_data,
                "parts": parts_by_msg.get(mrow["id"], []),
            }
        )

    return results
