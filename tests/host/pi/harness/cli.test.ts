/**
 * Self-tests for the suite command line.
 *
 * Single-scenario reruns are part of the contract, so argument parsing must
 * select exactly what was asked for and must reject unknown ids instead of
 * silently skipping them.
 */

import { describe, expect, test } from "bun:test";
import { parseArgs, renderUsage } from "./cli.js";
import { HarnessError } from "./errors.js";

/** Scenario ids of the core suite, in registration order. */
const IDS = ["startup-todo", "session-isolation", "reload-idempotency"];

/** Capture the harness error thrown by a parse. */
function parseError(
  argv: string[],
  ids: readonly string[] = IDS,
): HarnessError | undefined {
  try {
    parseArgs(argv, ids);
    return undefined;
  } catch (error) {
    return error instanceof HarnessError ? error : undefined;
  }
}

describe("parseArgs", () => {
  test("defaults to every core scenario", () => {
    const parsed = parseArgs([], IDS);
    expect(parsed.scenarios).toEqual(IDS);
    expect(parsed.keep).toBe(false);
    expect(parsed.list).toBe(false);
    expect(parsed.verbose).toBe(false);
    expect(parsed.help).toBe(false);
  });

  test("selects one scenario and keeps registry order for several", () => {
    expect(
      parseArgs(["--scenario", "session-isolation"], IDS).scenarios,
    ).toEqual(["session-isolation"]);
    expect(
      parseArgs(["reload-idempotency", "startup-todo"], IDS).scenarios,
    ).toEqual(["startup-todo", "reload-idempotency"]);
  });

  test("parses --keep, --list, --verbose and --help", () => {
    expect(parseArgs(["--keep"], IDS).keep).toBe(true);
    expect(parseArgs(["--list"], IDS).list).toBe(true);
    expect(parseArgs(["--verbose"], IDS).verbose).toBe(true);
    expect(parseArgs(["--help"], IDS).help).toBe(true);
    expect(parseArgs(["-h"], IDS).help).toBe(true);
    expect(parseArgs(["--help"], IDS).list).toBe(false);
    expect(parseArgs(["-h"], IDS).list).toBe(false);
  });

  test("keeps flag order from mattering", () => {
    const parsed = parseArgs(["--verbose", "startup-todo", "--keep"], IDS);
    expect(parsed.scenarios).toEqual(["startup-todo"]);
    expect(parsed.keep).toBe(true);
    expect(parsed.verbose).toBe(true);
  });

  test("rejects an unknown scenario id", () => {
    expect(parseError(["--scenario", "nope"])?.code).toBe(
      "cli.unknown_scenario",
    );
  });

  test("rejects an option without a value", () => {
    expect(parseError(["--scenario"])?.code).toBe("cli.invalid_argument");
  });

  test("rejects an empty registry", () => {
    expect(parseError([], [])?.code).toBe("cli.no_scenarios");
  });
});

describe("renderUsage", () => {
  test("documents every flag, including --verbose", () => {
    const text = renderUsage();
    expect(text).toContain("bun tests/host/pi/run.ts");
    for (const flag of [
      "--scenario",
      "--list",
      "--keep",
      "--verbose",
      "--help",
    ]) {
      expect(text).toContain(flag);
    }
    expect(text).toContain("默认只列出失败检查");
  });
});
