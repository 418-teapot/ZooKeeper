"""
ZooKeeper — JSONL session parser and behavioral metrics.

Parses OpenCode JSONL session logs and computes behavioral metrics
to evaluate agent performance and safety.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

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

VERIFY_KEYWORDS = frozenset(
    {
        "build",
        "test",
        "lint",
        "typecheck",
        "check",
        "verify",
    }
)


@dataclass
class AssertionResult:
    """Outcome of a single behavior assertion.

    Attributes:
        name: The assertion name (matches the registry key).
        passed: Whether the assertion passed.
        message: Human-readable explanation of the result.
        deferred: If ``True``, the assertion could not be meaningfully
            verified (e.g. because the subagent's tool calls are not
            visible in the orchestrator JSONL). A deferred assertion
            is informational and does not count as pass or fail.
    """

    name: str
    passed: bool
    message: str
    deferred: bool = False


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

    calls: list[ToolCall]
    agent_text: str
    raw_events: list[dict[str, Any]]


@dataclass
class MetricValue:
    """A named metric with a numeric/dict value and human-readable explanation.

    Attributes:
        value: The metric value (float, int, or dict of str->int).
        detail: Human-readable explanation of the metric.
    """

    value: float | int | dict[str, int]
    detail: str


@dataclass
class SubagentSession:
    """A window of session data belonging to a single subagent invocation.

    Extracted from a parent ``SessionData`` by :func:`split_subagent_sessions`.
    Each ``SubagentSession`` corresponds to one ``task()`` call from the
    orchestrator.

    Attributes:
        name: Display name like ``"general#1"``, ``"explore#1"``.
        subagent_type: The subagent type (e.g. ``"general"``, ``"explore"``).
        task_prompt: The prompt string sent to the subagent.
        task_args: Full args dict of the task() call.
        calls: Tool calls made during this subagent's execution window.
        agent_text: Concatenated text output from this window.
    """

    name: str
    subagent_type: str
    task_prompt: str
    task_args: dict[str, Any]
    calls: list[ToolCall] = field(default_factory=list)
    agent_text: str = ""

    def to_session_data(self) -> SessionData:
        """Convert this subagent window into a plain SessionData.

        Returns:
            A :class:`SessionData` with the same calls and agent_text but
            no raw_events (these are not reconstructed for subagent windows).
        """
        return SessionData(
            calls=self.calls,
            agent_text=self.agent_text,
            raw_events=[],
        )


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
    raw_events: list[dict[str, Any]] = []
    calls: list[ToolCall] = []
    text_parts: list[str] = []

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


def is_verify_command(args: dict) -> bool:
    """Check if a bash tool's arguments contain a verify-related command.

    Args:
        args: The tool arguments dictionary.

    Returns:
        ``True`` if any argument value string contains a verify keyword.
    """
    for val in args.values():
        if isinstance(val, str) and any(
            kw in val.lower() for kw in VERIFY_KEYWORDS
        ):
            return True
    return False


def count_verified_tasks(calls: list[ToolCall]) -> tuple[int, int]:
    """Count code-modifying task() calls and how many are followed by a bash verify.

    A task is considered "verified" if a ``bash`` command containing a verify
    keyword appears after it and before the next ``task()`` call (or end of
    session).  Only tasks delegated to code-modifying subagents
    (``subagent_type="general"``) are counted; read-only subagents
    (explore, spider) do not require bash verification.

    Args:
        calls: The ordered list of tool calls from a session.

    Returns:
        A tuple ``(verified_count, code_modifying_task_count)``.
    """
    task_indices = [idx for idx, c in enumerate(calls) if c.tool == "task"]
    verified_count = 0
    code_modifying_tasks = 0
    for i, t_idx in enumerate(task_indices):
        subagent = calls[t_idx].args.get("subagent_type", "")
        is_code_task = subagent == "general"
        if is_code_task:
            code_modifying_tasks += 1

        end_idx = (
            task_indices[i + 1] if i + 1 < len(task_indices) else len(calls)
        )

        if is_code_task:
            for c in calls[t_idx + 1 : end_idx]:
                if c.tool == "bash" and is_verify_command(c.args):
                    verified_count += 1
                    break
    return verified_count, code_modifying_tasks


def measure_read_abuse(calls: list[ToolCall]) -> tuple[int, int]:
    """Measure consecutive read streaks in a call sequence.

    Args:
        calls: The ordered list of tool calls from a session.

    Returns:
        A tuple ``(max_consecutive_read, abuse_event_count)`` where
        ``abuse_event_count`` is the number of runs that exceed 3
        consecutive reads.
    """
    consecutive_read = 0
    max_consecutive_read = 0
    abuse_events = 0
    for c in calls:
        if c.tool == "read":
            consecutive_read += 1
            max_consecutive_read = max(max_consecutive_read, consecutive_read)
        else:
            if consecutive_read > 3:
                abuse_events += 1
            consecutive_read = 0
    # Check tail
    if consecutive_read > 3:
        abuse_events += 1
    if consecutive_read > max_consecutive_read:
        max_consecutive_read = consecutive_read
    return max_consecutive_read, abuse_events


def compute_metrics(data: SessionData) -> dict[str, MetricValue]:
    """Compute behavioral metrics from parsed session data.

    Metrics returned:

    - ``delegation_rate``: ``task / (task + edit_or_write)``.
      Returns ``1.0`` if denominator is zero.
    - ``verification_rate``: ``verify-bash-after-task / code_modifying_tasks``.
      Only counts tasks delegated to code-modifying subagents (subagent_type="general").
      Returns ``0.0`` if ``code_modifying_tasks`` is zero.
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

    tool_counts: dict[str, int] = {}
    for c in calls:
        tool_counts[c.tool] = tool_counts.get(c.tool, 0) + 1

    # --- delegation_rate ------------------------------------------------
    # edit_count already includes both edit and write
    denom = task_count + edit_count
    delegation_rate = 1.0 if denom == 0 else task_count / denom

    # --- verification_rate ----------------------------------------------
    verified_after_task, code_modifying_tasks = count_verified_tasks(calls)
    verification_rate = (
        0.0
        if code_modifying_tasks == 0
        else verified_after_task / code_modifying_tasks
    )

    # --- read_abuse_events ----------------------------------------------
    _max_streak, read_abuse_events = measure_read_abuse(calls)

    # --- self_verification_rate -----------------------------------------
    verify_bash_count = sum(
        1 for c in calls if c.tool == "bash" and is_verify_command(c.args)
    )
    # edit_count already includes both edit and write
    self_verification_rate = (
        0.0 if edit_count == 0 else verify_bash_count / edit_count
    )

    # --- pre_verification_rate -------------------------------------------
    # An edit/write is "pre-verified" if at least one of the last N
    # preceding calls (within the same session) is a read or grep.
    _PRE_VERIFY_WINDOW = 10
    verified_edits = 0
    for i, c in enumerate(calls):
        if c.tool in ("edit", "write"):
            window_start = max(0, i - _PRE_VERIFY_WINDOW)
            if any(
                calls[j].tool in ("read", "grep")
                for j in range(window_start, i)
            ):
                verified_edits += 1
    pre_verification_rate = (
        1.0 if edit_count == 0 else verified_edits / edit_count
    )

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
                f"verify_bash_after_task={verified_after_task}, "
                f"code_modifying_tasks={code_modifying_tasks} → rate={verification_rate:.3f}"
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
        "is_empty_session": MetricValue(
            value=1.0 if (not calls and not data.agent_text.strip()) else 0.0,
            detail="No tool calls and no agent text in session"
            if (not calls and not data.agent_text.strip())
            else "Session has content",
        ),
    }


