"""Build a Jaeger JSON trace document from a timeline of events."""

from __future__ import annotations

import hashlib
import json
from datetime import datetime
from typing import Any


def _to_epoch_us(ts: str) -> int:
    """Convert an ISO 8601 timestamp to epoch microseconds.

    Args:
        ts: ISO 8601 timestamp string (may end with ``Z``).

    Returns:
        Epoch time in microseconds.
    """
    ts = ts.replace("Z", "+00:00") if ts.endswith("Z") else ts
    dt = datetime.fromisoformat(ts)
    return int(dt.timestamp() * 1_000_000)


def _get_operation_name(event: dict) -> str:
    """Derive the Jaeger operationName from a timeline event.

    Args:
        event: A unified timeline event dict.

    Returns:
        Operation name string.
    """
    etype: str = event.get("type", "")
    source: str = event.get("source", "")
    detail: dict = event.get("detail", {}) or {}

    op_map: dict[str, str] = {
        "llm": "llm.select",
        "llm_stream": "llm.stream",
        "permission": "permission.deny",
        "tool_read": "tool.read",
        "tool_write": "tool.write",
        "tool_exec": "tool.exec",
        "tool_orch": "tool.orch",
        "tool_other": "tool.other",
        "file": "file.touch",
        "user_msg": "user.message",
        "assistant_reply": "assistant.reply",
        "assistant_reasoning": "assistant.reasoning",
    }

    if etype == "session":
        if "slug" in detail:
            return "session.create"
        if "step" in detail:
            return "session.loop"
        if "message_id" in detail:
            return "session.process"
        return "session.exit"

    if etype == "hook":
        if source == "zoo":
            hook_name = detail.get("hook", "unknown")
            return f"zoo.{hook_name}"
        return "opencode.hook"

    return op_map.get(etype, etype)


def _build_tags(event: dict) -> list[dict]:
    """Build Jaeger span tags from a timeline event.

    Produces common tags for all events plus type-specific tags from the
    ``detail`` sub-dict.

    Args:
        event: A unified timeline event dict.

    Returns:
        List of tag dicts with ``key``, ``type``, ``value``.
    """
    detail: dict = event.get("detail", {}) or {}
    etype: str = event.get("type", "")
    source: str = event.get("source", "")
    depth: int = event.get("depth", 0)
    summary: str = event.get("summary", "")

    tags: list[dict] = [
        {"key": "source", "type": "string", "value": source},
        {"key": "event.type", "type": "string", "value": etype},
        {
            "key": "session_id",
            "type": "string",
            "value": event.get("session_id", ""),
        },
        {"key": "depth", "type": "int64", "value": depth},
        {"key": "summary", "type": "string", "value": summary[:256]},
    ]

    if depth > 0:
        tags.append(
            {
                "key": "session_agent",
                "type": "string",
                "value": event.get("session_agent", ""),
            }
        )

    # ---- Type-specific tags ----
    if etype == "session":
        _add_detail_tags(
            tags,
            detail,
            (
                "slug",
                "agent",
                "model_id",
                "model_provider",
                "parent_id",
                "project_id",
                "cost",
                "tokens_input",
                "tokens_output",
            ),
        )
    elif etype in ("llm", "llm_stream"):
        _add_detail_tags(
            tags, detail, ("provider", "model", "runtime", "agent", "mode")
        )
    elif etype in (
        "permission",
        "tool_read",
        "tool_write",
        "tool_exec",
        "tool_orch",
        "tool_other",
    ):
        _add_detail_tags(tags, detail, ("permission", "pattern", "action"))
    elif etype == "file":
        _add_detail_tags(tags, detail, ("file", "action"))
    elif etype == "hook" and source == "zoo":
        _add_detail_tags(tags, detail, ("hook", "event", "level"))
    elif etype == "user_msg":
        _add_detail_tags(tags, detail, ("agent",), event)
    elif etype in ("assistant_reply", "assistant_reasoning"):
        _add_detail_tags(tags, detail, ("model", "agent"), event)
    elif etype == "hook" and source != "zoo":
        _add_detail_tags(tags, detail, ("message",))

    return tags


def _add_detail_tags(
    tags: list[dict],
    detail: dict,
    keys: tuple[str, ...],
    event: dict | None = None,
) -> None:
    """Add non-empty tags from *detail* (or fallback *event* top-level keys).

    Args:
        tags: Mutable list of tag dicts to append to.
        detail: The event's ``detail`` sub-dict.
        keys: Key names to extract.
        event: Optional full event dict used as fallback when a key is
            not found in *detail*.
    """
    for k in keys:
        val = detail.get(k) or (event and event.get(k)) or ""
        if val:
            tags.append({"key": k, "type": "string", "value": str(val)})


