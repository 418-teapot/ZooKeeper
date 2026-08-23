/**
 * Pi host adapter — render a folded view and region edits into a new pi
 * message array.
 *
 * The render path is fully pure: it deep-copies the input conversation,
 * applies `RegionEdit`s through the lens, injects per-round `[mN] ` line
 * refs into injectable regions, and materializes folded blocks as synthetic
 * user messages.  The original input array and its message objects are
 * never mutated.
 *
 * Summary materialization follows the same label format as the v1 adapter:
 * `[Block bN · K 条] 标题` with the block summary body on the next line and
 * a leading `[mN] ` prefix when the summary occupies a visible view line.
 *
 * @module
 */

import type {
  BlockSpan,
  HostMessage,
  RegionEdit,
  ViewItem,
} from "../../core/context/lens.js";
import type { SessionState } from "../../core/context/state.js";
import {
  formatSummaryLabel,
  numberView,
  refPrefix,
} from "../../core/context/view-refs.js";
import { history, isInjectableRegion, type WritableRegion } from "./history.js";
import type { PiAgentMessage, PiUserMessage } from "./types.js";

/**
 * Look up the block-map id matching a folded summary item's interval.
 */
function blockIdOf(
  state: SessionState,
  start: number,
  end: number,
): number | undefined {
  for (const [id, block] of state.blocks) {
    if (block.start === start && block.end === end) return id;
  }
  return undefined;
}

/**
 * Apply region edits through the lens.
 *
 * Edits whose anchor cannot be resolved are skipped defensively.
 */
export function applyEditsToLens(
  lens: HostMessage[],
  edits: RegionEdit[],
): void {
  for (const edit of edits) {
    if (edit.regionIndex === undefined) continue;
    const region = lens[edit.messageOrdinal]?.regions?.[edit.regionIndex];
    if (!region) continue;
    (region as WritableRegion).set(edit.text);
  }
}

/**
 * Apply region edits to a pi conversation, returning a new array.
 *
 * The input array and its message objects are never modified: a deep copy
 * is made, edits are written through the lens into the copy, and the
 * copy is returned.
 *
 * @param messages - The pi conversation before edits.
 * @param edits - Region text replacements.
 * @returns A new pi message array with edits applied.
 */
export function applyEdits(
  messages: PiAgentMessage[],
  edits: RegionEdit[],
): PiAgentMessage[] {
  const copies = messages.map(
    (message) => structuredClone(message) as PiAgentMessage,
  );
  const lens = history(copies);
  applyEditsToLens(lens, edits);
  return copies;
}

/**
 * Pick the region that receives the line-number prefix for an original
 * message.
 *
 * Tool-output regions win over text-derived content regions; thinking,
 * image-derived content, and tool-input regions never qualify.
 */
function pickInjectableRegion(msg: HostMessage): WritableRegion | undefined {
  for (const region of msg.regions) {
    if (region.kind === "tool-output" && isInjectableRegion(region)) {
      return region as WritableRegion;
    }
  }
  for (const region of msg.regions) {
    if (region.kind === "content" && isInjectableRegion(region)) {
      return region as WritableRegion;
    }
  }
  return undefined;
}

/**
 * Prepend the current round's prefix to an original message's injection
 * target.
 *
 * Pure prepend, no marker stripping: the input carries no prior-round
 * markers because the host delivers a fresh per-turn message array, so
 * the render output is never seen as input again.
 */
function injectLinePrefix(msg: HostMessage, line: number): void {
  const region = pickInjectableRegion(msg);
  if (region === undefined) return;
  region.set(refPrefix(line) + region.get());
}

/**
 * Materialize a folded block summary as a synthetic pi user message.
 */
export function materializeSummary(
  block: BlockSpan & { id?: number },
  lineNumber?: number,
): PiUserMessage {
  const label = formatSummaryLabel(block);
  const body = block.summary.length > 0 ? `\n${block.summary}` : "";
  const text =
    lineNumber === undefined
      ? `${label}${body}`
      : `${refPrefix(lineNumber)}${label}${body}`;
  return { role: "user", content: text };
}

/**
 * Build an index of tool-call / tool-result ordinal pairs.
 */
function buildToolPairIndex(messages: PiAgentMessage[]): {
  callOrdinalById: Map<string, number>;
  resultOrdinalById: Map<string, number>;
} {
  const callOrdinalById = new Map<string, number>();
  const resultOrdinalById = new Map<string, number>();
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role === "assistant") {
      for (const block of message.content) {
        if (block.type === "toolCall") {
          callOrdinalById.set(block.id, i);
        }
      }
    } else if (message.role === "toolResult") {
      resultOrdinalById.set(message.toolCallId, i);
    }
  }
  return { callOrdinalById, resultOrdinalById };
}

/**
 * Expand summary block intervals so that a tool call and its result are
 * always folded together.
 *
 * Pi represents a tool call and its result as two separate messages, while
 * the v1 adapter keeps them in the same message.  Whole-message fold
 * semantics therefore require a summary that covers one half of a pair to
 * swallow the other half as well.
 *
 * This stays as defensive hardening even though the compress gate chain
 * now rejects mid-pair ranges at creation (`validateRange` in
 * `compress.ts`): the gate consumes `ToolMeta.output`, which is carried
 * on the tool-input region only, so it rejects a range covering the
 * toolCall half without its result — but a range covering the RESULT
 * half without its call (a lone tool-output message inside the
 * interval) carries no linkage to check and would pass whenever the
 * phantom threshold is low enough.  Host truncation cannot produce a
 * mid-pair state interval (revert deactivates whole blocks, never
 * truncating one), but the expansion costs nothing and keeps every
 * pair-touching summary id-resolvable.
 */
