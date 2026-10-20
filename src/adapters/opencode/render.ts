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
 * Both steps are also exported separately so a caller can apply the
 * release-phase edits early and materialize later; the pipeline does
 * exactly that, and splitting the steps changes nothing observable.
 *
 * @module
 */

import type { RegionEdit, RenderEntry } from "../../core/context/lens.js";
import { applyLineInjections } from "../../core/context/render-plan.js";
import { applyRegionEdits } from "../../core/context/writable-regions.js";
import { history } from "./history.js";
import type { ContextMessageEntry } from "./types.js";

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
