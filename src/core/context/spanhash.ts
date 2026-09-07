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
 * Hash selection: FNV-1a, 32-bit, non-cryptographic, ten-ish lines of
 * plain TypeScript.  Each message's canon string is hashed
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
import type { Projection } from "./lens.js";

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
 * which occupy ordinals like any other message.  Each message is
 * projected through `canon` first, so core-side text mutations leave the
 * result unchanged.
 *
 * Invalid ranges are a programming error and throw a `RangeError`:
 * `start < 0`, `end > history.length`, or `start >= end` (an empty span
 * has no content to vouch for and is rejected).  Use `checkSpan` for
 * the tolerant comparison against persisted data.
 *
 * @param snapshot - The projection snapshot to hash over.
 * @param start - First covered ordinal (inclusive).
 * @param end - Last covered ordinal (exclusive).
 * @returns The fixed-length 8-character lowercase hex hash.
 * @throws RangeError when the interval is empty or out of bounds.
 */
export function computeSpanHash(
  snapshot: Projection,
  start: number,
  end: number,
): string {
  const history = snapshot.messages;
  if (start < 0 || end > history.length || start >= end) {
    throw new RangeError(
      `invalid span [${start}, ${end}) for history of length ${history.length}`,
    );
  }
  let state = FNV_OFFSET_BASIS;
  for (let i = start; i < end; i++) {
    state = mixMessage(state, fnv1a(canon(snapshot, i)));
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
 * Why a span check turned out the way it did.
 *
 * - `"match"` — the interval is in bounds and hashes to the stored value.
 * - `"out-of-bounds"` — the interval is not addressable in the current
 *   transcript (`start < 0` or `end > history.length`): a truncation or
 *   a fork cut into the span, or the transcript shrank under it.  No
 *   current hash is defined for such an interval.
 * - `"empty-span"` — `start >= end`, so the span vouches for nothing.
 * - `"hash-mismatch"` — the interval is addressable but its content no
 *   longer hashes to the stored value (compaction replacement, mid-span
 *   rewrite, or any other content change).
 */
export type SpanCheckReason =
  | "match"
  | "out-of-bounds"
  | "empty-span"
  | "hash-mismatch";

/**
 * Outcome of one span self-verification.
 *
 * Carries both sides of the comparison plus the transcript length it was
 * computed against, so a caller can log why a block stopped validating
 * instead of only that it did.
 */
export interface SpanCheck {
  /** True when the interval is in bounds and hashes to `storedHash`. */
  valid: boolean;
  /** Classification of the outcome. */
  reason: SpanCheckReason;
  /** The hash stored at block creation. */
  storedHash: string;
  /**
   * The hash of the interval as it reads now, or `null` when the
   * interval is not addressable and no hash is defined for it.
   */
  currentHash: string | null;
  /** Transcript length the interval was checked against. */
  historyLength: number;
}

/**
 * Recompute the span hash and compare it against the stored value.
 *
 * Tolerant by design: out-of-bounds or empty intervals are reported,
 * never thrown — this runs over persisted data.  `computeSpanHash` is
 * the strict counterpart used at creation time.
 *
 * @param snapshot - The current projection snapshot.
 * @param block - The block record to validate.
 * @returns The comparison outcome, including both hashes and the
 *   failure classification.
 */
export function checkSpan(snapshot: Projection, block: HashedSpan): SpanCheck {
  const historyLength = snapshot.messages.length;
  const storedHash = block.spanHash;
  if (block.start < 0 || block.end > historyLength) {
    return {
      valid: false,
      reason: "out-of-bounds",
      storedHash,
      currentHash: null,
      historyLength,
    };
  }
  if (block.start >= block.end) {
    return {
      valid: false,
      reason: "empty-span",
      storedHash,
      currentHash: null,
      historyLength,
    };
  }
  const currentHash = computeSpanHash(snapshot, block.start, block.end);
  return {
    valid: currentHash === storedHash,
    reason: currentHash === storedHash ? "match" : "hash-mismatch",
    storedHash,
    currentHash,
    historyLength,
  };
}

/**
 * Recompute the span hash and compare against the stored value.
 *
 * Boolean projection of {@link checkSpan}; use `checkSpan` when the
 * reason for a failure needs to be reported.
 *
 * @param snapshot - The current projection snapshot.
 * @param block - The block record to validate.
 * @returns True when the interval is in bounds and its content hashes
 *   to the stored `spanHash`.
 */
export function validateBlock(
  snapshot: Projection,
  block: HashedSpan,
): boolean {
  return checkSpan(snapshot, block).valid;
}
