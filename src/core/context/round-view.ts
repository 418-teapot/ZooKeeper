/**
 * The current round's frozen view — the single snapshot compression tools read.
 *
 * The context-pruning transform builds the folded view and its dense
 * `mN` line numbering every round; that pair IS the history address
 * space the model holds while it runs.  A compression tool invoked
 * mid-turn must therefore see the SAME view — re-deriving it from the
 * host risks addressing a different ordinal space than the one the
 * model was shown (the failure mode behind mismatched `mN` refs).
 *
 * This module is that hand-off: the transform `publishRoundView`s its
 * fold result, the tools `getRoundView` it.  The published view is
 * frozen on the way in — every region text copied into a plain string
 * and every view item copied into plain data — so the cache is a
 * snapshot, not a live handle: a host that mutates its conversation
 * in place mid-turn (or a state mutation from a preceding compress
 * call in the same round) can never reshuffle an address space already
 * handed to the model.
 *
 * The record is runtime-only (never persisted — loss on restart is
 * benign: the next transform republishes) and per-session, so
 * `cleanupSession` drops it alongside the other session-level records.
 *
 * @module
 */

import type { HostMessage, Invocation, Projection } from "./lens.js";
import { project } from "./lens.js";
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
        ? { type: "original" as const, ordinal: item.ordinal }
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
// Per-session cache
// ---------------------------------------------------------------------------

/** The latest published view per session. */
const roundViews = new Map<string, RoundView>();

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
export function publishRoundView(sessionId: string, view: RoundView): void {
  roundViews.set(sessionId, {
    projection: freezeProjection(view.projection),
    numbered: freezeNumberedView(view.numbered),
  });
}

/**
 * Read the current round's frozen view.
 *
 * @param sessionId - The session identifier.
 * @returns The published view, or undefined when no transform has run
 *   for this session yet in this process.
 */
export function getRoundView(sessionId: string): RoundView | undefined {
  return roundViews.get(sessionId);
}

/**
 * Drop the session's cached round view.
 *
 * Called by `cleanupSession` on `session.deleted`, and by the pi host's
 * `session_start` handler — pi reports no session-deletion event, so a
 * replayed session_start (reload / resume) is the only place its
 * long-lived process can reclaim the entry.
 *
 * @param sessionId - The session identifier.
 */
export function clearRoundView(sessionId: string): void {
  roundViews.delete(sessionId);
}

/** Test affordance: the sessions that currently hold a cached round view. */
export function _listRoundViewSessionsForTesting(): string[] {
  return [...roundViews.keys()];
}

/** Test affordance: drop every cached round view. */
export function _resetRoundViewsForTesting(): void {
  roundViews.clear();
}
