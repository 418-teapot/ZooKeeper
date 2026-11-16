/**
 * Default `zdebug` subprocess port for the auto-debug strategy.
 *
 * The port is the strategy's only door to the CLI: it runs one
 * invocation, captures both streams, and resolves with the process exit
 * status.  Nothing here interprets the exit status or the payload — the
 * strategy owns that policy — so the wrapper stays a mechanical
 * primitive that tests can replace with a fake.
 *
 * Runtime neutrality: `node:child_process` is provided by both hosts (bun
 * and node), so one implementation serves both.  The binary is located
 * through `PATH`; a missing binary surfaces as a spawn rejection, which
 * the strategy maps to a `verify-error` silence.  A stop cancels the
 * invocation: the child is killed, and `zdebug` forwards the signal to the
 * experiment's process group, so no grandchild outlives the settle.
 *
 * @module
 */

import { spawn } from "node:child_process";
import type {
  ZdebugExec,
  ZdebugExecResult,
} from "../../core/ports/autodebug.js";

/** The CLI binary resolved through `PATH` on every invocation. */
const ZDEBUG_BINARY = "zdebug";

/**
 * Spawn `zdebug`, capture its streams, and resolve with the exit code.
 *
 * Resolves once the child closes, carrying both streams and the exit
 * code (`-1` for a signal-terminated child).  Rejects when the child
 * cannot be spawned (binary absent) or when the settle is cancelled
 * before or during the run.  The run is unbounded apart from cancellation:
 * `zdebug` itself enforces each criterion's declared timeout.
 */
export const defaultZdebugExec: ZdebugExec = (args, cwd, signal) =>
  new Promise<ZdebugExecResult>((resolve, reject) => {
    // A cancelled settle starts no probe at all.
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const child = spawn(ZDEBUG_BINARY, [...args], {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      signal,
    });
    let stdout = "";
    let stderr = "";
    let settled = false;

    // The first terminal event (close / error) wins; later events are
    // ignored.
    const claim = (): boolean => {
      if (settled) return false;
      settled = true;
      return true;
    };

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", (err) => {
      if (!claim()) return;
      reject(err);
    });
    child.on("close", (code) => {
      if (!claim()) return;
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