export function expandSummaryBlocks(
  items: ViewItem[],
  messages: PiAgentMessage[],
): ViewItem[] {
  const { callOrdinalById, resultOrdinalById } = buildToolPairIndex(messages);
  const historyLength = messages.length;
  const covered = new Array<boolean>(historyLength).fill(false);
  const expandedSummaries: Array<{
    start: number;
    end: number;
    block: BlockSpan;
  }> = [];

  for (const item of items) {
    if (item.type !== "summary") continue;
    let start = item.block.start;
    let end = item.block.end;
    let changed = true;
    while (changed) {
      changed = false;
      for (let o = start; o < end; o++) {
        const message = messages[o];
        if (message.role === "assistant") {
          for (const block of message.content) {
            if (block.type !== "toolCall") continue;
            const resultOrdinal = resultOrdinalById.get(block.id);
            if (
              resultOrdinal !== undefined &&
              (resultOrdinal < start || resultOrdinal >= end)
            ) {
              start = Math.min(start, resultOrdinal);
              end = Math.max(end, resultOrdinal + 1);
              changed = true;
            }
          }
        } else if (message.role === "toolResult") {
          const callOrdinal = callOrdinalById.get(message.toolCallId);
          if (
            callOrdinal !== undefined &&
            (callOrdinal < start || callOrdinal >= end)
          ) {
            start = Math.min(start, callOrdinal);
            end = Math.max(end, callOrdinal + 1);
            changed = true;
          }
        }
      }
    }

    for (let o = start; o < end; o++) {
      covered[o] = true;
    }
    const block: BlockSpan = { ...item.block, start, end };
    expandedSummaries.push({ start, end, block });
  }

  const summaryByStart = new Map<number, BlockSpan>();
  for (const summary of expandedSummaries) {
    if (!summaryByStart.has(summary.start)) {
      summaryByStart.set(summary.start, summary.block);
    }
  }

  const out: ViewItem[] = [];
  for (let o = 0; o < historyLength; o++) {
    if (covered[o]) {
      const block = summaryByStart.get(o);
      if (block !== undefined) {
        out.push({ type: "summary", block });
      }
      continue;
    }
    out.push({ type: "original", ordinal: o });
  }
  return out;
}

/**
 * Build a rendered view from already-copied messages.
 *
 * The input array is treated as owned copies: the function mutates the
 * copies through the lens (line-number prefix injection) but never
 * touches the original conversation.  Callers must clone before calling.
 */
function buildRenderedView(
  copies: PiAgentMessage[],
  items: ViewItem[],
  state: SessionState,
): PiAgentMessage[] {
  const lens = history(copies);
  const view = expandSummaryBlocks(items, copies);
  const numbered = numberView(view, () => false);
  const lineByItem = new Map<ViewItem, number>();
  for (const { n, item } of numbered) {
    lineByItem.set(item, n);
  }

  const out: PiAgentMessage[] = [];
  for (const item of view) {
    if (item.type === "summary") {
      const id = blockIdOf(state, item.block.start, item.block.end);
      out.push(materializeSummary({ ...item.block, id }, lineByItem.get(item)));
      continue;
    }
    const line = lineByItem.get(item);
    if (line !== undefined) {
      injectLinePrefix(lens[item.ordinal], line);
    }
    out.push(copies[item.ordinal]);
  }
  return out;
}

/**
 * Render a folded view into a new pi message array.
 *
 * The input array is treated as already edited: a deep copy is made,
 * summary block intervals are expanded so tool-call / tool-result pairs
 * stay together, per-round line-number prefixes are injected into
 * injectable regions, and folded blocks materialize as synthetic user
 * messages.  The original input is never mutated.
 *
 * @param messages - The pi conversation after release-phase edits.
 * @param items - The folded view items, in view order.
 * @param state - The session state (block map, for summary ids).
 * @returns A new pi message array representing the rendered view.
 */
export function renderView(
  messages: PiAgentMessage[],
  items: ViewItem[],
  state: SessionState,
): PiAgentMessage[] {
  const copies = messages.map(
    (message) => structuredClone(message) as PiAgentMessage,
  );
  return buildRenderedView(copies, items, state);
}

/**
 * Render a pruning round into a new pi message array.
 *
 * Clones the conversation once, applies the region edits through the
 * lens, then renders the folded view on the same copies.  The original
 * input and every message object are never mutated.
 *
 * @param messages - The pi conversation from the `context` event.
 * @param items - The folded view items, in view order.
 * @param edits - Region text replacements.
 * @param state - The session state (block map, for summary ids).
 * @returns A new pi message array representing the rendered view.
 */
export function render(
  messages: PiAgentMessage[],
  items: ViewItem[],
  edits: RegionEdit[],
  state: SessionState,
): PiAgentMessage[] {
  const copies = messages.map(
    (message) => structuredClone(message) as PiAgentMessage,
  );
  const lens = history(copies);
  applyEditsToLens(lens, edits);
  return buildRenderedView(copies, items, state);
}
