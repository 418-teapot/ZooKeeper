/**
 * Golden scenario runner — drives the new-core context-pruning
 * pipeline through a scenario's rounds and captures the observable
 * output.
 *
 * Each round:
 *
 * 1. Run the optional action (`compress-tool`, `dcp`, programmatic
 *    state seed, simulated restart) — actions translate the
 *    ergonomic id-keyed scenario inputs (callID-keyed marks,
 *    anchorMessageId-keyed block plans) to the new core's
 *    ordinal-keyed collections.
 * 2. Run the new-core `contextPruningTransformHandler` (the unified
 *    transform hook the production entry point installs), which
 *    reads from the shared session-state manager, runs the
 *    producers / release / fold / materialize phases, and writes
 *    placeholders into the v1 messages in place.
 * 3. Capture the final view + projected state + tool result/error +
 *    notification texts.
 *
 * The runner never asserts anything itself — it only captures.  The
 * baseline test compares captures against the persisted snapshots.
 *
 * @module
 */

import { history } from "../../../src/adapters/opencode/history.js";
import type { ContextMessageEntry } from "../../../src/adapters/opencode/types.js";
import { handleDcpCommand } from "../../../src/commands/dcp/command.js";
import type { SessionClient } from "../../../src/core/client/session.js";
import type { ContextPruningConfig } from "../../../src/core/config-types.js";
import { setModelLimit } from "../../../src/core/context/model-limits.js";
import {
  getContextStateManager,
  getRuntimeFlaggedState,
  setPendingViewChange,
} from "../../../src/core/context/runtime.js";
import { computeSpanHash } from "../../../src/core/context/spanhash.js";
import {
  type Block,
  type Mark,
  markKey,
  nextBlockId,
  type SessionState,
} from "../../../src/core/context/state.js";
import { contextPruningTransformHandler } from "../../../src/hooks/context-pruning/hook.js";
import { createCompressTool } from "../../../src/tools/compress.js";
import { createDecompressTool } from "../../../src/tools/decompress.js";
import { captureState, captureView } from "./capture.js";
import type {
  CompressionPlan,
  RoundAction,
  RoundCapture,
  Scenario,
  ScenarioCapture,
  ScenarioRound,
} from "./types.js";

/**
 * Build a minimal session client over a message view.
 *
 * `session.messages` returns the given view (the tool / command paths
 * fetch from "storage"); `session.prompt` appends the notification text
 * to the capture list.
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
 * The new core keys marks by `(anchorOrdinal, regionIndex)`; the
 * runner needs that key to seed callID-keyed `add-mark` actions into
 * the shared state.  The lens mapping in
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
 * Execute one round action and capture its tool result / error.
 *
 * @param action - The action to run.
 * @param sessionID - The scenario session id.
 * @param config - The merged (scenario + round) transform config.
 * @param messages - The round's message view.
 * @param notifications - Notification accumulator (mutated).
 * @returns `{ result, error }` — at most one is non-null.
 */
