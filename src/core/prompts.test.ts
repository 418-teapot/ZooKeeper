/**
 * Text-assertion tests for the prompt-text constants in `prompts.ts`.
 *
 * Covers the `compress-usage` skill pointer: both nudge levels
 * carry the EXACT pointer (an inline copy would fail the equality
 * assertion), and the nudge template still exposes the `{TEACHING}`
 * slot.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  COMPRESS_USAGE_POINTER,
  CONTEXT_NUDGE_LEVELS,
  CONTEXT_NUDGE_TEMPLATE,
} from "./prompts.js";

describe("compress-usage skill pointer", () => {
  it("defines the pointer text in one place", () => {
    assert.ok(
      COMPRESS_USAGE_POINTER.includes("compress-usage"),
      "pointer must reference the compress-usage skill",
    );
  });

  it("exposes the {TEACHING} slot in the nudge template", () => {
    assert.ok(
      CONTEXT_NUDGE_TEMPLATE.includes("{TEACHING}"),
      "template must carry the {TEACHING} slot",
    );
  });

  it("embeds the exact pointer into both gentle and urgent nudge levels", () => {
    for (const level of ["gentle", "urgent"] as const) {
      assert.equal(
        CONTEXT_NUDGE_LEVELS[level].teaching,
        COMPRESS_USAGE_POINTER,
        `${level} teaching must reference the pointer, not a copy`,
      );
    }
  });
});
