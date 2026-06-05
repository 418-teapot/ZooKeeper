#!/usr/bin/env python3
"""CLI entry point for the ZooKeeper prompt testing framework.

Usage:
    python3 tests/runner.py
    python3 tests/runner.py --agent build
    python3 tests/runner.py --scenario build-basic --green
    python3 tests/runner.py --all --dry-run

Globs ``tests/scenarios/*.toml``, loads each scenario, runs ``opencode``
with the configured message and agent, analyses the session output, runs
assertions, compares metrics against thresholds, and produces a terminal
and JSON report.
"""

import argparse
import glob as globmod
import shutil
import subprocess
import sys
import tempfile
import traceback
from pathlib import Path

import tomli

# Ensure ``tests/`` is on the module search path so that sibling modules
# (session.py, assertions.py, report.py) can be imported without a package.
sys.path.insert(0, str(Path(__file__).parent))

import report  # noqa: E402

# session.py and assertions.py are optional; runner degrades gracefully when
# they are absent (--dry-run still works).
try:
    import session  # type: ignore[import-untyped]  # noqa: E402
except ImportError:
    session = None

try:
    import assertions  # type: ignore[import-untyped]  # noqa: E402
except ImportError:
    assertions = None


# ── Constants ───────────────────────────────────────────────────────────

RESULTS_DIR = Path(__file__).parent / "results"
REPORT_PATH = RESULTS_DIR / "report.json"
SCENARIOS_GLOB = str(Path(__file__).parent / "scenarios" / "*.toml")
THRESHOLDS_PATH = Path(__file__).parent / "thresholds.toml"


# ── CLI argument parsing ────────────────────────────────────────────────


def _build_parser() -> argparse.ArgumentParser:
    """Construct and return the CLI argument parser.

    Returns:
        A configured ArgumentParser instance.
    """
    parser = argparse.ArgumentParser(
        description="Run ZooKeeper prompt tests against opencode agents.",
    )
    parser.add_argument(
        "--all",
        action="store_true",
        default=False,
        help="Run all scenarios (default behaviour when no filter is given).",
    )
    parser.add_argument(
        "--agent",
        type=str,
        default=None,
        help='Filter scenarios by agent name (e.g. "build").',
    )
    parser.add_argument(
        "--scenario",
        type=str,
        default=None,
        dest="scenario_name",
        help="Filter by scenario file basename (without .toml extension).",
    )
    parser.add_argument(
        "--red",
        action="store_true",
        default=False,
        help="Only RED phase scenarios.",
    )
    parser.add_argument(
        "--green",
        action="store_true",
        default=False,
        help="Only GREEN + PRESSURE phase scenarios.",
    )
    parser.add_argument(
        "--pressure",
        action="store_true",
        default=False,
        help="Only PRESSURE phase scenarios.",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        default=False,
        help="Skip subprocess execution; only validate TOML loading.",
    )
    parser.add_argument(
        "--replay",
        action="store_true",
        default=False,
        help=(
            "Replay from saved JSONL files in tests/results/ instead of "
            "re-running opencode. Skips the subprocess entirely; runs "
            "assertions and thresholds on the existing session logs."
        ),
    )
    return parser


# ── TOML helpers ────────────────────────────────────────────────────────


def _load_thresholds(path: Path) -> dict:
    """Load the global threshold configuration.

    Expected format (TOML):

    .. code-block:: toml

        [build]
        accuracy_min = 0.7
        latency_max = 30.0

    Keys follow the pattern ``{metric}_{direction}`` where direction is
    ``min`` (value >= threshold) or ``max`` (value <= threshold).

    Args:
        path: Path to the thresholds TOML file.

    Returns:
        A dictionary mapping agent names to dicts of threshold entries.
        Returns an empty dict if the file does not exist.
    """
    if not path.exists():
        return {}
    with open(path, "rb") as f:
        return tomli.load(f)


