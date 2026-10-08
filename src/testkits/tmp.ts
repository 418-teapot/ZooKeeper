/**
 * tmp testkit — unique temporary directory helper for tests.
 *
 * Tests that need a filesystem directory call makeTmpDir instead of
 * repeating the mkdtemp construction. Built on mkdtempSync so the
 * directory is created atomically and cannot collide, even across
 * concurrently spawned test processes. The caller owns cleanup.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Creates a unique temporary directory whose name starts with prefix,
 * and returns its absolute path.
 */
export function makeTmpDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `${prefix}-`));
}
