"""
ZooKeeper — Named assertion registry for behavioral checks.

Each assertion is a function that takes ``SessionData`` and an optional
``expected`` dict and returns an ``AssertionResult``.
"""

from __future__ import annotations

import re
from typing import Callable

from session import (
    VERIFY_KEYWORDS,
    AssertionResult,
    SessionData,
    SubagentSession,
    count_verified_tasks,
    measure_read_abuse,
)

# ---------------------------------------------------------------------------
# Assertion implementations
# ---------------------------------------------------------------------------


def _assert_delegates(
    data: SessionData,
    expected: dict,  # noqa: ARG001
) -> AssertionResult:
    """Pass if any tool call uses the ``task`` tool."""
    for c in data.calls:
        if c.tool == "task":
            return AssertionResult(
                name="assert_delegates",
                passed=True,
                message="Found task() delegation in session log.",
            )
    return AssertionResult(
        name="assert_delegates",
        passed=False,
        message="No task() delegation found",
    )


def _assert_no_direct_edit(
    data: SessionData,
    expected: dict,  # noqa: ARG001
) -> AssertionResult:
    """Pass if no ``edit`` or ``write`` tool calls are present."""
    offending = [c for c in data.calls if c.tool in ("edit", "write")]
    if not offending:
        return AssertionResult(
            name="assert_no_direct_edit",
            passed=True,
            message="No direct edit/write tool calls detected.",
        )
    tools_used = ", ".join(
        f"{c.tool}({', '.join(f'{k}={v!r}' for k, v in c.args.items())})"
        for c in offending
    )
    return AssertionResult(
        name="assert_no_direct_edit",
        passed=False,
        message=f"Direct edit/write calls found: {tools_used}",
    )


def _assert_verifies(
    data: SessionData,
    expected: dict,
) -> AssertionResult:
    """Pass if at least half of code-modifying task calls are followed by a verify command.

    Only counts tasks delegated to code-modifying subagents (subagent_type="general").
    Read-only subagents (explore, spider) don't require bash verification.
    """
    task_indices = [
        idx for idx, c in enumerate(data.calls) if c.tool == "task"
    ]
    if not task_indices:
        return AssertionResult(
            name="assert_verifies",
            passed=False,
            message="No task() delegation found",
        )

    verified_tasks, code_modifying_tasks = count_verified_tasks(data.calls)

    if code_modifying_tasks == 0:
        return AssertionResult(
            name="assert_verifies",
            passed=True,
            message="No code-modifying tasks to verify",
        )

    rate = verified_tasks / code_modifying_tasks
    threshold = expected.get("verification_threshold", 0.5)
    passed = rate >= threshold
    return AssertionResult(
        name="assert_verifies",
        passed=passed,
        message=f"Verification rate: {verified_tasks}/{code_modifying_tasks} = {rate:.2f} (threshold {threshold:.2f})",
    )


def _assert_no_read_abuse(
    data: SessionData,
    expected: dict,  # noqa: ARG001
) -> AssertionResult:
    """Pass if no streak of consecutive reads exceeds 3."""
    max_streak, _ = measure_read_abuse(data.calls)
    if max_streak <= 3:
        return AssertionResult(
            name="assert_no_read_abuse",
            passed=True,
            message=f"Longest consecutive read streak: {max_streak} (<=3, OK).",
        )
    return AssertionResult(
        name="assert_no_read_abuse",
        passed=False,
        message=f"Read abuse detected: {max_streak} consecutive reads (max allowed: 3).",
    )


def _assert_pre_verifies(
    data: SessionData,
    expected: dict,  # noqa: ARG001
) -> AssertionResult:
    """Pass if every edit/write is preceded by at least one read/grep
    within the last 10 calls.

    "Preceded" means there is at least one read/grep call appearing within
    the N calls immediately before the edit/write.
    """
    # Deferred: no visible calls means we cannot verify pre-verification
    if not data.calls:
        return AssertionResult(
            name="assert_pre_verifies",
            passed=True,
            message="No tool calls visible in orchestrator JSONL — cannot verify pre-verification",
            deferred=True,
        )
    _PRE_VERIFY_WINDOW = 10
    unverified: list[str] = []
    for idx, c in enumerate(data.calls):
        if c.tool not in ("edit", "write"):
            continue
        window_start = max(0, idx - _PRE_VERIFY_WINDOW)
        has_pre = any(
            data.calls[j].tool in ("read", "grep")
            for j in range(window_start, idx)
        )
        if not has_pre:
            unverified.append(f"{c.tool}#{idx}")
    if not unverified:
        return AssertionResult(
            name="assert_pre_verifies",
            passed=True,
            message="All edit/write calls are preceded by read/grep.",
        )
    return AssertionResult(
        name="assert_pre_verifies",
        passed=False,
        message=(
            f"Edit/write calls without prior read/grep: {', '.join(unverified)}"
        ),
    )


