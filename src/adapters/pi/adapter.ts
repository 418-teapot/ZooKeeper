/**
 * Pi host adapter factory.
 *
 * Exposes the host-agnostic `HostAdapter<PiAgentMessage[]>` contract for
 * the pi host.  All operations are pure: every method deep-copies the input
 * conversation and returns a new array, never mutating the input.
 *
 * pi conversations carry no per-message session identifier and no synthetic
 * message ids; `sessionId` therefore delegates to the provider supplied at
 * construction, and `appendUserMessage` ignores the id/sessionId parameters.
 *
 * @module
 */

import type {
  HostAdapter,
  HostMessage,
  RegionEdit,
  ViewItem,
} from "../../core/context/lens.js";
import type { SessionState } from "../../core/context/state.js";
import { history } from "./history.js";
import {
  applyEdits as applyEditsToMessages,
  render as renderPi,
  renderView as renderPiView,
} from "./render.js";
import type { PiAgentMessage, PiUserMessage } from "./types.js";

/**
 * Build a pi host adapter exposing the host-agnostic contract.
 *
 * The returned adapter is strictly pure: every method returns a new
 * message array and leaves the input untouched.  `getSessionId` supplies
 * the session identifier because pi `AgentMessage` objects carry none.
 *
 * @param getSessionId - Returns the current session id, or undefined when
 *   unavailable.
 * @returns The pi host adapter.
 */
export function createPiAdapter(
  getSessionId: () => string | undefined,
): HostAdapter<PiAgentMessage[]> {
  return {
    history(conversation: PiAgentMessage[]): HostMessage[] {
      return history(conversation);
    },
    applyEdits(
      conversation: PiAgentMessage[],
      edits: RegionEdit[],
    ): PiAgentMessage[] {
      return applyEditsToMessages(conversation, edits);
    },
    renderView(
      conversation: PiAgentMessage[],
      items: ViewItem[],
      state: unknown,
    ): PiAgentMessage[] {
      return renderPiView(conversation, items, state as SessionState);
    },
    render(
      conversation: PiAgentMessage[],
      items: ViewItem[],
      edits: RegionEdit[],
      state: unknown,
    ): PiAgentMessage[] {
      return renderPi(conversation, items, edits, state as SessionState);
    },
    sessionId(_conversation: PiAgentMessage[]): string | undefined {
      return getSessionId();
    },
    appendUserMessage(
      conversation: PiAgentMessage[],
      _id: string,
      _sessionId: string,
      text: string,
    ): PiAgentMessage[] {
      const synthetic: PiUserMessage = { role: "user", content: text };
      return [...conversation, synthetic];
    },
  };
}
