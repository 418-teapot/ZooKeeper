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
 * End-anchored regex matching a trailing message ref `mNNNN` followed
 * by an optional tag-name fragment (tolerates misspelled tag names,
 * missing `<`, missing `/`, missing `>`, wrong case).
 *
 * An optional `<` before the ref (like `<m0001`) is consumed so that
 * the preceding `\n` is also consumed via `\n?` when both are present.
 *
 * Applied repeatedly (loop-until-stable) so that stacked trailing
 * fragments are stripped one per pass.  The preceding `\n` is consumed
 * so that round-trip strip→inject is deterministic (prefix-cache neutral).
 *
 * Deliberately NOT matched: bare/standalone refs, inline mentions,
 * refs separated from tag fragments by spaces without angle brackets,
 * and any tag/ref in the middle of text.
 */
export const ZOO_MSG_ID_REGEX =
  /\n?(?:<)?m\d{4}(?:(?:<\/?\s*)?\/?)?zoo[-\w]*\s*>?\s*$/gi;

/**
 * End-anchored regex matching a trailing orphan (unpaired) zoo-* tag
 * fragment, optionally followed by a ref `mNNNN` separated by whitespace.
 *
 * Applied *after* `ZOO_MSG_ID_REGEX` (in each loop pass) so that
 * properly-paired tags are removed first; this catches any leftovers
 * such as forged unpaired tags or open/close tag fragments.
 *
 * Tolerates misspelled tag names, missing `<`, missing `/`, missing `>`,
 * and wrong case via the `i` flag.
 *
 * The `\n?` prefix consumes the trailing newline left after Rule 1
 * removes a ref+closing-tag from a well-formed `<tag>ref</tag>`.
 */
export const ZOO_MSG_ID_ORPHAN_REGEX =
  /\n?<\/?\s*zoo[-\w]*[^>\n]*>?(?:\s*m\d{4})?\s*$/gi;

/**
 * Regex matching exactly the canonical (well-formed) trailing tag,
 * case-insensitive.
 *
 * Used by fuzzy-variant detection at call sites: a stripped trailing
 * fragment that matches this is the normal injected form and must NOT
 * trigger a fuzzy-variant warning.  The `i` flag mirrors the strip
 * regexes so uppercase canonical echoes are not falsely flagged.
 */
export const ZOO_MSG_ID_CANONICAL_END_REGEX = /\n?m\d{4}<\/zoo-msg-id>\s*$/i;

/**
 * Maximum assignable message ref index.
 *
 * Refs are numbered `m0001` … `m9999`.  When `nextRef > MAX_INDEX`
 * assignment stops silently (no wraparound).
 */
export const MAX_INDEX = 9999;
