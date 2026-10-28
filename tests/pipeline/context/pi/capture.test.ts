/**
 * Unit tests for the pi message projection in `capture.ts`.
 *
 * Covers the projection rules: text blocks joined with "\n" (user string
 * / user parts / assistant blocks), thinking blocks excluded, toolCall
 * input previews, toolResult output previews with placeholder
 * classification (line-start `[mN] ` prefix stripped via the shared
 * capture-core helper), and the pi-specific `isError` / boundary flags.
 *
 * @module
 */

import { describe, expect, test } from "bun:test";
import {
  PRUNED_TOOL_ERROR_INPUT_REPLACEMENT,
  PRUNED_TOOL_OUTPUT_REPLACEMENT,
} from "../../../../src/core/context/message-parts.js";
import { captureMessage } from "./capture.js";
import {
  assistantMsg,
  textPart,
  thinkingPart,
  toolCallPart,
  toolResultMsg,
  userMsg,
} from "./messages.js";

describe("captureMessage — text projection", () => {
  test("user string content is captured verbatim", () => {
    const capture = captureMessage(userMsg("hello world"));
    expect(capture.role).toBe("user");
    expect(capture.text).toBe("hello world");
    expect(capture.toolParts).toEqual([]);
  });

  test("user part-array content joins text parts with \\n and ignores images", () => {
    const message = userMsg([
      textPart("line-a"),
      { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
      textPart("line-b"),
    ]);
    const capture = captureMessage(message);
    expect(capture.text).toBe("line-a\nline-b");
  });

  test("assistant text blocks join with \\n; thinking blocks are excluded", () => {
    const message = assistantMsg([
      textPart("answer-a"),
      thinkingPart("reasoning trace"),
      textPart("answer-b"),
    ]);
    const capture = captureMessage(message);
    expect(capture.role).toBe("assistant");
    expect(capture.text).toBe("answer-a\nanswer-b");
  });

  test("an empty-content user message captures no text", () => {
    const capture = captureMessage(userMsg(""));
    expect(capture.text).toBeUndefined();
  });
});

describe("captureMessage — tool parts", () => {
  test("assistant toolCall blocks project as tool parts with an input preview", () => {
    const message = assistantMsg([
      thinkingPart("trace"),
      toolCallPart("c1", "bash", { cmd: "ls" }),
    ]);
    const capture = captureMessage(message);
    expect(capture.toolParts).toEqual([
      {
        tool: "bash",
        output: "",
        pruned: false,
        input: '{"cmd":"ls"}',
        inputPruned: false,
      },
    ]);
  });

  test("toolResult messages project as tool parts with an output preview", () => {
    const message = toolResultMsg("c1", "bash", [textPart("total 12")]);
    const capture = captureMessage(message);
    expect(capture.toolParts).toEqual([
      {
        tool: "bash",
        output: "total 12",
        pruned: false,
        input: null,
        inputPruned: false,
      },
    ]);
  });

  test("a pruned toolResult output (with [mN] prefix) is classified as pruned", () => {
    // The renderer's injectLinePrefix prepends `[mN] ` to the injectable
    // tool-output region, so the placeholder arrives with the prefix in
    // front; captureToolOutput strips one line-start prefix as snapshot
    // hygiene and keeps the full string in the pruned branch.
    const message = toolResultMsg("c1", "bash", [
      textPart(`[m3] ${PRUNED_TOOL_OUTPUT_REPLACEMENT}`),
    ]);
    const capture = captureMessage(message);
    expect(capture.toolParts[0]?.pruned).toBe(true);
    expect(capture.toolParts[0]?.output).toBe(
      `[m3] ${PRUNED_TOOL_OUTPUT_REPLACEMENT}`,
    );
  });

  test("a toolCall whose arguments wrap the error placeholder is inputPruned", () => {
    const message = assistantMsg([
      toolCallPart("c1", "bash", {
        pruned: PRUNED_TOOL_ERROR_INPUT_REPLACEMENT,
      }),
    ]);
    const capture = captureMessage(message);
    expect(capture.toolParts[0]?.inputPruned).toBe(true);
    expect(capture.toolParts[0]?.input).toBe(
      JSON.stringify({ pruned: PRUNED_TOOL_ERROR_INPUT_REPLACEMENT }).slice(
        0,
        80,
      ),
    );
  });
});

describe("captureMessage — pi-specific flags", () => {
  test("a failing toolResult surfaces isError", () => {
    const capture = captureMessage(
      toolResultMsg("c1", "bash", [textPart("boom")], { isError: true }),
    );
    expect((capture as unknown as Record<string, unknown>).isError).toBe(true);
  });

  test("a successful toolResult carries no isError flag", () => {
    const capture = captureMessage(
      toolResultMsg("c1", "bash", [textPart("ok")]),
    );
    expect(
      (capture as unknown as Record<string, unknown>).isError,
    ).toBeUndefined();
  });

  test("a compaction-summary marker (summary: true) surfaces boundary", () => {
    const message = userMsg("compaction summary text") as unknown as Record<
      string,
      unknown
    >;
    message.summary = true;
    const capture = captureMessage(message as never);
    expect(capture.boundary).toBe(true);
  });
});
