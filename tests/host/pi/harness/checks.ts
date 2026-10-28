/**
 * Result model of the end-to-end suite.
 *
 * Checks are collected per scenario; the suite aggregates them into one
 * report that carries per-scenario and total timing, the host marker, the
 * evidence paths and the totals.  The exit code is derived from the report
 * only, so a failing check can never be swallowed by a friendly console
 * summary.
 */

/** Status of one check. */
export type CheckStatus = "pass" | "fail" | "info";

/** One observable assertion. */
export interface CheckResult {
  /** Scenario id the check belongs to. */
  scenario: string;
  /** Check id, `<scenario>/<aspect>`. */
  id: string;
  /** Short Chinese title. */
  title: string;
  /** Outcome. */
  status: CheckStatus;
  /** Observed values (the evidence itself). */
  detail: string;
  /** Artefact files supporting the outcome. */
  evidence: string[];
}

/** Check input with a boolean shorthand. */
export interface CheckInput {
  id: string;
  title: string;
  status: CheckStatus | boolean;
  detail: string;
  evidence?: string | string[];
}

/** Collects the checks of one scenario. */
export class CheckSink {
  /** Scenario id. */
  readonly scenario: string;
  /** Checks in recording order. */
  readonly checks: CheckResult[] = [];

  /**
   * @param scenario - Scenario id the sink belongs to.
   */
  constructor(scenario: string) {
    this.scenario = scenario;
  }

  /**
   * Record one check.
   *
   * @param input - Check definition.
   * @returns The recorded check.
   */
  add(input: CheckInput): CheckResult {
    const status: CheckStatus =
      input.status === true
        ? "pass"
        : input.status === false
          ? "fail"
          : input.status;
    const evidence =
      input.evidence === undefined
        ? []
        : Array.isArray(input.evidence)
          ? input.evidence
          : [input.evidence];
    const check: CheckResult = {
      scenario: this.scenario,
      id: input.id,
      title: input.title,
      status,
      detail: input.detail,
      evidence,
    };
    this.checks.push(check);
    return check;
  }

  /**
   * Record an information observation that never fails the suite.
   *
   * @param id - Check id.
   * @param title - Short title.
   * @param detail - Observed host behaviour.
   * @returns The recorded check.
   */
  info(id: string, title: string, detail: string): CheckResult {
    return this.add({ id, title, status: "info", detail });
  }

  /** Whether any recorded check failed. */
  get failed(): boolean {
    return this.checks.some((check) => check.status === "fail");
  }
}

/** Verdict of a scenario. */
export interface ScenarioReport {
  id: string;
  title: string;
  /** Risk the scenario covers, printed in the report. */
  risk: string;
  durationMs: number;
  status: "pass" | "fail";
  /** Scenario root; present when artefacts are retained. */
  artifactsDir: string | null;
  checks: CheckResult[];
  /** Harness-level error that aborted the scenario, if any. */
  error?: string;
}

/**
 * Host marker of the suite: which pi executable ran.
 *
 * Only the resolved path is recorded.  A pi version is deliberately absent —
 * the suite presets none, so printing one would imply a support matrix it
 * does not have, and the repository pi package is a library dependency whose
 * metadata says nothing about the host on PATH.
 */
export interface SuiteHost {
  /** Absolute path of the pi executable resolved from PATH. */
  piBinary: string;
}

/** Totals of one suite run. */
export interface SuiteTotals {
  pass: number;
  fail: number;
  info: number;
}

/** Aggregated suite result. */
export interface SuiteReport {
  host: SuiteHost;
  scenarios: ScenarioReport[];
  totals: SuiteTotals;
  durationMs: number;
}

/**
 * Aggregate scenario reports into the suite report.
 *
 * @param input - Scenario reports, host marker and total duration.
 * @returns The suite report.
 */
export function summarize(input: {
  host: SuiteHost;
  scenarios: ScenarioReport[];
  durationMs: number;
}): SuiteReport {
  const checks = input.scenarios.flatMap((scenario) => scenario.checks);
  return {
    host: input.host,
    scenarios: input.scenarios,
    totals: {
      pass: checks.filter((check) => check.status === "pass").length,
      fail: checks.filter((check) => check.status === "fail").length,
      info: checks.filter((check) => check.status === "info").length,
    },
    durationMs: input.durationMs,
  };
}

/**
 * Format a duration for the report.
 *
 * @param ms - Duration in milliseconds.
 * @returns `123ms` or `1.23s`.
 */
export function formatDuration(ms: number): string {
  return ms < 1_000 ? `${Math.round(ms)}ms` : `${(ms / 1_000).toFixed(2)}s`;
}

/**
 * Exit code of the suite.
 *
 * @param report - Suite report.
 * @returns `1` when a scenario failed or any check failed, else `0`.
 */
export function suiteExitCode(report: SuiteReport): number {
  const scenarioFailed = report.scenarios.some(
    (scenario) => scenario.status === "fail",
  );
  return scenarioFailed || report.totals.fail > 0 ? 1 : 0;
}

/**
 * Whether the artefacts of this run must survive.
 *
 * @param report - Suite report.
 * @param keep - Explicit `--keep` request.
 * @returns Whether to keep the temporary roots.
 */
export function shouldRetainArtifacts(
  report: SuiteReport,
  keep: boolean,
): boolean {
  return keep || suiteExitCode(report) !== 0;
}

