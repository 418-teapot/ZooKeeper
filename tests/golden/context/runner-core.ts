/**
 * Golden scenario runner — drives the context-pruning pipeline through a
 * scenario's rounds and captures the observable output.
 *
 * This module is host-neutral: the message shape is the generic `M`, and
 * every host-dependent operation goes through the `GoldenHost` seam
 * (transform invocation, tool execution, /dcp handling, mark-target
 * resolution, plan landing, final view projection).  State-affecting
 * actions that only touch core state (`restart`, marks/blocks mutation,
 * model limits, manual-trigger flags) are dispatched here.
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
 *    placeholders into the messages in place.
 * 3. Capture the final view + projected state + tool result/error +
 *    notification texts.
 *
 * The runner never asserts anything itself — it only captures.  The
 * shared assertion helper (used by each lane's test entry) compares
 * captures against the persisted snapshots.
 *
 * @module
 */

import { expect } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ContextPruningConfig } from "../../../src/core/config-types.js";
import { setModelLimit } from "../../../src/core/context/model-limits.js";
import {
  getContextStateManager,
  getRuntimeFlaggedState,
  setPendingViewChange,
} from "../../../src/core/context/runtime.js";
import { type Mark, markKey } from "../../../src/core/context/state.js";
import { compareSnapshots } from "../framework/compare.js";
import { captureState } from "./capture-core.js";
import type {
  GoldenHost,
  RoundAction,
  RoundCapture,
  Scenario,
  ScenarioCapture,
  ScenarioRound,
} from "./types.js";

/**
 * Execute one round action and capture its tool result / error.
 *
 * Tool and /dcp actions are delegated to the host; state-only actions
 * run here against the core state.
 *
 * @param action - The action to run.
 * @param sessionID - The scenario session id.
 * @param config - The merged (scenario + round) transform config.
 * @param messages - The round's message view.
 * @param notifications - Notification accumulator (mutated).
 * @param host - The host seam.
 * @returns `{ result, error }` — at most one is non-null.
 */
async function runAction<M>(
  action: RoundAction | undefined,
  sessionID: string,
  config: ContextPruningConfig,
  messages: M[],
  notifications: string[],
  host: GoldenHost<M>,
): Promise<{ result: string | null; error: string | null }> {
  if (!action) return { result: null, error: null };

  // Force a fresh state snapshot through the shared manager — every
  // action here mutates the same in-memory state the transform round
  // will subsequently read.
  const state = getContextStateManager().get(sessionID);

  try {
    switch (action.kind) {
      case "compress-tool":
      case "decompress-tool":
      case "compress-tool-raw":
      case "decompress-tool-raw":
        // `await` (not bare `return`) keeps the promise rejection inside
        // this try block — a bare return would adopt the rejection
        // outside it and escape the error capture below.
        return await host.runTool(
          action,
          sessionID,
          config,
          messages,
          notifications,
        );
      case "dcp": {
        await host.handleDcp(sessionID, action.args, config, messages, notifications);
        return { result: null, error: null };
      }
      case "add-mark": {
        // Translate the callID-keyed fixture action into the new
        // core's `(ordinal, regionIndex)` mark via the host's lens
        // mapping.  The mark is written directly into the shared
        // state's marks map so the next `releaseMarks` phase picks it
        // up.
        const target = host.resolveMarkTarget(messages, action.callID);
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
        host.landPlan(state, messages, action.plan);
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
 * @param host - The host seam.
 * @returns The captured round output.
 */
async function runRound<M>(
  round: ScenarioRound<M>,
  sessionID: string,
  config: ContextPruningConfig,
  defaultHasCompressTool: boolean,
  host: GoldenHost<M>,
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
    host,
  );

  if (round.runTransform !== false) {
    const hasCompressTool = round.hasCompressTool ?? defaultHasCompressTool;
    // `await` — the pi lane's production entry (`buildPiContextHandler`)
    // is asynchronous; the opencode lane returns void, which awaits
    // trivially.
    await host.runTransform(round.messages, merged, hasCompressTool, (text) =>
      notifications.push(text),
    );
  }

  const state = getContextStateManager().get(sessionID);
  return {
    label: round.label,
    view: host.captureView(round.messages),
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
 * @param host - The host seam.
 * @returns The captured scenario output.
 */
export async function runScenario<M>(
  scenario: Scenario<M>,
  host: GoldenHost<M>,
): Promise<ScenarioCapture> {
  const rounds: RoundCapture[] = [];
  for (const round of scenario.rounds) {
    rounds.push(
      await runRound(
        round,
        scenario.sessionID,
        scenario.config,
        scenario.hasCompressTool ?? false,
        host,
      ),
    );
  }
  return { scenario: scenario.id, rounds };
}

/**
 * Assert one scenario's capture against its persisted snapshot,
 * regenerating the snapshot file when update mode is on.
 *
 * Shared by every lane's test entry; the snapshot directory is
 * resolved relative to the lane's own test file so moving the lane
 * (scenarios + snapshots + test entry) preserves resolution.
 *
 * @param scenario - The scenario to run and assert.
 * @param host - The host seam.
 * @param snapshotDir - Absolute path to the lane's snapshot directory.
 * @param update - Regenerate the snapshot from current behaviour.
 */
export async function assertScenarioMatchesSnapshot<M>(
  scenario: Scenario<M>,
  host: GoldenHost<M>,
  snapshotDir: string,
  update: boolean,
): Promise<void> {
  const capture = await runScenario(scenario, host);

  if (update) {
    mkdirSync(snapshotDir, { recursive: true });
    writeFileSync(
      join(snapshotDir, `${capture.scenario}.json`),
      `${JSON.stringify(capture, null, 2)}\n`,
      "utf8",
    );
    return;
  }

  const path = join(snapshotDir, `${capture.scenario}.json`);
  expect(existsSync(path), `missing snapshot ${path}`).toBe(true);
  const expected = JSON.parse(readFileSync(path, "utf8")) as ScenarioCapture;
  const diffs = compareSnapshots(capture, expected);
  expect(
    diffs,
    `scenario ${scenario.id} diverged from baseline:\n${diffs.join("\n")}`,
  ).toEqual([]);
}