def _parse_threshold_entry(
    key: str, value: dict | float
) -> tuple[str, str, float] | None:
    """Parse a single threshold entry from the TOML.

    Supports two formats:
      - Nested dict: ``delegation_rate = { min = 1.0 }``
      - Flat key (legacy): ``delegation_rate_min = 1.0``

    Args:
        key: The metric or compound key.
        value: A dict ``{min: float}`` / ``{max: float}``, or a bare float.

    Returns:
        A tuple ``(metric_name, direction, bound)`` or ``None`` if the
        entry cannot be parsed.
    """
    if isinstance(value, dict):
        for direction in ("min", "max"):
            if direction in value:
                return key, direction, float(value[direction])
        return None
    # Legacy flat format: "metric_min" or "metric_max"
    if isinstance(value, (int, float)):
        parts = key.rsplit("_", 1)
        if len(parts) != 2 or parts[1] not in ("min", "max"):
            return None
        return parts[0], parts[1], float(value)
    return None


def _check_thresholds(
    metrics: dict[str, float],
    agent: str,
    thresholds_cfg: dict,
    skip: set[str] | None = None,
) -> list[report.ThresholdResult]:
    """Compare metric values against configured thresholds.

    Only metrics that have a corresponding threshold entry are checked.
    Un-thresholded metrics are silently skipped.

    Args:
        metrics: Flat dict of metric name → float value.
        agent: The agent name used to look up its threshold section.
        thresholds_cfg: Full thresholds dictionary loaded from TOML.
        skip: Optional set of metric names to skip checking.

    Returns:
        A list of ThresholdResult objects (one per matched threshold).
    """
    results: list[report.ThresholdResult] = []
    agent_thresholds = thresholds_cfg.get(agent, {})
    if not agent_thresholds:
        return results

    for key, bound in agent_thresholds.items():
        parsed = _parse_threshold_entry(key, bound)
        if parsed is None:
            continue
        metric_name, direction, threshold_value = parsed
        if skip and metric_name in skip:
            continue
        actual = metrics.get(metric_name)
        if actual is None:
            results.append(
                report.ThresholdResult(
                    metric=key,
                    value=0.0,
                    threshold=threshold_value,
                    direction=direction,
                    passed=False,
                ),
            )
            continue

        if direction == "min":
            passed = actual >= threshold_value
        else:  # direction == "max"
            passed = actual <= threshold_value

        results.append(
            report.ThresholdResult(
                metric=metric_name,
                value=float(actual),
                threshold=threshold_value,
                direction=direction,
                passed=passed,
            ),
        )

    return results


# ── Scenario execution ──────────────────────────────────────────────────


def _build_cmd(scenario: dict) -> list[str]:
    """Build the ``opencode run`` command for a given scenario.

    Args:
        scenario: Parsed scenario dict (must include ``_tmpdir``, ``agent``,
            ``pure`` keys).

    Returns:
        A list of command-line arguments suitable for subprocess.
    """
    cmd = ["opencode", "run"]
    # Append the user message as positional argument.
    msg = scenario.get("user_message", "")
    if msg:
        cmd.append(msg)
    cmd.extend(["--agent", scenario["agent"]])
    cmd.extend(["--format", "json"])
    cmd.extend(["--dir", scenario["_tmpdir"]])

    # Only skip permissions for RED phase (which uses --pure anyway).
    # For GREEN and PRESSURE phases, we need the plugin's deny rules to work.
    if scenario.get("phase") == "red":
        cmd.append("--dangerously-skip-permissions")

    if scenario.get("pure", False):
        cmd.append("--pure")
    return cmd


