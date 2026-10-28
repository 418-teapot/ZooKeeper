/**
 * Scenario runner — drives the context-pruning pipeline through a
 * scenario's rounds and captures the observable output.
 *
 * The runner is host-neutral: the message shape is the generic `M`, and
 * every host-dependent operation goes through the `PipelineHost` seam
 * (transform invocation, tool execution, /dcp handling, mark-target
 * resolution, plan landing, final view projection).  Actions that only
 * touch core state (`restart`, marks/blocks mutation, model limits,
 * manual-trigger flags) are dispatched here.
 *
 * A round clones its message view (fixtures are module-level singletons
 * and the transform rewrites its input in place), runs the optional
 * action — translating the id-keyed fixture inputs (call ids,
 * anchor message ids) to the core's ordinal-keyed collections — then
 * runs `contextPruningTransformHandler` over the shared session state,
 * and finally captures the view plus the tool result/error and the
 * notification texts.
 *
 * The capture is the externally observable projection of a round only:
 * internal state never enters it.  Behaviour that state would expose is
 * proven through the view, a later round's tool result, the release
 * notification, or the persistence round-trip (see
 * `semantic-contracts.ts` for the named assertions).  The runner never
 * asserts anything itself — the shared helper compares captures against
 * the persisted snapshots.
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
import type {
  PipelineHost,
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
  host: PipelineHost<M>,
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
        await host.handleDcp(
          sessionID,
          action.args,
          config,
          messages,
          notifications,
        );
        return { result: null, error: null };
      }
      case "add-mark": {
        // Translate the callID-keyed fixture action into the core's
        // `(ordinal, regionIndex)` key through the host's lens mapping.
        // The mark is written into the shared state so the same round's
        // release phase sees it.
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
      case "stale-block": {
        // Simulate a block that lost its content guarantee (hash
        // expiry, revert cut): the record stays in the map with the
        // stale status.
        const block = state.blocks.get(action.blockId);
        if (block) block.status = "stale";
        return { result: null, error: null };
      }
      case "restart": {
        // Simulate a process crash: drop the in-memory cache of every
        // session.  Persisted files must survive — the reload below is
        // the round-trip under test.
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
  host: PipelineHost<M>,
): Promise<RoundCapture> {
  const notifications: string[] = [];
  // Per-round config override, shallow-merged over the scenario config.
  const merged: ContextPruningConfig = {
    ...config,
    ...(round.config ?? {}),
  };
  // Drive a pristine copy: the fixture arrays are shared module-level
  // values and the transform rewrites its input in place.
  const messages = structuredClone(round.messages);
  const { result, error } = await runAction(
    round.action,
    sessionID,
    merged,
    messages,
    notifications,
    host,
  );

  if (round.runTransform !== false) {
    const hasCompressTool = round.hasCompressTool ?? defaultHasCompressTool;
    // `await` — the pi lane's production entry (`buildPiContextHandler`)
    // is asynchronous; the opencode lane returns void, which awaits
    // trivially.
    await host.runTransform(messages, merged, hasCompressTool, (text) =>
      notifications.push(text),
    );
  }

  return {
    label: round.label,
    view: host.captureView(messages),
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
  host: PipelineHost<M>,
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
 * The snapshot directory is passed in (resolved relative to the lane's
 * own test file), so moving a lane as a unit preserves resolution.
 *
 * @param scenario - The scenario to run and assert.
 * @param host - The host seam.
 * @param snapshotDir - Absolute path to the lane's snapshot directory.
 * @param update - Regenerate the snapshot from current behaviour.
 */
export async function assertScenarioMatchesSnapshot<M>(
  scenario: Scenario<M>,
  host: PipelineHost<M>,
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
