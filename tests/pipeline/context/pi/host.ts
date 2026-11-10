/**
 * Pipeline host, pi lane — the host seam the scenario runner drives.
 *
 * Encapsulates every host-dependent operation the host-neutral runner
 * drives: the transform invocation through the production pi `context`
 * entry (`buildPiContextHandler` + the composed pruning contribution),
 * tool execution through the real pi tool host, the /dcp command (absent
 * on pi — the seam throws), call-id → mark-target resolution under the
 * pi lens mapping, plan landing with span hashing over the pi transcript,
 * and the pi view projection.
 *
 * Session binding: pi `AgentMessage`s carry no session id and the pi
 * adapter names none, so every seam takes the scenario's session id
 * explicitly — `runTransform` and `runTool` receive it from the runner,
 * and the session contexts bind it per call.
 *
 * Purity: the pi adapter is strictly pure — the transform returns a
 * fresh replacement array and never mutates the input message objects.
 * The runner contract mutates the round's view in place, so the host
 * splices the replacement back into the input array after the handler
 * resolves; the original message objects stay untouched.
 *
 * Notifications: pi's production release notification goes through the
 * unified pi tool host's `notify` port, which posts a `zoo-notice`
 * custom entry via `appendEntry` (persistent, never part of the LLM
 * context).  The tool host also serves the tool units' runtime prompts,
 * so the runner's notification accumulator captures both the release
 * notices and the tool notifications for the pi lane — the same
 * behaviour the opencode lane exhibits.
 *
 * @module
 */

import { createPiAdapter } from "../../../../src/adapters/pi/adapter.js";
import { buildPiContextHandler } from "../../../../src/adapters/pi/handlers.js";
import { history } from "../../../../src/adapters/pi/history.js";
import type { PiSessionContexts } from "../../../../src/adapters/pi/session-contexts.js";
import { createPiSessionContexts } from "../../../../src/adapters/pi/session-contexts.js";
import { createPiToolHost } from "../../../../src/adapters/pi/tool-host.js";
import type { PiAgentMessage } from "../../../../src/adapters/pi/types.js";
import type {
  ContextPruningConfig,
  ModeProfile,
} from "../../../../src/core/config-types.js";
import { computeSpanHash } from "../../../../src/core/context/spanhash.js";
import {
  allocateBlockId,
  type Block,
  type SessionState,
} from "../../../../src/core/context/state.js";
import type { Capabilities } from "../../../../src/core/ports/index.js";
import type { ToolHost } from "../../../../src/core/ports/tool-host.js";
import type { TransformContribution } from "../../../../src/core/unit.js";
import { REGISTRY } from "../../../../src/registry.js";
import { composeForTest } from "../../../../src/testkits/compose.js";
import {
  callFor,
  permitFor,
} from "../../../../src/testkits/context-runtime.js";
import { createCompressTool } from "../../../../src/tools/compress.js";
import { createDecompressTool } from "../../../../src/tools/decompress.js";
import type { PipelineSandbox } from "../sandbox.js";
import type {
  CompressionPlan,
  PipelineHost,
  ToolRoundAction,
} from "../types.js";
import { captureView } from "./capture.js";

/**
 * Compose the real pruning transform contribution for one round.
 *
 * Runs the selection engine over the full registry with a minimal
 * profile that enables exactly the `context-pruning` hook (plus the
 * `compress` tool when the round advertises it, so the nudge /
 * manual-compress gates see the selected `compress` in their `uses`
 * projection — the same derivation production pi uses).  The per-round
 * config is captured by the contribution closure, so config overrides
 * land on the right round.  The round's pi tool host is placed into
 * `deps.toolHost` so the release notification posts through the same
 * `zoo-notice` appendEntry port production pi uses.
 *
 * @param config - The merged (scenario + round) transform config.
 * @param hasCompressTool - Whether the compress tool is available.
 * @param toolHost - The round's pi tool host (release notification port).
 * @returns The composed transform contributions.
 */
