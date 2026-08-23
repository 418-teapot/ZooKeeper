/**
 * Snapshot capture — v1 message projection.
 *
 * Turns live v1 messages into the semantic view captures that get
 * persisted as golden snapshots.  The host-agnostic helpers
 * (`captureToolOutput` / `captureToolInput` / `captureState` in
 * `../capture-core.ts`) do the placeholder classification and state
 * projection; this module reads the v1 wire shape (`entry.info`,
 * `parts`, `part.state`), applies the host's ignore / sentinel-id
 * rules, and composes the helpers into ordered view captures.
 *
 * @module
 */

import type { ContextMessageEntry } from "../../../../src/adapters/opencode/types.js";
import { isMessageIgnored } from "../../../../src/adapters/opencode/types.js";
import { captureToolInput, captureToolOutput } from "../capture-core.js";
import type { ViewMessageCapture } from "../types.js";

/** Sentinel synthetic message id prefixes kept in the snapshot. */
const SENTINEL_PREFIXES = ["zoo-fold-b", "zoo-nudge", "zoo-manual-compress"];

/**
 * Capture one message's observable view shape.
 *
 * @param entry - The (possibly mutated) message entry.
 * @returns The view capture.
 */
export function captureMessage(entry: ContextMessageEntry): ViewMessageCapture {
  const info = entry.info as unknown as Record<string, unknown>;
  const capture: ViewMessageCapture = {
    role: entry.info.role,
    toolParts: [],
  };
  if (info.synthetic === true) capture.synthetic = true;
  if (info.summary === true) capture.boundary = true;
  if (isMessageIgnored(entry) || info.ignored === true) capture.ignored = true;

  const sentinel = SENTINEL_PREFIXES.find((p) =>
    String(entry.info.id).startsWith(p),
  );
  if (sentinel) {
    // Keep the sentinel identity (the numeric suffix is the stable
    // block id / a fixed marker) so the snapshot reader can tell
    // synthetic messages apart from ordinary user text.
    (capture as unknown as Record<string, unknown>).sentinelId = String(
      entry.info.id,
    );
  }

  const textParts: string[] = [];
  const parts = entry.parts ?? [];
  for (const part of parts) {
    const p = part as unknown as Record<string, unknown>;
    if (p.type === "text" && typeof p.text === "string") {
      textParts.push(p.text);
    } else if (p.type === "tool") {
      const state = p.state as Record<string, unknown> | undefined;
      const output = typeof state?.output === "string" ? state.output : "";
      capture.toolParts.push({
        tool: typeof p.tool === "string" ? p.tool : undefined,
        ...captureToolOutput(output),
        ...captureToolInput(state?.input),
      });
    }
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
export function captureView(
  messages: ContextMessageEntry[],
): ViewMessageCapture[] {
  return messages.map(captureMessage);
}
