/**
 * GoldenHost v1 implementation — the opencode lane's host seam.
 *
 * Encapsulates every host-dependent operation the host-neutral runner
 * drives: the transform invocation through the v1 adapter, tool
 * execution through the v1 tool host, /dcp command handling, call-id →
 * mark-target resolution under the v1 lens mapping, plan landing with
 * span hashing over the v1 transcript, and the v1 view projection.
 *
 * @module
 */

import { createV1Adapter } from "../../../../src/adapters/opencode/adapter.js";
import { history } from "../../../../src/adapters/opencode/history.js";
import { createV1ToolHost } from "../../../../src/adapters/opencode/tool-host.js";
import type { ContextMessageEntry } from "../../../../src/adapters/opencode/types.js";
import { handleDcpCommand } from "../../../../src/commands/dcp/command.js";
import type { SessionClient } from "../../../../src/core/client/session.js";
import type { ContextPruningConfig } from "../../../../src/core/config-types.js";
import { computeSpanHash } from "../../../../src/core/context/spanhash.js";
import {
  type Block,
  nextBlockId,
  type SessionState,
} from "../../../../src/core/context/state.js";
import { contextPruningTransformHandler } from "../../../../src/hooks/context-pruning/hook.js";
import { createCompressTool } from "../../../../src/tools/compress.js";
import { createDecompressTool } from "../../../../src/tools/decompress.js";
import type { CompressionPlan, GoldenHost, ToolRoundAction } from "../types.js";
import { captureView } from "./capture.js";

/**
 * Build a minimal session client over a message view.
 *
 * `session.messages` returns the given view (the tool / command paths
 * fetch from "storage"); `session.get` resolves a fixed agent so the
 * v1 tool host's notify path (agent resolution) reaches `session.prompt`,
 * which appends the notification text to the capture list.
 *
 * @param messages - The view the client serves.
 * @param notifications - Notification-text accumulator (mutated).
 * @returns A session client.
 */
function makeClient(
  messages: ContextMessageEntry[],
  notifications: string[],
): SessionClient {
  return {
    session: {
      messages: async () => ({ data: messages }),
      get: async (_input: { path: { id: string } }) => ({
        agent: "dolphin",
      }),
      prompt: async (input: {
        path: { id: string };
        body: {
          parts?: Array<{ type: string; text?: string }>;
        };
      }) => {
        const text = input.body.parts?.[0]?.text ?? "";
        notifications.push(text);
      },
    },
  } as unknown as SessionClient;
}

/**
 * Resolve a message id to its ordinal position within a session view.
 *
 * @param messages - The session messages (an id may appear zero, one,
 *   or many times; the first occurrence wins).
 * @param messageId - The id to look up.
 * @returns The ordinal index, or -1 when no match is found.
 */
function ordinalOfMessageId(
  messages: ContextMessageEntry[],
  messageId: string,
): number {
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].info.id === messageId) return i;
  }
  return -1;
}

/**
 * Resolve the (ordinal, regionIndex) of a tool part by its call id.
 *
 * The new core keys marks by `(anchorOrdinal, regionIndex)`; the runner
 * needs that key to seed callID-keyed `add-mark` actions into the
 * shared state.  The lens mapping in
 * `adapters/opencode/history.ts` iterates each tool part's regions
 * in order — a tool part with `state` contributes a `tool-input`
 * region (increment) then a `tool-output` region (increment, the
 * prune-anchor one).  The tool-output region's index is therefore
 * the part's tool-output region index in the lens transcript.
 *
 * @param messages - The session messages to scan.
 * @param callID - The tool call identifier (`part.callID`).
 * @returns The (ordinal, regionIndex) pair, or null when no part
 *   carries the call id.
 */
function resolveMarkTarget(
  messages: ContextMessageEntry[],
  callID: string,
): { ordinal: number; regionIndex: number } | null {
  for (let ordinal = 0; ordinal < messages.length; ordinal++) {
    const parts = messages[ordinal].parts ?? [];
    let regionIndex = 0;
    for (const part of parts) {
      const p = part as unknown as Record<string, unknown>;
      if (p.type === "tool" && p.state) {
        const isMatch =
          (p.callID as string | undefined) === callID ||
          (p.callId as string | undefined) === callID;
        if (isMatch) {
          // tool-input is regionIndex, tool-output is regionIndex + 1.
          return { ordinal, regionIndex: regionIndex + 1 };
        }
        regionIndex += 2;
      } else if (typeof p.text === "string") {
        regionIndex += 1;
      }
    }
  }
  return null;
}

