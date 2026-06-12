/**
 * Environment-variable-guarded debug logger for ZooKeeper OpenCode plugin.
 *
 * Uses `process.env.ZOOKEEPER_DEBUG` as the gate — silent by default,
 * writes to stderr only when enabled. This avoids polluting the OpenCode
 * TUI stdout stream that Bun treats `console.debug` as.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Check whether the `ZOOKEEPER_DEBUG` environment variable is set to a
 * truthy value.
 *
 * Accepted truthy values: `"1"`, `"true"`, `"yes"`.
 *
 * @returns `true` if debug output should be emitted.
 */
function isDebugEnabled(): boolean {
  const val = process.env.ZOOKEEPER_DEBUG;
  if (!val) return false;
  return (
    val === "1" || val.toLowerCase() === "true" || val.toLowerCase() === "yes"
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Emit a debug log line to stderr when `ZOOKEEPER_DEBUG` is enabled.
 *
 * Format: `[zookeeper:<tag>] <JSON-stringified data>\n`
 *
 * If called without data, only the tag prefix is written (without trailing
 * space or data).  This function is a no-op when debug is disabled.
 *
 * @param tag - Short label identifying the calling hook (e.g. `"focus-reminder"`).
 * @param data - Optional structured data to include in the log line.
 */
export function debug(tag: string, data?: Record<string, unknown>): void {
  if (!isDebugEnabled()) return;

  const prefix = `[zookeeper:${tag}]`;
  if (data === undefined) {
    process.stderr.write(`${prefix}\n`);
  } else {
    process.stderr.write(`${prefix} ${JSON.stringify(data)}\n`);
  }
}
