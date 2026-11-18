/**
 * Observation probe of the end-to-end suite.
 *
 * Loaded as its own extension file (see `probe-entry.ts`) beside the real
 * ZooKeeper entry, it records real host events, registers the deterministic
 * provider and exposes one reload command.  It never mutates an event or
 * returns a result.  The additions that are not observation are the `e2e`
 * provider (no network), `/e2e-reload` (pi's real `ctx.reload()`, because RPC
 * has no reload command) and the `e2e-hang` tool: a test-only tool that holds
 * a run open until its abort signal arrives, so the suite can observe the
 * timeout's cooperative cancellation.  The tool resolves itself after
 * `HANG_ESCAPE_MS` and records that escape, so a broken cancellation fails
 * the scenario instead of hanging the suite.
 *
 * A sub-session runtime loads this file too, so the probe also reports the
 * tool face the child ends up with.
 */

import { randomUUID } from "node:crypto";
import type {
  AgentEndEvent,
  AgentSettledEvent,
  AgentStartEvent,
  BeforeAgentStartEvent,
  ExtensionAPI,
  ExtensionCommandContext,
  SessionShutdownEvent,
  SessionStartEvent,
  ToolCallEvent,
  ToolResultEvent,
} from "@earendil-works/pi-coding-agent";
import { HANG_ESCAPE_MS, REQUIRED_TOOLS } from "../constants.js";
import {
  MODEL_ID,
  PROVIDER_API,
  PROVIDER_ID,
  PROVIDER_MODELS,
  streamSimple,
} from "./deterministic.js";
import { excerpt, loadId, record, sessionIdOf } from "./trace.js";

/** Parent session of a delegation in flight. */
let parentSessionID: string | undefined;

/** Child session observed during the delegation in flight. */
let childSessionID: string | undefined;

/** Whether the parent's `subagent` tool call is running. */
let subagentActive = false;

/**
 * Track the sessions a delegation touches.
 *
 * @param sessionID - Session id of the current event.
 */
function observeSession(sessionID: string | undefined): void {
  if (sessionID === undefined || !subagentActive) return;
  if (parentSessionID !== undefined && sessionID === parentSessionID) return;
  if (childSessionID === undefined) childSessionID = sessionID;
}

/**
 * Register the probe on a pi extension API.
 *
 * @param pi - pi ExtensionAPI instance of the current runtime.
 */