def _agent_category_tid(etype: str) -> int:
    """Map event type to Chrome trace ``tid`` (thread ID) for lane colouring.

    Each category gets a distinct thread ID so Chrome Trace renders them
    as different coloured sub-lanes within the same process row.

    Args:
        etype: The event type string (e.g. ``"tool_read"``, ``"llm"``).

    Returns:
        Integer thread ID (0–10).
    """
    tid_map: dict[str, int] = {
        "tool_read": 1,
        "tool_write": 2,
        "tool_exec": 3,
        "tool_orch": 4,
        "tool_other": 5,
        "llm": 6,
        "llm_stream": 6,
        "user_msg": 7,
        "assistant_reply": 8,
        "assistant_reasoning": 9,
        "hook": 10,
    }
    return tid_map.get(etype, 0)


def _find_root_agent(timeline: list[dict]) -> str:
    """Extract the root session's agent name from the first session.create event.

    Args:
        timeline: List of unified event dicts.

    Returns:
        Agent name string, or empty string if not found.
    """
    detail = _find_root_session_detail(timeline)
    return detail.get("agent", "")


def build_chrome_trace(timeline: list[dict]) -> list[dict]:
    """Convert a timeline into a Chrome Trace Event Format JSON array.

    Each timeline event becomes a complete event (``ph="X"``) with a
    duration equal to the delta to the next event (or 1 ms for the last
    event).

    ``pid`` is assigned per unique ``session_id`` — the root session
    (first encountered) gets pid 1 and each child session gets an
    independent pid (2, 3, 4, …).  ``tid`` is mapped from the event type
    category for sub-lane colouring within each process row.

    Args:
        timeline: List of unified event dicts from
            :func:`~tools._trace_builder.build_timeline`.

    Returns:
        List of Chrome Trace Event Format dicts.  An empty *timeline*
        returns ``[]``.
    """
    if not timeline:
        return []

    # ── First pass: build session_id → pid mapping ──
    sid_pid_map: dict[str, int] = {}
    next_pid = 1
    for event in timeline:
        sid = event.get("session_id", "") or ""
        ts = event.get("timestamp", "")
        if sid and sid not in sid_pid_map and ts:
            sid_pid_map[sid] = next_pid
            next_pid += 1

    default_pid = sid_pid_map.get("", 1)

    # Root-level agent fallback from session.create
    root_agent = _find_root_agent(timeline)

    # ── Second pass: build Chrome trace events ──
    events: list[dict] = []
    for idx, event in enumerate(timeline):
        ts = event.get("timestamp", "")
        if not ts:
            continue

        start_us = _to_epoch_us(ts)

        # Duration: max(1000, delta to next event) — last event falls back
        # to 1000 µs
        if idx + 1 < len(timeline):
            next_ts = timeline[idx + 1].get("timestamp", "")
            if next_ts:
                duration = max(1000, _to_epoch_us(next_ts) - start_us)
            else:
                duration = 1000
        else:
            duration = 1000

        sid = event.get("session_id", "") or ""
        etype: str = event.get("type", "")
        depth: int = event.get("depth", 0)
        detail: dict = event.get("detail", {}) or {}
        session_agent: str = event.get("session_agent", "") or ""

        pid = sid_pid_map.get(sid, default_pid)
        tid = _agent_category_tid(etype)

        summary: str = event.get("summary", "")
        name = summary[:120] if summary else ""
        if depth > 0:
            agent_label = session_agent or "?"
            name = f"[子:{agent_label}] {name}"

        args: dict[str, Any] = {}

        # Always attach agent info for Chrome trace filtering
        if session_agent:
            args["agent"] = session_agent
        elif root_agent:
            args["agent"] = root_agent
        else:
            args["agent"] = ""

        # Existing content / detail fields
        if etype in ("user_msg", "assistant_reply", "assistant_reasoning"):
            content = event.get("content", "")
            if content:
                args["content"] = content[:500]
        elif detail:
            for k in (
                "hook",
                "event",
                "level",
                "model",
                "agent",
                "provider",
                "permission",
                "pattern",
                "action",
                "file",
                "slug",
                "mode",
                "runtime",
            ):
                v = detail.get(k)
                if v:
                    args[k] = v

        ev: dict[str, Any] = {
            "name": name,
            "ph": "X",
            "ts": start_us,
            "dur": duration,
            "pid": pid,
            "tid": tid,
            "cat": etype,
        }
        if args:
            ev["args"] = args

        events.append(ev)

    return events


