/**
 * Entry point of the ZooKeeper × pi end-to-end suite.
 *
 * Runs the core scenarios against real `pi --mode rpc` processes: every
 * scenario gets a fresh process and a fresh temporary root, every model
 * response comes from the in-process deterministic provider, and the exit
 * code is non-zero as soon as one check fails.  No pi version is preset: the
 * host under test is the `pi` resolved from PATH, and the scenario assertions
 * decide whether that host behaves as required.
 *
 * Usage:
 *   bun tests/host/pi/run.ts                  # all core scenarios
 *   bun tests/host/pi/run.ts --list           # ids, titles and risks
 *   bun tests/host/pi/run.ts --help           # every flag
 *   bun tests/host/pi/run.ts --scenario fork-inheritance
 *   bun tests/host/pi/run.ts --keep           # keep temp roots on success
 *   bun tests/host/pi/run.ts --verbose        # full per-scenario report
 *
 * A green run prints one line per scenario and the totals; a failing run
 * adds only the failed checks — each attributed to its scenario — and names
 * the summary file and the retained scenario roots.  `--verbose` restores
 * the full diagnostics.
 */

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  formatDuration,
  renderArtifactNotice,
  renderReport,
  type ScenarioReport,
  shouldRetainArtifacts,
  suiteExitCode,
  summarize,
} from "./harness/checks.js";
import { parseArgs, renderUsage } from "./harness/cli.js";
import { HarnessError } from "./harness/errors.js";
import { resolvePiBinary } from "./harness/host.js";
import { runScenario } from "./harness/scenario-runtime.js";
import { SCENARIOS } from "./scenarios/index.js";

/** Repository root, resolved from this file (no hardcoded path). */
const REPO_ROOT = fileURLToPath(new URL("../../..", import.meta.url));

/**
 * Entry point.
 */
async function main(): Promise<number> {
  const options = parseArgs(
    process.argv.slice(2),
    SCENARIOS.map((s) => s.id),
  );
  if (options.help) {
    console.log(renderUsage());
    return 0;
  }
  if (options.list) {
    for (const scenario of SCENARIOS) {
      console.log(`${scenario.id}\t${scenario.title}\t风险：${scenario.risk}`);
    }
    return 0;
  }

  // Host: the same `pi` the developer runs, resolved from PATH.  The child
  // inherits that PATH, so the resolved path and the spawned one agree; the
  // repository shim is skipped because it ships the package under test.
  // The path is only printed by the verbose report, not on a quiet run.
  const piBinary = resolvePiBinary({ repoRoot: REPO_ROOT });

  const baseDir = mkdtempSync(join(tmpdir(), "zookeeper-pi-e2e-suite-"));
  const selected = SCENARIOS.filter((scenario) =>
    options.scenarios.includes(scenario.id),
  );
  const reports: ScenarioReport[] = [];
  const startedAt = Date.now();
  let exitCode = 1;
  try {
    for (const [index, scenario] of selected.entries()) {
      // The verdict line doubles as the progress cue: the scenario line is
      // written before the run and completed in place, so a green suite keeps
      // exactly one line per scenario.
      process.stdout.write(
        `[${index + 1}/${selected.length}] ${scenario.id} — ${scenario.title}`,
      );
      const report = await runScenario(scenario, {
        repoRoot: REPO_ROOT,
        piBinary,
        baseDir,
        keep: options.keep,
      });
      reports.push(report);
      console.log(
        ` · ${report.status === "pass" ? "通过" : "失败"} (${formatDuration(report.durationMs)})`,
      );
    }
  } finally {
    const report = summarize({
      host: { piBinary },
      scenarios: reports,
      durationMs: Date.now() - startedAt,
    });
    console.log("");
    console.log(renderReport(report, { verbose: options.verbose }));
    const summaryPath = join(baseDir, "summary.json");
    writeFileSync(summaryPath, `${JSON.stringify(report, null, 2)}\n`);
    exitCode = suiteExitCode(report);
    const retain = shouldRetainArtifacts(report, options.keep);
    const notice = renderArtifactNotice({
      report,
      keep: options.keep,
      summaryPath,
      verbose: options.verbose,
    });
    if (notice !== "") console.log(`\n${notice}`);
    if (!retain) {
      rmSync(baseDir, { recursive: true, force: true });
    }
  }
  return exitCode;
}

try {
  const code = await main();
  process.exitCode = code;
} catch (error) {
  if (error instanceof HarnessError) {
    console.error(`E2E 前置检查失败：${error.message}`);
    if (error.detail !== undefined) console.error(`  ${error.detail}`);
  } else {
    console.error("E2E 套件异常：", error);
  }
  process.exitCode = 1;
}
