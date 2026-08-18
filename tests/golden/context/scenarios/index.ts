/**
 * Golden scenario registry — the ordered list of all 19 scenarios.
 *
 * The order matches the checklist's golden-scenario table
 * (`.zoo/plans/semantic-equivalence-checklist-20260814.md`).
 *
 * @module
 */

import type { Scenario } from "../types.js";
import { G_COMP_01, G_COMP_02, G_COMP_03, G_COMP_04 } from "./compress.js";
import { G_DEC_01, G_DEC_02 } from "./decompress.js";
import { G_FOLD_01, G_FOLD_02, G_FOLD_03, G_FOLD_04 } from "./fold.js";
import { G_MS_01, G_MS_02, G_MS_03, G_MS_04 } from "./markSweep.js";
import { G_NUDGE_01, G_REF_01 } from "./nudgeRefs.js";
import { G_PERSIST_01, G_REPORT_01 } from "./persistReport.js";
import { G_TOOL_01 } from "./tools.js";

/** All golden scenarios, in checklist order. */
export const ALL_SCENARIOS: Scenario[] = [
  G_FOLD_01,
  G_FOLD_02,
  G_FOLD_03,
  G_FOLD_04,
  G_COMP_01,
  G_COMP_02,
  G_COMP_03,
  G_COMP_04,
  G_DEC_01,
  G_DEC_02,
  G_MS_01,
  G_MS_02,
  G_MS_03,
  G_MS_04,
  G_NUDGE_01,
  G_REF_01,
  G_PERSIST_01,
  G_REPORT_01,
  G_TOOL_01,
];

/**
 * Look up a scenario by id.
 *
 * @param id - Scenario id (e.g. `"G-FOLD-01"`).
 * @returns The scenario, or undefined.
 */
export function findScenario(id: string): Scenario | undefined {
  return ALL_SCENARIOS.find((s) => s.id === id);
}
