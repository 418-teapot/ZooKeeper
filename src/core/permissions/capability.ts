/**
 * Fail-closed capability set computation.
 *
 * Computes a capability set as the set difference of a baseline list
 * minus a list of denied tools (e.g. the config.toml tool-level denies).
 * The baseline is the gate: a missing, malformed, or non-string-bearing
 * baseline yields an empty set rather than guessing.  A malformed denied
 * list denies nothing — the baseline itself still gates.  The result is
 * sorted and deduplicated for deterministic output.
 *
 * @module
 */

/**
 * Compute the capability set as `baseline − deniedTools`.
 *
 * Both inputs are treated as string arrays.  The baseline must be a
 * string array for any capabilities to be returned; otherwise the result
 * is empty (fail-closed).  Non-string entries in the denied list are
 * ignored; a denied list that is not an array denies nothing.
 *
 * @param options - The capability inputs.
 * @param options.baseline - The full baseline capability list (e.g. the
 *   host's active tool set).
 * @param options.deniedTools - The tools to subtract from the baseline
 *   (e.g. from `[agent.<name>].permission` deny entries).
 * @returns The sorted, deduplicated capability set.
 */
export function computeCapabilitySet({
  baseline,
  deniedTools,
}: {
  baseline?: unknown;
  deniedTools?: unknown;
}): string[] {
  if (
    !Array.isArray(baseline) ||
    !baseline.every((entry) => typeof entry === "string")
  ) {
    return [];
  }
  const list = baseline as string[];

  const denied = new Set(
    Array.isArray(deniedTools)
      ? deniedTools.filter((entry) => typeof entry === "string")
      : [],
  );

  return [...new Set(list.filter((entry) => !denied.has(entry)))].sort();
}
