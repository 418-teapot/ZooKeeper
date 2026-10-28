/**
 * Observation probe of the end-to-end suite.
 *
 * Loaded in the same extension file as the real ZooKeeper extension (see
 * `entry.ts`), it records real host events, registers the deterministic
 * provider and exposes one reload command.  It only observes: no event is
 * mutated, no result is returned, no tool is registered.  The behavioural
 * additions are the `e2e` provider (no network) and `/e2e-reload`, which
 * calls pi's real `ctx.reload()` because RPC has no reload command.
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
import { hasPiSdkSession } from "../../../../../src/adapters/pi/sdk-lifecycle.js";
import { REQUIRED_TOOLS } from "../constants.js";
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
    rec("before_agent_start", {
      sessionID,
      messageType: event.messageType,
      prompt: excerpt(
        event.messageType === "user" ? event.prompt : undefined,
        160,
      ),
      child: subagentActive,
      // White-box, auxiliary evidence: read AFTER ZooKeeper's own handler ran
      // (it registers first and ensures the session scope), so the SDK bridge
      // association is visible here only when the child runtime shares the
      // module graph with the runtime the subagent driver stops.
      hasPiSdkSession: hasPiSdkSession(sessionID),
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
      // The driver stops the child's scope before the tool result exists, so
      // this reads the bridge AFTER the teardown it performs.
      fields.parentSessionID = parentSessionID ?? null;
      fields.childSessionID = childSessionID ?? null;
      fields.childHasPiSdkSession = hasPiSdkSession(childSessionID);
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
