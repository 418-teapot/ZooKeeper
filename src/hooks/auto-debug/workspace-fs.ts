/**
 * Default read-only filesystem port for the auto-debug strategy.
 *
 * Implements the {@link AutoDebugFs} contract over `node:fs/promises`
 * (available on both hosts).  The benign absence — a missing directory —
 * is normalized to `[]` so the strategy can treat "no Case" as a normal
 * state rather than an error; every other failure propagates.
 *
 * @module
 */

import { readdir } from "node:fs/promises";
import type { AutoDebugDirEntry, AutoDebugFs } from "../../core/slots.js";

/** Whether an error is a "path does not exist" failure. */
function isMissing(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    (err as { code?: unknown }).code === "ENOENT"
  );
}

/** Default filesystem reader used when the host injects none. */
export const defaultAutoDebugFs: AutoDebugFs = {
  async listDir(path: string): Promise<AutoDebugDirEntry[]> {
    try {
      const entries = await readdir(path, { withFileTypes: true });
      return entries.map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
      }));
    } catch (err) {
      if (isMissing(err)) return [];
      throw err;
    }
  },
};
