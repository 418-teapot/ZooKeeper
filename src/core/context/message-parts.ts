/**
 * Message part introspection and pruning placeholder contract.
 *
 * Lowest-level module shared by the context metrics writer (metrics.ts)
 * and the pruning reader (pruning/*): defines `getCallId` for extracting
 * a tool part's call identifier and the verbatim `PRUNED_*_REPLACEMENT`
 * placeholder strings that pruning writes and metrics counts.  This module
 * has zero imports, so both directions of the shared contract are safe
 * from import cycles.  Kept in the `context/` domain with the writer and
 * reader it serves.
 *
 * @module
 */

/**
 * Extract the callID from a part, checking multiple possible field names.
 *
 * OpenCode SDK may expose the call identifier as `callID` or `callId`.
 *
 * @param part - A message part.
 * @returns The call identifier string, or undefined.
 */
export function getCallId(part: unknown): string | undefined {
  const p = part as Record<string, unknown>;
  return (p.callID as string) ?? (p.callId as string) ?? undefined;
}

/**
 * Placeholder text used in place of a pruned tool input field for
 * input-heavy tools.
 *
 * Must be used verbatim — never paraphrase.
 */
export const PRUNED_TOOL_INPUT_REPLACEMENT =
  "[Input removed to save context - information superseded or no longer needed]";

/**
 * Placeholder text used in place of a pruned tool output.
 *
 * Must be used verbatim — never paraphrase.
 */
export const PRUNED_TOOL_OUTPUT_REPLACEMENT =
  "[Output removed to save context - information superseded or no longer needed]";

/**
 * Placeholder text used in place of a failed tool call's input.
 *
 * Must be used verbatim — never paraphrase.
 */
export const PRUNED_TOOL_ERROR_INPUT_REPLACEMENT =
  "[Input removed due to failed tool call - information no longer relevant]";
