/**
 * Message and content-part builders for the pi adapter tests.
 *
 * The pi adapter test files (`history.test.ts`, `render.test.ts`,
 * `adapter.test.ts`) each used to carry their own copies of these
 * builders; they now import them from here.  The builders emit the exact
 * shapes the adapter reads, so fixtures stay literal and the tests pin
 * the adapter's behavior against real structural input.
 *
 * @module
 */

import type {
  PiAssistantMessage,
  PiToolCallPart,
  PiToolResultMessage,
  PiUserMessage,
} from "../adapters/pi/types.js";

/**
 * Build a text content part.
 *
 * @param text - The part text.
 * @returns The text part.
 */
export function textPart(text: string): { type: "text"; text: string } {
  return { type: "text", text };
}

/**
 * Build an image content part.
 *
 * @param data - Base64 image data.
 * @param mimeType - Image MIME type.
 * @returns The image part.
 */
export function imagePart(
  data = "base64",
  mimeType = "image/png",
): { type: "image"; data: string; mimeType: string } {
  return { type: "image", data, mimeType };
}

/**
 * Build a thinking content part.
 *
 * @param thinking - The thinking text.
 * @returns The thinking part.
 */
export function thinkingPart(thinking: string): {
  type: "thinking";
  thinking: string;
} {
  return { type: "thinking", thinking };
}

/**
 * Build a tool-call content part.
 *
 * @param id - The call id.
 * @param name - The tool name.
 * @param args - The call arguments.
 * @returns The tool-call part.
 */
export function toolCallPart(
  id: string,
  name: string,
  args: Record<string, unknown>,
): PiToolCallPart {
  return { type: "toolCall", id, name, arguments: args };
}

/**
 * Build a pi user message.
 *
 * @param content - The message content.
 * @returns The user message.
 */
export function userMessage(content: PiUserMessage["content"]): PiUserMessage {
  return { role: "user", content };
}

/**
 * Build a pi assistant message, optionally with a usage report.
 *
 * @param content - The assistant content parts.
 * @param usage - Optional token usage report.
 * @returns The assistant message.
 */
export function assistantMessage(
  content: PiAssistantMessage["content"],
  usage?: PiAssistantMessage["usage"],
): PiAssistantMessage {
  return usage === undefined
    ? { role: "assistant", content }
    : { role: "assistant", content, usage };
}

/**
 * Build a pi tool-result message.
 *
 * @param toolCallId - The paired call id.
 * @param toolName - The tool name.
 * @param content - The result content parts.
 * @param isError - Whether the call failed.
 * @returns The tool-result message.
 */
export function toolResultMessage(
  toolCallId: string,
  toolName: string,
  content: PiToolResultMessage["content"],
  isError = false,
): PiToolResultMessage {
  return { role: "toolResult", toolCallId, toolName, content, isError };
}
