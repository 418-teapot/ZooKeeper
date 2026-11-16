/**
 * Tests for the default `zdebug` subprocess port (`zdebug-exec.ts`).
 *
 * The port is the strategy's only door to the CLI, so a settle's
 * cancellation must reach it: a cancelled settle starts no probe, and a
 * stop that lands mid-run kills the probe together with the experiment it
 * runs.  These tests drive the real release binary through the production
 * spawn wrapper and observe the real processes — the experiment writes its
 * own pid, and its disappearance is the cleanup evidence.  The suite fails
 * loudly when the release binary is missing (see the auto-debug testkit)
 * and never skips.
 *
 * State is synchronized by watching for the experiment's pid file and for
 * the process to disappear; nothing here waits a fixed time for a state.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";
import {
  createCaseFixture,
  requireZdebugBinary,
  zdebugExec,
} from "../../testkits/auto-debug.js";
import { defaultZdebugExec } from "./zdebug-exec.js";

/** Directory of the release binary: the `PATH` entry the wrapper resolves. */
const BINARY_DIR = dirname(requireZdebugBinary());

let origPath: string | undefined;

beforeEach(() => {
  origPath = process.env.PATH;
  // The default wrapper resolves `zdebug` through `PATH`, so the run below
  // exercises the production spawn against the release build.
  process.env.PATH = `${BINARY_DIR}:${origPath ?? ""}`;
});

afterEach(() => {
  if (origPath === undefined) delete process.env.PATH;
  else process.env.PATH = origPath;
});

/** Poll `condition` until it holds, or fail after `timeoutMs`. */
async function waitFor(
  condition: () => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline)
      throw new Error(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

/** Whether `pid` still names a live process. */
function isRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** The pids of the processes whose command line carries `pattern`. */
function matchingPids(pattern: string): number[] {
  try {
    const out = execFileSync("pgrep", ["-f", pattern], { encoding: "utf8" });
    return out
      .split("\n")
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  } catch {
    // pgrep exits non-zero when nothing matches.
    return [];
  }
}

/** The experiment id the Case's verify pointer names. */
async function verifyExperiment(
  caseDir: string,
  workspace: string,
): Promise<string> {
  const status = await zdebugExec(
    ["case", "status", "--json", "--case-dir", caseDir],
    workspace,
    new AbortController().signal,
  );
  assert.equal(status.exitCode, 0, status.stderr);
  const parsed = JSON.parse(status.stdout) as {
    result: { verify: { experiment: string } };
  };
  return parsed.result.verify.experiment;
}

describe("defaultZdebugExec — cancellation", () => {
  it("starts no probe for an already cancelled settle", async () => {
    // A spawn would resolve with a non-zero report for the missing Case
    // instead of rejecting, so the rejection itself proves no probe ran.
    const controller = new AbortController();
    controller.abort();

    await assert.rejects(
      defaultZdebugExec(
        ["case", "status", "--json", "--case-dir", "/nonexistent"],
        "/",
        controller.signal,
      ),
      (err: Error) => err.name === "AbortError",
    );
  });

  it("kills the probe and the experiment when the settle is cancelled", async () => {
    const scratch = mkdtempSync(join(tmpdir(), "zoo-cancel-"));
    const pidFile = join(scratch, "experiment.pid");
    // The experiment writes its own pid, then becomes the long-running
    // process itself, so the pid names the process the stop must kill.
    const fixture = await createCaseFixture({
      verifyCommand: `echo $$ > "${pidFile}"; exec sleep 300`,
      timeoutMs: 300_000,
    });
    try {
      const experiment = await verifyExperiment(
        fixture.caseDir,
        fixture.workspace,
      );
      const controller = new AbortController();

      const running = defaultZdebugExec(
        [
          "experiment",
          "run",
          experiment,
          "--json",
          "--case-dir",
          fixture.caseDir,
        ],
        fixture.workspace,
        controller.signal,
      );
      await waitFor(
        () => existsSync(pidFile),
        30_000,
        "the experiment to start",
      );
      const experimentPid = Number.parseInt(readFileSync(pidFile, "utf8"), 10);
      assert.ok(Number.isInteger(experimentPid) && experimentPid > 0);
      assert.equal(isRunning(experimentPid), true, "the experiment runs");

      controller.abort();
      // The cancelled probe settles; whether it resolves with the killed
      // exit or rejects with the abort is the wrapper's business.
      await running.then(
        () => undefined,
        () => undefined,
      );

      await waitFor(
        () => !isRunning(experimentPid),
        10_000,
        "the experiment process to exit",
      );
      assert.deepEqual(
        matchingPids(fixture.caseDir),
        [],
        "no probe outlives the cancelled settle",
      );
    } finally {
      fixture.dispose();
      rmSync(scratch, { recursive: true, force: true });
    }
  });
});
