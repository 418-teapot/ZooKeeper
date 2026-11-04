/**
 * pi handoff target for the plan handoff protocol.
 *
 * Adapts pi's command-context session-replacement API to the
 * host-agnostic `HandoffTarget` contract used by `executeHandoff` (in
 * `src/core/handoff.ts`).
 *
 * pi's `ctx.newSession` is a REPLACE operation that both creates the new
 * session and switches the TUI to it in one call, so the create and
 * deliver steps are coupled: the session the create step returns carries
 * the parent session id, and the deliver step's `withSession` callback
 * runs all post-replacement operations (the old command context is stale
 * once the session is replaced).
 *
 * The executor primary travels through an injected identity surface: the
 * parentage session's binding is read and written by id, and the executor
 * is published into the pending slot so the replacement session's
 * bind-time handlers resolve it before its first turn.
 *
 * @module
 */

import type { HandoffSession, HandoffTarget } from "../../core/handoff.js";
import { log } from "../../utils/logger.js";
import type { PiHandoffIdentity } from "./switch-host.js";

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
 * Build the pi handoff target from a command-context provider.
 *
 * `getCommandCtx` resolves the command context of ONE session by id: the
 * parentage session the handoff replaces.  The entry point binds that
 * context when the command is admitted, so the handoff addresses the session
 * that asked for it instead of whichever session ran a command last.
 *
 * The executor agent is NOT captured here: it arrives with each handoff
 * and rides through the returned session, so one target serves every
 * `/go` call.
 *
 * @param opts - The context supplier and the identity surface the executor
 *   primary travels through.
 * @returns The pi handoff target.
 */
export function createPiHandoffTarget(opts: {
  getCommandCtx: (sessionID: string) => PiCommandCtx | null | undefined;
  identity: PiHandoffIdentity;
}): HandoffTarget {
  const { getCommandCtx, identity } = opts;
  /**
   * Each created session's pre-handoff primary, keyed by that session, so
   * two overlapping handoffs never restore each other's binding.
   */
  const previousPrimaries = new WeakMap<HandoffSession, string | undefined>();

  return {
    /**
     * Validate that the current command context can create a session.
     *
     * pi's `newSession` couples create and replace, so nothing is created
     * here — the context is only validated.  The title is ignored (pi has
     * no session-list title concept).  Returns an empty id: pi's TUI binds
     * the replaced session itself, so deliver/focus never use it.  The
     * executor and the parent session are echoed into the returned
     * session, so the later steps read them from there instead of sharing
     * one slot.
     *
     * @param ctx - The handoff context (parentage = the current session
     *   id, agent = the handoff's executor).
     * @returns The session with an empty id (unused on pi), that executor
     *   and that parent session.
     * @throws Error when the command context is unavailable or lacks the
     *   `newSession` API (fail-closed).
     */
    create(ctx) {
      const cmdCtx = getCommandCtx(ctx.parentage);
      if (!cmdCtx?.newSession) {
        throw new Error(
          "pi session replacement API is not available. " +
            "Ensure the pi command context exposes newSession.",
        );
      }
      return Promise.resolve({
        id: "",
        agent: ctx.agent,
        parentage: ctx.parentage,
      });
    },

    /**
     * Prepare the new session's agent identity.
     *
     * Binds the parentage session to the session's executor so the
     * replaced session's `before_agent_start` resolves the executor's
     * prompt.  The previous binding is stashed so `deliver` can restore it
     * when the replacement is cancelled or throws before the session was
     * created.
     *
     * @param session - The created session whose `agent` becomes the
     *   primary.
     */
    installAgent(session) {
      previousPrimaries.set(session, identity.getPrimary(session.parentage));
      identity.setPrimary(session.parentage, session.agent);
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
     * The executor is published into the pending identity slot before the
     * replacement, so the new session's bind-time handlers resolve it.
     *
     * The `{ cancelled: true }` result is the replacement outcome and
     * stays awaited — a cancelled replacement means the session was never
     * created.  When the replacement is cancelled or `newSession` throws
     * before the session was created, the parentage session's primary is
     * restored to the value that preceded the handoff and the pending
     * target is dropped (the user stays in their planning session, so its
     * identity must survive).
     *
     * @param session - The created session; its `parentage` is the
     *   session the replacement addresses.
     * @param planReference - The plan-reference prompt text.
     * @throws Error when the session replacement is cancelled or the
     *   `newSession` API is unavailable.
     */
    async deliver(session, planReference) {
      const { parentage } = session;
      const cmdCtx = getCommandCtx(parentage);
      if (!cmdCtx?.newSession) {
        // Fail closed before any replacement: no session was created, so
        // restore the primary that preceded the handoff.
        identity.setPrimary(parentage, previousPrimaries.get(session));
        throw new Error(
          "pi session replacement API is not available. " +
            "Ensure the pi command context exposes newSession.",
        );
      }
      identity.stashPrimary(session.agent);
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
              log.warn({
                hook: "go-command",
                event: "deliver_async_failed",
                sessionId: parentage,
                error: String(err),
              });
            });
          },
        });
      } catch (err) {
        // `newSession` threw before the session was created: restore the
        // previous primary so the surviving session's identity is intact,
        // then propagate the failure (the plan file stays untouched).
        identity.setPrimary(parentage, previousPrimaries.get(session));
        identity.stashPrimary(undefined);
        throw err;
      }
      if (result?.cancelled === true) {
        // Cancelled: the session was never created, so restore the
        // previous primary before throwing (asymmetric with the catch
        // path above only in that `newSession` resolved).
        identity.setPrimary(parentage, previousPrimaries.get(session));
        identity.stashPrimary(undefined);
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
