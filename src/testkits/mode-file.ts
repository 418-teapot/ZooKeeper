/**
 * Shared test helpers that point `ZOO_MODE_FILE` at a temp mode state
 * file and restore the environment afterwards.
 *
 * The env var is never deleted here: every test file that consults the
 * mode state file already cleans it up in its own `afterEach`
 * (`delete process.env.ZOO_MODE_FILE`).  These helpers only manage the
 * temp directory they create.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * Write a temp mode state file, point `ZOO_MODE_FILE` at it, run `fn`,
 * then remove the temp directory.  The env var is restored by the
 * caller's `afterEach`, not here.
 *
 * @param contents - The raw file contents, e.g.
 *   `JSON.stringify({ mode: "poly" })` for a valid file or `"{ not json"`
 *   for a malformed one.
 * @param fn - The test body; may be sync or async.
 * @returns A promise that settles once `fn` and the cleanup finish.
 */
export async function withModeFile(
  contents: string,
  fn: () => void | Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "zoo-mode-test-"));
  const path = join(dir, "mode.json");
  writeFileSync(path, contents);
  process.env.ZOO_MODE_FILE = path;
  try {
    await fn();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Point `ZOO_MODE_FILE` at a path inside a temp directory that does not
 * exist (no file to read), run `fn`, then remove the temp directory.
 * The env var is restored by the caller's `afterEach`, not here.
 *
 * @param fn - The test body; may be sync or async.
 * @returns A promise that settles once `fn` and the cleanup finish.
 */
export async function withMissingModeFile(
  fn: () => void | Promise<void>,
): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "zoo-mode-missing-"));
  const path = join(dir, "mode.json");
  process.env.ZOO_MODE_FILE = path;
  try {
    await fn();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
