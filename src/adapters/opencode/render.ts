/**
 * V1 render entry points — region edits and render-plan
 * materialization.
 *
 * The render algorithm itself is host-agnostic and lives in the core
 * (`core/context/render-plan.ts`): the plan says which messages
 * survive, which one carries each visible unit's `[mN] ` line ref,
 * which raw text a hidden unit keeps, and what each folded block's
 * summary text is.  This module contributes only the v1 delivery:
 *
 * - `applyEdits` writes the round's region edits into the addressed v1
 *   parts (so the release placeholders are observable through the lens
 *   before the producers and the eligibility scan run);
 * - `materialize` applies the plan's line refs through the v1 lens,
 *   rebuilds the array in plan order — a summary entry becomes a
 *   synthetic user entry, a source entry keeps its v1 message — and
 *   swaps it into the input array in place.
 *
 * Both steps write into the array they receive; the adapter
 * (`adapter.ts`) hands them a private copy so the caller's conversation
 * is never rewritten.  They are also exported separately so a caller can
 * apply the release-phase edits early and materialize later; the pipeline
 * does exactly that, and splitting the steps changes nothing observable.
 *
 * @module
 */

import type { RegionEdit, RenderEntry } from "../../core/context/lens.js";
import { applyLineInjections } from "../../core/context/render-plan.js";
import { applyRegionEdits } from "../../core/context/writable-regions.js";
import { history } from "./history.js";
import type { ContextMessageEntry, ContextTextPart } from "./types.js";

/**
 * Copy a v1 messages array into a private, writable copy.
 *
 * Every message, its `info` record, its parts array, and each part are
 * copied one level deep, and a tool part's `state` object is copied so a
 * write-back closure can assign into it.  Nested payload values stay shared:
 * the render layer only ever replaces `part.text`, `state.input`, and
 * `state.output`.
 *
 * @param entries - The v1 messages array to copy.
 * @returns A copy the render layer may rewrite.
 */
export function copyEntries(
  entries: ContextMessageEntry[],
): ContextMessageEntry[] {
  return entries.map((entry) => {
    // Null entries survive as they are: the lens maps them to hidden empty
    // messages, so there is nothing to copy and nothing to write back.
    if (entry === null || entry === undefined) return entry;
    const parts = entry.parts?.map(copyPart);
    return {
      ...entry,
      info: { ...entry.info },
      ...(parts === undefined ? {} : { parts }),
    };
  });
}

/**
 * Copy one v1 part, including the tool state a write-back assigns into.
 *
 * @param part - The part to copy.
 * @returns The copy.
 */
function copyPart(part: ContextTextPart): ContextTextPart {
  // A null part carries no text and no state: the lens skips it.
  if (part === null || part === undefined) return part;
  const state = (part as { state?: Record<string, unknown> }).state;
  return state === undefined
    ? { ...part }
    : ({ ...part, state: { ...state } } as ContextTextPart);
}

/**
 * Apply region edits to the v1 messages array in place.
 *
 * Edits are written through a fresh lens binding of `entries`, so each
 * edit text lands in the addressed v1 part (tool state, text, or tool
 * input) without the caller keeping a lens around.  An edit whose
 * anchor cannot be resolved — out-of-range message ordinal,
 * out-of-range region index, or a missing region index — is skipped
 * defensively.
 *
 * @param entries - The v1 messages array (mutated in place).
 * @param edits - Region text replacements.
 */
export function applyEdits(
  entries: ContextMessageEntry[],
  edits: RegionEdit[],
): void {
  applyRegionEdits(history(entries).messages, edits);
}

/**
 * Build the v1 synthetic summary entry for a planned summary.
 *
 * The id is the block-derived placeholder `zoo-fold-bN`: it carries no
 * addressing semantics (the label owns block identity for the model),
 * but the numeric suffix is the stable block id host-side tooling reads
 * to tell synthetic messages apart.  A block whose id is not in the
 * session map falls back to `b0`.
 *
 * @param text - The planned summary text.
 * @param id - The block id behind the planned label, when known.
 * @returns The synthetic v1 message.
 */
function summaryEntry(text: string, id?: number): ContextMessageEntry {
  return {
    info: { role: "user", id: `zoo-fold-b${id ?? 0}`, synthetic: true },
    parts: [{ type: "text", text }],
  };
}

/**
 * Materialize a render plan into the v1 messages array in place.
 *
 * The plan's line refs are written through the v1 lens first, then the
 * array is rebuilt in plan order: an original entry keeps its v1
 * message object (content differences already landed via the lens —
 * this phase only restructures), and a summary entry inserts the
 * synthetic message carrying the planned summary text.
 *
 * The input `entries` array is replaced in place (whole-array swap), so
 * callers holding the array reference observe the folded view.
 *
 * @param entries - The v1 messages array (mutated in place).
 * @param plan - The render plan, in view order.
 * @returns The mutated `entries` array.
 */
export function materialize(
  entries: ContextMessageEntry[],
  plan: RenderEntry[],
): ContextMessageEntry[] {
  applyLineInjections(history(entries).messages, plan);

  const out: ContextMessageEntry[] = [];
  for (const entry of plan) {
    out.push(
      entry.kind === "summary"
        ? summaryEntry(entry.text, entry.id)
        : entries[entry.ordinal],
    );
  }
  entries.length = 0;
  entries.push(...out);
  return entries;
}