async function runAction(
  action: RoundAction | undefined,
  sessionID: string,
  config: ContextPruningConfig,
  messages: ContextMessageEntry[],
  notifications: string[],
): Promise<{ result: string | null; error: string | null }> {
  if (!action) return { result: null, error: null };

  // Force a fresh state snapshot through the shared manager — every
  // action here mutates the same in-memory state the transform round
  // will subsequently read.
  const state = getContextStateManager().get(sessionID);
  const client = makeClient(messages, notifications);

  try {
    switch (action.kind) {
      case "compress-tool": {
        const tool = createCompressTool(client, config);
        const result = await tool.execute(
          { ranges: action.ranges },
          { sessionID },
        );
        return { result, error: null };
      }
      case "decompress-tool": {
        const tool = createDecompressTool(client, config);
        const result = await tool.execute(
          { blockId: action.blockId },
          { sessionID },
        );
        return { result, error: null };
      }
      case "compress-tool-raw": {
        const tool = createCompressTool(client, config);
        const result = await tool.execute(
          action.args,
          action.toolCtx ?? { sessionID },
        );
        return { result, error: null };
      }
      case "decompress-tool-raw": {
        const tool = createDecompressTool(client, config);
        const result = await tool.execute(
          action.args,
          action.toolCtx ?? { sessionID },
        );
        return { result, error: null };
      }
      case "dcp": {
        await handleDcpCommand(client, sessionID, action.args, config, true);
        return { result: null, error: null };
      }
      case "add-mark": {
        // Translate the callID-keyed fixture action into the new
        // core's `(ordinal, regionIndex)` mark.  The mark is written
        // directly into the shared state's marks map so the next
        // `releaseMarks` phase picks it up.
        const target = resolveMarkTarget(messages, action.callID);
        if (target === null) return { result: null, error: null };
        const key = markKey(target.ordinal, target.regionIndex);
        if (state.marks.has(key)) return { result: null, error: null };
        const now = Date.now();
        const mark: Mark = {
          anchorOrdinal: target.ordinal,
          regionIndex: target.regionIndex,
          content: "",
          contentTokens: action.tokens,
          effective: action.effective,
          markedAt: now,
          ...(action.effective ? { effectiveAt: now, releasedAt: now } : {}),
        };
        state.marks.set(key, mark);
        return { result: null, error: null };
      }
      case "create-block": {
        landPlan(state, messages, action.plan);
        return { result: null, error: null };
      }
      case "deactivate-block": {
        const block = state.blocks.get(action.blockId);
        if (block) block.active = false;
        return { result: null, error: null };
      }
      case "restart": {
        // Simulate a process crash: drop the in-memory state for every
        // session (the entire manager's cache — a fresh process has no
        // memory at all).  Persisted files survive — process state is
        // recoverable — so the next `.get(sid)` reloads the saved state
        // back from disk.
        //
        // The previous implementation also called
        // `manager.store.delete(sessionID)`, which wiped the on-disk
        // file along with the cache and broke the round-trip
        // (G-PERSIST-01 captured an empty post-restart state because
        // the round-1 save had been deleted before round 3 could
        // reload it).
        const manager = getContextStateManager();
        manager._resetForTesting?.();
        // Re-prime the cache so the round sees the disk-restored
        // state rather than a fresh empty state.
        manager.get(sessionID);
        return { result: null, error: null };
      }
      case "set-model-limit": {
        setModelLimit(sessionID, action.context, "test-model");
        return { result: null, error: null };
      }
      case "arm-manual-trigger": {
        const flagged = getRuntimeFlaggedState(sessionID);
        flagged.pendingManualTrigger = true;
        return { result: null, error: null };
      }
      case "set-pending-view-change": {
        setPendingViewChange(sessionID);
        return { result: null, error: null };
      }
      default: {
        // Defensive — the action's kind is statically typed but a
        // runtime shape mismatch is still possible.
        return { result: null, error: "unknown action kind" };
      }
    }
  } catch (err) {
    return {
      result: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Run one round of a scenario.
 *
 * @param round - The round definition.
 * @param sessionID - The scenario session id.
 * @param config - The transform config.
 * @param defaultHasCompressTool - Scenario-level `hasCompressTool`.
 * @returns The captured round output.
 */
async function runRound(
  round: ScenarioRound,
  sessionID: string,
  config: ContextPruningConfig,
  defaultHasCompressTool: boolean,
): Promise<RoundCapture> {
  const notifications: string[] = [];
  // Per-round config override, shallow-merged over the scenario config.
  const merged: ContextPruningConfig = {
    ...config,
    ...(round.config ?? {}),
  };
  const { result, error } = await runAction(
    round.action,
    sessionID,
    merged,
    round.messages,
    notifications,
  );

  if (round.runTransform !== false) {
    const hasCompressTool = round.hasCompressTool ?? defaultHasCompressTool;
    contextPruningTransformHandler(
      round.messages,
      merged,
      (text) => notifications.push(text),
      hasCompressTool,
    );
  }

  const state = getContextStateManager().get(sessionID);
  return {
    label: round.label,
    view: captureView(round.messages),
    state: captureState(state),
    toolResult: result,
    toolError: error,
    notifications,
  };
}

/**
 * Run a full scenario and capture every round.
 *
 * @param scenario - The scenario definition.
 * @returns The captured scenario output.
 */
export async function runScenario(
  scenario: Scenario,
): Promise<ScenarioCapture> {
  const rounds: RoundCapture[] = [];
  for (const round of scenario.rounds) {
    rounds.push(
      await runRound(
        round,
        scenario.sessionID,
        scenario.config,
        scenario.hasCompressTool ?? false,
      ),
    );
  }
  return { scenario: scenario.id, rounds };
}
