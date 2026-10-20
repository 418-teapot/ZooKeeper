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
  Projection,
  RegionEdit,
  RenderEntry,
} from "../../core/context/lens.js";
import { history } from "./history.js";
import {
  applyEdits as applyEditsToMessages,
  materialize as materializePiPlan,
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
    history(conversation: PiAgentMessage[]): Projection {
      return history(conversation);
    },
    applyEdits(
      conversation: PiAgentMessage[],
      edits: RegionEdit[],
    ): PiAgentMessage[] {
      return applyEditsToMessages(conversation, edits);
    },
    materialize(
      conversation: PiAgentMessage[],
      plan: RenderEntry[],
    ): PiAgentMessage[] {
      return materializePiPlan(conversation, plan);
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
