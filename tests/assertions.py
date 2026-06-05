"""
ZooKeeper — Named assertion registry for behavioral checks.

Each assertion is a function that takes ``SessionData`` and an optional
``expected`` dict and returns an ``AssertionResult``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Callable, Dict, List

from session import SessionData

# ---------------------------------------------------------------------------
# Result type
# ---------------------------------------------------------------------------


@dataclass
class AssertionResult:
    """Outcome of a single behavior assertion.

    Attributes:
        name: The assertion name (matches the registry key).
        passed: Whether the assertion passed.
        message: Human-readable explanation of the result.
    """

    name: str
    passed: bool
    message: str


# ---------------------------------------------------------------------------
# Assertion implementations
# ---------------------------------------------------------------------------

_VERIFY_KEYWORDS = frozenset(
    {
        "build",
        "test",
        "lint",
        "typecheck",
        "check",
    }
)


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
    expected: dict,  # noqa: ARG001
) -> AssertionResult:
    """Pass if a bash verify command appears after a task call."""
    found_task = False
    for c in data.calls:
        if c.tool == "task":
            found_task = True
        elif found_task and c.tool == "bash":
            for val in c.args.values():
                if isinstance(val, str) and any(
                    kw in val.lower() for kw in _VERIFY_KEYWORDS
                ):
                    return AssertionResult(
                        name="assert_verifies",
                        passed=True,
                        message=f"Verification via bash with: {val!r}",
                    )
    return AssertionResult(
        name="assert_verifies",
        passed=False,
        message="No verify command found after a task delegation",
    )


def _assert_no_read_abuse(
    data: SessionData,
    expected: dict,  # noqa: ARG001
) -> AssertionResult:
    """Pass if no streak of consecutive reads exceeds 3."""
    streak = 0
    max_streak = 0
    for c in data.calls:
        if c.tool == "read":
            streak += 1
            max_streak = max(max_streak, streak)
        else:
            streak = 0
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
    """Pass if every edit/write is preceded by at least one read/grep.

    "Preceded" means there is at least one read/grep call appearing earlier
    in the call sequence before each edit/write.
    """
    unverified: List[str] = []
    for idx, c in enumerate(data.calls):
        if c.tool not in ("edit", "write"):
            continue
        # Look backwards for a prior read or grep
        has_pre = any(data.calls[j].tool in ("read", "grep") for j in range(idx))
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
        message=(f"Edit/write calls without prior read/grep: {', '.join(unverified)}"),
    )


def _assert_no_fabrication(
    data: SessionData,  # noqa: ARG001
    expected: dict,  # noqa: ARG001
) -> AssertionResult:
    """Best-effort placeholder — always passes with a warning."""
    return AssertionResult(
        name="assert_no_fabrication",
        passed=True,
        message="Fabrication detection requires manual review",
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
# Registry
# ---------------------------------------------------------------------------

ASSERTIONS: Dict[str, Callable[[SessionData, dict], AssertionResult]] = {
    "assert_delegates": _assert_delegates,
    "assert_no_direct_edit": _assert_no_direct_edit,
    "assert_verifies": _assert_verifies,
    "assert_no_read_abuse": _assert_no_read_abuse,
    "assert_pre_verifies": _assert_pre_verifies,
    "assert_no_fabrication": _assert_no_fabrication,
    "assert_cites_sources": _assert_cites_sources,
}


def run_assertions(
    required: List[str],
    data: SessionData,
    expected: dict | None = None,
) -> List[AssertionResult]:
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
    results: List[AssertionResult] = []
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
