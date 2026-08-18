/**
 * Golden scenario framework — shared type definitions.
 *
 * A scenario is an ordered sequence of rounds.  Each round carries the
 * message view for that turn (the transform mutates it in place, so every
 * round receives a fresh array) plus an optional programmatic action that
 * runs BEFORE the transform (tool calls, /dcp commands, mark seeding,
 * state restart).  The runner captures the observable output of every
 * round: the final view structure, the projected session state, tool
 * results/errors, and notification texts.
 *
 * @module
 */

import type { ContextMessageEntry } from "../../../src/adapters/opencode/types.js";
import type { ContextPruningConfig } from "../../../src/core/config-types.js";
import type { CompressRangeInput } from "../../../src/core/context/compress.js";

/**
 * Plan describing a single compression block to land on the transcript.
 *
 * The runtime `Block` (in `src/core/context/state.ts`) is keyed by ordinal
 * intervals, but the golden fixtures are written in terms of message ids
 * (the ergonomics preserved from the pre-P2.4 golden fixture corpus).
 * The runner resolves message ids to ordinals at action time, so the
 * plan shape carries message ids verbatim and the runner bears the
 * translation.
 */
export interface CompressionPlan {
  /** Message id that would become the anchor for the synthetic summary. */
  anchorMessageId: string;
  /** Ordered list of message ids that the block covers. */
  messageIds: string[];
  /** Deterministic summary text rendered into the view. */
  summary: string;
  /** One-line topic label shown in the block header. */
  title: string;
  /** Estimated token count of the original (compressed) messages. */
  compressedTokens: number;
  /** Estimated token count of the summary text. */
  summaryTokens: number;
}

/**
 * Programmatic step executed before the round's transform.
 *
 * Each kind drives a public entry point of the context-pruning
 * pipeline: the compress/decompress tool factories, the /dcp command
 * handler, the marks/blocks state APIs, or a simulated process restart.
 */
export type RoundAction =
  | { kind: "compress-tool"; ranges: CompressRangeInput[] }
  | { kind: "decompress-tool"; blockId: string }
  | { kind: "dcp"; args: string }
  | {
      kind: "compress-tool-raw";
      args: unknown;
      toolCtx?: unknown;
    }
  | {
      kind: "decompress-tool-raw";
      args: unknown;
      toolCtx?: unknown;
    }
  | {
      kind: "add-mark";
      callID: string;
      tokens: number;
      effective: boolean;
      action: "tool-output" | "tool-error-input";
    }
  | { kind: "create-block"; plan: CompressionPlan }
  | { kind: "deactivate-block"; blockId: number }
  | { kind: "restart" }
  | { kind: "set-model-limit"; context: number }
  | { kind: "arm-manual-trigger" }
  | { kind: "set-pending-view-change" };

/**
 * A single turn of a scenario.
 *
 * `messages` is the turn's view as read back from "storage" (fresh
 * objects every round — the transform mutates in place).  Host-side
 * mutations like revert (truncation) and compaction are expressed by
 * constructing the view accordingly; the round label documents the
 * mutation for the snapshot reader.
 */
export interface ScenarioRound {
  /** Stable identifier recorded in the snapshot. */
  label: string;
  /** The turn's message view. */
  messages: ContextMessageEntry[];
  /** Optional programmatic step run before the transform. */
  action?: RoundAction;
  /** Whether the transform handler runs this round (default true). */
  runTransform?: boolean;
  /** `hasCompressTool` passed to the handler (defaults to scenario-level). */
  hasCompressTool?: boolean;
  /**
   * Per-round config override, shallow-merged over the scenario config.
   * Used when one scenario must exercise different protection windows,
   * thresholds, or absent sections across its rounds.
   */
  config?: Partial<ContextPruningConfig>;
}

/**
 * A golden scenario: a session identity, the transform config for every
 * round, and the ordered rounds.
 */
export interface Scenario {
  /** Scenario id (e.g. `"G-FOLD-01"`). */
  id: string;
  /** Session id used for state isolation (unique per scenario). */
  sessionID: string;
  /** Transform config shared by all rounds. */
  config: ContextPruningConfig;
  /** Default `hasCompressTool` for the transform (nudge/manual gates). */
  hasCompressTool?: boolean;
  /** The ordered rounds. */
  rounds: ScenarioRound[];
}

/**
 * Projection of one compression block — the stable semantic subset
 * captured in snapshots (no anchor/messageIds/timestamps).
 */
export interface BlockProjection {
  blockId: number;
  active: boolean;
  title: string | null;
  /** Number of messages covered by the block. */
  coveredMessages: number;
  compressedTokens: number;
  summaryTokens: number;
}

/**
 * Projected session state — the semantic subset captured per round.
 */
export interface StateCapture {
  blocks: BlockProjection[];
  marks: {
    pending: number;
    pendingTokens: number;
    effective: number;
    effectiveTokens: number;
  };
  pendingViewChange: boolean;
  /** Persisted nudge watermark, or null when never evaluated. */
  nudgeAnchor: number | null;
}

/**
 * One tool part as seen in the final view.
 *
 * Tool outputs/inputs are captured as short previews (prune/ref
 * observables) rather than the full bodies — long payloads would drown
 * the snapshot.
 */
export interface ViewToolPartCapture {
  tool?: string;
  /** Output preview: the full placeholder, or the first 80 chars. */
  output: string;
  /** Whether the output was replaced by a prune placeholder. */
  pruned: boolean;
  /** Input preview (stringified), or null when the input is absent. */
  input: string | null;
  /** Whether the input was replaced by an error/input prune placeholder. */
  inputPruned: boolean;
}

/**
 * One message as seen in the final view.
 *
 * Text parts are captured verbatim (the summary body and ref-tag
 * positions are observable behaviour); refs are normalised at compare
 * time, not here.
 */
export interface ViewMessageCapture {
  role: string;
  /** Synthetic compression-block summary message. */
  synthetic?: boolean;
  /** Host-ignored message (injected reports etc.). */
  ignored?: boolean;
  /** Compaction boundary message (`info.summary === true`). */
  boundary?: boolean;
  /** Text parts joined with "\n" (raw). */
  text?: string;
  /** Tool parts in order. */
  toolParts: ViewToolPartCapture[];
}

/**
 * Captured observable output of one round.
 */
export interface RoundCapture {
  label: string;
  view: ViewMessageCapture[];
  state: StateCapture;
  /** Tool execute / command result text, or null when no action ran. */
  toolResult: string | null;
  /** Thrown error message, or null when the action did not fail. */
  toolError: string | null;
  /** All notification texts sent to the session chat, in order. */
  notifications: string[];
}

/**
 * Captured observable output of a whole scenario.
 */
export interface ScenarioCapture {
  scenario: string;
  rounds: RoundCapture[];
}