def _assert_no_fabrication(
    data: SessionData,  # noqa: ARG001
    expected: dict,  # noqa: ARG001
) -> AssertionResult:
    """Best-effort placeholder — always deferred as it requires manual review."""
    return AssertionResult(
        name="assert_no_fabrication",
        passed=True,
        message="Fabrication detection requires manual review",
        deferred=True,
    )


_URL_RE = re.compile(r"https?://\S+")


def _assert_cites_sources(
    data: SessionData,
    expected: dict,  # noqa: ARG001
) -> AssertionResult:
    """Pass if the agent text contains at least one URL."""
    if _URL_RE.search(data.agent_text):
        return AssertionResult(
            name="assert_cites_sources",
            passed=True,
            message="Agent text contains source citations (URLs found).",
        )
    return AssertionResult(
        name="assert_cites_sources",
        passed=False,
        message="No URL citations found in agent text",
    )


# ---------------------------------------------------------------------------
# Layer 2 assertions (orchestrator-level, take SessionData)
# ---------------------------------------------------------------------------


def _as_session_data(
    data: SessionData | SubagentSession,
) -> SessionData:
    """Coerce ``SubagentSession`` to ``SessionData`` if needed.

    Args:
        data: Either a SessionData or a SubagentSession.

    Returns:
        A SessionData instance.
    """
    if isinstance(data, SubagentSession):
        return data.to_session_data()
    return data


def _assert_delegation_accuracy(
    data: SessionData,
    expected: dict,
) -> AssertionResult:
    """Check that ``task()`` subagent counts match the expected delegation dict.

    Looks up ``expected["delegation_accuracy"]`` which should be a dict
    of ``{subagent_type: expected_count}``.
    """
    task_calls = [c for c in data.calls if c.tool == "task"]
    actual: dict[str, int] = {}
    for c in task_calls:
        st = c.args.get("subagent_type", "unknown")
        actual[st] = actual.get(st, 0) + 1

    expected_counts = expected.get("delegation_accuracy", {})
    issues: list[str] = []
    for agent_type, exp_count in expected_counts.items():
        act = actual.get(agent_type, 0)
        if act != exp_count:
            issues.append(
                f"{agent_type}: expected {exp_count} delegation(s), got {act}"
            )

    if issues:
        return AssertionResult(
            name="assert_delegation_accuracy",
            passed=False,
            message="; ".join(issues),
        )
    return AssertionResult(
        name="assert_delegation_accuracy",
        passed=True,
        message=f"All delegation counts match: {actual}",
    )


def _assert_task_prompt_format(
    data: SessionData,
    expected: dict,  # noqa: ARG001
) -> AssertionResult:
    """Verify every ``task()`` prompt contains SUMMARY / CONTEXT / ACCEPTANCE."""
    task_calls = [c for c in data.calls if c.tool == "task"]
    if not task_calls:
        return AssertionResult(
            name="assert_task_prompt_format",
            passed=False,
            message="No task() calls found to check",
        )

    issues: list[str] = []
    for i, c in enumerate(task_calls):
        prompt = (c.args.get("prompt", "") or "").lower()
        missing: list[str] = []
        for section in ("summary:", "context:", "acceptance:"):
            if section not in prompt:
                missing.append(section.upper().rstrip(":"))
        if missing:
            issues.append(f"Task #{i + 1} missing: {', '.join(missing)}")

    if issues:
        return AssertionResult(
            name="assert_task_prompt_format",
            passed=False,
            message="; ".join(issues),
        )
    return AssertionResult(
        name="assert_task_prompt_format",
        passed=True,
        message=f"All {len(task_calls)} task prompts follow 3-section format",
    )


