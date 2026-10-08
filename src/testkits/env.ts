/**
 * env-testkit — save/restore helpers for process env mutation in tests.
 *
 * Tests that mutate process.env must restore the previous value in
 * afterEach, or the mutation leaks into later test files. Use saveEnv
 * in beforeEach and restoreEnv in afterEach; set or delete the variable
 * between them as the test requires.
 */

/** Captures the current value of an env variable for later restoreEnv. */
export function saveEnv(key: string): string | undefined {
  return process.env[key];
}

/**
 * Restores an env variable captured by saveEnv: sets it back when the
 * saved value existed, deletes it otherwise.
 */
export function restoreEnv(key: string, saved: string | undefined): void {
  if (saved === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = saved;
  }
}