/**
 * Console verbosity of a suite report.
 *
 * The default form is quiet: the runner has already streamed one verdict line
 * per scenario, so the report only adds the failed checks and the totals.
 * The verbose form prints the full per-scenario diagnostics.
 */
export interface ReportOptions {
  /** Print the full per-scenario report, including the host banner. */
  verbose: boolean;
}

/**
 * Console notice describing where this run's artifacts are.
 *
 * A successful default run deletes its temporary root and prints nothing, so
 * the console stays limited to the verdicts.  A retained root always names
 * the summary file; the quiet form also lists the kept scenario directories
 * because it prints no per-scenario artefacts, while the verbose report
 * already names them per scenario.
 *
 * @param options - Report, retention and summary path.
 * @param options.report - Suite report.
 * @param options.keep - Whether `--keep` was requested.
 * @param options.summaryPath - Path of the written `summary.json`.
 * @param options.verbose - Explicit `--verbose` request.
 * @returns The notice, without surrounding blank lines; `""` means none.
 */
export function renderArtifactNotice(options: {
  report: SuiteReport;
  keep: boolean;
  summaryPath: string;
  verbose: boolean;
}): string {
  if (!shouldRetainArtifacts(options.report, options.keep)) {
    return options.verbose
      ? "本次全部通过：临时目录已清理，报告见上方控制台输出。"
      : "";
  }
  const lines = [`产物与报告：${options.summaryPath}`];
  if (!options.verbose) {
    const roots = options.report.scenarios
      .map((scenario) => scenario.artifactsDir)
      .filter((root): root is string => root !== null);
    if (roots.length > 0) lines.push(`场景目录：${roots.join("、")}`);
  }
  return lines.join("\n");
}

/**
 * Render the human-readable report.
 *
 * @param report - Suite report.
 * @param options - Console verbosity.
 * @returns The console report.
 */
export function renderReport(
  report: SuiteReport,
  options: ReportOptions,
): string {
  return options.verbose
    ? renderVerboseReport(report)
    : renderQuietReport(report);
}

/**
 * Totals line of the report.
 *
 * @param report - Suite report.
 * @param withInfo - Whether the informational checks are counted too.
 * @returns The totals line.
 */
function renderTotals(report: SuiteReport, withInfo: boolean): string {
  const passed = report.scenarios.filter(
    (scenario) => scenario.status === "pass",
  ).length;
  const info = withInfo ? ` / ${report.totals.info} 信息` : "";
  return (
    `场景 ${passed} 通过 / ${report.scenarios.length - passed} 失败 · ` +
    `断言 ${report.totals.pass} 通过 / ${report.totals.fail} 失败${info}`
  );
}

/**
 * Quiet report: only the failed checks and the totals.
 *
 * Each scenario verdict, with its own duration, was already streamed by the
 * runner, so the title is never repeated here.  Every failed check names its
 * scenario id, and a harness error that no failed check carries is printed
 * once as a fallback line.
 *
 * @param report - Suite report.
 * @returns The console report.
 */
function renderQuietReport(report: SuiteReport): string {
  const lines: string[] = [];
  for (const scenario of report.scenarios) {
    if (scenario.status !== "fail") continue;
    const failed = scenario.checks.filter((check) => check.status === "fail");
    for (const check of failed) {
      lines.push(`✗ [${scenario.id}] ${check.id} ${check.title}`);
      if (check.detail !== "") lines.push(`   ${check.detail}`);
    }
    if (
      scenario.error !== undefined &&
      !failed.some((check) => check.detail === scenario.error)
    ) {
      lines.push(`✗ [${scenario.id}] 异常：${scenario.error}`);
    }
  }
  if (lines.length > 0) lines.push("");
  lines.push(renderTotals(report, false));
  lines.push(`总耗时：${formatDuration(report.durationMs)}`);
  return lines.join("\n");
}

/**
 * Verbose report: host, risk, every check, evidence, artefacts and totals.
 *
 * @param report - Suite report.
 * @returns The console report.
 */
function renderVerboseReport(report: SuiteReport): string {
  const lines: string[] = [`宿主 pi：${report.host.piBinary}`, ""];
  report.scenarios.forEach((scenario, index) => {
    const status = scenario.status === "pass" ? "通过" : "失败";
    lines.push(
      `[${index + 1}/${report.scenarios.length}] ${scenario.id} — ${scenario.title} · ${status} (${formatDuration(scenario.durationMs)})`,
    );
    lines.push(`     风险：${scenario.risk}`);
    if (scenario.error !== undefined) {
      lines.push(`     异常：${scenario.error}`);
    }
    for (const check of scenario.checks) {
      const marker =
        check.status === "pass" ? "✓" : check.status === "fail" ? "✗" : "i";
      lines.push(`     ${marker} ${check.id} ${check.title}`);
      lines.push(`       ${check.detail}`);
      if (check.evidence.length > 0) {
        lines.push(`       证据：${check.evidence.join("、")}`);
      }
    }
    if (scenario.artifactsDir !== null) {
      lines.push(`     产物：${scenario.artifactsDir}`);
    }
  });
  if (report.scenarios.length > 0) lines.push("");
  lines.push(renderTotals(report, true));
  lines.push(`总耗时：${formatDuration(report.durationMs)}`);
  return lines.join("\n");
}