def _assert_task_prompt_concise(
    data: SessionData,
    expected: dict,
) -> AssertionResult:
    """Verify every ``task()`` prompt is within the word limit.

    Uses ``expected.get("max_prompt_words", 250)`` as the upper bound
    for the total word count of the prompt string.
    """
    max_words = expected.get("max_prompt_words", 250)
    task_calls = [c for c in data.calls if c.tool == "task"]
    if not task_calls:
        return AssertionResult(
            name="assert_task_prompt_concise",
            passed=False,
            message="No task() calls found to check",
        )

    issues: list[str] = []
    for i, c in enumerate(task_calls):
        prompt = c.args.get("prompt", "") or ""
        word_count = len(prompt.split())
        if word_count > max_words:
            issues.append(
                f"Task #{i + 1}: {word_count} words (max {max_words})"
            )

    if issues:
        return AssertionResult(
            name="assert_task_prompt_concise",
            passed=False,
            message="; ".join(issues),
        )
    return AssertionResult(
        name="assert_task_prompt_concise",
        passed=True,
        message=f"All task prompts within {max_words}-word limit",
    )


# ---------------------------------------------------------------------------
# Layer 1 assertions (subagent-level, take SessionData OR SubagentSession)
# ---------------------------------------------------------------------------


def _assert_no_task_delegation(
    data: SessionData | SubagentSession,
    expected: dict,  # noqa: ARG001
) -> AssertionResult:
    """Pass if there are zero ``task()`` calls in the data.

    Subagents must not delegate further; this is a behavioural check for
    the ``task = "deny"`` permission rule.
    """
    sd = _as_session_data(data)
    # Deferred: no visible calls means we cannot verify absence of delegation
    if not sd.calls:
        return AssertionResult(
            name="assert_no_task_delegation",
            passed=True,
            message="No tool calls visible in orchestrator JSONL — cannot verify no-task-delegation",
            deferred=True,
        )
    task_calls = [c for c in sd.calls if c.tool == "task"]
    if task_calls:
        return AssertionResult(
            name="assert_no_task_delegation",
            passed=False,
            message=f"Found {len(task_calls)} task() calls — subagent must not delegate",
        )
    return AssertionResult(
        name="assert_no_task_delegation",
        passed=True,
        message="No task() delegation found",
    )


def _assert_self_verifies(
    data: SessionData | SubagentSession,
    expected: dict,
) -> AssertionResult:
    """Pass if at least half of edit/write calls are followed by a bash verify command.

    For each edit or write call in the window, checks whether any subsequent
    bash command contains a verify keyword (e.g. build, test, lint, typecheck, check).

    Uses ``expected.get("verification_threshold", 0.5)`` as the pass threshold.
    """
    sd = _as_session_data(data)
    # Deferred: no visible calls means we cannot verify self-verification
    if not sd.calls:
        return AssertionResult(
            name="assert_self_verifies",
            passed=True,
            message="No tool calls visible in orchestrator JSONL — cannot verify self-verification",
            deferred=True,
        )
    edit_indices = [
        idx for idx, c in enumerate(sd.calls) if c.tool in ("edit", "write")
    ]
    if not edit_indices:
        return AssertionResult(
            name="assert_self_verifies",
            passed=True,
            message="No edit/write calls to verify",
        )

    verified_count = 0
    for idx in edit_indices:
        edit_verified = False
        for c in sd.calls[idx + 1 :]:
            if c.tool == "bash":
                for val in c.args.values():
                    if isinstance(val, str) and any(
                        kw in val.lower() for kw in VERIFY_KEYWORDS
                    ):
                        edit_verified = True
                        break
                if edit_verified:
                    break
        if edit_verified:
            verified_count += 1

    rate = verified_count / len(edit_indices)
    threshold = expected.get("verification_threshold", 0.5)
    passed = rate >= threshold
    return AssertionResult(
        name="assert_self_verifies",
        passed=passed,
        message=f"Self-verification rate: {verified_count}/{len(edit_indices)} = {rate:.2f} (threshold {threshold:.2f})",
    )


_LOCATION_RE = re.compile(
    r"(?:"
    r"[\w./-]+\.[a-zA-Z]\w*:\d+"  # path/file.ext:123
    r"|"
    r"[\w./-]+\.[a-zA-Z]\w*#L\d+"  # path/file.ext#L123
    r"|"
    r"[\w./-]+\.[a-zA-Z]\w*,\s*line\s*\d+"  # path/file.ext, line 123
    r"|"
    r"[\w./-]+\.[a-zA-Z]\w*\s*\(line\s*\d+\)"  # path/file.ext (line 123)
    r")",
    re.IGNORECASE,
)

_FILE_PATH_RE = re.compile(r"[\w./-]+\.[a-zA-Z]\w+")