function composePruningTransform(
  sandbox: PipelineSandbox,
  config: ContextPruningConfig,
  hasCompressTool: boolean,
  toolHost: ToolHost,
): TransformContribution[] {
  const profile: ModeProfile = {
    name: "pipeline-pi",
    agents: [],
    skills: [],
    hooks: ["context-pruning"],
    tools: hasCompressTool ? ["compress"] : [],
    commands: [],
  };
  const deps: Partial<Capabilities> = {
    limits: {},
    contextConfig: config,
    directory: process.cwd(),
    resolveAgent: () => undefined,
    adapter: createPiAdapter(),
    contextRuntime: sandbox.runtime,
    toolHost,
  };
  const composed = composeForTest(profile, REGISTRY, deps);
  return composed.transform;
}

/**
 * Run the pruning transform through the production pi `context` entry.
 *
 * Builds the handler from the composed transform, drives it with a
 * stubbed pi context (session id from the host's bound session; the
 * model context window re-exposed from the core model-limit registry so
 * the runner's `set-model-limit` action resolves percentage thresholds
 * through `capturePiModelLimit`), then writes the pruned replacement
 * back into the input array.  The pi adapter is pure, so the handler
 * returns a fresh array; the splice keeps the runner's in-place-view
 * contract while the original message objects stay untouched.
 *
 * The round's tool host is wired into the transform deps with an
 * `appendEntry` binding that forwards every `zoo-notice` entry's
 * `data.content` into the runner's notification accumulator — the
 * release notice is captured exactly like the pi tool units' runtime
 * prompts, symmetric with the opencode lane.
 *
 * @param sessionID - The scenario session id.
 * @param messages - The round's view (spliced with the replacement).
 * @param config - The merged (scenario + round) transform config.
 * @param hasCompressTool - Whether the compress tool is available.
 * @param notify - Notification-text accumulator callback (fed by the
 *   transform's release notification through the tool host).
 */
async function runTransformFor(
  sandbox: PipelineSandbox,
  sessionID: string,
  messages: PiAgentMessage[],
  config: ContextPruningConfig,
  hasCompressTool: boolean,
  notify: (text: string) => void,
): Promise<void> {
  const contexts = makePiSession(sessionID, messages);
  const host = createPiToolHost(contexts, makeAppendEntry(notify));
  const handler = buildPiContextHandler(
    composePruningTransform(sandbox, config, hasCompressTool, host),
    sandbox.runtime,
  );
  const permit = permitFor(sessionID);
  const modelLimit = sandbox.runtime.modelLimit(sessionID);
  const result = await handler(
    { type: "context", messages },
    {
      sessionManager: { getSessionId: () => sessionID },
      ...(modelLimit !== undefined
        ? {
            model: {
              id: modelLimit.modelId,
              contextWindow: modelLimit.context,
            },
          }
        : {}),
    },
    permit.sessionID,
    permit,
  );
  const pruned = result?.messages;
  if (pruned !== undefined && pruned !== messages) {
    messages.splice(0, messages.length, ...(pruned as PiAgentMessage[]));
  }
}

/**
 * Build the session contexts of a stubbed pi session for the tool host.
 *
 * The scenario's session is bound under its own id, because every reader of
 * a context names its session.  `buildContextEntries` serves the round's
 * message array (the tool path fetches from "storage"); notifications flow
 * through the production `appendEntry` channel — the tool host posts
 * `zoo-notice` entries whose `data.content` text is captured into the list
 * (the same channel the TUI renders).
 *
 * @param sessionID - The scenario session id.
 * @param messages - The view the session serves.
 * @returns The contexts the pi tool host reads.
 */
function makePiSession(
  sessionID: string,
  messages: PiAgentMessage[],
): PiSessionContexts {
  const contexts = createPiSessionContexts();
  contexts.bind(sessionID, {
    sessionManager: {
      getSessionId: () => sessionID,
      buildContextEntries: () =>
        messages.map((message) => ({ type: "message", message })),
    },
  });
  return contexts;
}

/**
 * The pi `appendEntry` binding of this host.
 *
 * Forwards the `data.content` text of every appended `zoo-notice` entry
 * into a text sink, mirroring the production entry point's bound
 * `piApi.appendEntry` whose entries the TUI renders.
 *
 * @param sink - Receives the `content` text of each appended entry.
 * @returns A `PiAppendEntry`-shaped function.
 */
