/**
 * Context Metrics barrel export.
 *
 * The unit's transform handler is now host-agnostic: it runs the active
 * host adapter's `history()` projection over the messages and measures the
 * resulting lens transcript with the core `measureMessages` estimator.
 * The legacy v1-only `measureContext` / `estimateMessageHeuristic` exports
 * remain for callers that still consume v1-shaped entries directly.
 *
 * Generalized path: adapter.history -> measureMessages -> log with the v1
 * payload shape (estimated_tokens, message_count, exact_tokens,
 * estimated_new_tokens, agent).  Agent is recovered by scanning the raw
 * messages for the last user message that carries `info.agent`; pi-shaped
 * messages have no such field, so the agent stays "unknown".
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
import type { HostAdapter } from "../../core/context/lens.js";
import { measureMessages } from "../../core/context/measure.js";
import type { HookUnitDescriptor, TransformOutput } from "../../core/slots.js";
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
 * Scan raw messages for the last user message carrying `info.agent`.
 *
 * v1-shaped entries store agent identity in `info.agent`; pi-shaped
 * messages carry no per-message agent field.  This keeps parity with the
 * legacy metrics log without coupling to either host.
 *
 * @param messages - The raw messages array.
 * @returns The discovered agent name or "unknown".
 */
function resolveAgent(messages: unknown[]): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg === null || typeof msg !== "object") continue;
    const record = msg as Record<string, unknown>;
    const info = record.info as
      | (Record<string, unknown> & { role?: unknown; agent?: unknown })
      | undefined;
    if (info && info.role === "user" && typeof info.agent === "string") {
      return info.agent;
    }
  }
  return "unknown";
}

/**
 * Build the host-agnostic metrics handler for a concrete host adapter.
 *
 * The adapter projects whatever message shape the host uses (v1 entries or
 * native pi messages) into lens messages; `measureMessages` computes the
 * exact + heuristic total.  The result is logged in the legacy payload
 * shape so downstream consumers stay unchanged.
 *
 * @param adapter - The host adapter for the active host.
 * @returns The messages-transform measurement handler.
 */
export function createMetricsHandler(
  adapter: HostAdapter<unknown>,
): (output: TransformOutput) => void {
  return (output: TransformOutput) => {
    try {
      const rawMessages = output.messages;
      const hasMessages =
        rawMessages !== null &&
        rawMessages !== undefined &&
        Array.isArray(rawMessages);
      const sessionID = hasMessages
        ? (adapter.sessionId(rawMessages) ?? "")
        : "";

      if (!hasMessages || rawMessages.length === 0) {
        log(
          "context-metrics",
          "context_measured",
          sessionID,
          undefined,
          "debug",
          {
            reason: hasMessages ? "no_messages" : "missing_messages",
            estimated_tokens: 0,
            message_count: hasMessages ? rawMessages.length : 0,
            exact_tokens: 0,
            estimated_new_tokens: 0,
            agent: resolveAgent(hasMessages ? (rawMessages as unknown[]) : []),
          },
        );
        return;
      }

      const view = adapter.history(rawMessages);
      const measured = measureMessages(view);
      const agent = resolveAgent(rawMessages as unknown[]);

      log("context-metrics", "context_measured", sessionID, undefined, "info", {
        estimated_tokens: measured.total,
        message_count: rawMessages.length,
        exact_tokens: measured.exact,
        estimated_new_tokens: measured.heuristic,
        agent,
      });
    } catch (err) {
      log("plugin", "handler_crashed", "", undefined, "error", {
        handler: "contextMetrics",
        error: String(err),
      });
    }
  };
}

/**
 * Track context metrics with error isolation.
 *
 * The transform output arrives as the core `TransformOutput` shape; the
 * `messages` entry type is this adapter's v1 shape, so it is narrowed
 * here before the measurement call.
 *
 * This standalone overload keeps old callers and tests working without
 * requiring a host adapter.
 *
 * @param output - The messages transform output.
 */
export function handleMessagesTransform(output: TransformOutput): void {
  try {
    const v1Output: ContextMetricsOutput = {
      messages: output.messages as ContextMessageEntry[] | null | undefined,
    };
    measureContext(v1Output);
  } catch (err) {
    const messages = output.messages as
      | ContextMessageEntry[]
      | null
      | undefined;
    log(
      "plugin",
      "handler_crashed",
      messages?.[0]?.info?.sessionID ?? "",
      undefined,
      "error",
      { handler: "measureContext", error: String(err) },
    );
  }
}

/**
 * Context-metrics hook unit descriptor.
 *
 * Contributes the messages-transform measurement handler when a host
 * adapter is wired; otherwise the unit contributes nothing (fail-closed).
 */
export const unit: HookUnitDescriptor = {
  name: "context-metrics",
  kind: "hook",
  create(deps) {
    const adapter = deps.adapter;
    if (!adapter) {
      return {
        kind: "hook",
        beforeExec: [],
        afterExec: [],
        transform: [],
        textComplete: [],
        toolDefinition: [],
      };
    }
    return {
      kind: "hook",
      beforeExec: [],
      afterExec: [],
      transform: [
        {
          name: "contextMetrics",
          handle: createMetricsHandler(adapter),
        },
      ],
      textComplete: [],
      toolDefinition: [],
    };
  },
};