/**
 * Land a `CompressionPlan` (id-keyed) on the new-core state as an
 * ordinal-keyed block.
 *
 * The runner uses the first id in `messageIds` as `start` and one past
 * the last as `end` — the snapshots treat consecutive message ids as
 * consecutive ordinals, so this preserves the historical contract
 * preserved in the fixtures.  The plan's `compressedTokens` and
 * `summaryTokens` are stored verbatim so the captured state matches
 * the persisted projection; the `spanHash` is computed over the live
 * transcript so the fold layer can validate it.
 *
 * @param state - The session state (mutated).
 * @param messages - The current transcript (for `computeSpanHash`).
 * @param plan - The id-shaped plan.
 */
function landPlan(
  state: SessionState,
  messages: ContextMessageEntry[],
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
  // Compute the span hash over the host-agnostic transcript produced by
  // the v1 adapter.  Throws when the interval is empty / out of bounds;
  // we silently bail in that case (a plan that cannot land on the
  // current view is a no-op for the captured snapshot).
  let spanHash: string;
  try {
    spanHash = computeSpanHash(history(messages), startOrdinal, end);
  } catch {
    return;
  }
  const id = nextBlockId(state.blocks);
  const block: Block = {
    start: startOrdinal,
    end,
    title: plan.title,
    summary: plan.summary,
    spanHash,
    active: true,
    compressedTokens: plan.compressedTokens,
    summaryTokens: plan.summaryTokens,
    createdAt: Date.now(),
  };
  state.blocks.set(id, block);
}

/**
 * Execute one tool action through the v1 tool host.
 *
 * @param action - The tool action to run.
 * @param sessionID - The scenario session id.
 * @param config - The merged (scenario + round) transform config.
 * @param messages - The round's message view.
 * @param notifications - Notification accumulator (mutated).
 * @returns `{ result, error }` — at most one is non-null.
 */
async function runTool(
  action: ToolRoundAction,
  sessionID: string,
  config: ContextPruningConfig,
  messages: ContextMessageEntry[],
  notifications: string[],
): Promise<{ result: string | null; error: string | null }> {
  const client = makeClient(messages, notifications);
  switch (action.kind) {
    case "compress-tool": {
      const tool = createCompressTool(
        createV1ToolHost(client, () => undefined),
        config,
      );
      const result = await tool.execute(
        { ranges: action.ranges },
        { sessionID },
      );
      return { result, error: null };
    }
    case "decompress-tool": {
      const tool = createDecompressTool(
        createV1ToolHost(client, () => undefined),
        config,
      );
      const result = await tool.execute(
        { blockId: action.blockId },
        { sessionID },
      );
      return { result, error: null };
    }
    case "compress-tool-raw": {
      const tool = createCompressTool(
        createV1ToolHost(client, () => undefined),
        config,
      );
      const result = await tool.execute(
        action.args,
        action.toolCtx ?? { sessionID },
      );
      return { result, error: null };
    }
    case "decompress-tool-raw": {
      const tool = createDecompressTool(
        createV1ToolHost(client, () => undefined),
        config,
      );
      const result = await tool.execute(
        action.args,
        action.toolCtx ?? { sessionID },
      );
      return { result, error: null };
    }
  }
}

/**
 * Build the opencode lane's host seam.
 *
 * The returned object is stateless — every call constructs the clients
 * and adapters it needs — so one instance serves all scenarios.
 *
 * @returns The v1 host implementation.
 */
export function createV1GoldenHost(): GoldenHost<ContextMessageEntry> {
  return {
    runTransform(messages, config, hasCompressTool, notify) {
      contextPruningTransformHandler(
        createV1Adapter(),
        messages,
        config,
        notify,
        hasCompressTool,
      );
    },
    runTool,
    async handleDcp(sessionID, args, config, messages, notifications) {
      const client = makeClient(messages, notifications);
      await handleDcpCommand(
        createV1ToolHost(client, () => undefined),
        sessionID,
        args,
        config,
        true,
      );
    },
    resolveMarkTarget,
    landPlan,
    captureView,
  };
}
