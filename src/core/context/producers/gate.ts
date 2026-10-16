/**
 * Shared producer gate over the host-agnostic context lens.
 *
 * Both prune producers (`producers/dedup.ts`, `producers/purge-errors.ts`)
 * open with the same gating prelude: an absent protected window skips
 * everything (fail-safe), then the message-count floor, then the
 * context-fraction threshold.  This module is that prelude, so the gate
 * order and its equality semantics live in exactly one place; the
 * producers keep only their scan logic.
 *
 * @module
 */

import type { Projection } from "../lens.js";
import { measureMessages } from "../measure.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Gate options shared by every prune producer.
 *
 * The gate parameters (`minMessages`, `thresholdContext`) are required —
 * the caller supplies them from config.toml; a producer carries no
 * defaults and refuses to run when either is absent.
 */
export interface ProducerGateOptions {
  /**
   * Minimum non-hidden message count before the producer runs.  The
   * producer skips when the count is not greater.
   */
  minMessages: number;
  /**
   * Fraction of `contextLimit` that must be reached for marks to be
   * produced; equality opens the gate.
   */
  thresholdContext: number;
  /**
   * Model context window in tokens.  Undefined closes the gate
   * (fail-closed — the fraction cannot be evaluated).
   */
  contextLimit?: number;
  /**
   * First protected ordinal (inclusive): regions at or after this
   * ordinal are never marked.  Computed by the caller from the
   * protected-messages / protected-tokens window; undefined skips
   * the producer entirely (fail-safe when the window is not
   * configured).  `messages.length` is an empty window.
   */
  protectedStartOrdinal?: number;
  /**
   * Tool names excluded from the producer, matched case-sensitively.
   * Undefined → empty list (neutral — no tool names are protected).
   */
  protectedTools?: string[];
  /**
   * Predicate over message ordinals reporting messages already folded
   * into a compression block or otherwise pruned; their tool calls are
   * never marked.
   */
  prunedOrdinals?: (ordinal: number) => boolean;
}

/**
 * Result of one producer pass.
 */
export interface ProducerRunResult {
  /** Number of new pending marks written. */
  created: number;
  /** Total estimated reclaim tokens of the new marks. */
  tokens: number;
}

// ---------------------------------------------------------------------------
// Gate
// ---------------------------------------------------------------------------

/**
 * Run the shared producer gate over the projection snapshot.
 *
 * Gate order: an absent protected window skips everything (fail-safe),
 * then the empty transcript, then the message-count floor (equality
 * skips — `messageCount <= minMessages`), then the context-fraction
 * threshold (unknown model limit closes the gate fail-closed; equality
 * opens it).
 *
 * @param snapshot - The projection snapshot: the region view the gate
 *   measures over.
 * @param options - The producer's gate options.
 * @returns The gate outcome carrying `protectedStartOrdinal`, or null
 *   when the producer must skip (zero side effects).
 */
export function checkProducerGate(
  snapshot: Projection,
  options: ProducerGateOptions,
): { protectedStartOrdinal: number } | null {
  // Fail-safe: without a protection window the producer is skipped with
  // zero side effects.
  if (options.protectedStartOrdinal === undefined) return null;
  const protectedStartOrdinal = options.protectedStartOrdinal;

  const messages = snapshot.messages;
  if (!messages || messages.length === 0) return null;
  const measured = measureMessages(messages);
  if (measured.messageCount <= options.minMessages) return null;

  // Context gate: unknown model limit closes the gate; equality opens it.
  if (options.contextLimit === undefined) return null;
  if (measured.total < options.contextLimit * options.thresholdContext) {
    return null;
  }
  return { protectedStartOrdinal };
}
