/**
 * OpenCode v1 host adapter factory.
 *
 * Wraps the concrete v1 lens functions (`history`, `applyEdits`,
 * `materialize`) in the host-agnostic `HostAdapter<unknown>` contract.
 * All v1-specific casts live here, so the pruning handler stays
 * host-free.
 *
 * The write operations deliver into a private copy of the conversation:
 * the caller's array and its message objects are never rewritten, so an
 * abandoned round leaves the host's messages exactly as they arrived.
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
import { applyEdits, copyEntries, materialize } from "./render.js";
import type { ContextMessageEntry } from "./types.js";

/**
 * Build a v1 adapter exposing the host-agnostic contract.
 *
 * The returned adapter is typed over `unknown`; every method casts the
 * opaque conversation to the v1 `ContextMessageEntry[]` it actually is.
 * This keeps the `Capabilities.adapter` boundary host-agnostic while allowing the
 * OpenCode host to pass its native messages shape unchanged.
 *
 * @returns The v1 host adapter.
 */
export function createV1Adapter(): HostAdapter<unknown> {
  return {
    history(conversation: unknown): Projection {
      return history(conversation as ContextMessageEntry[] | null | undefined);
    },
    applyEdits(conversation: unknown, edits: RegionEdit[]): unknown {
      const entries = copyEntries(conversation as ContextMessageEntry[]);
      applyEdits(entries, edits);
      return entries;
    },
    materialize(conversation: unknown, plan: RenderEntry[]): unknown {
      return materialize(
        copyEntries(conversation as ContextMessageEntry[]),
        plan,
      );
    },
    appendUserMessage(
      conversation: unknown,
      id: string,
      sessionId: string,
      text: string,
    ): unknown {
      return [
        ...(conversation as ContextMessageEntry[]),
        {
          info: { id, role: "user", sessionID: sessionId },
          parts: [{ type: "text", text }],
        },
      ];
    },
  };
}
