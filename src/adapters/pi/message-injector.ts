/**
 * pi user-message injector for commands that start an in-session turn.
 *
 * Adapts pi's `ExtensionAPI.sendUserMessage` to the host-agnostic
 * `MessageInjector` contract: the text becomes a real user message that
 * triggers an agent turn, which is how `/debug` starts the auto-debug
 * investigation in the current session.  `deliverAs: "followUp"` makes
 * the delivery safe even if the command runs while the agent is
 * streaming; when idle the option is ignored and the message triggers a
 * turn as usual.  `sendUserMessage` delivers asynchronously, so a
 * rejection after the call returns is recorded in the log rather than
 * left unhandled.
 *
 * @module
 */

import type { MessageInjector } from "../../core/slots.js";
import { log } from "../../utils/logger.js";

/**
 * Minimal duck-type of pi's `ExtensionAPI` used by the injector.
 *
 * `sendUserMessage` returns a promise on pi's side, so a delivery
 * failure can reject after the call has returned.  Only its presence
 * can be validated here; the pi package is never imported.
 */
export interface PiMessageSender {
  sendUserMessage(
    content: string,
    options?: { deliverAs?: "steer" | "followUp" },
  ): Promise<void> | void;
}

/** Test whether `value` is a thenable promise. */
function isThenable(value: Promise<void> | void): value is Promise<void> {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

/**
 * Build the pi message injector from the pi extension API.
 *
 * @param pi - The pi `ExtensionAPI` slice (may be partial).
 * @returns The pi message injector.
 */
export function createPiMessageInjector(pi: PiMessageSender): MessageInjector {
  return {
    /**
     * Inject `text` into the active pi session as a user message.
     *
     * @param sessionID - The session identifier (logged; pi is
     *   single-session, so the active session is implicit).
     * @param text - The user-message text.
     * @throws Error when pi's `sendUserMessage` API is unavailable.
     */
    async inject(sessionID, text) {
      if (typeof pi?.sendUserMessage !== "function") {
        throw new Error(
          "pi sendUserMessage API 不可用，无法自动启动调查。" +
            "请确认 pi 命令上下文已正确加载。",
        );
      }
      const pending = pi.sendUserMessage(text, { deliverAs: "followUp" });
      // Delivery is asynchronous: a rejection would otherwise be
      // unobservable, so record it in the log instead of letting it
      // surface as an unhandled rejection.
      if (isThenable(pending)) {
        void pending.catch((err: unknown) => {
          log(
            "debug-command",
            "inject_async_failed",
            sessionID,
            undefined,
            "warn",
            { error: err instanceof Error ? err.message : String(err) },
          );
        });
      }
    },
  };
}
