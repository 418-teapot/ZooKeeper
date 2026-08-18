/**
 * Context Metrics barrel export.
 *
 * Thin re-export — all logic lives in `src/adapters/opencode/types.ts`.
 *
 * @module
 */

import {
  type ContextMessageEntry,
  type ContextMessageInfo,
  type ContextMetricsOutput,
  type ContextMetricsResult,
  type ContextTextPart,
  type ContextTokenInfo,
  estimateMessageHeuristic,
  measureContext,
} from "../../adapters/opencode/types.js";
import type { HookUnitDescriptor } from "../../core/slots.js";
import { log } from "../../utils/logger.js";

export type {
  ContextMessageEntry,
  ContextMessageInfo,
  ContextMetricsOutput,
  ContextMetricsResult,
  ContextTextPart,
  ContextTokenInfo,
};
export { estimateMessageHeuristic, measureContext };

/**
 * Track context metrics with error isolation.
 *
 * Sunk from the host entry point so the unit can self-describe.
 *
 * @param output - The messages transform output.
 */
export function handleMessagesTransform(output: ContextMetricsOutput): void {
  try {
    measureContext(output);
  } catch (err) {
    log(
      "plugin",
      "handler_crashed",
      output.messages?.[0]?.info?.sessionID ?? "",
      undefined,
      "error",
      { handler: "measureContext", error: String(err) },
    );
  }
}

/**
 * Context-metrics hook unit descriptor.
 *
 * Contributes the messages-transform measurement handler.
 */
export const unit: HookUnitDescriptor = {
  name: "context-metrics",
  kind: "hook",
  create() {
    return {
      kind: "hook",
      beforeExec: [],
      afterExec: [],
      transform: [
        {
          name: "contextMetrics",
          handle: handleMessagesTransform,
        },
      ],
      toolDefinition: [],
    };
  },
};
