/**
 * Golden scenario — the pi lane smoke test (PI-SMOKE-01).
 *
 * Proves the pi lane runs end-to-end through the shared runner with the
 * pi message shapes: a seeded pending mark is released next turn
 * (placeholder written into the linked tool-result region, per-round
 * refs injected), and the `set-model-limit` action flows through the
 * same core runtime API into the pi `context` handler's model so the
 * nudge phase resolves percentage thresholds (baseline silent, then the
 * gentle reminder fires and appends the synthetic user message).
 *
 * The 17 ported scenarios (Lane C) extend this harness.
 *
 * @module
 */

import {
  assistantMsg,
  textPart,
  toolCallPart,
  toolResultMsg,
  userMsg,
} from "../messages.js";
import type { Scenario } from "../types.js";

const SID = "golden-pi-smoke-01";

/** View WITHOUT assistant usage — promptTokens = 0, so the release gate stays closed. */
function noUsageView() {
  return [
    userMsg("hello", { id: "u0", timestamp: 1 }),
    assistantMsg([toolCallPart("c1", "bash", { cmd: "ls" })], {
      id: "a1",
      timestamp: 2,
    }),
    toolResultMsg("c1", "bash", [textPart("total 12")], {
      id: "tr1",
      timestamp: 3,
    }),
    assistantMsg([textPart("done")], { id: "a2", timestamp: 4 }),
  ];
}

/** View WITH assistant usage — promptTokens > 0, so the release gate opens. */
function usageView(inputTokens: number) {
  return [
    userMsg("hello", { id: "u0", timestamp: 1 }),
    assistantMsg([toolCallPart("c1", "bash", { cmd: "ls" })], {
      id: "a1",
      timestamp: 2,
      usage: { input: inputTokens, output: 200 },
    }),
    toolResultMsg("c1", "bash", [textPart("total 12")], {
      id: "tr1",
      timestamp: 3,
    }),
    assistantMsg([textPart("done")], { id: "a2", timestamp: 4 }),
  ];
}

/**
 * View for the nudge rounds.
 *
 * Carries a second user message so the nudge eligibility window
 * `[firstUser + 1, lastUser)` is non-empty (the tool-call / tool-result
 * pair is compressible).
 */
function nudgeView(inputTokens: number) {
  return [
    userMsg("hello", { id: "u0", timestamp: 1 }),
    assistantMsg([toolCallPart("c1", "bash", { cmd: "ls" })], {
      id: "a1",
      timestamp: 2,
      usage: { input: inputTokens, output: 100 },
    }),
    toolResultMsg("c1", "bash", [textPart("total 12")], {
      id: "tr1",
      timestamp: 3,
    }),
    userMsg("again", { id: "u3", timestamp: 4 }),
    assistantMsg([textPart("done")], { id: "a2", timestamp: 5 }),
  ];
}

/** Base config: release gate at 0 %, no producers, no model limit. */
const BASE_CONFIG = {
  protectedMessages: 0,
  releasedPercent: 0,
  dedup: {},
  purgeErrors: {},
};

/** Config carrying the nudge section (used by the model-limit rounds). */
const NUDGE_CONFIG = {
  protectedMessages: 0,
  nudge: {
    minContext: "60%",
    minContextCap: 200000,
    maxContext: "80%",
    maxContextCap: 300000,
    growthTokens: "5%",
  },
  compress: { protectedTokens: 0, thresholdTokens: 0 },
  dedup: {},
  purgeErrors: {},
};

/**
 * PI-SMOKE-01 — the pi lane smoke scenario.
 */
export const PI_SMOKE_01: Scenario = {
  id: "PI-SMOKE-01",
  sessionID: SID,
  config: BASE_CONFIG,
  rounds: [
    {
      label: "seed-pending-mark",
      messages: noUsageView(),
      action: {
        kind: "add-mark",
        callID: "c1",
        tokens: 200,
        effective: false,
        action: "tool-output",
      },
    },
    {
      label: "release-prune",
      messages: usageView(5000),
    },
    {
      label: "nudge-baseline-silent",
      messages: nudgeView(140000),
      action: { kind: "set-model-limit", context: 200000 },
      config: NUDGE_CONFIG,
      hasCompressTool: true,
    },
    {
      label: "nudge-gentle-fires",
      messages: nudgeView(150000),
      config: NUDGE_CONFIG,
      hasCompressTool: true,
    },
  ],
};
