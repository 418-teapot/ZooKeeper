"""Timeline builder — merge ZooKeeper + opencode logs into unified trace events."""

from __future__ import annotations

import json
import os

from collections import Counter, defaultdict, deque
from datetime import datetime
from typing import Any

from _db import query_db_messages
from _parser import _get_zoo_log_dir, parse_opencode_line


def _normalize_timestamp(ts: str) -> str:
    """Normalize a timestamp to ISO 8601 format."""
    if not ts:
        return ""
    if ts.endswith("Z"):
        return ts
    try:
        dt = datetime.fromisoformat(ts.replace("Z", "+00:00"))
        return dt.strftime("%Y-%m-%dT%H:%M:%S.%fZ")
    except (ValueError, AttributeError):
        return ts


def _tool_type_and_icon(permission: str) -> tuple[str, str]:
    """Map a permission string to a trace event type and icon.

    Args:
        permission: The permission field from an evaluated entry.

    Returns:
        Tuple of (type, icon).
    """
    if permission in ("read", "grep", "glob"):
        return "tool_read", "■"
    if permission in ("edit", "write"):
        return "tool_write", "■"
    if permission == "bash":
        return "tool_exec", "■"
    if permission == "task":
        return "tool_orch", "◈"
    return "tool_other", "■"


def _classify_opencode(entry: dict) -> dict | None:
    """Convert an opencode log entry to a unified trace event.

    Args:
        entry: Parsed opencode log entry.

    Returns:
        Unified event dict, or None if the entry should be skipped.
    """
    msg = entry.get("message", "")

    # Session created
    if msg == "created":
        slug = entry.get("slug", "")
        agent = entry.get("agent", "")
        model_id = entry.get("model_id", "")
        model_provider = entry.get("model_providerID", "")
        title = entry.get("title", slug)
        parts = []
        if slug:
            parts.append(slug)
        if agent:
            parts.append(f"agent={agent}")
        if model_id:
            parts.append(f"model={model_id}")
        if model_provider:
            parts.append(f"provider={model_provider}")
        summary = (
            f"Session {slug}: {title}" if title and title != slug else f"Session {slug}"
        )
        if parts:
            summary = f"Session {slug} ({', '.join(parts)})"

        detail = {
            "id": entry.get("id", ""),
            "slug": slug,
            "agent": agent,
            "model_id": model_id,
            "model_provider": model_provider,
            "title": entry.get("title", ""),
            "parent_id": entry.get("parent_id", ""),
            "project_id": entry.get("projectID", ""),
            "cost": entry.get("cost", "0"),
            "tokens_input": entry.get("tokens_input", "0"),
            "tokens_output": entry.get("tokens_output", "0"),
        }
        return {
            "timestamp": _normalize_timestamp(entry.get("timestamp", "")),
            "source": "opencode",
            "type": "session",
            "icon": "◆",
            "summary": summary,
            "detail": detail,
        }

    # Loop step
    if msg == "loop":
        step = entry.get("step", "0")
        return {
            "timestamp": _normalize_timestamp(entry.get("timestamp", "")),
            "source": "opencode",
            "type": "session",
            "icon": "◆",
            "summary": f"Loop step={step}",
            "detail": {"step": step, "session_id": entry.get("session_id", "")},
        }

    # Process message (no role/content in opencode log — just a message ID)
    if msg == "process":
        return {
            "timestamp": _normalize_timestamp(entry.get("timestamp", "")),
            "source": "opencode",
            "type": "session",
            "icon": "💬",
            "summary": "Process message",
            "detail": {
                "message_id": entry.get("messageID", ""),
                "session_id": entry.get("session_id", ""),
            },
        }

    # Exiting loop
    if msg == "exiting loop":
        return {
            "timestamp": _normalize_timestamp(entry.get("timestamp", "")),
            "source": "opencode",
            "type": "session",
            "icon": "◆",
            "summary": "Exiting loop",
            "detail": {"session_id": entry.get("session_id", "")},
        }

    # LLM runtime selected
    if msg == "llm runtime selected":
        provider = entry.get("llm_provider", "?")
        model = entry.get("llm_model", "?")
        return {
            "timestamp": _normalize_timestamp(entry.get("timestamp", "")),
            "source": "opencode",
            "type": "llm",
            "icon": "▲",
            "summary": f"LLM {provider}/{model}",
            "detail": {
                "provider": provider,
                "model": model,
                "runtime": entry.get("llm_runtime", ""),
            },
        }

    # Stream (LLM response)
    if msg == "stream":
        provider = entry.get("providerID", "?")
        model = entry.get("modelID", "?")
        agent = entry.get("agent", "?")
        mode = entry.get("mode", "?")
        return {
            "timestamp": _normalize_timestamp(entry.get("timestamp", "")),
            "source": "opencode",
            "type": "llm_stream",
            "icon": "▲",
            "summary": f"Stream {provider}/{model} agent={agent} ({mode})",
            "detail": {
                "provider": provider,
                "model": model,
                "agent": agent,
                "mode": mode,
            },
        }

    # Permission evaluated — tool call (allow) vs permission deny
    if msg == "evaluated":
        permission = entry.get("permission", "?")
        pattern = entry.get("pattern", "")
        action = entry.get("action_action", "?")

        # Denied → permission event
        if action == "deny":
            return {
                "timestamp": _normalize_timestamp(entry.get("timestamp", "")),
                "source": "opencode",
                "type": "permission",
                "icon": "▼",
                "summary": f"permission=deny {permission} {pattern}",
                "detail": {
                    "permission": permission,
                    "pattern": pattern,
                    "action": action,
                },
            }

        # Allowed (or missing) → tool call (classified by permission)
        type_, icon = _tool_type_and_icon(permission)
        return {
            "timestamp": _normalize_timestamp(entry.get("timestamp", "")),
            "source": "opencode",
            "type": type_,
            "icon": icon,
            "summary": f"{permission}: {pattern}",
            "detail": {
                "permission": permission,
                "pattern": pattern,
                "action": action,
            },
        }

    # Touching file
    if msg == "touching file":
        file_path = entry.get("file", "")
        action = entry.get("action", "edit")
        return {
            "timestamp": _normalize_timestamp(entry.get("timestamp", "")),
            "source": "opencode",
            "type": "file",
            "icon": "■",
            "summary": f"{action}: {file_path}",
            "detail": {"file": file_path, "action": action},
        }

    # Fallback: treat as hook
    return {
        "timestamp": _normalize_timestamp(entry.get("timestamp", "")),
        "source": "opencode",
        "type": "hook",
        "icon": "◈",
        "summary": f"opencode: {msg}" if msg else "opencode event",
        "detail": dict(entry),
    }