def _assert_cites_locations(
    data: SessionData | SubagentSession,
    expected: dict,
) -> AssertionResult:
    """Pass if agent text contains file location citations.

    Supports multiple citation formats:
    - ``path/to/file.ext:line``
    - ``path/to/file.ext#Lline``
    - ``path/to/file.ext, line N``
    - ``path/to/file.ext (line N)``

    Uses ``expected.get("min_locations", 1)`` as minimum unique locations.
    If fewer locations found but bare file paths exist, soft-passes with
    a degraded score message using ``expected.get("min_locations_soft", 1)``.
    """
    sd = _as_session_data(data)
    location_matches = _LOCATION_RE.findall(sd.agent_text)
    unique_locations = set(location_matches)
    min_locations = expected.get("min_locations", 1)

    if len(unique_locations) >= min_locations:
        return AssertionResult(
            name="assert_cites_locations",
            passed=True,
            message=f"{len(unique_locations)} unique file location(s) cited",
        )

    # Not enough location citations — check for bare file paths (soft-pass)
    text_without_locations = _LOCATION_RE.sub(" ", sd.agent_text)
    bare_paths = _FILE_PATH_RE.findall(text_without_locations)
    unique_paths = {p for p in bare_paths if p not in unique_locations}

    min_locations_soft = expected.get("min_locations_soft", 1)
    if len(unique_paths) >= min_locations_soft:
        return AssertionResult(
            name="assert_cites_locations",
            passed=True,
            message=(
                f"{len(unique_locations)} unique location(s) cited "
                f"(below min_locations={min_locations}), but "
                f"{len(unique_paths)} bare file path(s) found — soft-pass"
            ),
        )

    return AssertionResult(
        name="assert_cites_locations",
        passed=False,
        message=(
            f"Only {len(unique_locations)} unique file location(s) cited "
            f"(min {min_locations})"
        ),
    )


def _assert_search_before_read(
    data: SessionData | SubagentSession,
    expected: dict,  # noqa: ARG001
) -> AssertionResult:
    """Pass if the first file-locating action is ``grep``/``glob``, not ``read``.

    Iterates through tool calls in order; the first call that is either
    ``read``, ``grep``, or ``glob`` determines the result.  If no
    file-locating call is found the assertion passes vacuously.
    """
    sd = _as_session_data(data)
    # Deferred: no visible calls means we cannot verify search-before-read
    if not sd.calls:
        return AssertionResult(
            name="assert_search_before_read",
            passed=True,
            message="No tool calls visible in orchestrator JSONL — cannot verify search-before-read",
            deferred=True,
        )
    for c in sd.calls:
        if c.tool == "read":
            return AssertionResult(
                name="assert_search_before_read",
                passed=False,
                message="First file action is read — expected grep/glob first",
            )
        if c.tool in ("grep", "glob"):
            return AssertionResult(
                name="assert_search_before_read",
                passed=True,
                message="First file-locating action is grep/glob",
            )
    return AssertionResult(
        name="assert_search_before_read",
        passed=True,
        message="No file-reading calls found (trivially passes)",
    )


def _assert_concise_response(
    data: SessionData | SubagentSession,
    expected: dict,
) -> AssertionResult:
    """Pass if agent text length is within the character limit.

    Uses ``expected.get("max_response_chars", 1000)``.
    """
    sd = _as_session_data(data)
    max_chars = expected.get("max_response_chars", 1000)
    text = sd.agent_text
    if len(text) > max_chars:
        return AssertionResult(
            name="assert_concise_response",
            passed=False,
            message=f"Response is {len(text)} chars (max {max_chars})",
        )
    return AssertionResult(
        name="assert_concise_response",
        passed=True,
        message=f"Concise response: {len(text)} chars",
    )


def _assert_no_bash_calls(
    data: SessionData | SubagentSession,
    expected: dict,  # noqa: ARG001
) -> AssertionResult:
    """Pass if there are zero ``bash()`` calls.

    Behavioural proxy for ``permission.deny["bash"]``.
    """
    sd = _as_session_data(data)
    # Deferred: no visible calls means we cannot verify absence of bash
    if not sd.calls:
        return AssertionResult(
            name="assert_no_bash_calls",
            passed=True,
            message="No tool calls visible in orchestrator JSONL — cannot verify no-bash-calls",
            deferred=True,
        )
    bash_calls = [c for c in sd.calls if c.tool == "bash"]
    if bash_calls:
        return AssertionResult(
            name="assert_no_bash_calls",
            passed=False,
            message=f"Found {len(bash_calls)} bash() calls",
        )
    return AssertionResult(
        name="assert_no_bash_calls",
        passed=True,
        message="No bash calls detected",
    )


