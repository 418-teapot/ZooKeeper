#!/usr/bin/env python3
"""Terminal output and JSON report generation for ZooKeeper prompt tests.

Provides colored ANSI terminal output (via print_report) and JSON file
serialization (via write_report) for structured test results.
"""

import json
from dataclasses import dataclass, field
from pathlib import Path


# ── Color constants ─────────────────────────────────────────────────────


class _Colors:
    """ANSI escape sequences for colored terminal output."""

    GREEN = "\033[92m"
    RED = "\033[91m"
    CYAN = "\033[96m"
    YELLOW = "\033[93m"
    BOLD = "\033[1m"
    NC = "\033[0m"  # No Color / reset


# ── Shared data types ───────────────────────────────────────────────────


@dataclass
class AssertionResult:
    """Result of a single named assertion check.

    Attributes:
        name: Short identifier for the assertion (e.g. \"output_clean\").
        passed: Whether the assertion succeeded.
        message: Human-readable description of what was checked.
    """

    name: str
    passed: bool
    message: str


@dataclass
class ThresholdResult:
    """Result of comparing a metric against a numeric threshold.

    Attributes:
        metric: Name of the metric (e.g. \"accuracy\").
        value: Actual measured value.
        threshold: Expected bound value.
        direction: \"min\" when value must be >= threshold, \"max\" when <=.
        passed: Whether the value satisfies the threshold.
    """

    metric: str
    value: float
    threshold: float
    direction: str  # "min" or "max"
    passed: bool


@dataclass
class ScenarioReport:
    """Aggregated results for a single test scenario.

    Attributes:
        name: Scenario name from the TOML [scenario] section.
        agent: Agent under test (e.g. \"build\").
        phase: Test phase (\"RED\", \"GREEN\", \"PRESSURE\").
        passed: Overall pass/fail for this scenario.
        assertions: List of assertion results.
        thresholds: List of threshold comparison results.
        metrics: Raw metric key-value pairs from session analysis.
        error: Optional error string if execution or parsing failed.
    """

    name: str
    agent: str
    phase: str
    passed: bool
    assertions: list = field(default_factory=list)  # list[AssertionResult]
    thresholds: list = field(default_factory=list)  # list[ThresholdResult]
    metrics: dict = field(default_factory=dict)
    error: str | None = None


# ── Helper for color formatting ─────────────────────────────────────────


def _color(text: str, color: str) -> str:
    """Wrap text in an ANSI color code and reset.

    Args:
        text: The text to colorize.
        color: ANSI escape sequence (one of the _Colors constants).

    Returns:
        The text wrapped with the color escape and reset code.
    """
    return f"{color}{text}{_Colors.NC}"


# ── Public API ──────────────────────────────────────────────────────────


def print_report(reports: list[ScenarioReport]) -> None:
    """Print a colored test report to stdout.

    Renders a header, per-scenario detail sections (assertions, thresholds,
    errors), and a final summary line showing passed/failed/total counts.
    Uses ANSI escape codes for colorised terminal output.

    Args:
        reports: Ordered list of scenario results to display.
    """
    sep = "━" * 55
    print()
    print(_color(sep, _Colors.CYAN))
    print(_color("  ZooKeeper Prompt Test Report", _Colors.CYAN))
    print(_color(sep, _Colors.CYAN))
    print()

    passed_count = 0
    failed_count = 0

    for report in reports:
        # ── Scenario header ──────────────────────────────────────────
        label = f"{report.name} ({report.agent} / {report.phase})"
        if report.error:
            label += f"  {_color('ERROR', _Colors.RED)}"
        elif report.passed:
            label += f"  {_color('PASSED', _Colors.GREEN)}"
        else:
            label += f"  {_color('FAILED', _Colors.RED)}"
        print(_color(label, _Colors.BOLD))

        # ── Error block ──────────────────────────────────────────────
        if report.error:
            print(f"  {_color('✖', _Colors.RED)} {report.error}")
            print()

        # ── Assertions ───────────────────────────────────────────────
        for a in report.assertions:
            icon = _color("✓", _Colors.GREEN) if a.passed else _color("✗", _Colors.RED)
            print(f"  {icon} {a.name}: {a.message}")

        # ── Thresholds ───────────────────────────────────────────────
        for t in report.thresholds:
            icon = _color("✓", _Colors.GREEN) if t.passed else _color("✗", _Colors.RED)
            op = ">=" if t.direction == "min" else "<="
            detail = f"{t.metric} ({t.value} {op} {t.threshold})"
            print(f"  {icon} {detail}")

        # ── Counts ───────────────────────────────────────────────────
        if report.passed:
            passed_count += 1
        else:
            failed_count += 1

        print()

    # ── Summary line ─────────────────────────────────────────────────
    total = passed_count + failed_count
    summary = f"  {passed_count} passed / {failed_count} failed / {total} total"
    print(_color(sep, _Colors.CYAN))
    if failed_count == 0:
        print(_color(summary, _Colors.GREEN))
    else:
        print(_color(summary, _Colors.YELLOW))
    print(_color(sep, _Colors.CYAN))
    print()


def write_report(reports: list[ScenarioReport], path: Path) -> None:
    """Write a JSON report file from a list of scenario reports.

    Each ScenarioReport is serialised via its __dict__ attribute.  The output
    file is human-readable (2-space indent).

    Args:
        reports: Ordered list of scenario results to serialise.
        path: Destination file path (parent directory must exist).
    """
    with open(path, "w", encoding="utf-8") as f:
        json.dump(
            reports,
            f,
            default=lambda o: o.__dict__,
            indent=2,
            ensure_ascii=False,
        )
        f.write("\n")
