/**
 * JSONL trace writer of the harness extension.
 *
 * The driver reads this file after a scenario: it is the only channel for
 * extension-side observations (which tools were registered, whether a child
 * runtime ran, when a handler fired).  Records are appended synchronously so
 * a trace survives a process that exits right after the last event.
 *
 * `loadId` identifies one extension factory execution.  pi caches extension
 * modules per (cwd, cache generation), so a child SDK session can reuse the
 * parent's module instance while a reload or a fresh process starts a new
 * one.
 */

import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

/** Trace file chosen by the driver for this pi process. */
const TRACE_PATH = process.env.ZOO_E2E_TRACE ?? "";

/** Identity of this module instance. */
const LOAD_ID = randomUUID();

/** Per-module record sequence. */
let seq = 0;

/** Identity of this extension module instance. */
export function loadId(): string {
  return LOAD_ID;
}

/** Trace file this process writes to (empty when the driver set none). */
export function tracePath(): string {
  return TRACE_PATH;
}

/**
 * Append one record.
 *
 * @param event - Event name (`factory`, `session_start`, ...).
 * @param data - Event payload; JSON-serialisable.
 */
export function record(
  event: string,
  data: Record<string, unknown> = {},
): void {
  if (TRACE_PATH === "") return;
  seq += 1;
  const line = {
    ts: new Date().toISOString(),
    pid: process.pid,
    loadId: LOAD_ID,
    seq,
    event,
    ...data,
  };
  try {
    appendFileSync(TRACE_PATH, `${JSON.stringify(line)}\n`);
  } catch {
    // A trace write failure must never change extension behaviour.
  }
}

/**
 * Session id an extension event context names.
 *
 * @param ctx - pi event context.
 * @returns The session id, or `undefined` when the host named none.
 */
export function sessionIdOf(ctx: ExtensionContext): string | undefined {
  const id = ctx.sessionManager.getSessionId();
  return typeof id === "string" && id.length > 0 ? id : undefined;
}

/**
 * First `max` characters of a text, for trace excerpts.
 *
 * @param value - Candidate text.
 * @param max - Maximum length.
 * @returns The excerpt (empty for non-strings).
 */
export function excerpt(value: unknown, max = 400): string {
  const text = typeof value === "string" ? value : "";
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