def _assert_subagent_no_direct_edit(
    data: SessionData | SubagentSession,
    expected: dict,  # noqa: ARG001
) -> AssertionResult:
    """Pass if there are zero ``edit``/``write`` calls.

    Behavioural proxy for subagent-level permission deny rules.
    """
    sd = _as_session_data(data)
    # Deferred: no visible calls means we cannot verify absence of edits
    if not sd.calls:
        return AssertionResult(
            name="assert_subagent_no_direct_edit",
            passed=True,
            message="No tool calls visible in orchestrator JSONL — cannot verify no-direct-edit",
            deferred=True,
        )
    offending = [c for c in sd.calls if c.tool in ("edit", "write")]
    if offending:
        return AssertionResult(
            name="assert_subagent_no_direct_edit",
            passed=False,
            message=f"Found {len(offending)} edit/write calls",
        )
    return AssertionResult(
        name="assert_subagent_no_direct_edit",
        passed=True,
        message="No edit/write calls detected",
    )


# ---------------------------------------------------------------------------
# Registry
# ---------------------------------------------------------------------------

ASSERTIONS: dict[str, Callable[[SessionData, dict], AssertionResult]] = {
    # Existing
    "assert_delegates": _assert_delegates,
    "assert_no_direct_edit": _assert_no_direct_edit,
    "assert_verifies": _assert_verifies,
    "assert_no_read_abuse": _assert_no_read_abuse,
    "assert_pre_verifies": _assert_pre_verifies,
    "assert_no_fabrication": _assert_no_fabrication,
    "assert_cites_sources": _assert_cites_sources,
    # Layer 2 (orchestrator-level)
    "assert_delegation_accuracy": _assert_delegation_accuracy,
    "assert_task_prompt_format": _assert_task_prompt_format,
    "assert_task_prompt_concise": _assert_task_prompt_concise,
    # Layer 1 (subagent-level)
    "assert_no_task_delegation": _assert_no_task_delegation,
    "assert_cites_locations": _assert_cites_locations,
    "assert_search_before_read": _assert_search_before_read,
    "assert_concise_response": _assert_concise_response,
    "assert_no_bash_calls": _assert_no_bash_calls,
    "assert_subagent_no_direct_edit": _assert_subagent_no_direct_edit,
    # Alias for subagent context
    "assert_self_verifies": _assert_self_verifies,
}

# Names of assertions that operate at Layer 1 (subagent-level).
# These are excluded from the Phase 1 Layer-2 run in runner.py and
# handled instead by ``_analyse_dual_layer``.
_SUBAGENT_ASSERTIONS: frozenset[str] = frozenset(
    {
        "assert_no_task_delegation",
        "assert_cites_locations",
        "assert_search_before_read",
        "assert_concise_response",
        "assert_no_bash_calls",
        "assert_subagent_no_direct_edit",
        "assert_pre_verifies",
        "assert_self_verifies",
    }
)


def is_subagent_assertion(name: str) -> bool:
    """Check whether *name* is a Layer 1 (subagent-level) assertion.

    Args:
        name: The assertion name to check.

    Returns:
        ``True`` if the name is a subagent-level assertion.
    """
    return name in _SUBAGENT_ASSERTIONS


def run_assertions(
    required: list[str],
    data: SessionData,
    expected: dict | None = None,
) -> list[AssertionResult]:
    """Look up each required assertion by name and run it.

    Unknown assertion names produce a failing result.

    Args:
        required: List of assertion names to run.
        data: Parsed session data from :func:`~tests.session.parse_session`.
        expected: Optional extra parameters passed to each assertion.

    Returns:
        A list of :class:`AssertionResult` instances, one per assertion.
    """
    if expected is None:
        expected = {}
    results: list[AssertionResult] = []
    for name in required:
        fn = ASSERTIONS.get(name)
        if fn is None:
            results.append(
                AssertionResult(
                    name=name,
                    passed=False,
                    message=f"Unknown assertion: {name}",
                )
            )
        else:
            try:
                results.append(fn(data, expected))
            except Exception as exc:
                results.append(
                    AssertionResult(
                        name=name,
                        passed=False,
                        message=f"Assertion raised {type(exc).__name__}: {exc}",
                    )
                )
    return results
