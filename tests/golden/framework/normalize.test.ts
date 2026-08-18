/**
 * Comparator unit tests — prove the normalisation contracts.
 *
 * - Same observable output with different ref numbering (`m0001` vs
 *   `m0007` vs `[m1]`) compares identical.
 * - Semantic differences (block active state, view message count,
 *   ToolResult text) compare as different.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import type { ScenarioCapture } from "../context/types.js";
import { compareSnapshots } from "./compare.js";
import { normalizeRefs, normalizeSnapshotValue } from "./normalize.js";

// ---------------------------------------------------------------------------
// normalizeRefs — pure function contract
// ---------------------------------------------------------------------------

describe("normalizeRefs", () => {
  test("collapses zero-padded refs to a placeholder", () => {
    expect(normalizeRefs("hello\nm0001")).toBe("hello\n[mN]");
  });

  test("collapses bare zero-padded refs", () => {
    expect(normalizeRefs("window m0002–m0002")).toBe("window [mN]–[mN]");
  });

  test("collapses new-style bracket refs", () => {
    expect(normalizeRefs("[m1] hello [m12]")).toBe("[mN] hello [mN]");
  });

  test("leaves plain text untouched", () => {
    expect(normalizeRefs("no refs here")).toBe("no refs here");
  });

  test("normalises every string leaf recursively", () => {
    const value = {
      rounds: [{ text: "a\nm0007", list: ["x m0003"] }],
    };
    expect(normalizeSnapshotValue(value)).toEqual({
      rounds: [{ text: "a\n[mN]", list: ["x [mN]"] }],
    });
  });
});

// ---------------------------------------------------------------------------
// Same output, different ref numbering → identical
// ---------------------------------------------------------------------------

describe("compareSnapshots — ref-numbering insensitivity", () => {
  const base: ScenarioCapture = {
    scenario: "G-TEST",
    rounds: [
      {
        label: "r1",
        view: [
          {
            role: "user",
            text: "hello\nm0001",
            toolParts: [],
          },
          {
            role: "user",
            text: "again\nm0003",
            toolParts: [],
          },
        ],
        state: {
          blocks: [],
          marks: {
            pending: 1,
            pendingTokens: 100,
            effective: 0,
            effectiveTokens: 0,
          },
          pendingViewChange: false,
          nudgeAnchor: null,
        },
        toolResult: "上下文压缩：已压缩 1 条消息为压缩块 b1，ref m0001",
        toolError: null,
        notifications: [],
      },
    ],
  };

  test("m0001 vs m0007 refs compare identical", () => {
    const other = JSON.parse(JSON.stringify(base)) as ScenarioCapture;
    other.rounds[0].view[0].text = "hello\nm0007";
    other.rounds[0].view[1].text = "again\nm9999";
    expect(compareSnapshots(other, base)).toEqual([]);
  });

  test("old XML tags vs new bracket refs compare identical", () => {
    const other = JSON.parse(JSON.stringify(base)) as ScenarioCapture;
    other.rounds[0].view[0].text = "hello\n[m1]";
    other.rounds[0].view[1].text = "again\n[m3]";
    expect(compareSnapshots(other, base)).toEqual([]);
  });

  test("ref number inside a ToolResult compares identical", () => {
    const other = JSON.parse(JSON.stringify(base)) as ScenarioCapture;
    other.rounds[0].toolResult =
      "上下文压缩：已压缩 1 条消息为压缩块 b1，ref m0005";
    expect(compareSnapshots(other, base)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Semantic differences → different
// ---------------------------------------------------------------------------

describe("compareSnapshots — semantic differences detected", () => {
  const base: ScenarioCapture = {
    scenario: "G-TEST",
    rounds: [
      {
        label: "r1",
        view: [
          {
            role: "user",
            text: "hello\nm0001",
            toolParts: [],
          },
          {
            role: "assistant",
            toolParts: [
              {
                output: "data",
                pruned: false,
                input: null,
                inputPruned: false,
              },
            ],
          },
        ],
        state: {
          blocks: [
            {
              blockId: 1,
              active: true,
              title: "t",
              coveredMessages: 3,
              compressedTokens: 900,
              summaryTokens: 40,
            },
          ],
          marks: {
            pending: 0,
            pendingTokens: 0,
            effective: 1,
            effectiveTokens: 100,
          },
          pendingViewChange: false,
          nudgeAnchor: null,
        },
        toolResult: "上下文压缩：已压缩 3 条消息为压缩块 b1：t",
        toolError: null,
        notifications: [],
      },
    ],
  };

  test("block active state differs → flagged", () => {
    const other = JSON.parse(JSON.stringify(base)) as typeof base;
    other.rounds[0].state.blocks[0].active = false;
    const diffs = compareSnapshots(other, base);
    expect(diffs.length).toBeGreaterThan(0);
    expect(diffs.some((d) => d.includes("active"))).toBe(true);
  });

  test("view message count differs → flagged", () => {
    const other = JSON.parse(JSON.stringify(base)) as typeof base;
    other.rounds[0].view.push({ role: "user", text: "extra", toolParts: [] });
    const diffs = compareSnapshots(other, base);
    expect(diffs.length).toBeGreaterThan(0);
  });

  test("ToolResult text differs → flagged", () => {
    const other = JSON.parse(JSON.stringify(base)) as typeof base;
    other.rounds[0].toolResult = "上下文压缩：已压缩 99 条消息为压缩块 b9：x";
    const diffs = compareSnapshots(other, base);
    expect(diffs.length).toBeGreaterThan(0);
    expect(diffs.some((d) => d.includes("toolResult"))).toBe(true);
  });

  test("mark effective state differs → flagged", () => {
    const other = JSON.parse(JSON.stringify(base)) as typeof base;
    other.rounds[0].state.marks.effective = 2;
    const diffs = compareSnapshots(other, base);
    expect(diffs.length).toBeGreaterThan(0);
  });
});
