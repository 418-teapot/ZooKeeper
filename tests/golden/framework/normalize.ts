/**
 * Golden snapshot normalisation — pure functions applied to a captured
 * snapshot BEFORE comparison.
 *
 * Three classes of implementation detail are allowed to differ between
 * runs and implementations — they carry no user-observable semantics,
 * and pinning them would turn harmless internal evolution into red
 * builds.  Each is normalised here (or excluded at capture time):
 *
 * 1. **Ref numbering** — `m0001` / `m0007` (zero-padded registry
 *    refs) and `[m1]` (per-turn dense row numbers) all collapse to
 *    the stable placeholder `[mN]`.  Comparison only asserts "a ref
 *    marker exists here", never the concrete number.
 * 2. **Persistence schema** — never reaches the snapshot: state is
 *    projected to its semantic subset at capture time (`capture.ts`).
 * 3. **Boundary-detection traces** — compaction boundary ids etc. are
 *    excluded at capture time; this module only deals with text.
 *
 * All functions here are explicit pure functions so they can be unit
 * tested in isolation.
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
