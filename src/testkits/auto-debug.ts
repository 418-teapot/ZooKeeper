/**
 * Shared end-to-end fixtures for the auto-debug loop tests.
 *
 * These fixtures drive the real `zdebug` release binary against a real
 * Case on disk: the strategy's judgment consumes the CLI's actual status
 * payload, verify pointer, and experiment exit code, while the host ports
 * remain injected.  Nothing here substitutes a fake for the binary — a
 * missing build is a hard failure carrying the `./build.sh` remedy, never
 * a silent skip (a test suite that quietly passes without the artifact
 * it claims to exercise is worse than no test).
 *
 * The binary is located at its fixed release path rather than through
 * `PATH`, so the suite runs identically regardless of how `zdebug` is
 * installed on the machine.
 *
 * @module
 */

import { execFile } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ZdebugExec, ZdebugExecResult } from "../core/slots.js";

/** Repository root derived from this module's own location. */
const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

/** Absolute path to the release `zdebug` binary produced by `./build.sh`. */
export const ZDEBUG_BINARY = join(
  REPO_ROOT,
  "tools",
  "target",
  "release",
  "zdebug",
);

/**
 * Resolve the built `zdebug` binary, failing loudly when it is absent.
 *
 * The message names the exact command that produces it so a missing
 * build is self-explanatory in CI output.
 *
 * @returns The absolute path to the release binary.
 */
export function requireZdebugBinary(): string {
  if (!existsSync(ZDEBUG_BINARY)) {
    throw new Error(
      `zdebug release binary not found at ${ZDEBUG_BINARY}; ` +
        "run ./build.sh before the auto-debug e2e tests",
    );
  }
  return ZDEBUG_BINARY;
}

/**
 * Run one `zdebug` invocation against the absolute release binary.
 *
 * Resolves with both streams and the exit code; rejects only when the
 * child cannot be spawned.  An optional `timeoutMs` bounds the run, used
 * by the fixture's own setup commands as a liveness net; the `ZdebugExec`
 * port below stays unbounded like the production port.
 */
function execZdebug(
  args: readonly string[],
  cwd: string,
  timeoutMs?: number,
): Promise<ZdebugExecResult> {
  return new Promise<ZdebugExecResult>((resolve, reject) => {
    execFile(
      requireZdebugBinary(),
      [...args],
      {
        cwd,
        maxBuffer: 64 * 1024 * 1024,
        ...(timeoutMs === undefined ? {} : { timeout: timeoutMs }),
      },
      (error, stdout, stderr) => {
        if (error && typeof error.code !== "number") {
          reject(error);
          return;
        }
        resolve({
          stdout: String(stdout),
          stderr: String(stderr),
          exitCode: typeof error?.code === "number" ? error.code : 0,
        });
      },
    );
  });
}

/**
 * Fixture `ZdebugExec` port.
 *
 * Mirrors the default subprocess port's contract (resolve with both
 * streams and the exit code; reject only when the child cannot be
 * spawned) so the strategy sees the same shape it sees in production,
 * including the unbounded run.
 */
export const zdebugExec: ZdebugExec = (args, cwd) => execZdebug(args, cwd);

/** A temporary workspace wrapping one on-disk Case. */
export interface CaseFixture {
  /** The workspace root the strategy scans (`<workspace>/.zoo/debug/`). */
  workspace: string;
  /** The created Case directory. */
  caseDir: string;
  /** The objective stored in the Case (the wake text's target line). */
  objective: string;
  /** Remove the workspace tree. */
  dispose(): void;
}

/** The `result` object of a successful `{"ok":true,...}` report. */
type Report = Record<string, unknown>;

/** Process-launch bound for one fixture `zdebug` invocation, in ms. */
const FIXTURE_EXEC_TIMEOUT_MS = 60_000;

/**
 * Default criterion time limit staged by {@link createCaseFixture}, in
 * ms.  Generous enough for the e2e verification commands it creates.
 */
const DEFAULT_VERIFY_TIMEOUT_MS = 60_000;

/**
 * Run a fixture-setup `zdebug` command and require a successful report.
 *
 * @param args - The CLI arguments.
 * @param cwd - The working directory.
 * @returns The report's `result` object.
 */
async function runZdebug(args: string[], cwd: string): Promise<Report> {
  const result = await execZdebug(args, cwd, FIXTURE_EXEC_TIMEOUT_MS);
  if (result.exitCode !== 0) {
    throw new Error(
      `zdebug ${args.join(" ")} failed (exit ${result.exitCode}): ` +
        result.stderr,
    );
  }
  const parsed = JSON.parse(result.stdout) as {
    ok?: unknown;
    result?: unknown;
  };
  if (parsed.ok !== true) {
    throw new Error(`zdebug ${args.join(" ")} reported no success`);
  }
  return parsed.result as Report;
}

/**
 * Create a temp workspace and a Case whose verification experiment runs
 * `verifyCommand`.
 *
 * The Case is created and its criterion materialized through the real
 * binary, exactly as the `/debug` command would: `case init` builds the
 * Case and `case update-verify` stages the command as an Experiment and
 * moves the verify pointer to it.
 *
 * @param options - The Case's objective, verify command, and criterion
 *   time limit.
 * @returns The fixture handle (dispose it to clean up).
 */
export async function createCaseFixture(options: {
  /** Shell command whose exit code is the convergence criterion. */
  verifyCommand: string;
  /** Investigation objective; defaults to a payment-test objective. */
  objective?: string;
  /** Case id; defaults to `CASE-1`. */
  caseId?: string;
  /** Human-readable Case title. */
  title?: string;
  /**
   * Criterion time limit in milliseconds, staged via `--timeout` in
   * seconds; defaults to {@link DEFAULT_VERIFY_TIMEOUT_MS}.
   */
  timeoutMs?: number;
}): Promise<CaseFixture> {
  const workspace = mkdtempSync(join(tmpdir(), "zoo-autodebug-"));
  const caseId = options.caseId ?? "CASE-1";
  const title = options.title ?? "E2E Case";
  const objective = options.objective ?? "支付并发测试间歇失败";
  const timeoutMs = options.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
  await runZdebug(
    [
      "case",
      "init",
      caseId,
      "--title",
      title,
      "--objective",
      objective,
      "--workspace",
      workspace,
      "--json",
    ],
    workspace,
  );
  const caseDir = join(workspace, ".zoo", "debug", caseId);
  await runZdebug(
    [
      "case",
      "update-verify",
      "--case-dir",
      caseDir,
      "--command",
      options.verifyCommand,
      "--timeout",
      String(timeoutMs / 1000),
      "--source",
      "user",
      "--json",
    ],
    workspace,
  );
  return {
    workspace,
    caseDir,
    objective,
    dispose() {
      rmSync(workspace, { recursive: true, force: true });
    },
  };
}
