/**
 * OpenCode host adapter — always-on infrastructure hooks.
 *
 * These hooks are resident regardless of the active mode profile, so a
 * null profile (absent or invalid) still leaves them working: the `event`
 * hook tracks agent identity, records aborts, gives the host's session
 * events to the lifecycle wiring, and runs the loop settle path;
 * `experimental.chat.system.transform` captures the live model's context
 * limit and swaps the model-conditional prompt wording.
 *
 * The mutable state lives with its owner: the loop engine and every
 * session's abort flag and pending wake echo are lifecycle services (see
 * `services.ts`), reached only through the session the current event
 * names.  No collection here is keyed by session, so one session's abort
 * cannot silence its sibling and a deleted session cannot hand its echo to
 * another one.  Every path ensures the session first: an event other than
 * `session.created` can be the host's first word about a session, and a
 * session the host deleted (or the plugin disposed) is never rebuilt.
 *
 * The loop settle path is role-gated: the session must resolve to the
 * orchestrator the assembly selected, which arrives as an input — this
 * module holds no agent name of its own, and an absent orchestrator keeps
 * the path inert (fail-closed).
 *
 * @module
 */

import { setModelLimit } from "../../core/context/model-limits.js";
import {
  applyModelVariant,
  type PromptVariantPair,
} from "../../core/prompt-variant.js";
import { sessionAgentRegistry } from "../../core/session-agent.js";
import { log } from "../../utils/logger.js";
import { ABORT_ERROR_NAMES, newInjectedMessageID } from "./message-shape.js";
import type { OpenCodeSessionState } from "./services.js";
import { classifyStopCause } from "./settle-cause.js";

/**
 * The lifecycle surface the always-on hooks drive.
 *
 * The hooks address one session's state by id and hand the host's session
 * events to the wiring; they never see a scope, another session's state,
 * or the kernel itself.
 */
export interface InfraSessionLifecycle {
  /**
   * Ensure the session scope of `sessionID` and return its state.
   *
   * `null` covers every "no session" case — an absent or blank id, a
   * session the host already deleted, a disposed plugin — and none of
   * them may create or rebuild anything.
   */
  sessionState(
    sessionID: string | null | undefined,
  ): Promise<OpenCodeSessionState | null>;
  /** Map one host session event (creation, deletion) onto the kernel. */
  handleEvent(event: unknown): Promise<unknown>;
}

/**
 * The wiring surfaces the infrastructure hooks close over.
 */
export interface InfraHookDeps {
  /** The host client (session APIs, model limits). */
  client: any;
  /** Resolve a session's bound agent from the shared registry. */
  resolveAgent(sessionID: string): string | undefined;
  /**
   * Model-family prompt wordings from the composed agents, with the
   * overlapping pairs filtered out (`filterDisjointVariants`).  Empty
   * when no enabled agent ships a variant; the transform then swaps
   * nothing (fail-closed).
   */
  promptVariants: readonly PromptVariantPair[];
  /**
   * The orchestrator the assembly selected, or `undefined` when the
   * profile resolved none.  Only this agent's sessions may wake; without
   * it the settle path stays inert (fail-closed).
   */
  orchestrator?: string;
  /** The lifecycle wiring of this plugin instance. */
  sessions: InfraSessionLifecycle;
}

/**
 * Build the always-on infrastructure hooks.
 *
 * The loop engine is a lifecycle service, built once per plugin instance
 * when the profile contributes at least one settle strategy (fail-closed:
 * no contribution, no engine, no settle branch).  Each strategy declares
 * its own wake allowance, so the engine needs no configuration of its own;
 * this host owns the settle-cause classification and the wake delivery.
 *
 * @param deps - The wiring surfaces the hooks close over.
 * @returns The `event` and `experimental.chat.system.transform` hooks.
 */
