/**
 * Comparator unit tests — prove the normalisation contracts.
 *
 * - Same observable output with different ref numbering (`m0001` vs
 *   `m0007` vs `[m1]`) compares identical.
 * - Semantic differences (folded summary text, view message count,
 *   ToolResult text, prune flags, notification texts) compare as
 *   different.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import type { ScenarioCapture } from "../context/types.js";
import { compareSnapshots } from "./compare.js";
import { normalizeRefs, normalizeSnapshotValue } from "./normalize.js";

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

describe("compareSnapshots — semantic differences detected", () => {
  const base: ScenarioCapture = {
    scenario: "G-TEST",
    rounds: [
      {
        label: "r1",
        view: [
          {
            role: "user",
            text: "[m1] [Block b1 · 3 条] t\nt",
            synthetic: true,
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
        toolResult: "上下文压缩：已压缩 3 条消息为压缩块 b1：t",
        toolError: null,
        notifications: [],
      },
    ],
  };

  test("folded summary text differs → flagged", () => {
    const other = JSON.parse(JSON.stringify(base)) as typeof base;
    other.rounds[0].view[0].text = "[m1] [Block b1 · 4 条] t\nt";
    const diffs = compareSnapshots(other, base);
    expect(diffs.length).toBeGreaterThan(0);
    expect(diffs.some((d) => d.includes("view[0].text"))).toBe(true);
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

  test("prune flag differs → flagged", () => {
    const other = JSON.parse(JSON.stringify(base)) as typeof base;
    other.rounds[0].view[1].toolParts[0].pruned = true;
    const diffs = compareSnapshots(other, base);
    expect(diffs.length).toBeGreaterThan(0);
    expect(diffs.some((d) => d.includes("pruned"))).toBe(true);
  });

  test("notification text differs → flagged", () => {
    const other = JSON.parse(JSON.stringify(base)) as typeof base;
    other.rounds[0].notifications.push("上下文清理：已折叠 1 个工具调用");
    const diffs = compareSnapshots(other, base);
    expect(diffs.length).toBeGreaterThan(0);
    expect(diffs.some((d) => d.includes("notifications"))).toBe(true);
  });
});