def _build_logs(event: dict) -> list[dict]:
    """Build Jaeger span logs for content-heavy events.

    - ``user_msg``, ``assistant_reply``, ``assistant_reasoning``: the full
      ``content`` field is placed in log fields.
    - ``opencode`` hook events: the entire ``detail`` dict is dumped as a
      JSON string into log fields.

    Args:
        event: A unified timeline event dict.

    Returns:
        List of log dicts (each with ``timestamp`` and ``fields``).
    """
    etype: str = event.get("type", "")
    source: str = event.get("source", "")
    ts = event.get("timestamp", "")
    epoch_us = _to_epoch_us(ts) if ts else 0

    # user_msg / assistant_reply / assistant_reasoning: large content in logs
    if etype in ("user_msg", "assistant_reply", "assistant_reasoning"):
        content = event.get("content", "")
        if content:
            return [
                {
                    "timestamp": epoch_us,
                    "fields": [
                        {"key": "content", "type": "string", "value": content},
                    ],
                }
            ]

    # opencode hook: dump entire detail as JSON string
    if etype == "hook" and source == "opencode":
        detail = event.get("detail", {}) or {}
        return [
            {
                "timestamp": epoch_us,
                "fields": [
                    {
                        "key": "detail",
                        "type": "string",
                        "value": json.dumps(detail, ensure_ascii=False),
                    },
                ],
            }
        ]

    return []


def _find_root_session_detail(timeline: list[dict]) -> dict:
    """Find the first session.create event's detail for process tags.

    Args:
        timeline: List of unified event dicts.

    Returns:
        The ``detail`` dict of the first session.create event, or empty dict.
    """
    for ev in timeline:
        if ev.get("type") == "session":
            detail = ev.get("detail", {}) or {}
            if detail.get("slug"):
                return detail
    return {}


def build_jaeger_doc(session_id: str, timeline: list[dict]) -> dict:
    """Convert a timeline into a Jaeger JSON trace document.

    Each timeline event becomes a child span of the root ``"session"`` span.
    Large content fields (user messages, assistant replies, reasoning) are
    placed in span logs.

    Args:
        session_id: UUID string (hyphenated) used to derive the trace ID.
        timeline: List of unified event dicts from
            :func:`~tools._trace_builder.build_timeline`.

    Returns:
        Jaeger-compatible dict matching the ``/api/traces/{trace-id}``
        response shape::

            {
                "data": [{"traceID": "...", "spans": [...], "processes": {...}}],
                "total": 1,
            }

        An empty *timeline* returns ``{"data": []}``.
    """
    if not timeline:
        return {"data": []}

    trace_id: str = hashlib.sha256(session_id.encode()).hexdigest()[:32]

    # ---- Process tags from root session ----
    root_detail = _find_root_session_detail(timeline)
    process_tags: list[dict] = []
    for k in ("agent", "model_id", "model_provider"):
        val = root_detail.get(k, "")
        if val:
            process_tags.append(
                {"key": k, "type": "string", "value": str(val)}
            )

    # ---- Root span ----
    first_ts = timeline[0].get("timestamp", "")
    last_ts = timeline[-1].get("timestamp", "")
    root_start_us = _to_epoch_us(first_ts) if first_ts else 0
    root_end_us = _to_epoch_us(last_ts) if last_ts else 0
    root_duration = max(1, root_end_us - root_start_us)

    root_span: dict[str, Any] = {
        "traceID": trace_id,
        "spanID": "0000000000000001",
        "operationName": "session",
        "startTime": root_start_us,
        "duration": root_duration,
        "tags": [
            {"key": "source", "type": "string", "value": "opencode"},
            {"key": "session_id", "type": "string", "value": session_id},
        ],
        "logs": [],
        "processID": "p1",
    }
    spans: list[dict] = [root_span]

    # ---- Event spans ----
    for idx, event in enumerate(timeline):
        ts = event.get("timestamp", "")
        if not ts:
            continue

        span_id: str = f"{idx + 2:016x}"
        start_time: int = _to_epoch_us(ts)

        # Duration: max(1000, delta to next event) — last event falls back
        # to 1_000_000 µs (1 second)
        if idx + 1 < len(timeline):
            next_ts = timeline[idx + 1].get("timestamp", "")
            if next_ts:
                duration = max(1000, _to_epoch_us(next_ts) - start_time)
            else:
                duration = 1_000_000
        else:
            duration = 1_000_000

        span: dict[str, Any] = {
            "traceID": trace_id,
            "spanID": span_id,
            "operationName": _get_operation_name(event),
            "references": [
                {
                    "refType": "CHILD_OF",
                    "traceID": trace_id,
                    "spanID": "0000000000000001",
                }
            ],
            "startTime": start_time,
            "duration": duration,
            "tags": _build_tags(event),
            "logs": _build_logs(event),
            "processID": "p1",
        }
        spans.append(span)

    return {
        "data": [
            {
                "traceID": trace_id,
                "spans": spans,
                "processes": {
                    "p1": {
                        "serviceName": "opencode",
                        "tags": process_tags,
                    }
                },
            }
        ],
        "total": 1,
    }
