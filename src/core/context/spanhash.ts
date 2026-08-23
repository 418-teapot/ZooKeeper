/**
 * Rolling span hashing over mutation-invariant message projections.
 *
 * A block declares a cover over a transcript interval `[start, end)` and
 * proves its validity by content alone: the span hash is recomputed each
 * round and compared against the value stored at creation.  Because the
 * input is the `canon` projection (see `canon.ts`), prune placeholder
 * replacement — the one core-side text mutation that lands between the
 * two hash observations — leaves the hash stable, while any real
 * content change anywhere in the interval breaks it.  Line-number
 * injection never reaches hashed text: both observations run before
 * the injection phase.
 *
 * Hash selection (spec Q2): FNV-1a, 32-bit, non-cryptographic, ten-ish
 * lines of plain TypeScript.  Each message's canon string is hashed
 * individually over its UTF-8 bytes; the per-message hashes are then
 * rolled into a running state in ordinal order as fixed-width 4-byte
 * frames (big-endian).  The fixed frame width keeps the composition
 * unambiguous at the byte level: `[a, b]` always occupies twice the
 * bytes of `[ab]` and order is preserved, so no concatenation ambiguity
 * can be encoded into the same stream.  The result is a fixed-length
 * 8-character lowercase hex string.
 *
 * @module
 */

import { canon } from "./canon.js";
import type { HostMessage } from "./lens.js";

/** FNV-1a 32-bit offset basis. */
const FNV_OFFSET_BASIS = 0x811c9dc5;

/** FNV-1a 32-bit prime. */
const FNV_PRIME = 0x01000193;

/**
 * FNV-1a 32-bit hash of a string's UTF-8 bytes.
 *
 * Non-cryptographic; used for span self-validation only, so collision
 * resistance is not a requirement.  Deterministic and dependency-free.
 *
 * @param text - The string to hash.
 * @returns The unsigned 32-bit FNV-1a hash.
 */
export function fnv1a(text: string): number {
  let hash = FNV_OFFSET_BASIS;
  const bytes = new TextEncoder().encode(text);
  for (let i = 0; i < bytes.length; i++) {
    hash = Math.imul(hash ^ bytes[i], FNV_PRIME) >>> 0;
  }
  return hash >>> 0;
}

/**
 * Roll one message's hash into the running span state.
 *
 * The message hash is written as a fixed-width 4-byte frame,
 * big-endian; the fixed width is what makes the composition injective
 * at the byte level (see module docstring).
 *
 * @param state - The running hash.
 * @param messageHash - The message's own 32-bit hash.
 * @returns The updated running hash.
 */
function mixMessage(state: number, messageHash: number): number {
  let hash = state;
  hash = Math.imul(hash ^ ((messageHash >>> 24) & 0xff), FNV_PRIME) >>> 0;
  hash = Math.imul(hash ^ ((messageHash >>> 16) & 0xff), FNV_PRIME) >>> 0;
  hash = Math.imul(hash ^ ((messageHash >>> 8) & 0xff), FNV_PRIME) >>> 0;
  hash = Math.imul(hash ^ (messageHash & 0xff), FNV_PRIME) >>> 0;
  return hash >>> 0;
}

/**
 * Compute the rolling span hash over the transcript interval
 * `[start, end)`.
 *
 * Every message in the interval participates — including hidden ones,
 * which occupy ordinals like any other message (spec Decision 1).  Each
 * message is projected through `canon` first, so core-side text
 * mutations leave the result unchanged.
 *
 * Invalid ranges are a programming error and throw a `RangeError`:
 * `start < 0`, `end > history.length`, or `start >= end` (an empty span
 * has no content to vouch for and is rejected).  Use `validateBlock`
 * for the tolerant existence check against persisted data.
 *
 * @param history - The transcript to hash over.
 * @param start - First covered ordinal (inclusive).
 * @param end - Last covered ordinal (exclusive).
 * @returns The fixed-length 8-character lowercase hex hash.
 * @throws RangeError when the interval is empty or out of bounds.
 */
export function computeSpanHash(
  history: HostMessage[],
  start: number,
  end: number,
): string {
  if (start < 0 || end > history.length || start >= end) {
    throw new RangeError(
      `invalid span [${start}, ${end}) for history of length ${history.length}`,
    );
  }
  let state = FNV_OFFSET_BASIS;
  for (let i = start; i < end; i++) {
    state = mixMessage(state, fnv1a(canon(history[i])));
  }
  return state.toString(16).padStart(8, "0");
}

/**
 * Minimal span shape a block must satisfy to be hash-validated.
 *
 * The persisted `Block` of a later phase satisfies this interface —
 * `start`/`end` ordinals plus the `spanHash` computed at creation time.
 */
export interface HashedSpan {
  /** First covered ordinal (inclusive). */
  start: number;
  /** Last covered ordinal (exclusive). */
  end: number;
  /** Rolling span hash computed at block creation. */
  spanHash: string;
}

/**
 * Recompute the span hash and compare against the stored value.
 *
 * Any of the following makes the block invalid: `start < 0`,
 * `end > history.length` (a truncation or fork cut into the interval),
 * or `start >= end`.  Otherwise the hash is recomputed over the current
 * interval content and compared — a mismatch means the interval no
 * longer contains what was hashed at creation (compaction replacement,
 * mid-span rewrite, or any other content change).
 *
 * @param history - The current transcript.
 * @param block - The block record to validate.
 * @returns True when the interval is in bounds and its content hashes
 *   to the stored `spanHash`.
 */
export function validateBlock(
  history: HostMessage[],
  block: HashedSpan,
): boolean {
  if (
    block.start < 0 ||
    block.end > history.length ||
    block.start >= block.end
  ) {
    return false;
  }
  return computeSpanHash(history, block.start, block.end) === block.spanHash;
}
