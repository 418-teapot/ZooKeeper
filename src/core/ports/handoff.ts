/**
 * Handoff capability port.
 *
 * Pure types: the host session-handoff surface and the model-visible
 * message injector commands use.  The file imports types only — never an
 * implementation.
 *
 * @module
 */

import type { HandoffTarget } from "../handoff.js";

/**
 * Host-specific injector for a model-visible user message into the
 * current session.
 *
 * Distinct from a tool host's `notify`: the injected text is a real user
 * message the model reads on its next turn, which is how a command can
 * start an agent turn (the `/debug` command uses it to start the
 * auto-debug investigation in place).  Implementations must reject on
 * failure so the caller can surface a user-visible error.
 */
export interface MessageInjector {
  /**
   * Inject a model-visible user message into `sessionID`.
   *
   * @param sessionID - The session to inject into.
   * @param text - The user-message text.
   * @throws Error when the host cannot deliver the message.
   */
  inject(sessionID: string, text: string): Promise<void>;
}

/** The handoff capability. */
export interface HandoffPort {
  /**
   * The host-specific session handoff surface for the `/go` command.
   *
   * Absent on hosts that do not wire a handoff target — the `/go` command
   * unit then contributes no command.
   */
  handoffTarget: HandoffTarget;
  /**
   * The host-specific user-message injector for commands that start an
   * in-session turn.
   *
   * Absent on hosts that do not wire one — the `/debug` command then
   * reports that the Case was created but the investigation could not be
   * started automatically.
   */
  messageInjector: MessageInjector;
}