def _load_scenario_toml(path: Path) -> dict:
    """Load a single scenario TOML file into a flat dict for processing.

    The sections of the file are mapped as:

        [scenario]   → scenario dict
        [user]       → user dict
        [fixture]    → fixture dict
        [expected]   → expected dict
        [assertions] → assertions dict

    Args:
        path: Path to the .toml scenario file.

    Returns:
        A flat dict with keys ``name``, ``agent``, ``phase``, ``timeout``,
        ``pure``, ``user_message``, ``fixture_project``, ``expected``,
        ``assertions``, and the raw ``_scenario_path``.

    Raises:
        tomli.TOMLError: If the file is not valid TOML.
        KeyError: If a required section or key is missing.
    """
    with open(path, "rb") as f:
        data = tomli.load(f)

    scenario = data.get("scenario", {})
    user = data.get("user", {})
    fixture = data.get("fixture", {})
    expected = data.get("expected", {})
    assertions_raw = data.get("assertions", {})

    result = {
        "name": scenario.get("name", path.stem),
        "agent": scenario["agent"],
        "phase": scenario.get("phase", "GREEN"),
        "timeout": scenario.get("timeout", 120),
        "pure": scenario.get("pure", False),
        "expect_fail": scenario.get("expect_fail", False),
        "skip_thresholds": scenario.get("skip_thresholds", []),
        "user_message": user.get("message", ""),
        "fixture_project": fixture.get("project", ""),
        "expected": expected,
        "assertions": assertions_raw,
        "_scenario_path": str(path),
    }
    return result


def _run_opencode(
    cmd: list[str],
    timeout: int,
    stdout_path: Path,
    dry_run: bool,
) -> str:
    """Execute the opencode command and capture its output.

    Args:
        cmd: Command list to execute.
        timeout: Maximum wall-clock time in seconds.
        stdout_path: Where to write the captured stdout (as JSONL).
        dry_run: If true, skip subprocess and write an empty file.

    Returns:
        The captured stdout string (empty string for dry-run).

    Raises:
        subprocess.TimeoutExpired: Re-raised if the process times out.
    """
    stdout_path.parent.mkdir(parents=True, exist_ok=True)

    if dry_run:
        stdout_path.write_text("", encoding="utf-8")
        return ""

    proc = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    stdout_path.write_text(proc.stdout, encoding="utf-8")
    return proc.stdout


def _analyse_session(
    stdout_path: Path,
    scenario: dict,
) -> tuple[dict[str, float], list, str | None]:
    """Analyse opencode session output: parse metrics and run assertions.

    Calls ``session.parse_session(stdout_path)`` →
    ``session.compute_metrics(data)``, then
    ``assertions.run_assertions(names, data, expected)``.

    Falls back to empty / default values when a module is not available.

    Args:
        stdout_path: Path to the saved JSONL session log.
        scenario: The loaded scenario dict (includes ``expected`` and
            ``assertions`` sub-dicts).

    Returns:
        A tuple ``(flat_metrics, assertion_results, error)``.
    """
    flat_metrics: dict[str, float] = {}
    assertion_results: list = []
    error: str | None = None

    # --- Session parsing ----------------------------------------------
    if session is None:
        return flat_metrics, assertion_results, "session.py not available"

    try:
        data = session.parse_session(stdout_path)  # type: ignore[attr-defined]
    except Exception as exc:
        return flat_metrics, assertion_results, f"Session parse failed: {exc}"

    # --- Metrics ------------------------------------------------------
    try:
        raw_metrics = session.compute_metrics(data)  # type: ignore[attr-defined]
        flat_metrics = {
            name: (float(mv.value) if not isinstance(mv.value, dict) else 0.0)
            for name, mv in raw_metrics.items()
        }
    except Exception as exc:
        error = f"Metric computation failed: {exc}"
        return flat_metrics, assertion_results, error

    # --- Assertions ---------------------------------------------------
    if assertions is not None:
        try:
            # The TOML assertions section can be either:
            #   1. required = ["assert_delegates", "assert_verifies"]
            #   2. output_clean = "No error messages"  (flat name→desc)
            assertions_raw = scenario.get("assertions", {})
            if isinstance(assertions_raw, dict) and "required" in assertions_raw:
                required_names = list(assertions_raw["required"])
            else:
                required_names = list(assertions_raw.keys())
            expected_params = scenario.get("expected", {})
            raw_results = assertions.run_assertions(  # type: ignore[attr-defined]
                required_names,
                data,
                expected_params,
            )
            assertion_results = list(raw_results)
        except Exception as exc:
            if error:
                error += f" | Assertions failed: {exc}"
            else:
                error = f"Assertions failed: {exc}"

    return flat_metrics, assertion_results, error