export function buildInfraHooks(deps: InfraHookDeps) {
  const { client, resolveAgent, orchestrator, sessions } = deps;

  return {
    async event(input: {
      event: { type: string; properties?: Record<string, unknown> };
    }) {
      const { type, properties } = input.event;

      // Session lifetime belongs to the wiring: `session.created` is a real
      // start notice and `session.deleted` stops exactly that session (or
      // releases a session this instance never observed).  Neither is a
      // reason to create a scope here.
      if (type === "session.created" || type === "session.deleted") {
        await sessions.handleEvent(input.event);
        return;
      }

      // Track agent identity from message.updated events.
      // Covers user messages, assistant responses, and system messages
      // (e.g. /go handoff) — more comprehensive than chat.message alone.
      if (type === "message.updated") {
        const info = properties?.info as
          | {
              agent?: string;
              sessionID?: string;
              role?: string;
              synthetic?: boolean;
              id?: string;
            }
          | undefined;
        // A message update may be the first thing this instance hears about
        // the session, and a session the host deleted stays deleted: ensure
        // before touching any of its state.
        const session = await sessions.sessionState(info?.sessionID);
        if (session === null) return;
        if (info?.agent) {
          sessionAgentRegistry.bind(session.sessionID, info.agent);
        }
        // Budget bookkeeping: only a real user message resets the
        // per-session reminder counter.  This host's own wake
        // also arrives as a user message, carrying the id recorded on the
        // session; it is swallowed only when the ids match, so a real user
        // message in the delivery window is never mistaken for the echo.
        if (info?.role === "assistant") {
          session.clearEcho();
        } else if (info?.role === "user") {
          const isEcho = session.takeEcho(info.id);
          if (!isEcho && info.synthetic !== true) {
            session.engine?.reset(session.sessionID);
          }
        }
        return;
      }

      // Record an aborted turn so the next idle classifies as aborted
      // instead of settled.  Consumed once by the classification.
      if (type === "session.error") {
        const props = properties as
          | { sessionID?: unknown; error?: { name?: unknown } }
          | undefined;
        const name = props?.error?.name;
        if (
          typeof props?.sessionID !== "string" ||
          typeof name !== "string" ||
          !ABORT_ERROR_NAMES.has(name)
        ) {
          return;
        }
        const session = await sessions.sessionState(props.sessionID);
        session?.markAborted();
        return;
      }

      // Loop settle: the orchestrator's turn settled with unfinished
      // work.  Fail-closed — only the orchestrator session, and only
      // when the active profile contributed a settle judge.
      if (type === "session.idle") {
        const sessionID = (properties as { sessionID?: unknown } | undefined)
          ?.sessionID;
        if (typeof sessionID !== "string") return;
        if (orchestrator === undefined) return;
        if (resolveAgent(sessionID) !== orchestrator) return;
        // The gates above read host facts only; the session's own state is
        // read below, so the scope is ensured here.
        const session = await sessions.sessionState(sessionID);
        const engine = session?.engine;
        if (session === null || engine === undefined) return;

        const outcome = await classifyStopCause(client, session, sessionID);
        if (outcome === null) return;

        const decision = await engine.run({
          sessionID,
          cause: outcome.cause,
          hadActivity: outcome.hadActivity,
        });
        if (decision === null) return;

        if (typeof client?.session?.promptAsync !== "function") {
          log.warn({
            hook: "loop",
            event: "wake_inject_unavailable",
            sessionId: sessionID,
          });
          return;
        }
        // Count the reminder before dispatch so a delivery failure
        // cannot become an unbounded retry loop.
        engine.record(sessionID, decision.name);
        // Tag the injected message so its echo is recognizable by
        // `info.id` when the corresponding `message.updated` arrives.
        const messageID = newInjectedMessageID();
        session.expectEcho(messageID);
        try {
          await client.session.promptAsync({
            path: { id: sessionID },
            body: {
              agent: orchestrator,
              messageID,
              parts: [{ type: "text", text: decision.text }],
            },
          });
          log.info({
            hook: "loop",
            event: "wake_injected",
            sessionId: sessionID,
            handler: decision.name,
            used: engine.used(sessionID, decision.name),
            cause: outcome.cause,
            hadActivity: outcome.hadActivity,
          });
        } catch (err) {
          session.clearEcho();
          log.warn({
            hook: "loop",
            event: "wake_inject_failed",
            sessionId: sessionID,
            error: String(err),
          });
        }
      }
    },

    async "experimental.chat.system.transform"(
      input: {
        sessionID?: string;
        model: { id: string; limit: { context: number; output: number } };
      },
      output: { system: string[] },
    ) {
      // Capture the active model's context window per session so the
      // pruning nudge phase can resolve percentage thresholds against
      // the real limit.  The session must be live first: capturing a limit
      // for a deleted session would recreate the record the deletion
      // released.
      if (input.model?.limit?.context !== undefined) {
        const session = await sessions.sessionState(input.sessionID);
        if (session !== null) {
          setModelLimit(
            session.sessionID,
            input.model.limit.context,
            input.model.id,
          );
        }
      }
      // Swap the model-conditional prompt wording in the live system
      // prompt so a session that switches models follows the switch.
      // The config hook bakes the base wording; this is the runtime
      // correction.  Missing model info fails closed to the base wording.
      for (let i = 0; i < output.system.length; i += 1) {
        output.system[i] = applyModelVariant(
          output.system[i],
          input.model?.id,
          deps.promptVariants,
        );
      }
    },
  };
}