def _classify_zoo(entry: dict) -> dict | None:
    """Convert a ZooKeeper log entry to a unified trace event.

    Args:
        entry: Parsed ZooKeeper log entry (JSON).

    Returns:
        Unified event dict.
    """
    hook = entry.get("hook", "?")
    event = entry.get("event", "?")
    level = entry.get("level", "info")

    if hook == "context-metrics" and event == "context_measured":
        tokens = entry.get("estimated_tokens", 0)
        msgs = entry.get("message_count", 0)
        agent = entry.get("agent", "")
        if agent:
            summary = f"context [{agent}]: {tokens:,} tokens ({msgs} msgs)"
        else:
            summary = f"context: {tokens:,} tokens ({msgs} msgs)"
    else:
        summary = f"{hook}/{event}"

    detail = dict(entry)

    return {
        "timestamp": _normalize_timestamp(entry.get("timestamp", "")),
        "source": "zoo",
        "type": "hook",
        "icon": "◈",
        "summary": summary,
        "detail": detail,
        "level": level,
    }


def _parse_opencode_multi_session(
    path: str,
    sids: set[str],
) -> dict[str, list[dict]]:
    """Parse opencode log once, grouping entries by session_id.

    Single-file scan that returns ``{sid: [entry dicts]}`` for all
    requested session IDs.

    Handles ``message=evaluated`` lines that lack ``session.id`` by
    using the ``run → session_id`` mapping from ``message=created``
    lines.

    Args:
        path: Path to the opencode log file.
        sids: Set of session IDs to extract.

    Returns:
        Dict mapping each session_id to its list of parsed entry dicts.
        Sessions not present in the log will have an empty list.

    Raises:
        FileNotFoundError: If the log file is not found.
    """
    if not os.path.isfile(path):
        raise FileNotFoundError(f"Log file not found: {path}")

    if not sids:
        return {}

    run_to_session: dict[str, str] = {}
    result: dict[str, list[dict]] = {sid: [] for sid in sids}

    with open(path, "r", encoding="utf-8") as f:
        for line in f:
            entry = parse_opencode_line(line)
            if entry is None:
                continue

            # Build run → session_id mapping from 'created' lines
            if (
                entry.get("message") == "created"
                and entry.get("id")
                and entry.get("run")
            ):
                run_to_session[entry["run"]] = entry["id"]

            # Check direct session_id / id match
            matched_id = entry.get("session_id") or entry.get("id")
            if matched_id and matched_id in sids:
                result[matched_id].append(entry)
                continue

            # Check run-based mapping (for evaluated lines without session_id)
            run = entry.get("run")
            if run and run in run_to_session and run_to_session[run] in sids:
                result[run_to_session[run]].append(entry)

    return result


