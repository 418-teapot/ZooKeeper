/**
 * Default `zdebug` subprocess adapter.
 *
 * @module
 */

import { spawn } from "node:child_process";
import type {
  ZdebugExec,
  ZdebugExecResult,
} from "../../core/ports/autodebug.js";

const ZDEBUG_BINARY = "zdebug";

/**
 * Spawn `zdebug`, capture its streams, and resolve with the exit code.
 *
 * Resolves once the child closes, carrying both streams and the exit code
 * (`-1` for a signal-terminated child).  Rejects when the child cannot be
 * spawned or when the settle is cancelled.
 */
export const defaultZdebugExec: ZdebugExec = (args, cwd, signal) =>
  new Promise<ZdebugExecResult>((resolve, reject) => {
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

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    // Reject after close so probe cleanup can finish.
    child.on("error", (err) => {
      if (signal.aborted) return;
      reject(err);
    });
    child.on("close", (code) => {
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      resolve({ stdout, stderr, exitCode: code ?? -1 });
    });
  });
