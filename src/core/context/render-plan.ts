/**
 * Core render plan — the folded view as materialization instructions.
 *
 * The render algorithm is host-agnostic.  Given the lens transcript, the
 * fold's view items and the round's published numbering, `planViewRender`
 * produces an ordered list of what the host must emit: the synthetic
 * summary text of a folded block, or the ordinal of a transcript message
 * — plus, for a visible fold unit, which single member carries the
 * unit's `[mN] ` line ref.
 *
 * Numbering stays with the caller.  The pipeline numbers the view once
 * (`numberView`) and publishes that numbering to the compression tools,
 * so the plan consumes the published numbered view rather than
 * re-deriving it: the refs the model reads and the refs the tools resolve
 * can never drift apart.
 *
 * A host adapter only clones, applies the planned injections through its
 * own lens (`applyLineInjections`) and turns the plan into its message
 * shape (`HostAdapter.materialize`).  Injection targets are chosen here,
 * by the placement rule `pickInjectableRegion` encodes, because which
 * message of a unit receives the prefix is part of the address space the
 * model perceives — not a host detail.
 *
 * @module
 */

import type { HostMessage, RenderEntry, ViewItem } from "./lens.js";
import { blockIdOf, type SessionState } from "./state.js";
import { formatSummaryText, type NumberedItem } from "./view-refs.js";
import { injectLinePrefix, pickInjectableRegion } from "./writable-regions.js";

export type { RenderEntry };

/**
 * Plan how a numbered folded view materializes.
 *
 * Original items keep every member message of their fold unit; the
 * unit's line ref lands on the first member that carries an injectable
 * region (an assistant text prefix ahead of a later tool result, by
 * message order), and a unit with no injectable member keeps its line
 * allocated but unplaced — at most one prefix per visible unit either
 * way.  A hidden unit stays in the plan without a line ref, so its raw
 * text renders but occupies no address.
 *
 * Feed the returned plan to `applyLineInjections` and to the host's
 * `materialize`.
 *
 * @param lens - The lens transcript of the conversation being rendered.
 * @param items - The folded view items, in view order.
 * @param numbered - The published numbering of the same view.
 * @param state - The session state (block map, for summary block ids).
 * @returns The render plan, in view order.
 */
export function planViewRender(
  lens: HostMessage[],
  items: ViewItem[],
  numbered: NumberedItem[],
  state: SessionState,
): RenderEntry[] {
  const lineByItem = new Map<ViewItem, number>();
  for (const { n, item } of numbered) {
    lineByItem.set(item, n);
  }

  const plan: RenderEntry[] = [];
  for (const item of items) {
    const line = lineByItem.get(item);
    if (item.type === "summary") {
      const id = blockIdOf(state, item.block.start, item.block.end);
      plan.push({
        kind: "summary",
        text: formatSummaryText({ ...item.block, id }, line),
        ...(id !== undefined ? { id } : {}),
      });
      continue;
    }
    // An original item is one fold unit — a contiguous interval the
    // fold layer keeps indivisible.  Every member renders; the unit's
    // single line ref is placed on the first member offering an
    // injectable region.  A ordinal with no lens message (a transcript
    // hole) offers none and is skipped.
    let linePlaced = false;
    for (let ordinal = item.start; ordinal < item.end; ordinal++) {
      const msg = lens[ordinal];
      const injectable =
        !linePlaced &&
        line !== undefined &&
        msg !== undefined &&
        pickInjectableRegion(msg) !== undefined;
      if (injectable) linePlaced = true;
      plan.push(
        injectable
          ? { kind: "source", ordinal, line }
          : { kind: "source", ordinal },
      );
    }
  }
  return plan;
}

/**
 * Write the plan's line refs through a lens.
 *
 * Each planned source entry with a line ref receives the `[mN] `
 * prefix on the region `planViewRender` chose for it; every other
 * message keeps its text unchanged.  An entry whose ordinal addresses
 * no message is skipped defensively.
 *
 * @param lens - The lens transcript of the conversation being rendered.
 * @param plan - The render plan for that transcript.
 */
export function applyLineInjections(
  lens: HostMessage[],
  plan: RenderEntry[],
): void {
  for (const entry of plan) {
    if (entry.kind !== "source" || entry.line === undefined) continue;
    const msg = lens[entry.ordinal];
    if (msg === undefined) continue;
    injectLinePrefix(msg, entry.line);
  }
}
