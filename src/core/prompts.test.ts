/**
 * Text-assertion tests for the prompt-text constants in `prompts.ts`.
 *
 * Covers the compress teaching skeleton (single source of truth): all
 * four segmentation points are present in the skeleton itself, the nudge
 * template exposes the `{TEACHING}` slot, and both nudge levels embed
 * the EXACT skeleton through that slot (an inline copy would fail the
 * equality assertion).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  COMPRESS_GUIDANCE,
  CONTEXT_NUDGE_LEVELS,
  CONTEXT_NUDGE_TEMPLATE,
} from "./prompts.js";

/** Distinctive phrase per teaching point, in skeleton order. */
const TEACHING_POINT_PHRASES = [
  "重要信息不压缩",
  "委派边界",
  "最近上下文",
  "批量提交多范围",
];

describe("compress teaching skeleton", () => {
  it("defines all four teaching points in one place", () => {
    for (const phrase of TEACHING_POINT_PHRASES) {
      assert.ok(
        COMPRESS_GUIDANCE.includes(phrase),
        `skeleton must contain: ${phrase}`,
      );
    }
  });

  it("exposes the {TEACHING} slot in the nudge template", () => {
    assert.ok(
      CONTEXT_NUDGE_TEMPLATE.includes("{TEACHING}"),
      "template must carry the {TEACHING} slot",
    );
  });

  it("embeds the exact skeleton into both gentle and urgent nudge levels", () => {
    for (const level of ["gentle", "urgent"] as const) {
      const copy = CONTEXT_NUDGE_LEVELS[level];
      assert.equal(
        copy.teaching,
        COMPRESS_GUIDANCE,
        `${level} teaching must reference the skeleton, not a copy`,
      );
      for (const phrase of TEACHING_POINT_PHRASES) {
        assert.ok(
          copy.teaching.includes(phrase),
          `${level} teaching must contain: ${phrase}`,
        );
      }
    }
  });
});
