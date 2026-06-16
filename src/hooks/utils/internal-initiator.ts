/**
 * Layer 1 — Internal initiator marker utilities.
 *
 * Replicates omo's `OMO_INTERNAL_INITIATOR_MARKER` pattern but adapted for
 * ZooKeeper.  An injected text part is distinguished from real user input by
 * a trailing HTML-comment marker (`<!-- ZOO_INTERNAL_INITIATOR -->`) and/or
 * the `synthetic` flag.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Trailing marker appended to every internally-generated text part.
 */
export const ZOO_INTERNAL_INITIATOR_MARKER = "<!-- ZOO_INTERNAL_INITIATOR -->";

/**
 * Regex to detect the marker with arbitrary whitespace inside the comment.
 */
const INTERNAL_INITIATOR_MARKER_DETECT_PATTERN =
  /<!--\s*ZOO_INTERNAL_INITIATOR\s*-->/;

/**
 * Regex to strip all occurrences of the marker (including surrounding
 * newlines and trailing whitespace).
 */
const INTERNAL_INITIATOR_MARKER_PATTERN =
  /\n*<!--\s*ZOO_INTERNAL_INITIATOR\s*-->\s*/g;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Minimal shape of a text-like part for marker inspection.
 */
export interface InternalInitiatorTextPartLike {
  type?: string;
  text?: string;
  synthetic?: boolean;
}

// ---------------------------------------------------------------------------
// Detection
// ---------------------------------------------------------------------------

/**
 * Check whether `text` contains the internal initiator marker.
 *
 * Whitespace inside the HTML comment is normalized, so
 * `<!--  ZOO_INTERNAL_INITIATOR  -->` also matches.
 *
 * @param text - Text to inspect.
 * @returns `true` if the marker is present.
 */
export function hasInternalInitiatorMarker(text: string): boolean {
  return INTERNAL_INITIATOR_MARKER_DETECT_PATTERN.test(text);
}

/**
 * Check whether a text-like part qualifies as synthetic or internal based on
 * either the `synthetic` flag or the presence of the marker in its text.
 *
 * @param part - Part to inspect.
 * @returns `true` if the part is synthetic or marked as internal.
 */
export function isSyntheticOrInternalTextPart(
  part: InternalInitiatorTextPartLike,
): boolean {
  return (
    part.type === "text" &&
    typeof part.text === "string" &&
    (part.synthetic === true || hasInternalInitiatorMarker(part.text))
  );
}

/**
 * Check whether a text-like part is "real" user input — the inverse of
 * {@link isSyntheticOrInternalTextPart}.
 *
 * TODO: Exported for future hooks that need to filter out injected content
 * from real user text (e.g. a message-level handler that must only react
 * to genuine user input).
 *
 * @param part - Part to inspect.
 * @returns `true` if the part is a real user text part.
 */
export function isRealUserTextPart(
  part: InternalInitiatorTextPartLike,
): part is InternalInitiatorTextPartLike & { type: "text"; text: string } {
  return (
    part.type === "text" &&
    typeof part.text === "string" &&
    !isSyntheticOrInternalTextPart(part)
  );
}

/**
 * Check whether **all** text parts in the given array are synthetic or
 * internal.  Returns `false` when the array is empty or undefined.
 *
 * TODO: Exported for future hooks that should skip self-generated messages
 * entirely (e.g. a keyword detector or mode switcher that only cares about
 * real user turns).
 *
 * @param parts - Array of text-like parts to inspect.
 * @returns `true` if every text part is synthetic/internal.
 */
export function isSyntheticOrInternalOnlyTextParts(
  parts: readonly InternalInitiatorTextPartLike[] | undefined,
): boolean {
  const textParts = (parts ?? []).filter(
    (p): p is InternalInitiatorTextPartLike & { type: "text"; text: string } =>
      p.type === "text" && typeof p.text === "string",
  );
  return textParts.length > 0 && textParts.every(isSyntheticOrInternalTextPart);
}

// ---------------------------------------------------------------------------
// Stripping
// ---------------------------------------------------------------------------

/**
 * Remove all internal initiator markers from `text` and trim trailing
 * whitespace.
 *
 * TODO: Exported for future hooks that need to display or forward the clean
 * content without the marker (e.g. compaction summarization or log export).
 *
 * @param text - Text to clean.
 * @returns Cleaned text with markers removed.
 */
export function stripInternalInitiatorMarkers(text: string): string {
  return text.replace(INTERNAL_INITIATOR_MARKER_PATTERN, "").trimEnd();
}

// ---------------------------------------------------------------------------
// Creation
// ---------------------------------------------------------------------------

/**
 * Create a text part that is clearly marked as internal/agent-generated.
 *
 * Strips any existing markers from the input, then appends a single fresh
 * marker on a new line at the end.
 *
 * @param text - The content for the text part.
 * @returns A `{ type: "text", text }` part with the marker appended.
 */
export function createInternalAgentTextPart(text: string): {
  type: "text";
  text: string;
} {
  const cleanText = stripInternalInitiatorMarkers(text);
  return {
    type: "text",
    text: `${cleanText}\n${ZOO_INTERNAL_INITIATOR_MARKER}`,
  };
}
