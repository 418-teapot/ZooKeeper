/**
 * Shared structural guard for untrusted payloads.
 *
 * Every persisted value this plugin reads back (context blocks, todo
 * snapshots, tool details) arrives as `unknown` and must be narrowed before
 * it is indexed or spread.  The narrowing rule is one rule — a plain record
 * is a non-null, non-array object — so it is defined once here instead of
 * being re-derived in every parser.
 *
 * @module
 */

/**
 * Whether a value is a plain record (non-null object, not an array).
 *
 * @param value - The value to test (typically from parsed JSON).
 * @returns True when the value can be indexed or spread as a record.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