def _build_session_agents(
    oc_path: str,
    session_ids: set[str],
) -> dict[str, str]:
    """Build a map of session_id → agent/slug from opencode log.

    Only sessions present in *session_ids* are included.

    Args:
        oc_path: Path to the opencode log file.
        session_ids: Set of session IDs to look up.

    Returns:
        Dict mapping session_id to agent (slug fallback, empty fallback).
    """
    agents: dict[str, str] = {}
    if not os.path.isfile(oc_path) or not session_ids:
        return agents

    with open(oc_path, "r", encoding="utf-8") as f:
        for line in f:
            entry = parse_opencode_line(line)
            if entry is None:
                continue
            if entry.get("message") != "created":
                continue
            eid = entry.get("id", "")
            if eid in session_ids:
                agents[eid] = entry.get("agent", "") or entry.get("slug", "")

    return agents


def _parse_opencode_all(oc_path: str) -> list[dict]:
    """Parse an entire opencode log file in a single scan.

    Args:
        oc_path: Path to the opencode log file.

    Returns:
        List of all parsed entry dicts.

    Raises:
        FileNotFoundError: If the log file is not found.
    """
    if not os.path.isfile(oc_path):
        raise FileNotFoundError(f"Log file not found: {oc_path}")

    entries: list[dict] = []
    with open(oc_path, "r", encoding="utf-8") as f:
        for line in f:
            entry = parse_opencode_line(line)
            if entry is not None:
                entries.append(entry)
    return entries


def _discover_child_sessions_from_entries(
    all_entries: list[dict],
    root_session_id: str,
) -> list[tuple[str, int]]:
    """Discover child sessions from pre-parsed entries.

    Builds a ``parentID → [child IDs]`` map from ``message=created``
    lines, then BFS-traverses from *root_session_id*.

    Args:
        all_entries: Pre-parsed opencode log entries.
        root_session_id: Root session ID to start discovery from.

    Returns:
        List of ``(sid, depth)`` tuples including the root session
        (depth 0), direct children (depth 1), etc., in BFS order.
    """
    children: dict[str, list[str]] = defaultdict(list)

    for entry in all_entries:
        if entry.get("message") != "created":
            continue
        eid = entry.get("id", "")
        if not eid:
            continue
        pid = entry.get("parentID", "") or entry.get("parent_id", "")
        if pid and pid != "undefined":
            children[pid].append(eid)

    # BFS from root_session_id
    result: list[tuple[str, int]] = [(root_session_id, 0)]
    queue: deque[tuple[str, int]] = deque([(root_session_id, 0)])
    visited: set[str] = {root_session_id}

    while queue:
        current, depth = queue.popleft()
        for child in children.get(current, []):
            if child not in visited:
                visited.add(child)
                entry = (child, depth + 1)
                result.append(entry)
                queue.append(entry)

    return result


