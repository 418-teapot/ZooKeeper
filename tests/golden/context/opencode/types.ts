/**
 * Opencode-lane type aliases — the shared generic types instantiated
 * with the v1 message shape as the default `M`.
 *
 * The moved scenario fixtures import `Scenario` from `../types.js`
 * (i.e. this module) without a type argument; the alias defaults the
 * message shape to `ContextMessageEntry` so the fixtures stay typed
 * against the wire shape they build.
 *
 * @module
 */

import type { ContextMessageEntry } from "../../../../src/adapters/opencode/types.js";
import type {
  Scenario as SharedScenario,
  ScenarioRound as SharedScenarioRound,
} from "../types.js";

/** A scenario over the v1 message shape. */
export type Scenario = SharedScenario<ContextMessageEntry>;
/** A single round over the v1 message shape. */
export type ScenarioRound = SharedScenarioRound<ContextMessageEntry>;

export type {
  BlockProjection,
  CompressionPlan,
  GoldenHost,
  RoundAction,
  RoundCapture,
  ScenarioCapture,
  StateCapture,
  ToolRoundAction,
  ViewMessageCapture,
  ViewToolPartCapture,
} from "../types.js";
