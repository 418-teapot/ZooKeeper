/**
 * Process helpers for shutdown and leftover-process checks.
 *
 * A pi process that ignores stdin EOF would otherwise outlive its scenario,
 * so the suite both times out `close()` and verifies afterwards that no
 * descendant of the scenario process is still alive.  Discovery reads
 * `/proc/<pid>/task/<tid>/children`; on hosts without `/proc` the helper
 * reports `null` and the caller downgrades that check to an explicit
 * information record instead of pretending it passed.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Delay between liveness probes. */
const POLL_INTERVAL_MS = 25;

/**
 * Whether a pid is alive.
 *
 * @param pid - Process id (0 and negatives are never alive).
 * @returns Whether the process exists.
 */
export function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // EPERM means the process exists but belongs to another user.
    return code === "EPERM";
  }
}

/**
 * Live descendants of a process, read from `/proc`.
 *
 * @param pid - Root process id.
 * @returns Descendant pids, or `null` when `/proc` is unavailable.
 */
export function descendantPids(pid: number): number[] | null {
  if (!Number.isInteger(pid) || pid <= 0) return null;
  try {
    // Probe support once up front: an unavailable /proc throws here.
    readdirSync(join("/proc", String(pid), "task"));
  } catch {
    return null;
  }
  const found = new Set<number>();
  const queue = [pid];
  while (queue.length > 0) {
    const current = queue.shift() as number;
    let threads: string[];
    try {
      threads = readdirSync(join("/proc", String(current), "task"));
    } catch {
      continue;
    }
    for (const thread of threads) {
      let text: string;
      try {
        text = readFileSync(
          join("/proc", String(current), "task", thread, "children"),
          "utf8",
        );
      } catch {
        continue;
      }
      for (const field of text.split(/\s+/)) {
        if (!/^\d+$/.test(field)) continue;
        const child = Number(field);
        if (found.has(child)) continue;
        found.add(child);
        queue.push(child);
      }
    }
  }
  return [...found];
}

/**
 * Wait until a pid disappears.
 *
 * @param pid - Process id to watch.
 * @param timeoutMs - Maximum wait.
 * @returns Whether the process is gone (also `true` for an invalid pid).
 */
export async function waitForGone(
  pid: number,
  timeoutMs: number,
): Promise<boolean> {
  if (!isAlive(pid)) return true;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
    if (!isAlive(pid)) return true;
  }
  return !isAlive(pid);
}