def _build_session_agents_from_entries(
    all_entries: list[dict],
    sids: set[str],
) -> dict[str, str]:
    """Build session_id → agent map from pre-parsed entries.

    Args:
        all_entries: Pre-parsed opencode log entries.
        sids: Set of session IDs to look up.

    Returns:
        Dict mapping session_id to agent (slug fallback, empty fallback).
    """
    agents: dict[str, str] = {}
    for entry in all_entries:
        if entry.get("message") != "created":
            continue
        eid = entry.get("id", "")
        if eid in sids:
            agents[eid] = entry.get("agent", "") or entry.get("slug", "")
    return agents


def _group_entries_by_session(
    all_entries: list[dict],
    sids: set[str],
) -> dict[str, list[dict]]:
    """Group pre-parsed entries by session ID.

    Handles ``message=evaluated`` lines that lack ``session.id`` by
    using the ``run → session_id`` mapping from ``message=created``
    lines.

    Args:
        all_entries: Pre-parsed opencode log entries.
        sids: Set of session IDs to extract.

    Returns:
        Dict mapping each session_id to its list of entry dicts.
        Sessions not present in the log will have an empty list.
    """
    if not sids:
        return {}

    run_to_session: dict[str, str] = {}
    result: dict[str, list[dict]] = {sid: [] for sid in sids}

    for entry in all_entries:
        # Build run → session_id mapping from 'created' lines
        if entry.get("message") == "created" and entry.get("id") and entry.get("run"):
            run_to_session[entry["run"]] = entry["id"]

        # Check direct session_id / id match
        matched_id = entry.get("session_id") or entry.get("id")
        if matched_id and matched_id in sids:
            result[matched_id].append(entry)
            continue

        # Check run-based mapping (for evaluated lines without session_id)
        run = entry.get("run")
        if run and run in run_to_session and run_to_session[run] in sids:
            result[run_to_session[run]].append(entry)

    return result


