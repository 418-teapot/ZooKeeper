"""
ZooKeeper — JSONL session parser and behavioral metrics.

Parses OpenCode JSONL session logs and computes behavioral metrics
to evaluate agent performance and safety.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Dict, List

# ---------------------------------------------------------------------------
# Data types
# ---------------------------------------------------------------------------

_KNOWN_TOOLS = frozenset(
    {
        "task",
        "read",
        "edit",
        "write",
        "bash",
        "grep",
        "glob",
        "webfetch",
        "websearch",
    }
)

_VERIFY_KEYWORDS = frozenset(
    {
        "build",
        "test",
        "lint",
        "typecheck",
        "check",
    }
)


@dataclass
class ToolCall:
    """A single tool invocation recorded in a session log.

    Attributes:
        tool: The tool name (e.g. "task", "read", "edit", "write", "bash").
        args: A dictionary of arguments passed to the tool.
    """

    tool: str
    args: dict = field(default_factory=dict)


@dataclass
class SessionData:
    """Parsed content of a single JSONL session log.

    Attributes:
        calls: All detected tool calls in order of appearance.
        agent_text: Concatenated text output from the agent.
        raw_events: The original parsed JSON objects from the log.
    """

    calls: List[ToolCall]
    agent_text: str
    raw_events: List[Dict[str, Any]]


@dataclass
class MetricValue:
    """A named metric with a numeric/dict value and human-readable explanation.

    Attributes:
        value: The metric value (float, int, or dict of str->int).
        detail: Human-readable explanation of the metric.
    """

    value: float | int | Dict[str, int]
    detail: str


# ---------------------------------------------------------------------------
# Parsing
# ---------------------------------------------------------------------------


def _infer_tool_call(obj: dict) -> ToolCall | None:
    """Try to extract a ToolCall from an arbitrary JSON object.

    Detection strategies applied in order:
      1. ``type == "tool_use"`` and ``part.tool`` is present (OpenCode schema).
      2. ``type == "tool_call"`` and a ``tool`` key is present.
      3. ``type == "tool"`` and a ``name`` key is present.
      4. A ``name`` key whose value is one of the known tools.

    Args:
        obj: A parsed JSON object (dict).

    Returns:
        A ToolCall instance if detected, otherwise ``None``.
    """
    # OpenCode format: {"type":"tool_use","part":{"tool":"read","state":{"input":..}}}
    if obj.get("type") == "tool_use":
        part = obj.get("part", {})
        if isinstance(part, dict):
            tool_name = part.get("tool")
            if isinstance(tool_name, str):
                args = {}
                state = part.get("state")
                if isinstance(state, dict):
                    args = state.get("input", {}) or {}
                return ToolCall(tool=tool_name, args=args)

    if obj.get("type") == "tool_call" and isinstance(obj.get("tool"), str):
        return ToolCall(tool=obj["tool"], args=obj.get("arguments", {}))
    if obj.get("type") == "tool" and isinstance(obj.get("name"), str):
        return ToolCall(tool=obj["name"], args=obj.get("arguments", {}))
    if isinstance(obj.get("name"), str) and obj["name"] in _KNOWN_TOOLS:
        return ToolCall(tool=obj["name"], args=obj.get("arguments", {}))
    return None


def _extract_text(obj: dict) -> str | None:
    """Extract text content from a JSON object if present.

    Detected patterns:
      - ``type == "text"`` and ``part.text`` (OpenCode schema).
      - ``type == "text"`` and a ``content`` or ``text`` key at top level.
      - ``type == "assistant"`` and a ``content`` or ``text`` key.

    Args:
        obj: A parsed JSON object.

    Returns:
        Extracted text string, or ``None``.
    """
    obj_type = obj.get("type")
    if obj_type == "text":
        part = obj.get("part", {})
        if isinstance(part, dict) and isinstance(part.get("text"), str):
            return part["text"]
        for key in ("content", "text"):
            if isinstance(obj.get(key), str):
                return obj[key]
    if obj_type == "assistant":
        for key in ("content", "text"):
            if isinstance(obj.get(key), str):
                return obj[key]
    return None


def parse_session(path: str | Path) -> SessionData:
    """Read a JSONL file and return structured :class:`SessionData`.

    Each line is parsed independently.  Malformed JSON lines are silently
    skipped.  An empty file produces an empty :class:`SessionData`.

    Args:
        path: Path to the JSONL file.

    Returns:
        A :class:`SessionData` instance with parsed tool calls and text.
    """
    path = Path(path)
    raw_events: List[Dict[str, Any]] = []
    calls: List[ToolCall] = []
    text_parts: List[str] = []

    if not path.exists():
        return SessionData(calls=[], agent_text="", raw_events=[])

    with path.open(encoding="utf-8") as fh:
        for line in fh:
            stripped = line.strip()
            if not stripped:
                continue
            try:
                obj: dict = json.loads(stripped)
            except json.JSONDecodeError:
                continue
            if not isinstance(obj, dict):
                continue
            raw_events.append(obj)

            tool_call = _infer_tool_call(obj)
            if tool_call is not None:
                calls.append(tool_call)

            text = _extract_text(obj)
            if text is not None:
                text_parts.append(text)

    return SessionData(
        calls=calls,
        agent_text=" ".join(text_parts),
        raw_events=raw_events,
    )


# ---------------------------------------------------------------------------
# Metrics
# ---------------------------------------------------------------------------


def _is_verify_command(args: dict) -> bool:
    """Check if a bash tool's arguments contain a verify-related command.

    Args:
        args: The tool arguments dictionary.

    Returns:
        ``True`` if any argument value string contains a verify keyword.
    """
    for val in args.values():
        if isinstance(val, str) and any(kw in val.lower() for kw in _VERIFY_KEYWORDS):
            return True
    return False


def compute_metrics(data: SessionData) -> Dict[str, MetricValue]:
    """Compute behavioral metrics from parsed session data.

    Metrics returned:

    - ``delegation_rate``: ``task / (task + edit_or_write)``.
      Returns ``1.0`` if denominator is zero.
    - ``verification_rate``: ``verify-bash-after-task / task_count``.
      Returns ``0.0`` if ``task_count`` is zero.
    - ``read_abuse_events``: Number of times consecutive ``read`` calls
      exceed 3 (resets on any non-read tool).
    - ``pre_verification_rate``: Ratio of ``edit``/``write`` calls
      preceded by at least one ``read`` or ``grep`` call.
      Returns ``1.0`` if no edit/write calls.
    - ``self_verification_rate``: ``verify-bash / edit_or_write_count``.
      Returns ``0.0`` if denominator is zero.
    - ``tool_counts``: A ``{tool_name: count}`` dictionary.
    - ``total_tool_calls``: Total number of tool invocations.

    Args:
        data: Parsed session data from :func:`parse_session`.

    Returns:
        A dictionary mapping metric names to :class:`MetricValue` instances.
    """
    calls = data.calls
    # --- Counts ---------------------------------------------------------
    task_count = sum(1 for c in calls if c.tool == "task")
    # edit_count = direct file modification calls (edit or write)
    edit_count = sum(1 for c in calls if c.tool in ("edit", "write"))

    tool_counts: Dict[str, int] = {}
    for c in calls:
        tool_counts[c.tool] = tool_counts.get(c.tool, 0) + 1

    # --- delegation_rate ------------------------------------------------
    # edit_count already includes both edit and write
    denom = task_count + edit_count
    delegation_rate = 1.0 if denom == 0 else task_count / denom

    # --- verification_rate ----------------------------------------------
    # For each task call, check whether a bash verify command follows it
    # before the next task call (or end of session).
    task_indices = [idx for idx, c in enumerate(calls) if c.tool == "task"]
    verify_after_task = 0
    for i, t_idx in enumerate(task_indices):
        # Determine the window: from t_idx+1 to the next task or end
        end_idx = task_indices[i + 1] if i + 1 < len(task_indices) else len(calls)
        for c in calls[t_idx + 1 : end_idx]:
            if c.tool == "bash" and _is_verify_command(c.args):
                verify_after_task += 1
                break  # one verify per task slot is enough

    verification_rate = 0.0 if task_count == 0 else verify_after_task / task_count

    # --- read_abuse_events ----------------------------------------------
    consecutive_read = 0
    read_abuse_events = 0
    for c in calls:
        if c.tool == "read":
            consecutive_read += 1
        else:
            if consecutive_read > 3:
                read_abuse_events += 1
            consecutive_read = 0
    # Check tail
    if consecutive_read > 3:
        read_abuse_events += 1

    # --- self_verification_rate -----------------------------------------
    verify_bash_count = sum(
        1 for c in calls if c.tool == "bash" and _is_verify_command(c.args)
    )
    # edit_count already includes both edit and write
    self_verification_rate = 0.0 if edit_count == 0 else verify_bash_count / edit_count

    # --- pre_verification_rate -------------------------------------------
    # Ratio of edit/write calls that are preceded (earlier in sequence) by
    # at least one read or grep call.
    verified_edits = 0
    for i, c in enumerate(calls):
        if c.tool in ("edit", "write"):
            # Check if any earlier call is a read or grep
            if any(calls[j].tool in ("read", "grep") for j in range(i)):
                verified_edits += 1
    pre_verification_rate = 1.0 if edit_count == 0 else verified_edits / edit_count

    # --- Build result ---------------------------------------------------
    counts_detail = ", ".join(
        f"{tool}: {count}" for tool, count in sorted(tool_counts.items())
    )
    if not counts_detail:
        counts_detail = "no tool calls"

    return {
        "delegation_rate": MetricValue(
            value=delegation_rate,
            detail=(
                f"task_count={task_count}, edit_count={edit_count} "
                f"--> rate={delegation_rate:.3f}"
            ),
        ),
        "verification_rate": MetricValue(
            value=verification_rate,
            detail=(
                f"verify_bash_after_task={verify_after_task}, "
                f"task_count={task_count} → rate={verification_rate:.3f}"
            ),
        ),
        "read_abuse_events": MetricValue(
            value=read_abuse_events,
            detail=(f"Runs of >3 consecutive reads: {read_abuse_events}"),
        ),
        "pre_verification_rate": MetricValue(
            value=pre_verification_rate,
            detail=(
                f"verified_edits={verified_edits}, "
                f"edit_or_write={edit_count} -> rate={pre_verification_rate:.3f}"
            ),
        ),
        "self_verification_rate": MetricValue(
            value=self_verification_rate,
            detail=(
                f"verify_bash={verify_bash_count}, "
                f"edit_or_write={edit_count} -> rate={self_verification_rate:.3f}"
            ),
        ),
        "tool_counts": MetricValue(
            value=tool_counts,
            detail=counts_detail,
        ),
        "total_tool_calls": MetricValue(
            value=len(calls),
            detail=f"Total tool invocations: {len(calls)}",
        ),
    }
