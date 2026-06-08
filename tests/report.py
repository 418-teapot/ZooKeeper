#!/usr/bin/env python3
"""Terminal output and JSON report generation for ZooKeeper prompt tests.

Provides colored ANSI terminal output (via print_report) and JSON file
serialization (via write_report) for structured test results.
"""

import dataclasses
import json
import os
import subprocess
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from session import AssertionResult  # noqa: F401  # re-exported for runner.py

# ── Color constants ─────────────────────────────────────────────────────


_GREEN = "\033[92m"
_RED = "\033[91m"
_CYAN = "\033[96m"
_YELLOW = "\033[93m"
_BOLD = "\033[1m"
_NC = "\033[0m"  # No Color / reset


# ── Shared data types ───────────────────────────────────────────────────


@dataclass
class RunMetadata:
    """Metadata about the test run, collected once at report time.

    Attributes:
        timestamp: ISO8601 timestamp of when the report was written.
        git_commit: Git commit hash from ``git rev-parse HEAD``.
        opencode_version: Version string from ``opencode --version``.
        python: Python version (``sys.version.split()[0]``).
        runner_file: Absolute path to the runner script.
    """

    timestamp: str
    git_commit: str
    opencode_version: str
    python: str
    runner_file: str


@dataclass
class TestRun:
    """Top-level container for a test run report.

    Attributes:
        metadata: Run-level metadata.
        scenarios: Ordered list of per-scenario results.
    """

    metadata: RunMetadata
    scenarios: list


@dataclass
class ThresholdResult:
    """Result of comparing a metric against a numeric threshold.

    Attributes:
        metric: Name of the metric (e.g. "accuracy").
        value: Actual measured value.
        threshold: Expected bound value.
        direction: "min" when value must be >= threshold, "max" when <=.
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
        agent: Agent under test (e.g. "build").
        phase: Test phase ("RED", "GREEN", "PRESSURE").
        passed: Overall pass/fail for this scenario.
        assertions: List of assertion results.
        thresholds: List of threshold comparison results.
        metrics: Raw metric key-value pairs from session analysis.
        error: Optional error string if execution or parsing failed.
        deferred_count: Number of assertions that were deferred.
        total_assertion_count: Total number of assertions evaluated.
    """

    name: str
    agent: str
    phase: str
    passed: bool
    assertions: list = field(default_factory=list)  # list[AssertionResult]
    thresholds: list = field(default_factory=list)  # list[ThresholdResult]
    metrics: dict = field(default_factory=dict)
    error: str | None = None
    deferred_count: int = 0
    total_assertion_count: int = 0


# ── Helper for metadata collection ──────────────────────────────────────


def _collect_metadata(
    git_commit: str | None = None,
    opencode_version: str | None = None,
    runner_file: str | None = None,
) -> RunMetadata:
    """Build a RunMetadata instance, shelling out for missing values.

    Args:
        git_commit: Pre-captured git commit hash, or None to shell out.
        opencode_version: Pre-captured opencode version, or None to shell out.
        runner_file: Path to the runner script, or None (will use "unknown").

    Returns:
        A populated RunMetadata dataclass instance.
    """
    if git_commit is None:
        try:
            git_commit = subprocess.run(
                ["git", "rev-parse", "HEAD"],
                capture_output=True,
                text=True,
                timeout=10,
            ).stdout.strip()
        except Exception:
            git_commit = "unknown"
    if opencode_version is None:
        try:
            opencode_version = subprocess.run(
                ["opencode", "--version"],
                capture_output=True,
                text=True,
                timeout=10,
            ).stdout.strip()
        except Exception:
            opencode_version = "unknown"

    return RunMetadata(
        timestamp=datetime.now(timezone.utc).isoformat(),
        git_commit=git_commit,
        opencode_version=opencode_version,
        python=sys.version.split()[0],
        runner_file=runner_file or "unknown",
    )


# ── Helper for color formatting ─────────────────────────────────────────


def _color(text: str, color: str) -> str:
    """Wrap text in an ANSI color code and reset.

    Args:
        text: The text to colorize.
        color: ANSI escape sequence (one of the _Colors constants).

    Returns:
        The text wrapped with the color escape and reset code.
    """
    return f"{color}{text}{_NC}"


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
    print(_color(sep, _CYAN))
    print(_color("  ZooKeeper 提示词测试报告", _CYAN))
    print(_color(sep, _CYAN))
    print()

    passed_count = 0
    failed_count = 0

    for report in reports:
        # ── Scenario header ──────────────────────────────────────────
        label = f"{report.name} ({report.agent} / {report.phase})"
        if report.error:
            label += f"  {_color('错误', _RED)}"
        elif report.passed:
            label += f"  {_color('通过', _GREEN)}"
        else:
            label += f"  {_color('失败', _RED)}"

        # ── Deferred marker (when most assertions are deferred) ──────
        if report.deferred_count > report.total_assertion_count // 2:
            label += _color(
                f"  (deferred: {report.deferred_count}/{report.total_assertion_count})",
                _YELLOW,
            )

        print(_color(label, _BOLD))

        # ── Error block ──────────────────────────────────────────────
        if report.error:
            print(f"  {_color('✖', _RED)} {report.error}")
            print()

        # ── Assertions ───────────────────────────────────────────────
        for a in report.assertions:
            if a.deferred:
                icon = _color("⊘", _YELLOW)
            elif a.passed:
                icon = _color("✓", _GREEN)
            else:
                icon = _color("✗", _RED)
            print(f"  {icon} {a.name}: {a.message}")

        # ── Thresholds ───────────────────────────────────────────────
        for t in report.thresholds:
            icon = _color("✓", _GREEN) if t.passed else _color("✗", _RED)
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
    total_deferred = sum(r.deferred_count for r in reports)
    summary = f"  通过 {passed_count} / 失败 {failed_count} / 共 {total}"
    if total_deferred > 0:
        summary += _color(f"  (deferred: {total_deferred})", _YELLOW)
    print(_color(sep, _CYAN))
    if failed_count == 0:
        print(_color(summary, _GREEN))
    else:
        print(_color(summary, _YELLOW))
    print(_color(sep, _CYAN))
    print()


def write_report(
    reports: list[ScenarioReport],
    path: Path,
    git_commit: str | None = None,
    opencode_version: str | None = None,
    runner_file: str | None = None,
) -> None:
    """Write a JSON report file from a list of scenario reports.

    Wraps the reports in a ``TestRun`` container with ``RunMetadata``.
    The output has the shape ``{"metadata": {...}, "scenarios": [...]}``.
    Writes atomically to a ``.tmp`` file then ``os.replace``.

    Args:
        reports: Ordered list of scenario results to serialise.
        path: Destination file path (parent directory must exist).
        git_commit: Pre-captured git commit hash, or None to auto-detect.
        opencode_version: Pre-captured opencode version, or None to auto-detect.
        runner_file: Path to the runner script, or None to use "unknown".
    """
    metadata = _collect_metadata(
        git_commit=git_commit,
        opencode_version=opencode_version,
        runner_file=runner_file,
    )
    test_run = TestRun(metadata=metadata, scenarios=reports)

    # Atomic write: write to .tmp then replace
    tmp_path = Path(str(path) + ".tmp")
    with open(tmp_path, "w", encoding="utf-8") as f:
        json.dump(
            dataclasses.asdict(test_run),
            f,
            indent=2,
            ensure_ascii=False,
        )
        f.write("\n")
    os.replace(str(tmp_path), str(path))