def _copy_fixture(fixture_project: str) -> str:
    """Copy a fixture project directory to a temporary location.

    Args:
        fixture_project: Subdirectory under ``tests/fixtures/`` to copy.

    Returns:
        The absolute path to the temporary copy.

    Raises:
        FileNotFoundError: If the fixture directory does not exist.
    """
    fixtures_dir = Path(__file__).parent / "fixtures"
    src = fixtures_dir / fixture_project
    if not src.is_dir():
        raise FileNotFoundError(
            f"Fixture directory not found: {src}",
        )

    tmpdir = tempfile.mkdtemp(prefix="zk-test-")
    dst = Path(tmpdir) / fixture_project
    shutil.copytree(str(src), str(dst), dirs_exist_ok=True)
    return str(dst)


# ── Main entry point ────────────────────────────────────────────────────


def main() -> None:
    """Orchestrate scenario discovery, execution, analysis, and reporting."""
    parser = _build_parser()
    args = parser.parse_args()

    # ── Phase filter resolution (case-insensitive) ───────────────────
    # If no phase flag is set, all phases are included.
    phase_set: set[str] | None = None
    if args.red:
        phase_set = {"red"}
    elif args.green:
        phase_set = {"green", "pressure"}
    elif args.pressure:
        phase_set = {"pressure"}

    # ── Discover scenarios ───────────────────────────────────────────
    scenario_paths = sorted(globmod.glob(SCENARIOS_GLOB))
    if not scenario_paths:
        print(f"No scenario files found at {SCENARIOS_GLOB}", file=sys.stderr)
        sys.exit(1)

    # ── Load thresholds ──────────────────────────────────────────────
    thresholds_cfg = _load_thresholds(THRESHOLDS_PATH)

    reports: list[report.ScenarioReport] = []

    # ── Quick summary of what we're about to run ──────────────────────
    matching_scenarios = []
    for sp in scenario_paths:
        sp_path = Path(sp)
        if args.scenario_name and sp_path.stem != args.scenario_name:
            continue
        try:
            scenario = _load_scenario_toml(sp_path)
        except Exception:
            continue
        if args.agent and scenario["agent"] != args.agent:
            continue
        if phase_set is not None and scenario["phase"].lower() not in phase_set:
            continue
        matching_scenarios.append(scenario["name"])

    print(
        f"🚀 Starting {len(matching_scenarios)} scenarios: {', '.join(matching_scenarios)}",
        flush=True,
    )

    for sp in scenario_paths:
        sp_path = Path(sp)

        # ── Quick basename filter (before TOML parse) ────────────────
        if args.scenario_name and sp_path.stem != args.scenario_name:
            continue

        # ── Load TOML ────────────────────────────────────────────────
        try:
            scenario = _load_scenario_toml(sp_path)
        except FileNotFoundError:
            err_msg = f"Scenario file not found: {sp}"
            print(err_msg, file=sys.stderr)
            reports.append(
                report.ScenarioReport(
                    name=sp_path.stem,
                    agent="?",
                    phase="?",
                    passed=False,
                    error=err_msg,
                ),
            )
            continue
        except tomli.TOMLError as exc:
            err_msg = f"TOML parse error in {sp}: {exc}"
            print(err_msg, file=sys.stderr)
            reports.append(
                report.ScenarioReport(
                    name=sp_path.stem,
                    agent="?",
                    phase="?",
                    passed=False,
                    error=err_msg,
                ),
            )
            continue
        except KeyError as exc:
            err_msg = f"Missing required key in {sp}: {exc}"
            print(err_msg, file=sys.stderr)
            reports.append(
                report.ScenarioReport(
                    name=sp_path.stem,
                    agent="?",
                    phase="?",
                    passed=False,
                    error=err_msg,
                ),
            )
            continue

        # ── Agent filter ─────────────────────────────────────────────
        if args.agent and scenario["agent"] != args.agent:
            continue

        # ── Phase filter (case-insensitive, after load) ────────────────
        if phase_set is not None and scenario["phase"].lower() not in phase_set:
            continue

        # ── Progress output ──────────────────────────────────────────
        print(
            f"\n▶ Running: {scenario['name']} ({scenario['agent']}/{scenario['phase']})",
            flush=True,
        )

        # ── Fixture ──────────────────────────────────────────────────
        try:
            scenario["_tmpdir"] = _copy_fixture(scenario["fixture_project"])
        except FileNotFoundError as exc:
            print(str(exc), file=sys.stderr)
            reports.append(
                report.ScenarioReport(
                    name=scenario["name"],
                    agent=scenario["agent"],
                    phase=scenario["phase"],
                    passed=False,
                    error=str(exc),
                ),
            )
            continue
        except Exception as exc:
            err_msg = f"Fixture copy failed: {exc}"
            print(err_msg, file=sys.stderr)
            reports.append(
                report.ScenarioReport(
                    name=scenario["name"],
                    agent=scenario["agent"],
                    phase=scenario["phase"],
                    passed=False,
                    error=err_msg,
                ),
            )
            continue

        # ── Build command ────────────────────────────────────────────
        cmd = _build_cmd(scenario)

        # ── Stdout path (JSONL) ──────────────────────────────────────
        stdout_path = RESULTS_DIR / f"{scenario['name']}.jsonl"

        # ── Run opencode ─────────────────────────────────────────────
        exec_error: str | None = None
        if args.replay:
            # Replay mode: skip subprocess, use existing JSONL
            if not stdout_path.exists():
                exec_error = (
                    f"Replay JSONL not found: {stdout_path}. "
                    "Run the scenario first without --replay."
                )
        else:
            try:
                _ = _run_opencode(
                    cmd,
                    scenario["timeout"],
                    stdout_path,
                    args.dry_run,
                )
            except subprocess.TimeoutExpired:
                exec_error = f"Timeout after {scenario['timeout']} seconds"
            except Exception as exc:
                exec_error = f"Subprocess error: {exc}"

        # ── Analyse session ──────────────────────────────────────────
        metrics: dict[str, float] = {}
        assertion_results: list = []
        analysis_error: str | None = exec_error

        if exec_error is None:
            try:
                metrics, assertion_results, analysis_error = _analyse_session(
                    stdout_path, scenario
                )
            except Exception as exc:
                analysis_error = f"Analysis error: {exc}"
                traceback.print_exc()

        # ── Check thresholds ─────────────────────────────────────────
        skip_thresholds = set(scenario.get("skip_thresholds", []))
        threshold_results = _check_thresholds(
            metrics,
            scenario["agent"],
            thresholds_cfg,
            skip=skip_thresholds,
        )

        # ── Overall pass/fail ────────────────────────────────────────
        # assertion_results may contain AssertionResult objects from
        # assertions.py; they all have ``.passed``, ``.name``, ``.message``.
        all_assertions_pass = not assertion_results or all(
            a.passed for a in assertion_results
        )
        all_thresholds_pass = all(t.passed for t in threshold_results)
        raw_pass = (
            analysis_error is None and all_assertions_pass and all_thresholds_pass
        )

        # RED / baseline scenarios use expect_fail=true: assertions and
        # thresholds are *expected* to fail, so ``passed`` is inverted.
        if scenario.get("expect_fail", False):
            overall_pass = not raw_pass
        else:
            overall_pass = raw_pass

        # ── Build report entry ───────────────────────────────────────
        reports.append(
            report.ScenarioReport(
                name=scenario["name"],
                agent=scenario["agent"],
                phase=scenario["phase"],
                passed=overall_pass,
                assertions=assertion_results,
                thresholds=threshold_results,
                metrics=metrics,
                error=analysis_error,
            ),
        )

        # ── Clean up temp dir ────────────────────────────────────────
        tmpdir = scenario.get("_tmpdir")
        if tmpdir:
            try:
                shutil.rmtree(tmpdir)
            except OSError:
                pass  # Best-effort cleanup.

    # ── Output results ───────────────────────────────────────────────
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    report.print_report(reports)
    report.write_report(reports, REPORT_PATH)

    # ── Exit code ────────────────────────────────────────────────────
    all_passed = all(r.passed for r in reports)
    sys.exit(0 if all_passed else 1)


if __name__ == "__main__":
    main()
