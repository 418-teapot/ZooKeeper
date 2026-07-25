/**
 * Types for the context-pruning module.
 *
 * Defines message entry and part shapes used by the mark-sweep
 * two-phase pruning mechanism.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Part & message shapes (OpenCode wire format)
// ---------------------------------------------------------------------------

/**
 * A tool part as it appears in a session message's parts array.
 *
 * Includes `callID` to correlate with tool invocations and `state.output`
 * that gets replaced during the sweep phase.
 */
export interface SweepToolPart {
  type: string;
  callID?: string;
  state?: {
    input?: unknown;
    output?: unknown;
  };
  tool?: string;
}

/**
 * A text part in a session message.
 */
export interface SweepTextPart {
  type: string;
  text?: string;
  ignored?: boolean;
}

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

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

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
