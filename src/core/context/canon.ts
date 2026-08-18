/**
 * Mutation-invariant message projection (`canon`).
 *
 * Maps a message to a deterministic string that stays equal under every
 * text mutation the core itself performs — line-start message-ref
 * injection and tool-input/tool-output placeholder replacement — while
 * changing whenever the real message content changes.  Block span hashes
 * are computed over these projections, so a projection must never absorb
 * a core-side rewrite (a block would otherwise validate against text the
 * core itself replaced).
 *
 * Component list (concatenated in this order):
 *
 * 1. `role` — the message role string.
 * 2. Content region texts, each with injected markers stripped
 *    (`stripTags`), in region order.
 * 3. Thinking region texts, verbatim, in region order (full text — a
 *    truncation would introduce a boundary semantic).
 * 4. Tool names, in region order, from tool-input and tool-output
 *    regions (every call contributes its name twice; no dedup, so call
 *    count is preserved).
 *
 * Explicitly excluded: tool-output text (sweep/dedup may replace it
 * with a placeholder), tool-input text (purge-errors may replace it),
 * and every ref / line-number marker.
 *
 * The components are serialized with `JSON.stringify` of a nested array;
 * the JSON delimiters and escaping make any component boundary
 * unambiguous ("ab" + "c" never collides with "a" + "bc").  No
 * cryptographic hash — this module produces the string projection only;
 * hashing is a separate concern.
 *
 * @module
 */

import type { HostMessage } from "./lens.js";
import { regionsOfKind } from "./lens.js";

/**
 * Line-start message-ref prefix injected by the render layer: `[mN] ` —
 * natural integer, no zero padding, trailing space included.  Only an
 * exact line-start match is stripped; bare refs in prose are preserved.
 *
 * Exported as the single strip rule shared with the render layer, so
 * injection, stripping, and the canon projection can never disagree.
 */
export const LINE_START_REF_PREFIX = /^\[m\d+\] /;

/**
 * Strip core-injected markers from a message text.
 *
 * Only line-start ref prefixes `[mN] ` are removed — stripped per line
 * on an exact line-start match, including the trailing space.  Mid-text
 * occurrences are preserved.  Idempotent.
 *
 * @param text - The raw region text.
 * @returns The text with injected markers removed.
 */
export function stripTags(text: string): string {
  return text
    .split("\n")
    .map((line) => line.replace(LINE_START_REF_PREFIX, ""))
    .join("\n");
}

/**
 * Compute the mutation-invariant projection of a message.
 *
 * The projection ignores the `hidden` flag — the caller decides whether
 * hidden messages participate in hashing.  The result is a plain string
 * projection (no cryptographic hash; hashing is the caller's concern).
 *
 * @param msg - The message to project.
 * @returns The deterministic canonical string.
 */
export function canon(msg: HostMessage): string {
  const content = regionsOfKind(msg, "content").map((region) =>
    stripTags(region.get()),
  );
  const thinking = regionsOfKind(msg, "thinking").map((region) => region.get());
  const toolNames = msg.regions
    .filter(
      (region) => region.kind === "tool-input" || region.kind === "tool-output",
    )
    .map((region) => region.tool?.name ?? "");
  return JSON.stringify([msg.role, content, thinking, toolNames]);
}
