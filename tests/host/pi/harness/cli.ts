/**
 * Command line of the end-to-end suite.
 *
 * The suite runs every core scenario by default and accepts explicit ids so
 * one scenario can be rerun after a failure.  An unknown id is an error, not
 * a silent skip: a typo must never look like a passing run.  Output is quiet
 * unless the developer asks otherwise, so `--list` and `--help` report the
 * same flags they document.
 */

import { HarnessError } from "./errors.js";

/** Parsed command line. */
export interface CliOptions {
  /** Scenarios to run, in registry order. */
  scenarios: string[];
  /** Keep temporary artefacts even on success. */
  keep: boolean;
  /** Print the scenario list and exit. */
  list: boolean;
  /** Expand every scenario instead of only the failures. */
  verbose: boolean;
  /** Print the usage text and exit. */
  help: boolean;
}

/**
 * Usage text of the suite.
 *
 * @returns The help text, without a trailing newline.
 */
export function renderUsage(): string {
  return [
    "用法：bun tests/host/pi/run.ts [选项] [场景 id …]",
    "",
    "选项：",
    "  --scenario <id>  只运行指定场景，可重复",
    "  --list           列出场景 id、标题与风险",
    "  --keep           成功后也保留临时目录与产物",
    "  --verbose        展开每个场景的完整诊断（默认只列出失败检查）",
    "  --help, -h       显示本帮助",
  ].join("\n");
}

/**
 * Parse the suite arguments.
 *
 * @param argv - Arguments after the script name.
 * @param scenarioIds - Known scenario ids, in registry order.
 * @returns The parsed options.
 * @throws HarnessError on an unknown id, a missing value or an empty registry.
 */
export function parseArgs(
  argv: string[],
  scenarioIds: readonly string[],
): CliOptions {
  if (scenarioIds.length === 0) {
    throw new HarnessError("cli.no_scenarios", "没有可运行的核心场景");
  }
  const selected = new Set<string>();
  let keep = false;
  let list = false;
  let verbose = false;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index] as string;
    if (argument === "--keep") {
      keep = true;
      continue;
    }
    if (argument === "--verbose") {
      verbose = true;
      continue;
    }
    if (argument === "--list") {
      list = true;
      continue;
    }
    if (argument === "--help" || argument === "-h") {
      help = true;
      continue;
    }
    if (argument === "--scenario") {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new HarnessError(
          "cli.invalid_argument",
          "--scenario 缺少场景 id",
        );
      }
      selected.add(assertKnown(value, scenarioIds));
      index += 1;
      continue;
    }
    if (argument.startsWith("-")) {
      throw new HarnessError("cli.invalid_argument", `未知参数：${argument}`);
    }
    selected.add(assertKnown(argument, scenarioIds));
  }
  const scenarios =
    selected.size === 0
      ? [...scenarioIds]
      : scenarioIds.filter((id) => selected.has(id));
  return { scenarios, keep, list, verbose, help };
}

/**
 * Reject an id that is not a registered scenario.
 *
 * @param value - Candidate id.
 * @param scenarioIds - Known ids.
 * @returns The id, unchanged.
 */
function assertKnown(value: string, scenarioIds: readonly string[]): string {
  if (!scenarioIds.includes(value)) {
    throw new HarnessError(
      "cli.unknown_scenario",
      `未知场景：${value}`,
      `可用：${scenarioIds.join(", ")}`,
    );
  }
  return value;
}
