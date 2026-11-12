/**
 * OpenCode profile-driven hooks.
 *
 * Translates profile contributions into OpenCode event keys.  Given the
 * host-agnostic `ComposedResult` produced by the assembly pipeline, the
 * per-plugin-instance capability values and the {@link Selection} the
 * pipeline resolved, it assembles the plugin-hook fragment the publisher
 * merges with the always-on infrastructure hooks:
 *
 *  - `config` — the host config write (see `config.ts`), which this
 *    fragment always carries.
 *  - `tool` — the enabled tool contributions keyed by tool name.
 *  - `tool.execute.before` — the composed delegation gate for subagent
 *    calls; a refusal propagates as an error (cancels tool execution).
 *  - `tool.execute.after` — per-handler error isolation.
 *  - `experimental.chat.messages.transform` — isolated handlers (a crash
 *    is logged and skipped).
 *  - `experimental.text.complete` — isolated handlers (text
 *    finalization, e.g. ref-echo stripping).
 *  - `tool.definition` — the raw OpenCode output is mapped onto the
 *    host-neutral tool-definition view, enhancers run in order (the
 *    subagent-prompt contributor), and the changed fields are written back.
 *  - `command.execute.before` — routes by `input.command`, then throws
 *    the unified `COMMAND_HANDLED` sentinel to short-circuit the flow.
 *
 * Event keys appear only when their contribution arrays are non-empty
 * (and `tool` only when at least one tool is enabled).
 *
 * Two host-boundary translations live here: `normalizeToolName` maps the
 * host's `task` tool onto the core's `subagent`, and the tool-definition
 * halves map the native definition onto the host-neutral view and back.
 *
 * @module
 */

import type { ComposedResult } from "../../core/compose.js";
import { runIsolated } from "../../core/compose.js";
import type { WorkPermit } from "../../core/lifecycle/index.js";
import type { Capabilities } from "../../core/ports/index.js";
import type { Selection } from "../../core/selection.js";
import {
  collectToolDefinitionChanges,
  createToolDefinitionView,
  runToolDefinitionContributions,
} from "../../core/tool-definition.js";
import type {
  AfterExecInput,
  AfterExecOutput,
  CommandInput,
  TextCompleteInput,
  TextCompleteOutput,
  ToolBeforeInput,
  ToolBeforeOutput,
  ToolDefinitionView,
  TransformOutput,
} from "../../core/unit.js";
import { log } from "../../utils/logger.js";
import { createConfigHook } from "./config.js";

// ---------------------------------------------------------------------------
// Unified slash-command sentinel
// ---------------------------------------------------------------------------

/**
 * Sentinel thrown after a registered slash command's handler resolves.
 *
 * The adapter throws it uniformly to short-circuit the `command()` flow
 * so a handled command is never processed as a user message.
 */
export const COMMAND_HANDLED = new Error(
  "command handled — no user message needed",
);

// ---------------------------------------------------------------------------
// Tool-name normalization
// ---------------------------------------------------------------------------

/**
 * Map an OpenCode tool name to the canonical name the core hooks gate on.
 *
 * The core and hook layers speak a host-neutral vocabulary where the
 * delegation tool is named `"subagent"`; OpenCode registers that tool as
 * `"task"`.  Normalizing at this event-key boundary keeps every hook
 * identical across hosts (pi already names the tool "subagent").  All
 * other names pass through unchanged.
 *
 * @param name - The raw OpenCode tool name from the event input.
 * @returns The canonical tool name.
 */
function normalizeToolName(name: string): string {
  return name === "task" ? "subagent" : name;
}

// ---------------------------------------------------------------------------
// Tool-definition translation (OpenCode ↔ host-neutral view)
// ---------------------------------------------------------------------------

/** Raw `tool.definition` hook input handed by OpenCode. */
interface OpenCodeToolDefinitionInput {
  toolID: string;
}

/** Raw `tool.definition` hook output handed by OpenCode (mutated in place). */
interface OpenCodeToolDefinitionOutput {
  description: string;
  parameters: Record<string, unknown>;
}

/**
 * Read the native per-argument schemas out of an OpenCode output.
 *
 * @param output - The raw OpenCode hook output.
 * @returns The `parameters.properties` map, or `undefined` when absent.
 */
function nativeProperties(
  output: OpenCodeToolDefinitionOutput,
): Record<string, unknown> | undefined {
  const parameters =
    output.parameters && typeof output.parameters === "object"
      ? (output.parameters as { properties?: unknown }).properties
      : undefined;
  return parameters && typeof parameters === "object"
    ? (parameters as Record<string, unknown>)
    : undefined;
}

/**
 * Write the neutral view's changes back into the raw OpenCode output.
 *
 * Only the fields the contributors actually changed are written; the
 * target stays the native `output` object because the host hook contract
 * requires an in-place mutation.
 *
 * @param view - The (possibly mutated) host-neutral view.
 * @param output - The raw OpenCode hook output.
 */
function applyToolDefinitionView(
  view: ToolDefinitionView,
  output: OpenCodeToolDefinitionOutput,
): void {
  const parameters = nativeProperties(output);
  const changes = collectToolDefinitionChanges(
    view,
    output.description,
    parameters,
  );
  if (changes.description !== undefined) {
    output.description = changes.description;
  }
  if (parameters === undefined) return;
  for (const [key, description] of Object.entries(changes.args)) {
    const property = parameters[key];
    if (property !== null && typeof property === "object") {
      (property as { description?: unknown }).description = description;
    }
  }
}

// ---------------------------------------------------------------------------
// Hook assembly
// ---------------------------------------------------------------------------