export function probe(pi: ExtensionAPI): void {
  // One id per extension factory execution: pi caches the extension module
  // per (cwd, generation), so a parent and its SDK child can share this
  // module while still being distinguishable runtime instances.
  const runtime = randomUUID();
  const rec = (event: string, data: Record<string, unknown> = {}): void =>
    record(event, { runtime, ...data });
  rec("factory", {
    node: process.version,
    cwd: process.cwd(),
    loadId: loadId(),
  });

  pi.registerProvider(PROVIDER_ID, {
    name: "E2E Deterministic",
    baseUrl: "http://127.0.0.1:9/e2e",
    api: PROVIDER_API,
    apiKey: "e2e-dummy",
    models: PROVIDER_MODELS,
    streamSimple: (model, context, options) =>
      streamSimple(model, context, options, rec),
  });
  rec("provider_registered", {
    provider: PROVIDER_ID,
    api: PROVIDER_API,
    model: MODEL_ID,
  });

  pi.registerCommand("e2e-reload", {
    description: "E2E probe: perform a real pi runtime reload",
    handler: async (_args: string, ctx: ExtensionCommandContext) => {
      rec("reload_requested", { sessionID: sessionIdOf(ctx) });
      await ctx.reload();
    },
  });

  pi.registerTool({
    name: "e2e-hang",
    label: "e2e-hang",
    description: "E2E probe: hold the run open until it is aborted",
    parameters: { type: "object", properties: {} },
    execute: async (toolCallId, _params, signal, _onUpdate, ctx) => {
      const sessionID = sessionIdOf(ctx);
      rec("e2e_hang_started", { sessionID, toolCallId, child: subagentActive });
      await new Promise<void>((resolve) => {
        // One settle path for the abort signal and the escape deadline, so
        // the timer and the listener are always released together.
        const settle = (): void => {
          clearTimeout(escapeTimer);
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = (): void => {
          rec("e2e_hang_aborted", {
            sessionID,
            toolCallId,
            child: subagentActive,
          });
          settle();
        };
        const escapeTimer = setTimeout(() => {
          rec("e2e_hang_escape", {
            sessionID,
            toolCallId,
            child: subagentActive,
          });
          settle();
        }, HANG_ESCAPE_MS);
        signal?.addEventListener("abort", onAbort, { once: true });
        if (signal?.aborted === true) onAbort();
      });
      return {
        content: [{ type: "text" as const, text: "E2E-HANG: settled" }],
        details: {},
      };
    },
  });
  rec("hang_tool_registered", { escapeMs: HANG_ESCAPE_MS });

  pi.on("session_start", (event: SessionStartEvent, ctx) => {
    const sessionID = sessionIdOf(ctx);
    const tools = pi
      .getAllTools()
      .map((tool) => tool.name)
      .sort();
    const duplicates = tools.filter(
      (name, index) => tools.indexOf(name) !== index,
    );
    observeSession(sessionID);
    rec("session_start", {
      sessionID,
      reason: event.reason,
      // The replaced session pi recorded on the new session's header: the
      // evidence a scheduled session replacement is claimed by.
      parentSession: ctx.sessionManager?.getHeader?.()?.parentSession ?? null,
      toolCount: tools.length,
      trackedTools: tools.filter((name) =>
        (REQUIRED_TOOLS as readonly string[]).includes(name),
      ),
      duplicateTools: duplicates,
      child: subagentActive,
    });
  });

  pi.on("session_shutdown", (event: SessionShutdownEvent, ctx) => {
    rec("session_shutdown", {
      sessionID: sessionIdOf(ctx) ?? childSessionID ?? null,
      reason: event.reason,
      child: subagentActive,
    });
  });

  pi.on("before_agent_start", (event: BeforeAgentStartEvent, ctx) => {
    const sessionID = sessionIdOf(ctx);
    observeSession(sessionID);
    // The tool face of this runtime: a sub-session loads ZooKeeper from the
    // inline factory, so its own tools must be visible here.
    const toolNames = pi
      .getAllTools()
      .map((tool) => tool.name)
      .sort();
    // The set the model is offered, after ZooKeeper's own handler applied
    // this session's visibility rules (handlers run in registration order).
    const activeToolNames = pi.getActiveTools().slice().sort();
    rec("before_agent_start", {
      sessionID,
      messageType: event.messageType,
      prompt: excerpt(
        event.messageType === "user" ? event.prompt : undefined,
        160,
      ),
      // ZooKeeper registers before the probe, so this reads the system
      // prompt AFTER its prompt injection: the record shows which agent
      // the session resolved.
      systemPrompt: excerpt(event.systemPrompt, 240),
      child: subagentActive,
      toolNames,
      activeToolNames,
    });
  });

  pi.on("tool_call", (event: ToolCallEvent, ctx) => {
    const input = event.input as Record<string, unknown>;
    rec("tool_call", {
      sessionID: sessionIdOf(ctx),
      tool: event.toolName,
      toolCallId: event.toolCallId,
      op: typeof input.op === "string" ? input.op : null,
      agent: typeof input.agent === "string" ? input.agent : null,
      child: subagentActive,
    });
    if (event.toolName === "subagent" && !subagentActive) {
      subagentActive = true;
      parentSessionID = sessionIdOf(ctx);
      childSessionID = undefined;
    }
  });

  pi.on("tool_result", (event: ToolResultEvent, ctx) => {
    const text = event.content
      .map((part) => (part.type === "text" ? part.text : ""))
      .join("");
    const input = event.input as Record<string, unknown>;
    const fields: Record<string, unknown> = {
      sessionID: sessionIdOf(ctx),
      tool: event.toolName,
      toolCallId: event.toolCallId,
      isError: event.isError,
      op: typeof input.op === "string" ? input.op : null,
      text: excerpt(text, 600),
      child: subagentActive,
    };
    if (event.toolName === "subagent") {
      fields.parentSessionID = parentSessionID ?? null;
      fields.childSessionID = childSessionID ?? null;
      subagentActive = false;
    }
    rec("tool_result", fields);
  });

  pi.on("agent_start", (_event: AgentStartEvent, ctx) => {
    const sessionID = sessionIdOf(ctx);
    observeSession(sessionID);
    rec("agent_start", { sessionID, child: subagentActive });
  });

  pi.on("agent_end", (_event: AgentEndEvent, ctx) => {
    const sessionID = sessionIdOf(ctx);
    observeSession(sessionID);
    rec("agent_end", { sessionID, child: subagentActive });
  });

  pi.on("agent_settled", (event: AgentSettledEvent, ctx) => {
    const sessionID = sessionIdOf(ctx);
    observeSession(sessionID);
    rec("agent_settled", {
      sessionID,
      aborted: event.aborted === true,
      child: subagentActive,
    });
  });

  rec("probe_registered", { requiredTools: [...REQUIRED_TOOLS] });
}
