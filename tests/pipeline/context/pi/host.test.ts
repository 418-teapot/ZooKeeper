/**
 * Unit tests for the pi lane host seam (`host.ts`).
 *
 * Covers the seam methods that the smoke scenario does not drive: the
 * /dcp absence error, call-id → mark-target resolution under the pi lens
 * mapping (linked toolResult, bare toolCall fallback, unknown id), plan
 * landing over the pi transcript (span hashing, absent-id no-op, empty
 * transcript no-op), and the tool path through the REAL pi tool host
 * (compress / decompress dispatch with their loud Chinese guidance
 * errors).  The production-entry transform and the model-limit nudge
 * flow are covered by the PI-SMOKE-01 scenario and the smoke tests in
 * `snapshots.test.ts`.
 *
 * @module
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import type { PiAgentMessage } from "../../../../src/adapters/pi/types.js";
import { getContextStateManager } from "../../../../src/core/context/runtime.js";
import { createPipelineSandbox } from "../sandbox.js";
import { resetPipelineState } from "../teardown.js";
import { createPiPipelineHost } from "./host.js";
import {
  assistantMsg,
  textPart,
  thinkingPart,
  toolCallPart,
  toolResultMsg,
  userMsg,
} from "./messages.js";

/** Test-owned storage root the tool path and plan landing write into. */
const SANDBOX = createPipelineSandbox("pi-host");

beforeEach(() => {
  resetPipelineState(SANDBOX);
});

afterAll(() => {
  SANDBOX.dispose();
});

/** A small view: user, assistant toolCall, linked toolResult, assistant. */
function toolView(): PiAgentMessage[] {
  return [
    userMsg("hello"),
    assistantMsg([toolCallPart("c1", "bash", { cmd: "ls" })], {
      usage: { input: 500, output: 100 },
    }),
    toolResultMsg("c1", "bash", [textPart("total 12")]),
    assistantMsg([textPart("done")]),
  ];
}

describe("pi host — /dcp absence", () => {
  test("handleDcp throws the pi-specific absence error", async () => {
    const host = createPiPipelineHost("pi-host-dcp");
    await expect(
      host.handleDcp(
        "pi-host-dcp",
        "compress",
        { dedup: {}, purgeErrors: {} },
        [],
        [],
      ),
    ).rejects.toThrow("dcp is not wired in the pi pipeline host");
  });
});

describe("pi host — resolveMarkTarget", () => {
  test("resolves a call id to its linked toolResult's tool-output region", () => {
    const host = createPiPipelineHost("pi-host-mark");
    const target = host.resolveMarkTarget(toolView(), "c1");
    expect(target).toEqual({ ordinal: 2, regionIndex: 0 });
  });

  test("falls back to the toolCall block's tool-input region without a result", () => {
    const host = createPiPipelineHost("pi-host-mark");
    const messages: PiAgentMessage[] = [
      userMsg("hello"),
      assistantMsg([
        thinkingPart("trace"),
        toolCallPart("c9", "bash", { cmd: "ls" }),
      ]),
    ];
    // The thinking block occupies region 0; the toolCall block is the
    // second content block → tool-input region index 1.
    const target = host.resolveMarkTarget(messages, "c9");
    expect(target).toEqual({ ordinal: 1, regionIndex: 1 });
  });

  test("returns null for an unknown call id", () => {
    const host = createPiPipelineHost("pi-host-mark");
    expect(host.resolveMarkTarget(toolView(), "ghost")).toBeNull();
  });
});

describe("pi host — landPlan", () => {
  test("lands an id-keyed plan as an ordinal-keyed block with a span hash", () => {
    const host = createPiPipelineHost("pi-host-plan");
    const messages = [
      userMsg("hello", { id: "u0" }),
      assistantMsg([toolCallPart("c1", "bash", { cmd: "ls" })], { id: "a1" }),
      toolResultMsg("c1", "bash", [textPart("total 12")], { id: "tr1" }),
      userMsg("again", { id: "u3" }),
    ];
    const state = getContextStateManager().get("pi-host-plan");
    host.landPlan(state, messages, {
      anchorMessageId: "tr1",
      messageIds: ["a1", "tr1"],
      summary: "early segment.",
      title: "smoke",
      compressedTokens: 900,
      summaryTokens: 40,
    });
    expect(state.blocks.size).toBe(1);
    const block = state.blocks.get(1);
    expect(block?.start).toBe(1);
    expect(block?.end).toBe(3);
    expect(block?.title).toBe("smoke");
    expect(block?.summary).toBe("early segment.");
    expect(block?.status).toBe("active");
    expect(block?.spanHash.length).toBeGreaterThan(0);
  });

  test("no-ops when the first message id is absent from the view", () => {
    const host = createPiPipelineHost("pi-host-plan");
    const state = getContextStateManager().get("pi-host-plan");
    host.landPlan(state, toolView(), {
      anchorMessageId: "ghost",
      messageIds: ["ghost"],
      summary: "s",
      title: "t",
      compressedTokens: 100,
      summaryTokens: 10,
    });
    expect(state.blocks.size).toBe(0);
  });

  test("no-ops on an empty transcript (interval cannot be hashed)", () => {
    const host = createPiPipelineHost("pi-host-plan");
    const state = getContextStateManager().get("pi-host-plan");
    host.landPlan(state, [], {
      anchorMessageId: "u0",
      messageIds: ["u0"],
      summary: "s",
      title: "t",
      compressedTokens: 100,
      summaryTokens: 10,
    });
    expect(state.blocks.size).toBe(0);
  });
});

describe("pi host — runTool through the real pi tool host", () => {
  test("compress-tool-raw with malformed args rejects with Chinese guidance", async () => {
    const host = createPiPipelineHost("pi-host-tool");
    await expect(
      host.runTool(
        { kind: "compress-tool-raw", args: {} },
        "pi-host-tool",
        { dedup: {}, purgeErrors: {} },
        toolView(),
        [],
      ),
    ).rejects.toThrow("压缩工具参数格式错误");
  });

  test("decompress-tool with an unknown block rejects with the not-found error", async () => {
    const host = createPiPipelineHost("pi-host-tool");
    const config = {
      decompress: { maxFillPercent: 80 },
      dedup: {},
      purgeErrors: {},
    };
    await expect(
      host.runTool(
        { kind: "decompress-tool", blockId: "b9" },
        "pi-host-tool",
        config,
        toolView(),
        [],
      ),
    ).rejects.toThrow(/块/);
  });
});
