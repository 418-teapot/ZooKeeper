/**
 * OpenCode host adapter — always-on infrastructure hooks.
 *
 * These hooks are resident regardless of the active mode profile, so a
 * null profile (absent or invalid) still leaves them working: the `event`
 * hook tracks agent identity, records aborts, cleans up deleted sessions,
 * and runs the loop settle path; `experimental.chat.system.transform`
 * captures the live model's context limit and swaps the model-conditional
 * prompt wording.  The mutable loop state (the engine, the aborted-session
 * set, the injected-wake echo map) lives in this factory's closure.
 *
 * @module
 */

import { setModelLimit } from "../../core/context/model-limits.js";
import { cleanupSession } from "../../core/context/runtime.js";
import { createLoopEngine } from "../../core/loop/index.js";
import { applyModelVariant } from "../../core/prompt-variant.js";
import { sessionAgentRegistry } from "../../core/session-agent.js";
import type { SettledContribution } from "../../core/slots.js";
import { log } from "../../utils/logger.js";
import { ABORT_ERROR_NAMES, newInjectedMessageID } from "./message-shape.js";
import { classifyStopCause } from "./settle-cause.js";

/**
 * The wiring surfaces the infrastructure hooks close over.
 */
export interface InfraHookDeps {
  /** The host client (session APIs, model limits). */
  client: any;
  /** Resolve a session's bound agent from the shared registry. */
  resolveAgent(sessionID: string): string | undefined;
  /** The profile's settle strategies; none disables the loop engine. */
  onSettled: SettledContribution[];
}

/**
 * Build the always-on infrastructure hooks.
 *
 * The loop engine is built whenever the profile contributes at least one
 * settle strategy (fail-closed: no contribution, no engine, no settle
 * branch).  Each strategy declares its own wake allowance, so the engine
 * needs no configuration of its own; this host owns the settle-cause
 * classification and the wake delivery.
 *
 * @param deps - The wiring surfaces the hooks close over.
 * @returns The `event` and `experimental.chat.system.transform` hooks.
 */
export function buildInfraHooks(deps: InfraHookDeps) {
  const { client, resolveAgent } = deps;
  const engine =
    deps.onSettled.length > 0 ? createLoopEngine(deps.onSettled) : undefined;
  // Sessions with an observed abort (`session.error`), consumed once at
  // the next idle so the classification does not linger.
  const abortedSessions = new Set<string>();
  // Sessions with an in-flight wake whose next user
  // `message.updated` is this host's own `promptAsync` echo.  Keyed by
  // session, valued by the injected user message id: an incoming user
  // message is swallowed only when its id matches, so a real user
  // message arriving in the window still resets the budget.  Consume-once;
  // an assistant update also clears it so a missing echo can never linger
  // into a later real user message.
  const injectedEchoMessages = new Map<string, string>();

  return {
    async event(input: {
      event: { type: string; properties?: Record<string, unknown> };
    }) {
      const { type, properties } = input.event;

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
        if (info?.agent && info.sessionID) {
          sessionAgentRegistry.bind(info.sessionID, info.agent);
        }
        // Budget bookkeeping: only a real user message resets the
        // per-session reminder counter.  This host's own wake
        // also arrives as a user message, carrying the id recorded in
        // `injectedEchoMessages`; it is swallowed only when the ids
        // match, so a real user message in the delivery window is never
        // mistaken for the echo.
        if (typeof info?.sessionID === "string") {
          if (info.role === "assistant") {
            injectedEchoMessages.delete(info.sessionID);
          } else if (info.role === "user") {
            const echoID = injectedEchoMessages.get(info.sessionID);
            if (echoID !== undefined && info.id === echoID) {
              // Consume-once: the injected wake echo.
              injectedEchoMessages.delete(info.sessionID);
            } else if (info.synthetic !== true) {
              engine?.reset(info.sessionID);
            }
          }
        }
      }

      // Record an aborted turn so the next idle classifies as aborted
      // instead of settled.  Consumed once by the classification.
      if (type === "session.error") {
        const props = properties as
          | { sessionID?: unknown; error?: { name?: unknown } }
          | undefined;
        const name = props?.error?.name;
        if (
          typeof props?.sessionID === "string" &&
          typeof name === "string" &&
          ABORT_ERROR_NAMES.has(name)
        ) {
          abortedSessions.add(props.sessionID);
        }
      }

      // Clean up on session deletion — single entry point that drops
      // every per-session record (maps, model limit, pruning state).
      if (type === "session.deleted") {
        const info = properties?.info as { id?: string } | undefined;
        if (info?.id) {
          cleanupSession(info.id);
          engine?.reset(info.id);
          abortedSessions.delete(info.id);
          injectedEchoMessages.delete(info.id);
        }
      }

      // Loop settle: a dolphin turn settled with unfinished work.
      // Fail-closed — only the orchestrator session, and only when the
      // active profile contributed a settle judge.
      if (type === "session.idle") {
        const sessionID = (properties as { sessionID?: unknown } | undefined)
          ?.sessionID;
        if (typeof sessionID !== "string") return;
        if (resolveAgent(sessionID) !== "dolphin") return;
        if (engine === undefined) return;

        const outcome = await classifyStopCause(
          client,
          abortedSessions,
          sessionID,
        );
        if (outcome === null) return;

        const decision = await engine.run({
          sessionID,
          cause: outcome.cause,
          hadActivity: outcome.hadActivity,
        });
        if (decision === null) return;

        if (typeof client?.session?.promptAsync !== "function") {
          log("loop", "wake_inject_unavailable", sessionID, undefined, "warn");
          return;
        }
        // Count the reminder before dispatch so a delivery failure
        // cannot become an unbounded retry loop.
        engine.record(sessionID, decision.name);
        // Tag the injected message so its echo is recognizable by
        // `info.id` when the corresponding `message.updated` arrives.
        const messageID = newInjectedMessageID();
        injectedEchoMessages.set(sessionID, messageID);
        try {
          await client.session.promptAsync({
            path: { id: sessionID },
            body: {
              agent: "dolphin",
              messageID,
              parts: [{ type: "text", text: decision.text }],
            },
          });
          log("loop", "wake_injected", sessionID, undefined, "info", {
            handler: decision.name,
            used: engine.used(sessionID, decision.name),
            cause: outcome.cause,
            hadActivity: outcome.hadActivity,
          });
        } catch (err) {
          injectedEchoMessages.delete(sessionID);
          log("loop", "wake_inject_failed", sessionID, undefined, "warn", {
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
      // the real limit.  Missing session IDs / limits are ignored by
      // the registry itself.
      if (input.model?.limit?.context !== undefined) {
        setModelLimit(
          input.sessionID ?? "",
          input.model.limit.context,
          input.model.id,
        );
      }
      // Swap the model-conditional prompt wording in the live system
      // prompt so a session that switches models follows the switch.
      // The config hook bakes the base wording; this is the runtime
      // correction.  Missing model info fails closed to the base wording.
      for (let i = 0; i < output.system.length; i += 1) {
        output.system[i] = applyModelVariant(output.system[i], input.model?.id);
      }
    },
  };
}
