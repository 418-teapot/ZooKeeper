/**
 * Snapshot capture — pi message projection.
 *
 * Turns live pi `AgentMessage`s into the semantic view captures that get
 * persisted as golden snapshots.  The host-agnostic helpers
 * (`captureToolOutput` / `captureToolInput` / `captureState` in
 * `../capture-core.ts`) do the placeholder classification and state
 * projection; this module reads the pi wire shape (role, content blocks,
 * toolResult fields), applies the pi-specific flags, and composes the
 * helpers into ordered view captures.
 *
 * Projection rules:
 * - role passes through; text blocks (user and assistant) are joined
 *   with "\n" into `text`.
 * - assistant `thinking` blocks are reasoning traces — never captured as
 *   text (they are non-addressable under the pi lens mapping).
 * - assistant `toolCall` blocks project as tool parts with their input
 *   preview (`captureToolInput`); tool-result messages project as tool
 *   parts with their output preview (`captureToolOutput`).
 * - pi-specific flags: a failing tool result surfaces `isError: true`;
 *   a compaction-summary message (pi-side `summary: true` marker) is
 *   surfaced as `boundary: true` — the pi analogue of the v1 capture's
 *   synthetic / boundary / ignored flags.
 *
 * @module
 */

import type { PiAgentMessage } from "../../../../src/adapters/pi/types.js";
import { extractText } from "../../../../src/compose-pi.js";
import { captureToolInput, captureToolOutput } from "../capture-core.js";
import type { ViewMessageCapture } from "../types.js";

/**
 * Capture one message's observable view shape.
 *
 * @param message - The (possibly replaced) pi message.
 * @returns The view capture.
 */
export function captureMessage(message: PiAgentMessage): ViewMessageCapture {
  const capture: ViewMessageCapture = { role: message.role, toolParts: [] };
  const record = message as unknown as Record<string, unknown>;

  if (message.role === "toolResult" && message.isError === true) {
    (capture as unknown as Record<string, unknown>).isError = true;
  }
  // pi compaction summaries carry a `summary: true` marker on the
  // message; the adapter types leave it open, so the capture recognises
  // the field directly (analogous to the v1 `info.summary` boundary).
  if (record.summary === true) capture.boundary = true;

  const textParts: string[] = [];
  if (message.role === "user") {
    const content = message.content;
    if (typeof content === "string") {
      if (content.length > 0) textParts.push(content);
    } else {
      for (const part of content) {
        if (part.type === "text") textParts.push(part.text);
      }
    }
  } else if (message.role === "assistant") {
    for (const block of message.content) {
      if (block.type === "text") {
        textParts.push(block.text);
      } else if (block.type === "toolCall") {
        capture.toolParts.push({
          tool: block.name,
          output: "",
          pruned: false,
          ...captureToolInput(block.arguments),
        });
      }
      // thinking blocks are reasoning traces — no text, no tool part.
    }
  } else {
    // toolResult — the single tool-output region of the message.
    capture.toolParts.push({
      tool: message.toolName,
      ...captureToolOutput(extractText(message.content)),
    });
  }

  if (textParts.length > 0) capture.text = textParts.join("\n");
  return capture;
}

/**
 * Capture the final view structure of a (mutated) message array.
 *
 * @param messages - The messages after the transform ran.
 * @returns Ordered view captures.
 */
export function captureView(messages: PiAgentMessage[]): ViewMessageCapture[] {
  return messages.map(captureMessage);
}
