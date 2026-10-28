/**
 * Snapshot normalisation — pure functions applied to a captured snapshot
 * BEFORE comparison.
 *
 * Two classes of detail are allowed to differ between runs — they carry
 * no user-observable semantics, so pinning them would turn harmless
 * internal evolution into red builds:
 *
 * - Ref numbering: `m0001` (zero-padded registry refs) and `[m1]`
 *   (per-turn dense row numbers) both collapse to `[mN]`, so comparison
 *   asserts that a ref marker exists, never which number it carries.
 * - Internal state: never captured at all — a snapshot holds the
 *   externally observable projection only (`view`, `toolResult`,
 *   `toolError`, `notifications`), so block records, mark bookkeeping
 *   and watermarks cannot leak into a baseline.
 *
 * Every function here is pure so it can be unit tested in isolation.
 *
 * @module
 */

/** Ref markers: zero-padded `mNNNN` (registry refs) or `[mN]` (row numbers). */
const REF_TOKEN_RE = /m\d{4}|\[m\d+\]/g;

/**
 * Replace every message-ref marker in a string with the stable
 * placeholder `[mN]`.
 *
 * Handles both the bare `mNNNN` form (window text, log payloads) and
 * the `[mN]` row-number form.
 *
 * @param text - Raw text possibly containing ref markers.
 * @returns Text with every ref marker collapsed to `[mN]`.
 */
export function normalizeRefs(text: string): string {
  return text.replace(REF_TOKEN_RE, "[mN]");
}

/**
 * Recursively apply `normalizeRefs` to every string leaf of an unknown
 * JSON value (arrays and plain objects are traversed).
 *
 * @param value - The raw snapshot value.
 * @returns The normalised snapshot value.
 */
export function normalizeSnapshotValue(value: unknown): unknown {
  if (typeof value === "string") return normalizeRefs(value);
  if (Array.isArray(value)) return value.map(normalizeSnapshotValue);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      out[key] = normalizeSnapshotValue(child);
    }
    return out;
  }
  return value;
}
