/**
 * Shared producer gate over the host-agnostic context lens.
 *
 * Both prune producers (`producers/dedup.ts`, `producers/purge-errors.ts`)
 * open with the same gating prelude: an absent protection map skips
 * everything (fail-closed), then the message-count floor, then the
 * context-fraction threshold.  This module is that prelude, so the gate
 * order and its equality semantics live in exactly one place; the
 * producers keep only their scan logic.
 *
 * @module
 */

import type { Projection } from "../lens.js";
import { measureMessages } from "../measure.js";
import type { ProtectionMap } from "../protection-map.js";

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
   * This round's protection map: a region anchored at a protected
   * ordinal is never marked.  Undefined skips the producer entirely
   * with zero side effects (fail-closed when the round has no map).
   */
  protection?: ProtectionMap;
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
 * Gate order: an absent protection map skips everything (fail-closed),
 * then the empty transcript, then the message-count floor (equality
 * skips — `messageCount <= minMessages`), then the context-fraction
 * threshold (unknown model limit closes the gate fail-closed; equality
 * opens it).
 *
 * @param snapshot - The projection snapshot: the region view the gate
 *   measures over.
 * @param options - The producer's gate options.
 * @returns The gate outcome carrying the round's protection map, or
 *   null when the producer must skip (zero side effects).
 */
export function checkProducerGate(
  snapshot: Projection,
  options: ProducerGateOptions,
): { protection: ProtectionMap } | null {
  // Fail-closed: without the round's protection map the producer is
  // skipped with zero side effects.
  const protection = options.protection;
  if (protection === undefined) return null;

  const messages = snapshot.messages;
  if (!messages || messages.length === 0) return null;
  const measured = measureMessages(messages);
  if (measured.messageCount <= options.minMessages) return null;

  // Context gate: unknown model limit closes the gate; equality opens it.
  if (options.contextLimit === undefined) return null;
  if (measured.total < options.contextLimit * options.thresholdContext) {
    return null;
  }
  return { protection };
}