def build_timeline(
    session_id: str,
    opencode_path: str = "~/.local/share/opencode/log/opencode.log",
    include_children: bool = False,
) -> list[dict]:
    """Merge ZooKeeper + opencode logs, sorted by timestamp.

    When *include_children* is ``True``, automatically discovers and
    includes all child sessions (transitive descendants) of the given
    session.  Each event is tagged with a ``session_id`` and ``depth``
    field (0 for the root session, 1 for direct children, etc.).

    Args:
        session_id: Session ID to filter on.
        opencode_path: Path to the opencode log file.
        include_children: Whether to include child sessions.

    Returns:
        List of unified event dicts sorted by timestamp.

    Raises:
        FileNotFoundError: If the opencode log file is not found.
    """
    oc_path = os.path.expanduser(opencode_path)

    # Single scan: parse opencode log once
    all_entries = _parse_opencode_all(oc_path)

    # Discover sessions to include
    sessions: list[tuple[str, int]] = [(session_id, 0)]
    if include_children:
        sessions = _discover_child_sessions_from_entries(all_entries, session_id)

    # Pre-build session → agent map for child labelling
    all_sids = {sid for sid, _ in sessions}
    session_agents = _build_session_agents_from_entries(all_entries, all_sids)

    # Group entries by session
    oc_entries_by_sid = _group_entries_by_session(all_entries, all_sids)

    # Collect events for every session
    timeline: list[dict] = []

    for sid, depth in sessions:
        # ── ZooKeeper log ──
        zoo_dir = _get_zoo_log_dir()
        zoo_path = os.path.join(zoo_dir, f"opencode-{sid}.log")
        if os.path.isfile(zoo_path):
            with open(zoo_path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        zoo_ev = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    ev = _classify_zoo(zoo_ev)
                    if ev is not None:
                        ev["session_id"] = sid
                        ev["depth"] = depth
                        timeline.append(ev)

        # ── Opencode log (from pre-parsed multi-session map) ──
        for oc_entry in oc_entries_by_sid.get(sid, []):
            ev = _classify_opencode(oc_entry)
            if ev is not None:
                ev["session_id"] = sid
                ev["depth"] = depth
                timeline.append(ev)

    # ── Database messages (user / assistant) ──
    depth_map = dict(sessions)
    db_events = query_db_messages(list(all_sids))
    for ev in db_events:
        sid = ev.get("session_id", "")
        ev["depth"] = depth_map.get(sid, 0)
        timeline.append(ev)

    # Attach session_agent label for child events
    for ev in timeline:
        sid = ev.get("session_id", "")
        if sid in session_agents:
            ev["session_agent"] = session_agents[sid]

    # Sort by timestamp (missing timestamps last)
    timeline.sort(
        key=lambda e: (e.get("timestamp", ""), e.get("source", ""), e.get("type", ""))
    )

    return timeline


def build_stats(
    timeline: list[dict],
    child_sessions: list[dict] | None = None,
) -> dict:
    """Extract statistics from a timeline.

    Args:
        timeline: List of unified event dicts from build_timeline().
        child_sessions: Optional list of child session info dicts
            (each with keys ``session_id``, ``depth``, ``agent``,
            ``event_count``) to include in the returned stats.

    Returns:
        Dict with stats:
            - total_events
            - total_turns (loop steps)
            - llm_calls (stream events)
            - tool_calls (tool type events)
            - permission_checks
            - zoo_interventions (zoo source events)
            - session_events
            - file_events
            - child_sessions (list, only when *child_sessions* given)
            - type_distribution
            - source_distribution
            - time_span (duration dict or None)
    """
    total = len(timeline)
    type_dist: Counter[str] = Counter(e.get("type", "?") for e in timeline)
    source_dist: Counter[str] = Counter(e.get("source", "?") for e in timeline)

    # Time span
    timestamps = [e["timestamp"] for e in timeline if e.get("timestamp")]
    time_span = None
    if len(timestamps) >= 2:
        try:
            first = datetime.fromisoformat(timestamps[0].replace("Z", "+00:00"))
            last = datetime.fromisoformat(timestamps[-1].replace("Z", "+00:00"))
            delta = last - first
            time_span = {
                "start": timestamps[0],
                "end": timestamps[-1],
                "seconds": int(delta.total_seconds()),
            }
        except (ValueError, IndexError):
            pass

    result: dict[str, Any] = {
        "total_events": total,
        "total_turns": sum(
            1
            for e in timeline
            if e.get("source") == "opencode" and e.get("type") == "session"
        ),
        "llm_calls": type_dist.get("llm", 0) + type_dist.get("llm_stream", 0),
        "tool_calls": (
            type_dist.get("tool_read", 0)
            + type_dist.get("tool_write", 0)
            + type_dist.get("tool_exec", 0)
            + type_dist.get("tool_orch", 0)
            + type_dist.get("tool_other", 0)
        ),
        "permission_checks": type_dist.get("permission", 0),
        "zoo_interventions": source_dist.get("zoo", 0),
        "session_events": type_dist.get("session", 0),
        "file_events": type_dist.get("file", 0),
        "type_distribution": dict(type_dist),
        "source_distribution": dict(source_dist),
        "time_span": time_span,
        "tools": {
            "total": (
                type_dist.get("tool_read", 0)
                + type_dist.get("tool_write", 0)
                + type_dist.get("tool_exec", 0)
                + type_dist.get("tool_orch", 0)
                + type_dist.get("tool_other", 0)
            ),
            "read": type_dist.get("tool_read", 0),
            "write": type_dist.get("tool_write", 0),
            "exec": type_dist.get("tool_exec", 0),
            "orch": type_dist.get("tool_orch", 0),
            "other": type_dist.get("tool_other", 0),
        },
    }

    if child_sessions is not None:
        result["child_sessions"] = child_sessions
        result["total_child_sessions"] = len(child_sessions)
        result["total_child_events"] = sum(
            cs.get("event_count", 0) for cs in child_sessions
        )

    return result
