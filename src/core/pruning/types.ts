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
    output?: string;
    status?: string;
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
 * Set of tool names that are input-heavy (large input payloads with
 * small, precious outputs).  For these tools, pruning replaces input
 * fields rather than output.
 *
 * Built-in constant — code-level knowledge of OpenCode tool shapes.
 */
export const INPUT_HEAVY_TOOLS = new Set(["question", "edit", "write"]);

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

/**
 * XML-like tag name used to wrap a message ref in injected text.
 *
 * The full injected fragment looks like:
 * `<zoo-msg-id>m0001</zoo-msg-id>`.
 */
export const ZOO_MSG_ID_TAG = "zoo-msg-id";

/**
 * Regex matching a `<zoo-msg-id>mNNNN</zoo-msg-id>` tag, optionally
 * preceded by a newline.
 *
 * The preceding `\n` is consumed so that round-trip strip→inject
 * is deterministic (prefix-cache neutral).  Captures only the tag
 * itself — the leading newline is a convenience for clean removal.
 */
export const ZOO_MSG_ID_REGEX = /\n?<zoo-msg-id>m\d{4}<\/zoo-msg-id>/g;

/**
 * Regex matching an orphan (unpaired) `<zoo-msg-id>` or `</zoo-msg-id>`
 * tag, including any attributes (e.g. `<zoo-msg-id foo="bar">`).
 *
 * Applied *after* `ZOO_MSG_ID_REGEX` so that properly-paired tags are
 * removed first; this catches any leftovers such as forged unpaired tags.
 */
export const ZOO_MSG_ID_ORPHAN_REGEX = /<\/?zoo-msg-id[^>]*>/g;

/**
 * Maximum assignable message ref index.
 *
 * Refs are numbered `m0001` … `m9999`.  When `nextRef > MAX_INDEX`
 * assignment stops silently (no wraparound).
 */
export const MAX_INDEX = 9999;
