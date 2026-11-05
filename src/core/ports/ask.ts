/**
 * Ask capability port.
 *
 * Pure types: the host provider of question channels and the ask tool's
 * timeout budget.  The file imports types only — never an implementation.
 *
 * @module
 */

import type { QuestionChannel } from "../ask.js";

/**
 * Build the question channel of one tool call from the host's own
 * execution context.
 *
 * The provider runs in the host adapter, which is the only place the
 * native context is readable; it answers `undefined` when the host cannot
 * ask (no interactive surface), and the ask tool then reports the
 * system-side slot.
 */
export type QuestionChannelProvider = (
  hostCtx: unknown,
) => QuestionChannel | undefined;

/** The ask capability. */
export interface AskPort {
  /**
   * Host provider of per-call question channels.
   *
   * Absent on hosts without one — the ask tool unit then contributes no
   * tools, so `ask` never registers there.
   */
  askQuestionChannel: QuestionChannelProvider;
  /**
   * Ask-tool timeout in seconds (`[zoo.ask].timeout`).
   *
   * Absent when the section is absent or failed validation — the ask tool
   * then waits for the user indefinitely (no default timeout is ever
   * invented).
   */
  askTimeoutSeconds: number;
}