function makeAppendEntry(
  sink: (text: string) => void,
): (customType: string, data?: unknown) => void {
  return (_customType, data) => {
    const content = (data as { content?: unknown } | undefined)?.content;
    if (typeof content === "string") sink(content);
  };
}

/**
 * Execute one tool action through the real pi tool host.
 *
 * The tool host is constructed over a stubbed pi session whose
 * `buildContextEntries` serves the round's messages; tool execution
 * resolves the session id from the tool context's `sessionManager` — the
 * same surface pi passes at runtime.
 *
 * @param action - The tool action to run.
 * @param sessionID - The scenario session id.
 * @param config - The merged (scenario + round) transform config.
 * @param messages - The round's message view.
 * @param notifications - Notification accumulator (mutated).
 * @returns `{ result, error }` — at most one is non-null.
 */
async function runTool(
  sandbox: PipelineSandbox,
  action: ToolRoundAction,
  sessionID: string,
  config: ContextPruningConfig,
  messages: PiAgentMessage[],
  notifications: string[],
): Promise<{ result: string | null; error: string | null }> {
  const contexts = makePiSession(sessionID, messages);
  const host = createPiToolHost(
    contexts,
    makeAppendEntry((text) => notifications.push(text)),
  );
  const call = callFor(sessionID, { permit: permitFor(sessionID) });
  switch (action.kind) {
    case "compress-tool": {
      const tool = createCompressTool(host, config, sandbox.runtime);
      const { text } = await tool.execute({ ranges: action.ranges }, call);
      return { result: text, error: null };
    }
    case "decompress-tool": {
      const tool = createDecompressTool(host, config, sandbox.runtime);
      const { text } = await tool.execute({ blockId: action.blockId }, call);
      return { result: text, error: null };
    }
    case "compress-tool-raw": {
      const tool = createCompressTool(host, config, sandbox.runtime);
      const { text } = await tool.execute(action.args, call);
      return { result: text, error: null };
    }
    case "decompress-tool-raw": {
      const tool = createDecompressTool(host, config, sandbox.runtime);
      const { text } = await tool.execute(action.args, call);
      return { result: text, error: null };
    }
  }
}

/**
 * The /dcp command seam — this host does not wire it.
 *
 * Pi itself registers /dcp (pi `registration` `registerCommand`), but the
 * harness has no command surface.  Throws so the runner captures
 * a clear `toolError` naming the gap instead of silently no-op'ing.
 */
async function handleDcp(): Promise<void> {
  throw new Error("dcp is not wired in the pi pipeline host");
}

/**
 * Resolve the (ordinal, regionIndex) of a tool-call id under the pi lens
 * mapping.
 *
 * The core keys marks by `(anchorOrdinal, regionIndex)`; the runner
 * needs that key to seed callID-keyed `add-mark` actions.  The pi lens
 * (`adapters/pi/history.ts`) maps each content block to exactly one
 * region: a tool-result message contributes a single `tool-output`
 * region at index 0, an assistant `toolCall` block contributes a
 * `tool-input` region at the block's content index.  Text blocks are
 * `content` regions and thinking blocks are non-addressable
 * `thinking` regions.
 *
 * The linked tool-result is preferred (the add-mark action's `tool-output`
 * semantics); the bare tool-call block is the fallback (its `tool-input`
 * region).  Reasoning blocks are never returned.
 *
 * @param messages - The round's message view.
 * @param callID - The tool call identifier.
 * @returns The `(ordinal, regionIndex)` pair with the region's current
 *   text, or null when the lens has no such region.
 */
function resolveMarkTarget(
  messages: PiAgentMessage[],
  callID: string,
): { ordinal: number; regionIndex: number; text: string } | null {
  const target = locateTarget(messages, callID);
  if (target === null) return null;
  const text =
    history(messages).messages[target.ordinal]?.regions[
      target.regionIndex
    ]?.get();
  if (text === undefined) return null;
  return { ...target, text };
}