/**
 * Derive the conversation session id from a transform output.
 *
 * The OpenCode `experimental.chat.messages.transform` hook input carries
 * no session context; the host conversation's first entry does.  Core's
 * `TransformOutput.messages` is deliberately opaque, so the id is read
 * structurally with a `""` fallback for an empty or malformed list.
 *
 * @param output - The transform output being handled.
 * @returns The session id, or `""` when it cannot be derived.
 */
function transformSessionID(output: TransformOutput): string {
  const first = (
    output.messages as
      | Array<{ info?: { sessionID?: unknown } }>
      | null
      | undefined
  )?.[0];
  const id = first?.info?.sessionID;
  return typeof id === "string" ? id : "";
}

/**
 * Assemble the selection-driven OpenCode hooks fragment.
 *
 * The `config` hook always exists (see {@link createConfigHook}); every
 * other event key appears only when it has contributions.  Handler arrays
 * keep the registry's order.
 *
 * @param composed - The host-agnostic composition result.
 * @param deps - Per-plugin-instance dependencies.
 * @param selection - The selection the composition was built from.
 * @returns The hooks object fragment merged into the plugin.
 */
export function assembleProfileHooks(
  composed: ComposedResult,
  deps: Partial<Capabilities>,
  selection: Selection,
): Record<string, any> {
  return {
    config: createConfigHook(composed, deps, selection),

    ...(Object.keys(composed.tools).length > 0 ? { tool: composed.tools } : {}),

    // Present only when the context-pruning hook unit is enabled.
    ...(composed.transform.length > 0
      ? {
          async "experimental.chat.messages.transform"(
            _input: Record<string, never>,
            output: TransformOutput,
            permit?: WorkPermit,
          ) {
            await runIsolated(
              composed.transform,
              (handler) => handler.handle(output, undefined, permit),
              { sessionID: transformSessionID(output) },
            );
          },
        }
      : {}),

    // Present only when the reply-strip hook unit is enabled.
    ...(composed.textComplete.length > 0
      ? {
          async "experimental.text.complete"(
            input: TextCompleteInput,
            output: TextCompleteOutput,
          ) {
            await runIsolated(
              composed.textComplete,
              (handler) => handler.handle(input, output),
              { sessionID: input.sessionID, callId: input.partID },
            );
          },
        }
      : {}),

    // Present only when the subagent-prompt hook unit is enabled.
    ...(composed.toolDefinition.length > 0
      ? {
          async "tool.definition"(
            input: OpenCodeToolDefinitionInput,
            output: OpenCodeToolDefinitionOutput,
          ) {
            const view = createToolDefinitionView(
              normalizeToolName(input.toolID),
              output.description,
              nativeProperties(output),
            );
            await runToolDefinitionContributions(view, composed.toolDefinition);
            applyToolDefinitionView(view, output);
          },
        }
      : {}),

    // Present only when at least one delegation judge is enabled — the
    // composed gate judges every subagent call and a refusal propagates
    // as an error, cancelling tool execution.
    ...(composed.gate !== null
      ? {
          async "tool.execute.before"(
            input: ToolBeforeInput,
            output: ToolBeforeOutput,
          ) {
            const mapped: ToolBeforeInput = {
              ...input,
              tool: normalizeToolName(input.tool),
            };
            // Delegation gate — the strategy contributed by hook-unit
            // judges runs only for the subagent tool.  The caller is
            // resolved only when at least one judge needs it (an
            // asynchronous host query otherwise skipped); an unresolvable
            // caller stays `undefined`, which the judge refuses
            // (fail-closed).
            if (composed.gate !== null && mapped.tool === "subagent") {
              const caller =
                composed.gateNeedsCaller &&
                deps.resolveCallerAgent !== undefined
                  ? await deps.resolveCallerAgent(mapped.sessionID)
                  : undefined;
              const target =
                typeof output.args?.subagent_type === "string"
                  ? output.args.subagent_type
                  : undefined;
              const prompt =
                typeof output.args?.prompt === "string"
                  ? output.args.prompt
                  : undefined;
              const refusal = composed.gate({ caller, target, prompt });
              if (refusal !== null) {
                log.warn({
                  hook: "delegation",
                  event: "gate_blocked",
                  sessionId: mapped.sessionID,
                  callId: mapped.callID,
                  caller: caller ?? null,
                  target: target ?? null,
                  judge: refusal.judge,
                  reason: refusal.reason,
                  ...(refusal.cause !== undefined
                    ? { cause: refusal.cause }
                    : {}),
                });
                throw new Error(refusal.reason);
              }
            }
          },
        }
      : {}),

    ...(composed.afterExec.length > 0
      ? {
          async "tool.execute.after"(
            input: AfterExecInput,
            output: AfterExecOutput,
          ) {
            const mapped: AfterExecInput = {
              ...input,
              tool: normalizeToolName(input.tool),
            };
            // A throwing handler is logged (`handler_crashed`) and never
            // blocks the next handler.
            await runIsolated(
              composed.afterExec,
              (handler) => handler.handle(mapped, output),
              { sessionID: mapped.sessionID, callId: mapped.callID },
            );
          },
        }
      : {}),

    // Present only when at least one slash command is registered.
    ...(Object.keys(composed.commands).length > 0
      ? {
          async "command.execute.before"(
            input: CommandInput,
            permit?: WorkPermit,
          ) {
            const contribution = composed.commands[input.command];
            // Unregistered command — pass through untouched.
            if (!contribution) return;
            await contribution.handle(input, permit);
            throw COMMAND_HANDLED;
          },
        }
      : {}),
  };
}
