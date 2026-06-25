#!/usr/bin/env python3
"""CLI entry point for the ZooKeeper prompt testing framework.

Usage:
    python3 tests/runner.py                                 # run all
    python3 tests/runner.py --scenario dolphin-green          # single scenario
    python3 tests/runner.py --replay                        # replay from JSONL
    python3 tests/runner.py --replay --scenario dolphin-green # replay single

Globs ``tests/scenarios/*.toml``, loads each scenario, runs ``opencode``
with the configured message and agent, analyses the session output, runs
assertions, compares metrics against thresholds, and produces a terminal
and JSON report.
"""

import argparse
import glob
import json
import shutil
import subprocess
import sys
import tempfile

try:
    import tomllib
except ModuleNotFoundError:
    import tomli as tomllib  # Python < 3.11
import traceback
from pathlib import Path

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
        "--scenario",
        type=str,
        default=None,
        dest="scenario_name",
        help="Filter by scenario file basename (without .toml extension).",
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
    parser.add_argument(
        "--verbose",
        "-v",
        action="store_true",
        default=False,
        help="Print detailed debug info: subprocess stderr, metric details, tracebacks.",
    )
    return parser


# ── TOML helpers ────────────────────────────────────────────────────────


def _load_thresholds(path: Path) -> tuple[dict, bool]:
    """Load the global threshold configuration.

    Expected format (TOML):

    .. code-block:: toml

        [dolphin]
        accuracy_min = 0.7
        latency_max = 30.0

    Keys follow the pattern ``{metric}_{direction}`` where direction is
    ``min`` (value >= threshold) or ``max`` (value <= threshold).

    Args:
        path: Path to the thresholds TOML file.

    Returns:
        A tuple ``(thresholds_dict, file_exists)``. Returns an empty dict
        and ``False`` if the file does not exist.
    """
    if not path.exists():
        return {}, False
    with open(path, "rb") as f:
        return tomllib.load(f), True


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
                    metric=metric_name,
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
        tomllib.TOMLDecodeError: If the file is not valid TOML.
        KeyError: If a required section or key is missing.
    """
    with open(path, "rb") as f:
        data = tomllib.load(f)

    scenario = data.get("scenario", {})
    user = data.get("user", {})
    fixture = data.get("fixture", {})
    expected = data.get("expected", {})
    assertions_raw = data.get("assertions", {})
    dual_layer = data.get("dual_layer", {})

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
        "dual_layer": dual_layer,
        "_scenario_path": str(path),
    }
    return result


def _run_opencode(
    cmd: list[str],
    timeout: int,
    stdout_path: Path,
    dry_run: bool,
) -> tuple[str, str]:
    """Execute the opencode command and capture its output.

    Args:
        cmd: Command list to execute.
        timeout: Maximum wall-clock time in seconds.
        stdout_path: Where to write the captured stdout (as JSONL).
        dry_run: If true, skip subprocess and write an empty file.

    Returns:
        A tuple ``(stdout, stderr)`` (empty strings for dry-run).

    Raises:
        subprocess.TimeoutExpired: Re-raised if the process times out.
    """
    stdout_path.parent.mkdir(parents=True, exist_ok=True)

    if dry_run:
        # Only create the placeholder file if it doesn't already exist,
        # so a real run's JSONL data is not destroyed by a subsequent --dry-run.
        if not stdout_path.exists():
            stdout_path.write_text("", encoding="utf-8")
        return "", ""

    proc = subprocess.run(
        cmd,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    stdout_path.write_text(proc.stdout, encoding="utf-8")
    return proc.stdout, proc.stderr


def _analyse_session(
    stdout_path: Path,
    scenario: dict,
    verbose: bool = False,
) -> tuple[dict[str, float | dict[str, int]], dict, list, str | None]:
    """Analyse opencode session output: parse metrics and run assertions.

    Calls ``session.parse_session(stdout_path)`` →
    ``session.compute_metrics(data)``, then
    ``assertions.run_assertions(names, data, expected)``.

    Falls back to empty / default values when a module is not available.

    Args:
        stdout_path: Path to the saved JSONL session log.
        scenario: The loaded scenario dict (includes ``expected`` and
            ``assertions`` sub-dicts).
        verbose: If true, print full tracebacks on analysis errors.

    Returns:
        A tuple ``(flat_metrics, raw_metrics, assertion_results, error)``.
    """
    flat_metrics: dict[str, float | dict[str, int]] = {}
    raw_metrics: dict = {}
    assertion_results: list = []
    error: str | None = None

    # --- Session parsing ----------------------------------------------
    if session is None:
        return (
            flat_metrics,
            raw_metrics,
            assertion_results,
            "session.py 不可用",
        )

    try:
        data = session.parse_session(stdout_path)  # type: ignore[attr-defined]
    except Exception as exc:
        if verbose:
            traceback.print_exc()
        return (
            flat_metrics,
            raw_metrics,
            assertion_results,
            f"会话解析失败: {exc}",
        )

    # --- Metrics ------------------------------------------------------
    try:
        raw_metrics = session.compute_metrics(data)  # type: ignore[attr-defined]
        flat_metrics = {
            name: (
                float(mv.value) if not isinstance(mv.value, dict) else mv.value
            )
            for name, mv in raw_metrics.items()
        }
        if flat_metrics.get("is_empty_session", 0.0) == 1.0:
            error = "空会话: 未检测到工具调用 (JSONL 可能为空或无法解析)"
    except Exception as exc:
        if verbose:
            traceback.print_exc()
        error = f"指标计算失败: {exc}"
        return flat_metrics, raw_metrics, assertion_results, error

    # --- Assertions ---------------------------------------------------
    if assertions is not None:
        try:
            # The TOML assertions section can be either:
            #   1. required = ["assert_delegates", "assert_verifies"]
            #   2. output_clean = "No error messages"  (flat name->desc)
            assertions_raw = scenario.get("assertions", {})
            if (
                isinstance(assertions_raw, dict)
                and "required" in assertions_raw
            ):
                required_names = list(assertions_raw["required"])
            else:
                required_names = list(assertions_raw.keys())

            # Phase 1: Layer 2 (orchestrator-level) assertions on full session
            layer2_names = [
                n
                for n in required_names
                if not assertions.is_subagent_assertion(n)  # type: ignore[attr-defined]
            ]
            expected_params = scenario.get("expected", {})

            if layer2_names:
                try:
                    layer2_results = assertions.run_assertions(  # type: ignore[attr-defined]
                        layer2_names,
                        data,
                        expected_params,
                    )
                except Exception as exc:
                    if verbose:
                        traceback.print_exc()
                    layer2_results = [
                        report.AssertionResult(
                            name="layer2",
                            passed=False,
                            message=f"Layer 2 assertion failed: {exc}",
                        )
                    ]
            else:
                layer2_results = []

            # Phase 2: Dual-layer (subagent-level) assertions
            dual_results = _analyse_dual_layer(data, scenario, verbose)

            assertion_results = list(layer2_results) + list(dual_results)
        except Exception as exc:
            if verbose:
                traceback.print_exc()
            if error:
                error += f" | 断言执行失败: {exc}"
            else:
                error = f"断言执行失败: {exc}"

    return flat_metrics, raw_metrics, assertion_results, error


def _analyse_dual_layer(
    data: session.SessionData,  # type: ignore[arg-type]
    scenario: dict,
    verbose: bool = False,
) -> list:
    """Run Layer 1 (subagent) assertions on extracted subagent windows.

    Reads ``dual_layer`` config from the scenario dict, splits the session
    into per-subagent windows via ``session.split_subagent_sessions``, and
    runs the configured assertions on each window.

    Args:
        data: Parsed session data.
        scenario: The loaded scenario dict (may contain a ``dual_layer`` key).
        verbose: If true, print full tracebacks on errors.

    Returns:
        A list of ``AssertionResult`` objects.  Returns an empty list if
        no ``dual_layer`` config is present.
    """
    dual_layer_config = scenario.get("dual_layer", {})
    if not dual_layer_config:
        return []

    if assertions is None:
        return [
            report.AssertionResult(
                name="dual_layer",
                passed=False,
                message="assertions module unavailable",
            )
        ]

    # Split the session into subagent windows.
    try:
        subagent_sessions = session.split_subagent_sessions(data)  # type: ignore[attr-defined]
    except Exception as exc:
        if verbose:
            traceback.print_exc()
        return [
            report.AssertionResult(
                name="dual_layer",
                passed=False,
                message=f"split_subagent_sessions failed: {exc}",
            )
        ]

    results: list = []
    found_subagent_types = {s.subagent_type for s in subagent_sessions}
    expected_params = scenario.get("expected", {})

    # --- Run assertions for found subagent windows ----------------------
    for subagent_window in subagent_sessions:
        subagent_type = subagent_window.subagent_type
        config = dual_layer_config.get(subagent_type)
        if config is None:
            continue

        assertion_names = config.get("assertions", [])
        if assertion_names:
            try:
                sub_results = assertions.run_assertions(  # type: ignore[attr-defined]
                    assertion_names,
                    subagent_window.to_session_data(),
                    expected_params,
                )
                for r in sub_results:
                    r.name = f"{r.name} [{subagent_window.name}]"
                results.extend(sub_results)
            except Exception as exc:
                if verbose:
                    traceback.print_exc()
                results.append(
                    report.AssertionResult(
                        name=f"dual_layer [{subagent_window.name}]",
                        passed=False,
                        message=f"Assertion error: {exc}",
                    )
                )

        # NOTE: assertions_optional was a forward-looking feature for
        # scenarios where some assertions are informational-only. No
        # scenario ever used it, so the code path was removed. The
        # dual_layer TOML schema still documents the key for reference.

    # --- Fail required assertions for expected but missing windows ------
    expected_types = set(dual_layer_config.keys())
    missing_types = expected_types - found_subagent_types
    for agent_type in sorted(missing_types):
        config = dual_layer_config[agent_type]
        for name in config.get("assertions", []):
            results.append(
                report.AssertionResult(
                    name=f"{name} [{agent_type}#?]",
                    passed=False,
                    message=f"Subagent window '{agent_type}' not found in session",
                )
            )

    return results


def _prepare_fixture(fixture_project: str, parent_dir: Path) -> Path:
    """Copy a fixture project directory into a parent temporary directory.

    Args:
        fixture_project: Subdirectory under ``tests/fixtures/`` to copy.
        parent_dir: Existing parent directory to copy into.

    Returns:
        The absolute path to the copied fixture.

    Raises:
        FileNotFoundError: If the fixture directory does not exist.
    """
    fixtures_dir = Path(__file__).parent / "fixtures"
    src = fixtures_dir / fixture_project
    if not src.is_dir():
        raise FileNotFoundError(
            f"夹具目录未找到: {src}",
        )

    dst = parent_dir / fixture_project
    shutil.copytree(str(src), str(dst), dirs_exist_ok=True)
    return dst


# ── Replay validation ──────────────────────────────────────────────────


def _validate_replay_jsonl(
    path: Path, expected_agent: str
) -> tuple[bool, str | None]:
    """Validate a JSONL file for ``--replay`` mode.

    Checks that the file exists, is non-empty, and contains at least one
    parseable JSON line.  Attempts to extract the agent name from events
    (best-effort; OpenCode format may not expose it).

    Args:
        path: Path to the JSONL file.
        expected_agent: Agent name expected for this scenario.

    Returns:
        A tuple ``(ok, warning)``.  ``ok`` is ``False`` if the file is
        unusable (missing, empty, no parseable events).  ``warning`` is
        ``None`` or a human-readable warning string.
    """
    if not path.exists():
        return False, f"回放 JSONL 未找到: {path}"

    if path.stat().st_size == 0:
        return False, f"回放 JSONL 为空: {path}"

    valid_lines = 0
    parse_warnings: list[str] = []

    with path.open(encoding="utf-8") as fh:
        for line_no, line in enumerate(fh, 1):
            stripped = line.strip()
            if not stripped:
                continue
            try:
                obj = json.loads(stripped)
                if not isinstance(obj, dict):
                    continue
                valid_lines += 1
            except json.JSONDecodeError:
                parse_warnings.append(f"第 {line_no} 行: JSON 解析失败")

    if valid_lines == 0:
        return False, (
            f"回放 JSONL 没有可解析的事件: {path} "
            f"(共 {line_no} 行)，请先不使用 --replay 运行场景"
        )

    if parse_warnings:
        return True, "; ".join(parse_warnings)

    return True, None


# ── Main entry point ────────────────────────────────────────────────────


def main() -> None:
    """Orchestrate scenario discovery, execution, analysis, and reporting."""
    parser = _build_parser()
    args = parser.parse_args()

    # ── Capture run metadata at startup ───────────────────────────────
    git_commit: str = "unknown"
    try:
        git_commit = subprocess.run(
            ["git", "rev-parse", "HEAD"],
            capture_output=True,
            text=True,
            timeout=10,
        ).stdout.strip()
    except Exception:
        pass

    opencode_version: str = "unknown"
    try:
        opencode_version = subprocess.run(
            ["opencode", "--version"],
            capture_output=True,
            text=True,
            timeout=10,
        ).stdout.strip()
    except Exception:
        pass

    # ── Discover scenarios ───────────────────────────────────────────
    scenario_paths = sorted(glob.glob(SCENARIOS_GLOB))
    if not scenario_paths:
        print(f"未找到场景文件: {SCENARIOS_GLOB}", file=sys.stderr)
        sys.exit(1)

    # ── Load thresholds ──────────────────────────────────────────────
    thresholds_cfg, thresholds_found = _load_thresholds(THRESHOLDS_PATH)
    if not thresholds_found:
        print(
            f"⚠ 警告: 阈值文件未找到: {THRESHOLDS_PATH}，将跳过所有阈值检查",
            file=sys.stderr,
        )

    reports: list[report.ScenarioReport] = []
    seen_scenario_names: set[str] = set()

    # ── Pre-load all scenario TOMLs once ──────────────────────────────
    all_scenarios: list[tuple[Path, dict | None]] = []
    for sp in scenario_paths:
        sp_path = Path(sp)
        if args.scenario_name and sp_path.stem != args.scenario_name:
            all_scenarios.append((sp_path, None))
            continue
        try:
            scenario = _load_scenario_toml(sp_path)
            all_scenarios.append((sp_path, scenario))
        except FileNotFoundError:
            err_msg = f"场景文件未找到: {sp}"
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
            all_scenarios.append((sp_path, None))
        except tomllib.TOMLDecodeError as exc:
            err_msg = f"TOML 解析错误 ({sp}): {exc}"
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
            all_scenarios.append((sp_path, None))
        except KeyError as exc:
            err_msg = f"场景缺少必需字段 ({sp}): {exc}"
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
            all_scenarios.append((sp_path, None))

    # ── Count and print preview ───────────────────────────────────────
    filtered_count = sum(1 for _, sc in all_scenarios if sc is not None)
    print(f"🚀 开始执行 {filtered_count} 个场景", flush=True)

    # ── Execute in a single pass over pre-loaded scenarios ───────────
    for sp_path, scenario in all_scenarios:
        if scenario is None:
            continue  # Already handled as error above

        # ── Scenario name collision check ─────────────────────────────
        if scenario["name"] in seen_scenario_names:
            print(
                f"⚠ 警告: 重复的场景名称 '{scenario['name']}' 位于 {sp_path}",
                file=sys.stderr,
            )
        seen_scenario_names.add(scenario["name"])

        # ── Progress output ──────────────────────────────────────────
        print(
            f"\n▶ 运行: {scenario['name']} ({scenario['agent']}/{scenario['phase']})",
            flush=True,
        )

        # ── Replay validation (before tempdir) ───────────────────────
        if args.replay:
            stdout_path_check = RESULTS_DIR / f"{scenario['name']}.jsonl"
            replay_ok, replay_warning = _validate_replay_jsonl(
                stdout_path_check, scenario["agent"]
            )
            if not replay_ok:
                print(replay_warning, file=sys.stderr)
                reports.append(
                    report.ScenarioReport(
                        name=scenario["name"],
                        agent=scenario["agent"],
                        phase=scenario["phase"],
                        passed=False,
                        error=replay_warning,
                    ),
                )
                continue
            if replay_warning:
                print(f"  ⚠ {replay_warning}", file=sys.stderr)

        # ── Execute scenario with TemporaryDirectory ─────────────────
        with tempfile.TemporaryDirectory(prefix="zk-test-") as tmpdir_ctx:
            tmpdir_path = Path(tmpdir_ctx)

            # ── Fixture ──────────────────────────────────────────────
            try:
                scenario["_tmpdir"] = str(
                    _prepare_fixture(scenario["fixture_project"], tmpdir_path)
                )
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
                _incremental_write(
                    reports, REPORT_PATH, git_commit, opencode_version
                )
                continue
            except Exception as exc:
                err_msg = f"夹具拷贝失败: {exc}"
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
                _incremental_write(
                    reports, REPORT_PATH, git_commit, opencode_version
                )
                continue

            # ── Build command ────────────────────────────────────────
            cmd = _build_cmd(scenario)

            # ── Stdout path (JSONL) ──────────────────────────────────
            stdout_path = RESULTS_DIR / f"{scenario['name']}.jsonl"

            # ── Run opencode ─────────────────────────────────────────
            exec_error: str | None = None
            stderr = ""
            if args.replay:
                # Replay mode: skip subprocess, use existing JSONL
                if not stdout_path.exists():
                    exec_error = (
                        f"回放 JSONL 未找到: {stdout_path}。"
                        "请先不使用 --replay 运行场景。"
                    )
            else:
                try:
                    _, stderr = _run_opencode(
                        cmd,
                        scenario["timeout"],
                        stdout_path,
                        args.dry_run,
                    )
                except subprocess.TimeoutExpired:
                    exec_error = f"超时 (超过 {scenario['timeout']} 秒)"
                except Exception as exc:
                    exec_error = f"子进程错误: {exc}"

            # Verbose: print subprocess stderr
            if args.verbose and stderr:
                print(f"  [标准错误] {stderr[:2000]}")

            # ── Analyse session ──────────────────────────────────────
            metrics: dict[str, float] = {}
            raw_metrics: dict = {}
            assertion_results: list = []
            analysis_error: str | None = exec_error

            if exec_error is None:
                try:
                    metrics, raw_metrics, assertion_results, analysis_error = (
                        _analyse_session(
                            stdout_path, scenario, verbose=args.verbose
                        )
                    )
                except Exception as exc:
                    analysis_error = f"分析错误: {exc}"
                    if args.verbose:
                        traceback.print_exc()

            # Verbose: print metric details
            if args.verbose and raw_metrics:
                for name, mv in raw_metrics.items():
                    print(f"  [指标] {name}: {mv.detail}")

            # ── Check thresholds ─────────────────────────────────────
            skip_thresholds = set(scenario.get("skip_thresholds", []))
            threshold_results = _check_thresholds(
                metrics,
                scenario["agent"],
                thresholds_cfg,
                skip=skip_thresholds,
            )

            # ── Count deferred assertions ────────────────────────────
            deferred_count = sum(1 for a in assertion_results if a.deferred)
            total_assertion_count = len(assertion_results)

            # ── Overall pass/fail ────────────────────────────────────
            # assertion_results may contain AssertionResult objects from
            # assertions.py; they all have ``.passed``, ``.name``,
            # ``.message``.  Deferred assertions are informational and
            # excluded from pass/fail.
            all_assertions_pass = not assertion_results or all(
                a.passed for a in assertion_results if not a.deferred
            )
            all_thresholds_pass = all(t.passed for t in threshold_results)
            raw_pass = (
                analysis_error is None
                and all_assertions_pass
                and all_thresholds_pass
            )

            # RED / baseline scenarios use expect_fail=true: assertions
            # and thresholds are *expected* to fail, so ``passed`` is
            # inverted only for assertion/threshold failures, not
            # infrastructure errors.
            infra_broken = analysis_error is not None and not (
                analysis_error.startswith("断言执行失败")
            )
            if scenario.get("expect_fail", False):
                if infra_broken:
                    overall_pass = False
                else:
                    overall_pass = not raw_pass
            else:
                overall_pass = raw_pass

            # ── Build report entry ───────────────────────────────────
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
                    deferred_count=deferred_count,
                    total_assertion_count=total_assertion_count,
                ),
            )

        # ── Incremental write (crash protection) ─────────────────────
        # TemporaryDirectory is cleaned up here; we write snapshots so
        # partial results survive a crash at scenario N.
        _incremental_write(reports, REPORT_PATH, git_commit, opencode_version)

    # ── Output final results ─────────────────────────────────────────
    RESULTS_DIR.mkdir(parents=True, exist_ok=True)
    report.print_report(reports)
    report.write_report(
        reports,
        REPORT_PATH,
        git_commit=git_commit,
        opencode_version=opencode_version,
        runner_file=__file__,
    )

    # ── Exit code ────────────────────────────────────────────────────
    all_passed = all(r.passed for r in reports)
    sys.exit(0 if all_passed else 1)


def _incremental_write(
    reports: list,
    path: Path,
    git_commit: str,
    opencode_version: str,
) -> None:
    """Write an intermediate report snapshot for crash protection.

    Args:
        reports: Scenario reports accumulated so far.
        path: Destination report path.
        git_commit: Git commit hash from startup.
        opencode_version: OpenCode version from startup.
    """
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        report.write_report(
            reports,
            path,
            git_commit=git_commit,
            opencode_version=opencode_version,
            runner_file=__file__,
        )
    except Exception as exc:
        # Swallow incremental write errors — they must not crash the run.
        print(
            f"  ⚠ 增量写入失败: {exc}",
            file=sys.stderr,
        )


if __name__ == "__main__":
    main()