# ---------------------------------------------------------------------------
# Subagent session splitting
# ---------------------------------------------------------------------------


def _build_call_to_event_map(data: SessionData) -> dict[int, int]:
    """Build a mapping from tool-call index to raw-event index.

    Iterates through ``raw_events`` and reconstructs the same detection
    logic used in :func:`parse_session` so we can locate which raw event
    produced each call.

    Args:
        data: Parsed session data.

    Returns:
        A dict ``{call_index: raw_event_index}``.
    """
    mapping: dict[int, int] = {}
    call_index = 0
    for event_idx, obj in enumerate(data.raw_events):
        tc = _infer_tool_call(obj)
        if tc is not None:
            mapping[call_index] = event_idx
            call_index += 1
    return mapping


def split_subagent_sessions(data: SessionData) -> list[SubagentSession]:
    """Split session data into per-subagent windows based on ``task()`` calls.

    Each ``task()`` invocation marks the beginning of a subagent window.
    The window extends to the next ``task()`` call (or the end of the
    session).  Tool calls and text events within that window are assigned
    to the subagent.

    Args:
        data: Parsed session data from :func:`parse_session`.

    Returns:
        A list of :class:`SubagentSession` instances, one per ``task()``
        call, ordered by occurrence.

    Notes:
        Subagent windows may include orchestrator-level calls that occur
        between subagent return and the next delegation (e.g. build's own
        ``bash`` verification).  Layer 1 assertions should be designed
        with this overlap in mind.
    """
    call_to_event = _build_call_to_event_map(data)

    task_calls = [(i, c) for i, c in enumerate(data.calls) if c.tool == "task"]
    if not task_calls:
        return []

    sessions: list[SubagentSession] = []

    for window_idx, (call_idx, task_call) in enumerate(task_calls):
        subagent_type = task_call.args.get("subagent_type", "unknown")
        task_prompt = task_call.args.get("prompt", "")
        task_args = task_call.args

        # --- Call window -------------------------------------------------
        # The orchestrator JSONL stores each task() as a single tool_use
        # event containing both input AND output. All tool calls *after* a
        # task() event belong to the orchestrator, not the subagent.
        # Subagent intermediate calls live in a separate SQLite DB and are
        # NOT visible in the orchestrator JSONL. Always set calls=[] for
        # subagent windows derived from the orchestrator JSONL.
        window_calls: list[ToolCall] = []

        # --- Text window -------------------------------------------------
        # Subagent response text lives in the task() event's output field:
        #   part["state"]["output"]
        window_text = ""
        task_event_idx = call_to_event.get(call_idx)
        if task_event_idx is not None:
            raw = data.raw_events[task_event_idx]
            # OpenCode schema: {"type":"tool_use","part":{"tool":"task","state":{"output":"..."}}}
            part = raw.get("part", {})
            if isinstance(part, dict):
                state = part.get("state", {})
                if isinstance(state, dict):
                    output = state.get("output")
                    if isinstance(output, str):
                        window_text = output

        # --- Naming ------------------------------------------------------
        name = f"{subagent_type}#{window_idx + 1}"

        sessions.append(
            SubagentSession(
                name=name,
                subagent_type=subagent_type,
                task_prompt=task_prompt,
                task_args=task_args,
                calls=window_calls,
                agent_text=window_text,
            )
        )

    return sessions
