/**
 * OpenCode v1 host adapter factory.
 *
 * Wraps the concrete v1 lens functions (`history`, `applyEdits`,
 * `renderView`) in the host-agnostic `HostAdapter<unknown>` contract.
 * All v1-specific casts live here, so the pruning handler stays
 * host-free.
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
import { applyEdits, renderView } from "./render.js";
import type { ContextMessageEntry } from "./types.js";

/**
 * Build a v1 adapter exposing the host-agnostic contract.
 *
 * The returned adapter is typed over `unknown`; every method casts the
 * opaque conversation to the v1 `ContextMessageEntry[]` it actually is.
 * This keeps the `Deps.adapter` boundary host-agnostic while allowing the
 * OpenCode host to pass its native messages shape unchanged.
 *
 * @returns The v1 host adapter.
 */
export function createV1Adapter(): HostAdapter<unknown> {
  return {
    history(conversation: unknown): HostMessage[] {
      return history(conversation as ContextMessageEntry[] | null | undefined);
    },
    applyEdits(conversation: unknown, edits: RegionEdit[]): unknown {
      applyEdits(conversation as ContextMessageEntry[], edits);
      return conversation;
    },
    renderView(
      conversation: unknown,
      items: ViewItem[],
      state: unknown,
    ): unknown {
      return renderView(
        conversation as ContextMessageEntry[],
        items,
        state as SessionState,
      );
    },
    render(
      conversation: unknown,
      items: ViewItem[],
      edits: RegionEdit[],
      state: unknown,
    ): unknown {
      applyEdits(conversation as ContextMessageEntry[], edits);
      return renderView(
        conversation as ContextMessageEntry[],
        items,
        state as SessionState,
      );
    },
    sessionId(conversation: unknown): string | undefined {
      return (conversation as ContextMessageEntry[] | null | undefined)?.[0]
        ?.info?.sessionID;
    },
    appendUserMessage(
      conversation: unknown,
      id: string,
      sessionId: string,
      text: string,
    ): unknown {
      const entries = conversation as ContextMessageEntry[];
      entries.push({
        info: { id, role: "user", sessionID: sessionId },
        parts: [{ type: "text", text }],
      });
      return conversation;
    },
  };
}
