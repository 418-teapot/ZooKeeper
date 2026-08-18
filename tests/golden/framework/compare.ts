/**
 * Golden snapshot comparator — deep structural diff over normalised
 * snapshots.
 *
 * Compares two JSON values (already run through `normalizeSnapshotValue`)
 * and returns a list of human-readable difference lines, one per
 * diverging leaf path.  An empty list means the snapshots are
 * semantically identical.
 *
 * @module
 */

import { normalizeSnapshotValue } from "./normalize.js";

/** Truncation length for values quoted inside a diff line. */
const QUOTE_LIMIT = 120;

/**
 * Quote a primitive value for a diff line.
 *
 * @param value - The primitive.
 * @returns A short quoted representation.
 */
function quote(value: unknown): string {
  const text =
    typeof value === "string"
      ? JSON.stringify(value)
      : (JSON.stringify(value) ?? String(value));
  if (text.length <= QUOTE_LIMIT) return text;
  return `${text.slice(0, QUOTE_LIMIT)}…`;
}

/**
 * Recursively diff two JSON values, appending difference lines.
 *
 * @param actual - The actual (normalised) snapshot.
 * @param expected - The expected (normalised) snapshot.
 * @param path - Current JSON path for diff lines.
 * @param out - Accumulated difference lines.
 */
function diffValues(
  actual: unknown,
  expected: unknown,
  path: string,
  out: string[],
): void {
  if (actual === expected) return;

  // Type mismatch — report and stop.
  if (typeof actual !== typeof expected) {
    out.push(`${path}: expected ${quote(expected)} but got ${quote(actual)}`);
    return;
  }

  if (actual === null || expected === null) {
    out.push(`${path}: expected ${quote(expected)} but got ${quote(actual)}`);
    return;
  }

  if (Array.isArray(actual) || Array.isArray(expected)) {
    if (!Array.isArray(actual) || !Array.isArray(expected)) {
      out.push(`${path}: expected ${quote(expected)} but got ${quote(actual)}`);
      return;
    }
    if (actual.length !== expected.length) {
      out.push(
        `${path}: expected ${expected.length} items but got ${actual.length}`,
      );
    }
    const max = Math.max(actual.length, expected.length);
    for (let i = 0; i < max; i++) {
      if (i >= actual.length || i >= expected.length) continue;
      diffValues(actual[i], expected[i], `${path}[${i}]`, out);
    }
    return;
  }

  if (typeof actual === "object") {
    const a = actual as Record<string, unknown>;
    const e = expected as Record<string, unknown>;
    const keys = new Set([...Object.keys(a), ...Object.keys(e)]);
    for (const key of keys) {
      if (!(key in a)) {
        out.push(`${path}.${key}: expected ${quote(e[key])} but got <missing>`);
        continue;
      }
      if (!(key in e)) {
        out.push(`${path}.${key}: expected <missing> but got ${quote(a[key])}`);
        continue;
      }
      diffValues(a[key], e[key], `${path}.${key}`, out);
    }
    return;
  }

  // Primitive mismatch (numbers / booleans).
  out.push(`${path}: expected ${quote(expected)} but got ${quote(actual)}`);
}

/**
 * Compare two raw snapshots after normalisation.
 *
 * @param actual - The freshly captured snapshot.
 * @param expected - The persisted snapshot.
 * @returns Difference lines; empty when identical.
 */
export function compareSnapshots(actual: unknown, expected: unknown): string[] {
  const out: string[] = [];
  diffValues(
    normalizeSnapshotValue(actual),
    normalizeSnapshotValue(expected),
    "$",
    out,
  );
  return out;
}
