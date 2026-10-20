/**
 * Pi host adapter — apply region edits and materialize the core render
 * plan into a new pi message array.
 *
 * Both entry points are fully pure: the input conversation is
 * deep-copied once, the caller's write lands in the copies, and the
 * original array and its message objects are never mutated.
 *
 * Materialization contributes host message construction and delivery
 * only.  The plan (`core/context/render-plan.ts`) decides which
 * messages survive, which one carries each unit's `[mN] ` line ref and
 * what a folded block's summary text is; this module applies the line
 * refs through the pi lens and turns each entry into a pi message.
 *
 * @module
 */

import type { RegionEdit, RenderEntry } from "../../core/context/lens.js";
import { applyLineInjections } from "../../core/context/render-plan.js";
import { applyRegionEdits } from "../../core/context/writable-regions.js";
import { history } from "./history.js";
import type { PiAgentMessage, PiUserMessage } from "./types.js";

/**
 * Deep-copy a pi conversation.
 *
 * @param messages - The conversation to copy.
 * @returns Fresh message objects, in the same order.
 */
function copyMessages(messages: PiAgentMessage[]): PiAgentMessage[] {
  return messages.map((message) => structuredClone(message) as PiAgentMessage);
}

/**
 * Apply region edits to a pi conversation, returning a new array.
 *
 * The input array and its message objects are never modified: a deep
 * copy is made, edits are written through the lens into the copy, and
 * the copy is returned.
 *
 * @param messages - The pi conversation before edits.
 * @param edits - Region text replacements.
 * @returns A new pi message array with edits applied.
 */
export function applyEdits(
  messages: PiAgentMessage[],
  edits: RegionEdit[],
): PiAgentMessage[] {
  const copies = copyMessages(messages);
  applyRegionEdits(history(copies).messages, edits);
  return copies;
}

/**
 * Materialize a render plan into a new pi message array.
 *
 * The copies' lens receives the plan's line refs (the plan already
 * chose the target message of each visible unit), then each entry emits
 * its pi message: a source entry keeps the addressed copy, a summary
 * entry becomes a synthetic user message carrying the planned text.
 *
 * @param messages - The pi conversation after the release-phase edits.
 * @param plan - The render plan, in view order.
 * @returns A new pi message array representing the rendered view.
 */
export function materialize(
  messages: PiAgentMessage[],
  plan: RenderEntry[],
): PiAgentMessage[] {
  const copies = copyMessages(messages);
  applyLineInjections(history(copies).messages, plan);

  const out: PiAgentMessage[] = [];
  for (const entry of plan) {
    if (entry.kind === "summary") {
      const summary: PiUserMessage = { role: "user", content: entry.text };
      out.push(summary);
      continue;
    }
    out.push(copies[entry.ordinal]);
  }
  return out;
}