/**
 * Locate the `(ordinal, regionIndex)` pair a tool call id addresses.
 *
 * @param messages - The round's message view.
 * @param callID - The tool call identifier.
 * @returns The `(ordinal, regionIndex)` pair, or null when no part
 *   carries the call id.
 */
function locateTarget(
  messages: PiAgentMessage[],
  callID: string,
): { ordinal: number; regionIndex: number } | null {
  for (let ordinal = 0; ordinal < messages.length; ordinal++) {
    const message = messages[ordinal];
    if (message.role === "toolResult" && message.toolCallId === callID) {
      return { ordinal, regionIndex: 0 };
    }
  }
  for (let ordinal = 0; ordinal < messages.length; ordinal++) {
    const message = messages[ordinal];
    if (message.role !== "assistant") continue;
    for (
      let regionIndex = 0;
      regionIndex < message.content.length;
      regionIndex++
    ) {
      const block = message.content[regionIndex];
      if (block.type === "toolCall" && block.id === callID) {
        return { ordinal, regionIndex };
      }
    }
  }
  return null;
}

/**
 * Resolve a synthetic fixture message id to its ordinal within a view.
 *
 * pi messages carry no native ids; the fixtures attach a synthetic `id`
 * field (see `messages.ts`), matched here.  First occurrence wins.
 *
 * @param messages - The pi conversation.
 * @param messageId - The id to look up.
 * @returns The ordinal index, or -1 when no match is found.
 */
function ordinalOfMessageId(
  messages: PiAgentMessage[],
  messageId: string,
): number {
  for (let i = 0; i < messages.length; i++) {
    const record = messages[i] as unknown as Record<string, unknown>;
    if (record.id === messageId) return i;
  }
  return -1;
}

/**
 * Land a `CompressionPlan` (id-keyed) on the core state as an
 * ordinal-keyed block.
 *
 * An id-keyed plan lands as an ordinal interval; the `spanHash` is
 * computed over the live pi transcript through the pi adapter's
 * `history()`.  A plan whose first id is absent
 * from the view, or whose interval cannot be hashed, is a silent no-op.
 *
 * @param state - The session state (mutated).
 * @param messages - The current transcript (for `computeSpanHash`).
 * @param plan - The id-shaped plan.
 */
function landPlan(
  state: SessionState,
  messages: PiAgentMessage[],
  plan: CompressionPlan,
): void {
  const startOrdinal = ordinalOfMessageId(messages, plan.messageIds[0] ?? "");
  if (startOrdinal < 0) return;
  let endOrdinal = startOrdinal;
  for (let i = 1; i < plan.messageIds.length; i++) {
    const ord = ordinalOfMessageId(messages, plan.messageIds[i] ?? "");
    if (ord > endOrdinal) endOrdinal = ord;
  }
  const end = endOrdinal + 1;
  let spanHash: string;
  try {
    spanHash = computeSpanHash(history(messages), startOrdinal, end);
  } catch {
    return;
  }
  const id = allocateBlockId(state);
  const block: Block = {
    start: startOrdinal,
    end,
    title: plan.title,
    summary: plan.summary,
    spanHash,
    status: "active",
    compressedTokens: plan.compressedTokens,
    summaryTokens: plan.summaryTokens,
    createdAt: Date.now(),
  };
  state.blocks.set(id, block);
}

/**
 * Build the pi lane's host seam.
 *
 * The returned object is stateless — every seam receives the session id
 * from the runner — so one instance serves all scenarios.
 *
 * @param sandbox - The pipeline sandbox (runtime and its store).
 * @returns The pi host implementation.
 */
export function createPiPipelineHost(
  sandbox: PipelineSandbox,
): PipelineHost<PiAgentMessage> {
  return {
    get runtime() {
      return sandbox.runtime;
    },
    restart: () => sandbox.restart(),
    runTransform: (sessionID, messages, config, hasCompressTool, notify) =>
      runTransformFor(
        sandbox,
        sessionID,
        messages,
        config,
        hasCompressTool,
        notify,
      ),
    runTool: (action, toolSessionID, config, messages, notifications) =>
      runTool(sandbox, action, toolSessionID, config, messages, notifications),
    handleDcp,
    resolveMarkTarget,
    landPlan,
    captureView,
  };
}
