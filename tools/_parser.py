"""Shared log parsing utilities for ZooKeeper tools."""

import glob
import json
import os
import shlex
from datetime import datetime


def parse_zoo_log(path: str) -> list[dict]:
    """Parse a ZooKeeper JSONL log file.

    Args:
        path: Path to the JSONL log file.

    Returns:
        List of parsed dict objects.

    Raises:
        FileNotFoundError: If the file does not exist.
        json.JSONDecodeError: If a line is not valid JSON.
    """
    if not os.path.isfile(path):
        raise FileNotFoundError(f"Log file not found: {path}")

    events: list[dict] = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            events.append(json.loads(line))
    return events


def parse_opencode_line(line: str) -> dict[str, str] | None:
    """Parse a single opencode key=value log line into a dict.

    Args:
        line: A single line from the opencode log.

    Returns:
        Parsed dict, or None for empty/unparseable lines.
    """
    line = line.strip()
    if not line:
        return None
    try:
        tokens = shlex.split(line)
    except ValueError:
        return None
    entry: dict[str, str] = {}
    for token in tokens:
        if "=" not in token:
            continue
        key, _, value = token.partition("=")
        # Remove surrounding quotes if present
        if len(value) >= 2 and value.startswith('"') and value.endswith('"'):
            value = value[1:-1]
        # Normalize key names (session.id → session_id)
        key = key.replace(".", "_")
        entry[key] = value
    return entry if entry else None


def parse_opencode_log(
    path: str,
    session_id: str | None = None,
) -> list[dict]:
    """Parse an opencode key=value format log file.

    Format: ``timestamp=... level=... key=value ...``
    Values may be quoted with double quotes.

    Args:
        path: Path to the opencode log file.
        session_id: If provided, only return lines with this session.id.

    Returns:
        List of parsed dict objects. Unparseable lines are silently skipped.
    """
    if not os.path.isfile(path):
        raise FileNotFoundError(f"Log file not found: {path}")

    events: list[dict] = []
    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            entry = parse_opencode_line(line)
            if entry is None:
                continue
            if session_id is not None and entry.get("session_id") != session_id:
                continue
            events.append(entry)
    return events


def resolve_log_path(session_id: str, log_dir: str = "~/.zoo/log") -> str:
    """Resolve a session ID to its ZooKeeper log file path.

    Args:
        session_id: The session ID string.
        log_dir: Directory containing log files (default: ~/.zoo/log).

    Returns:
        Absolute path to the log file.
    """
    log_dir = os.path.expanduser(log_dir)
    return os.path.join(log_dir, f"opencode-{session_id}.log")


def list_sessions(zoo_dir: str = "~/.zoo/log") -> list[dict]:
    """List all ZooKeeper log sessions.

    Args:
        zoo_dir: Directory containing opencode-*.log files.

    Returns:
        List of dicts with session_id, path, size, mtime, event_count.
    """
    log_dir = os.path.expanduser(zoo_dir)
    sessions: list[dict] = []

    if not os.path.isdir(log_dir):
        return sessions

    prefix = "opencode-"
    suffix = ".log"

    for filename in sorted(os.listdir(log_dir)):
        if not filename.startswith(prefix) or not filename.endswith(suffix):
            continue

        path = os.path.join(log_dir, filename)
        if not os.path.isfile(path):
            continue

        session_id = filename[len(prefix) : -len(suffix)]
        st = os.stat(path)

        with open(path, "r", encoding="utf-8") as f:
            event_count = sum(1 for line in f if line.strip())

        sessions.append(
            {
                "session_id": session_id,
                "path": path,
                "size": st.st_size,
                "mtime": datetime.fromtimestamp(st.st_mtime),
                "event_count": event_count,
            }
        )

    return sessions


def resolve_session_path(session_id: str, log_dir: str = "~/.zoo/log") -> str | None:
    """Resolve a session ID (or prefix) to the full log file path.

    Searches for files matching ``opencode-<session_id>*.log`` in *log_dir*.
    Returns the path if a unique match is found, None otherwise.

    Args:
        session_id: The session ID or prefix string.
        log_dir: Directory containing log files (default: ~/.zoo/log).

    Returns:
        Absolute path to the log file, or None if not found or ambiguous.
    """
    session_id = os.path.basename(session_id)
    dir_path = os.path.expanduser(log_dir)
    if not os.path.isdir(dir_path):
        return None
    pattern = os.path.join(dir_path, f"opencode-{session_id}*.log")
    matches = glob.glob(pattern)
    if len(matches) == 1:
        return matches[0]
    return None
