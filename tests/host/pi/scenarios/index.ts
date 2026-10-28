/**
 * Core scenario registry, ordered by risk: the load/tool loop first, then
 * session isolation, reload idempotency, fork inheritance, the SDK
 * sub-session and finally ordered shutdown.
 *
 * Any scenario can be selected on its own by id (`--scenario <id>`), which
 * is what makes a failure cheap to rerun.
 */

import type { ScenarioDefinition } from "../harness/scenario-runtime.js";
import { compressionTools } from "./compression-tools.js";
import { contextPipeline } from "./context-pipeline.js";
import { forkInheritance } from "./fork-inheritance.js";
import { reloadIdempotency } from "./reload-idempotency.js";
import { sessionIsolation } from "./session-isolation.js";
import { shutdown } from "./shutdown.js";
import { startupTodo } from "./startup-todo.js";
import { subagentSdk } from "./subagent-sdk.js";

/** Every core scenario, in run order. */
export const SCENARIOS: ScenarioDefinition[] = [
  startupTodo,
  sessionIsolation,
  reloadIdempotency,
  forkInheritance,
  subagentSdk,
  shutdown,
  contextPipeline,
  compressionTools,
];
