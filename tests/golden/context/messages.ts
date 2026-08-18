/**
 * Message / part builders for golden scenarios.
 *
 * Mirrors the construction helpers used by the hook test suites
 * (`src/hooks/context-pruning/index.test.ts`) so scenarios drive the
 * transform handler with the same wire shapes.
 *
 * @module
 */

import type {
  ContextMessageEntry,
  ContextTextPart,
  ContextTokenInfo,
} from "../../../src/adapters/opencode/types.js";

/** A text part in the wire format. */
export interface TextPart {
  type: string;
  text: string;
  ignored?: boolean;
}

/**
 * A tool part as the fixture builder emits it.
 *
 * Keeps `callID` so the `add-mark` action looks up a tool part by
 * call id and resolves its `(ordinal, regionIndex)` key under the
 * v1 adapter's lens mapping.  Matches the v1 wire shape the
 * OpenCode adapter maps to lens `tool-input` / `tool-output` regions.
 */
export interface SweepToolPart extends ContextTextPart {
  callID?: string;
  state?: {
    input?: unknown;
    output?: string;
    status?: string;
  };
  tool?: string;
}

/** Build a text part. */
export function textPart(text: string, ignored = false): TextPart {
  return { type: "text", text, ...(ignored ? { ignored: true } : {}) };
}

/**
 * Build a tool part with a callID, output and optional input.
 *
 * `status` defaults to "completed" (the transform treats completed /
 * undefined status as fully done).
 */
export function toolPart(
  callID: string,
  output: string,
  input?: unknown,
  tool = "bash",
  status?: string,
): SweepToolPart {
  return {
    type: "tool",
    callID,
    state: {
      input: input ?? "",
      output,
      ...(status !== undefined ? { status } : {}),
    },
    tool,
  };
}

/**
 * Build a message entry with the given role, id and parts.
 */
export function msg(
  role: string,
  id: string,
  parts: Array<SweepToolPart | TextPart>,
  sessionID?: string,
  tokens?: ContextTokenInfo,
): ContextMessageEntry {
  return {
    info: {
      role,
      id,
      ...(sessionID ? { sessionID } : {}),
      ...(tokens ? { tokens } : {}),
    },
    parts: parts as unknown as ContextMessageEntry["parts"],
  };
}

/**
 * Build a message entry carrying a host-side marker (ignored / summary
 * boundary / synthetic) on its info.
 */
export function msgWithInfo(
  info: Record<string, unknown>,
  parts: unknown[],
): ContextMessageEntry {
  return {
    info: info as unknown as ContextMessageEntry["info"],
    parts: parts as unknown as ContextMessageEntry["parts"],
  };
}

/**
 * Build a compaction-boundary summary message (what the host inserts
 * after built-in compaction).
 */
export function compactionSummaryMsg(
  id: string,
  sessionID: string,
  text: string,
): ContextMessageEntry {
  return msgWithInfo(
    { role: "assistant", id, sessionID, summary: true, ignored: true },
    [textPart(text)],
  );
}

/**
 * Deep-clone a message array (used when a later round must replay an
 * earlier view with fresh object identity).
 */
export function cloneMessages(
  messages: ContextMessageEntry[],
): ContextMessageEntry[] {
  return JSON.parse(JSON.stringify(messages)) as ContextMessageEntry[];
}
