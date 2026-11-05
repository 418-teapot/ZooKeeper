/**
 * The current round's frozen view — the single snapshot compression tools read.
 *
 * The context-pruning transform builds the folded view, its dense `mN`
 * line numbering and the protection map every round; that snapshot IS
 * the history address space the model holds while it runs.  A
 * compression tool invoked mid-turn must therefore see the SAME view —
 * re-deriving it from the host risks addressing a different ordinal
 * space than the one the model was shown (the failure mode behind
 * mismatched `mN` refs).
 *
 * This module is that hand-off: the `RoundViewRegistry` holds the
 * snapshot, the transform publishes it through the per-instance
 * `ContextRuntime` (`runtime.ts`) once the round committed, and the tools
 * read it back by session id.  The view is frozen on the way in — every
 * region text copied into a plain string and every view item copied into
 * plain data — so the cache is a snapshot, not a live handle: a host
 * that mutates its conversation in place mid-turn (or a state mutation
 * from a preceding compress call in the same round) can never reshuffle
 * an address space already handed to the model.
 *
 * The record is runtime-only (never persisted — loss on restart is
 * benign: the next transform republishes) and per-session.  One registry
 * belongs to one `ContextRuntime`, so two plugin instances in the same
 * process never share a published view, and the instance's session
 * records drop the entries on a stop.
 *
 * @module
 */

import type { HostMessage, Invocation, Projection } from "./lens.js";
import { project } from "./lens.js";
import { freezeProtectionMap, type ProtectionMap } from "./protection-map.js";
import type { NumberedItem } from "./view-refs.js";

/**
 * One round's view as the tools see it: the transcript snapshot the
 * fold ran over, plus the dense line numbering derived from it.
 */
export interface RoundView {
  /** The frozen projection snapshot (transcript + invocation table). */
  projection: Projection;
  /** The frozen numbered view items — the round's `mN` address space. */
  numbered: NumberedItem[];
  /** The round's frozen protection map; absent when the config defines
   * no protection inputs. */
  protection?: ProtectionMap;
}

/**
 * Deep-copy a projection snapshot into fixed text.
 *
 * Reads every region through its lens once and rebuilds the message
 * list over the copied strings, so the result no longer depends on any
 * host object.  The invocation table is copied field-wise and the
 * region reverse index is rebuilt from those copies, so addresses stay
 * consistent with the frozen transcript.
 *
 * @param snapshot - The projection to freeze (not mutated).
 * @returns An equivalent snapshot over copied data.
 */
export function freezeProjection(snapshot: Projection): Projection {
  const messages: HostMessage[] = snapshot.messages.map((message) => ({
    role: message.role,
    hidden: message.hidden,
    usage: message.usage === undefined ? undefined : { ...message.usage },
    compaction: message.compaction,
    regions: message.regions.map((region) => {
      const text = region.get();
      return { kind: region.kind, get: () => text };
    }),
  }));
  const invocations: Invocation[] = snapshot.invocations.map((invocation) => ({
    name: invocation.name,
    status: invocation.status,
    input: { ...invocation.input },
    output:
      invocation.output === undefined ? undefined : { ...invocation.output },
  }));
  return project(messages, invocations);
}

/**
 * Deep-copy numbered view items into plain data.
 *
 * A summary item normally references the live `Block` record; copying
 * the span fields keeps the cached address space independent of later
 * mutations of that record.
 *
 * @param numbered - The numbered items to freeze (not mutated).
 * @returns Equivalent items over copied data.
 */
export function freezeNumberedView(numbered: NumberedItem[]): NumberedItem[] {
  return numbered.map(({ n, item }) => ({
    n,
    item:
      item.type === "original"
        ? { type: "original" as const, start: item.start, end: item.end }
        : {
            type: "summary" as const,
            block: {
              start: item.block.start,
              end: item.block.end,
              title: item.block.title,
              summary: item.block.summary,
            },
          },
  }));
}

// ---------------------------------------------------------------------------
// Per-session registry
// ---------------------------------------------------------------------------

/** The published round view of each session. */
export interface RoundViewRegistry {
  /**
   * Publish the current round's view for the compression tools.
   *
   * The view is frozen on the way in (see `freezeProjection` /
   * `freezeNumberedView`), so callers hand over their live objects
   * without keeping a reachable handle.  Overwrites any earlier view of
   * the same session — only the newest round's address space is of
   * interest.
   *
   * @param sessionId - The session identifier.
   * @param view - The round's snapshot and numbered view.
   */
  publish(sessionId: string, view: RoundView): void;
  /**
   * Read the current round's frozen view.
   *
   * @param sessionId - The session identifier.
   * @returns The published view, or undefined when no transform has run
   *   for this session yet in this runtime.
   */
  get(sessionId: string): RoundView | undefined;
  /** Drop the session's cached round view. */
  clear(sessionId: string): void;
}

/**
 * Create an empty round-view registry.
 *
 * @returns The registry; its entries live only as long as the caller
 *   keeps it.
 */
export function createRoundViewRegistry(): RoundViewRegistry {
  const views = new Map<string, RoundView>();
  return {
    publish(sessionId, view) {
      views.set(sessionId, {
        projection: freezeProjection(view.projection),
        numbered: freezeNumberedView(view.numbered),
        ...(view.protection === undefined
          ? {}
          : { protection: freezeProtectionMap(view.protection) }),
      });
    },
    get(sessionId) {
      return views.get(sessionId);
    },
    clear(sessionId) {
      views.delete(sessionId);
    },
  };
}
