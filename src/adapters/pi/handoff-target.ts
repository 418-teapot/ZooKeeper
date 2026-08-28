/**
 * pi handoff target for the plan handoff protocol.
 *
 * Adapts pi's command-context session-replacement API to the
 * host-agnostic `HandoffTarget` contract used by `executeHandoff` (in
 * `src/core/handoff.ts`).
 *
 * pi's `ctx.newSession` is a REPLACE operation that both creates the new
 * session and switches the TUI to it in one call, so the create and
 * deliver steps are coupled: the parent session id is stashed at create
 * time and consumed by the deliver step's `withSession` callback (all
 * post-replacement operations must run inside that callback — the old
 * command context is stale once the session is replaced).
 *
 * @module
 */

import type { HandoffTarget } from "../../core/handoff.js";
import { getPrimary, setPrimary } from "../../core/subagent/identity.js";
import { log } from "../../utils/logger.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The pi command-context surface the handoff target needs.
 *
 * Duck-typed against pi's `ExtensionCommandContext` (the command handler
 * context pi passes to a registered command): `newSession` replaces the
 * current session and runs the `withSession` callback against the fresh
 * `ReplacedSessionContext`.  The handoff target's `deliver` step uses
 * the callback's `sendUserMessage` to accept the plan reference as the
 * new session's first user message (the message is written into session
 * state before the first LLM turn runs; the turn itself is not part of
 * the handoff target's guarantee).
 * The pi package is never imported.
 */
export interface PiCommandCtx {
  newSession?(options?: {
    parentSession?: string;
    withSession?: (ctx: {
      sendUserMessage(content: string): Promise<void>;
      ui?: {
        setWidget?(
          key: string,
          content: string[] | undefined,
          options?: { placement?: "aboveEditor" | "belowEditor" },
        ): void;
      };
      sessionManager?: { getSessionId(): string };
    }) => Promise<void> | void;
  }): Promise<{ cancelled: boolean }>;
}

// ---------------------------------------------------------------------------
// Handoff target factory
// ---------------------------------------------------------------------------

/**
 * Build the pi handoff target from a command-context provider and the
 * default primary.
 *
 * `getCommandCtx` is a supplier (not a value) so the handoff target
 * always reads the latest pi command context from the entry point's
 * mutable holder — the command handler refreshes that holder with pi's
 * fresh command context immediately before the handoff target runs.
 *
 * @param opts - The context supplier and the default primary agent name.
 * @returns The pi handoff target.
 */
export function createPiHandoffTarget(opts: {
  getCommandCtx: () => PiCommandCtx | null | undefined;
  defaultPrimary: string | undefined;
}): HandoffTarget {
  const { getCommandCtx, defaultPrimary } = opts;
  /** The parent session id stashed at create time for the deliver step. */
  let parentage: string | undefined;
  /** The primary that preceded the handoff, restored on a failed replacement. */
  let previousPrimary: string | undefined;

  return {
    /**
     * Validate that the current command context can create a session.
     *
     * pi's `newSession` couples create and replace, so nothing is created
     * here — the context is only validated and the parent session id is
     * stashed for the deliver step.  The title is ignored (pi has no
     * session-list title concept).  Returns an empty id: pi's TUI binds
     * the replaced session itself, so deliver/focus never use it.
     *
     * @param ctx - The handoff context (parentage = the current session id).
     * @returns `{ id: "" }` (unused on pi).
     * @throws Error when the command context is unavailable or lacks the
     *   `newSession` API (fail-closed).
     */
    create(ctx) {
      const cmdCtx = getCommandCtx();
      if (!cmdCtx?.newSession) {
        throw new Error(
          "pi session replacement API is not available. " +
            "Ensure the pi command context exposes newSession.",
        );
      }
      parentage = ctx.parentage;
      return Promise.resolve({ id: "" });
    },

    /**
     * Prepare the new session's agent identity.
     *
     * Switches pi's self-maintained primary to the default primary so the
     * replaced session's `before_agent_start` resolves the executor's
     * prompt.  The previous primary is stashed so `deliver` can restore
     * it when the replacement is cancelled or throws before the session
     * was created.  A no-op when no default primary is configured
     * (fail-closed — the session keeps whatever identity pi already had).
     */
    installAgent() {
      if (defaultPrimary !== undefined) {
        previousPrimary = getPrimary();
        setPrimary(defaultPrimary);
      }
    },

    /**
     * Replace the session and deliver the plan reference into it.
     *
     * All post-replacement operations run inside `withSession`: the old
     * command context is stale once the session is replaced, so nothing
     * may touch it afterwards.
     *
     * Delivery is queue-level: `sendUserMessage` accepts the plan
     * reference as the new session's first user message and returns, NOT
     * after the first LLM turn completes.  The user message itself is
     * written into session state/log BEFORE the agent turn runs, so not
     * awaiting the turn is safe — `executeHandoff` can mark the plan
     * `executing` immediately, before the executing session's first turn
     * can edit the plan file.  A rejection of the detached send promise
     * (e.g. the first turn crashing) is logged as a warn and does NOT
     * throw from `deliver`: the reference was already accepted, so the
     * handoff is not rolled back.
     *
     * The `{ cancelled: true }` result is the replacement outcome and
     * stays awaited — a cancelled replacement means the session was never
     * created.  When the replacement is cancelled or `newSession` throws
     * before the session was created, the primary is restored to the
     * value that preceded the handoff (the user stays in their planning
     * session, so its identity must survive).
     *
     * @param _session - Unused (pi binds the replaced session itself).
     * @param planReference - The plan-reference prompt text.
     * @throws Error when the session replacement is cancelled or the
     *   `newSession` API is unavailable.
     */
    async deliver(_session, planReference) {
      const cmdCtx = getCommandCtx();
      if (!cmdCtx?.newSession) {
        // Fail closed before any replacement: no session was created, so
        // restore the primary that preceded the handoff.
        if (previousPrimary !== undefined) setPrimary(previousPrimary);
        throw new Error(
          "pi session replacement API is not available. " +
            "Ensure the pi command context exposes newSession.",
        );
      }
      let result: { cancelled: boolean };
      try {
        result = await cmdCtx.newSession({
          parentSession: parentage,
          withSession: (newCtx) => {
            // Fire-and-forget: accept the plan reference as the new
            // session's first user message without awaiting the first LLM
            // turn (which is written into session state before it starts).
            // A synchronous/immediate rejection is still observable via the
            // detached promise's warn — deliver never throws for it.
            newCtx.sendUserMessage(planReference).catch((err) => {
              log(
                "go-command",
                "deliver_async_failed",
                parentage ?? "",
                undefined,
                "warn",
                { error: String(err) },
              );
            });
          },
        });
      } catch (err) {
        // `newSession` threw before the session was created: restore the
        // previous primary so the surviving session's identity is intact,
        // then propagate the failure (the plan file stays untouched).
        if (previousPrimary !== undefined) setPrimary(previousPrimary);
        throw err;
      }
      if (result?.cancelled === true) {
        // Cancelled: the session was never created, so restore the
        // previous primary before throwing (asymmetric with the catch
        // path above only in that `newSession` resolved).
        if (previousPrimary !== undefined) setPrimary(previousPrimary);
        throw new Error(
          "Plan handoff cancelled: the new session was not created.",
        );
      }
    },

    /**
     * Move the TUI focus to the new session — a no-op on pi because
     * `newSession` already replaced the TUI's active session.
     */
    async focus() {},
  };
}
