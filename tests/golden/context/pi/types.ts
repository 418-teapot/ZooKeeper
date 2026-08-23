/**
 * Pi-lane type aliases — the shared generic types instantiated with the
 * pi `AgentMessage` shape as the default `M`.
 *
 * The pi scenario fixtures import `Scenario` / `ScenarioRound` from
 * `../types.js` (i.e. this module) without a type argument; the aliases
 * default the message shape to `PiAgentMessage` so the fixtures stay
 * typed against the pi wire shapes they build.
 *
 * @module
 */

import type { PiAgentMessage } from "../../../../src/adapters/pi/types.js";
import type {
  Scenario as SharedScenario,
  ScenarioRound as SharedScenarioRound,
} from "../types.js";

/** A scenario over the pi message shape. */
export type Scenario = SharedScenario<PiAgentMessage>;
/** A single round over the pi message shape. */
export type ScenarioRound = SharedScenarioRound<PiAgentMessage>;

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
