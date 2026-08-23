/**
 * Golden scenario registry (pi lane) — the ordered list of scenarios.
 *
 * Carries the 17 ported scenarios (semantic translation of the opencode
 * lane's v1 scenarios into pi-native message shapes and pi numbering;
 * G-MS-03 and G-REPORT-01 are not ported because they drive the /dcp
 * command, which does not exist on pi), plus the smoke scenario and the
 * two pi-specific scenarios (PI-PAIR-01 pair folding, PI-SUMMARY-01
 * summary materialization).  Order mirrors the opencode lane's
 * checklist order.
 *
 * @module
 */

import type { Scenario } from "../types.js";
import { G_COMP_01, G_COMP_02, G_COMP_03, G_COMP_04 } from "./compress.js";
import { G_DEC_01, G_DEC_02 } from "./decompress.js";
import { G_FOLD_01, G_FOLD_02, G_FOLD_03, G_FOLD_04 } from "./fold.js";
import { G_MS_01, G_MS_02, G_MS_04 } from "./markSweep.js";
import { G_NUDGE_01, G_REF_01 } from "./nudgeRefs.js";
import { PI_PAIR_01 } from "./pair.js";
import { G_PERSIST_01 } from "./persistReport.js";
import { PI_SMOKE_01 } from "./smoke.js";
import { PI_SUMMARY_01 } from "./summary.js";
import { G_TOOL_01 } from "./tools.js";

/** All pi-lane golden scenarios, in checklist order. */
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
  G_MS_04,
  G_NUDGE_01,
  G_REF_01,
  G_PERSIST_01,
  G_TOOL_01,
  PI_SMOKE_01,
  PI_PAIR_01,
  PI_SUMMARY_01,
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
