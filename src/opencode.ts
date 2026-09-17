/**
 * ZooKeeper — OpenCode plugin entry point.
 *
 * Prompt injection via `config` hook + `task()` prompt validation via
 * `tool.execute.before` hook + advisory nudges via `tool.execute.after`.
 *
 * Tool deny-listing is a single source of truth defined in `config.toml`,
 * compiled by `install.py` into `~/.config/opencode/opencode.json`.
 * The plugin injects prompt files at runtime via `config` hook,
 * validates task() prompt structure via `tool.execute.before`,
 * and appends soft guidance nudges via `tool.execute.after`.
 *
 * Registration is driven by the active mode profile
 * (`[zoo.mode.<name>]`, parsed by `parseModeProfile`): the profile's
 * category lists declare which agents, skills, hook units, tools, and
 * slash commands load.  `composeProfile` (in `src/core/compose.ts`)
 * selects the enabled units from the registry
 * (`src/registry.ts`), and the OpenCode adapter
 *  (`src/compose-opencode.ts`) turns the host-agnostic result into hook
 *  registrations.  When the profile is `null` (absent or invalid) every
 *  profile-driven registration is skipped — no defaults, no fallback to a
 *  full load — while the always-on infrastructure hooks (event,
 *  experimental.chat.system.transform) keep working.
 *
 *  This module is the entry + always-on infrastructure: it wires the
 *  parsed config, feeds the shared session-agent registry
 *  (`src/core/session-agent.ts`) from `message.updated` events, and
 *  merges the adapter's profile-driven fragment with the always-on
 *  infrastructure hooks.
 */

import config from "../config.toml" with { type: "toml" };
import { createV1Adapter } from "./adapters/opencode/adapter.js";
import { createOpenCodeHandoffTarget } from "./adapters/opencode/handoff-target.js";
import { createV1ToolHost } from "./adapters/opencode/tool-host.js";
import {
  assembleOpenCodeHooks,
  buildSettledRunner,
} from "./compose-opencode.js";
import { composeProfile } from "./core/compose.js";
import {
  initPluginLogger,
  parseAgentModes,
  parseAgentPermissions,
  parseContextConfig,
  parseContinuationConfig,
  parseLimits,
  parseModeProfile,
} from "./core/config-parse.js";
import type { ModeProfile } from "./core/config-types.js";
import { setModelLimit } from "./core/context/model-limits.js";
import { cleanupSession } from "./core/context/runtime.js";
import {
  type Budget,
  isAwaitingUserAnswer,
  resolveWorkActions,
  type StopCause,
  type TurnToolCall,
} from "./core/continuation/index.js";
import { sessionAgentRegistry } from "./core/session-agent.js";
import type { Deps } from "./core/slots.js";
import { derivePrimaries } from "./core/subagent/identity.js";
import { REGISTRY } from "./registry.js";
import { log } from "./utils/logger.js";

// ---------------------------------------------------------------------------
// Session-idle continuation classification
// ---------------------------------------------------------------------------

/** Tool names that pose a question to the user and wait for an answer. */
const QUESTION_TOOL_NAMES: ReadonlySet<string> = new Set([
  "question",
  "ask_user_question",
  "askuserquestion",
]);

/** Assistant-turn error names that report an aborted request. */
const ABORT_ERROR_NAMES: ReadonlySet<string> = new Set([
  "MessageAbortedError",
  "AbortError",
]);

/**
 * Build a message id in the host's own layout (`msg_` + 12 hex
 * characters + 12 base62 characters, mirroring OpenCode's identifier
 * encoding).  `promptAsync` honors a caller-supplied id, so the host can
 * recognize the resulting `message.updated` as its own injected
 * continuation by `info.id` — the only stable discriminator that event
 * carries: `message.updated` transports message identity, not content
 * (text arrives separately via `message.part.updated`).
 *
 * @returns A fresh, host-format user message id.
 */
function newInjectedMessageID(): string {
  const alphabet =
    "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
  // Low 48 bits of the (ms timestamp * 4096) counter, matching the
  // upstream identifier so the id sorts with its contemporaries.
  const time = (BigInt(Date.now()) * 4096n) & ((1n << 48n) - 1n);
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  let suffix = "";
  for (const b of bytes) suffix += alphabet[b % 62];
  return `msg_${time.toString(16).padStart(12, "0")}${suffix}`;
}

/** The minimal message shape read while classifying a settle cause. */
interface IdleMessageEntry {
  info?: {
    role?: string;
    error?: { name?: string };
    /** Host-marked synthetic message (our own injections, summaries). */
    synthetic?: boolean;
  };
  parts?: Array<Record<string, unknown>>;
}

/**
 * Extract a tool name from a tool part.
 *
 * The OpenCode SDK names the tool `tool`; a few host variants expose it
 * as `name` / `toolName`, so all three are probed.
 *
 * @param part - A raw message part.
 * @returns The tool name, or `undefined` when the part carries none.
 */
function getPartToolName(part: Record<string, unknown>): string | undefined {
  const name = part.tool ?? part.name ?? part.toolName;
  return typeof name === "string" ? name : undefined;
}

/**
 * Whether a message part is a tool call.
 *
 * The OpenCode SDK uses `tool`; a few host variants expose `tool_use` or
 * `tool-invocation`, so all three are accepted.
 *
 * @param part - A raw message part.
 * @returns `true` when the part represents a tool call.
 */
function isToolPart(part: Record<string, unknown>): boolean {
  const type = part.type;
  return type === "tool" || type === "tool_use" || type === "tool-invocation";
}

/**
 * OpenCode's mutating tool vocabulary.
 *
 * Host vocabulary owned by this adapter: core never hardcodes which tool
 * names mutate, so OpenCode declares them here.
 */
const OPENCODE_MUTATING_TOOLS: readonly string[] = ["bash", "edit", "write"];

/**
 * OpenCode's delegation tool, naming the target agent in its input.
 *
 * `getPartAgent` is consulted only for this tool, so a present
 * `TurnToolCall.agent` marks delegation for core without it knowing the
 * name.
 */
const OPENCODE_DELEGATION_TOOL = "task";

/**
 * Extract the delegated agent name from the delegation tool's part.
 *
 * OpenCode's `task` tool names the target in `state.input.subagent_type`;
 * a few variants also expose `input.agent`, so both are probed.  Callers
 * must only consult this for `OPENCODE_DELEGATION_TOOL` parts.
 *
 * @param part - A raw tool part.
 * @returns The delegated agent name, or `undefined` when absent.
 */
function getPartAgent(part: Record<string, unknown>): string | undefined {
  const container = part.state ?? part;
  const input = (container as { input?: unknown }).input;
  if (input === null || typeof input !== "object") return undefined;
  const raw =
    (input as Record<string, unknown>).subagent_type ??
    (input as Record<string, unknown>).agent;
  return typeof raw === "string" ? raw : undefined;
}

/**
 * Whether a message part is an unanswered question-tool call.
 *
 * A question tool that has not reached the `completed` state is still
 * waiting for the user's answer.
 *
 * @param part - A raw message part.
 * @returns `true` when the part is a pending question call.
 */
function isUnansweredQuestionPart(part: Record<string, unknown>): boolean {
  if (!isToolPart(part)) return false;
  const name = getPartToolName(part)?.toLowerCase();
  if (name === undefined || !QUESTION_TOOL_NAMES.has(name)) return false;
  const state = part.state as { status?: unknown } | undefined;
  return state?.status !== "completed";
}

/**
 * Whether the transcript ends at a question tool call awaiting an answer.
 *
 * Messages are scanned backward: the first real user message terminates
 * the search (the question was answered or the turn interrupted), and
 * the first assistant message decides it.  Synthetic user messages (our
 * own continuation injections, block summaries) are skipped so they do
 * not mask a still-pending question.
 *
 * Exported for unit testing.
 *
 * @param messages - The session transcript in chronological order.
 * @returns `true` when an unanswered question tool call is pending.
 */
export function hasUnansweredQuestion(
  messages: readonly IdleMessageEntry[],
): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    const role = message?.info?.role;
    if (role === "user") {
      if (message.info?.synthetic === true) continue;
      return false;
    }
    if (role === "assistant") {
      const parts = Array.isArray(message.parts) ? message.parts : [];
      return parts.some(isUnansweredQuestionPart);
    }
  }
  return false;
}

/**
 * Whether the last assistant message reports an aborted turn.
 *
 * The `session.error` event is the primary abort signal; this inspection
 * is the fallback for an abort observed only in the persisted
 * transcript.
 *
 * Exported for unit testing.
 *
 * @param messages - The session transcript in chronological order.
 * @returns `true` when the last assistant turn carries an abort error.
 */
export function lastAssistantAborted(
  messages: readonly IdleMessageEntry[],
): boolean {
  for (let i = messages.length - 1; i >= 0; i--) {
    const info = messages[i]?.info;
    if (info?.role !== "assistant") continue;
    const name = info.error?.name;
    return name !== undefined && ABORT_ERROR_NAMES.has(name);
  }
  return false;
}

/** Facts extracted from the settled assistant turn. */
interface TurnOutcome {
  /** Tool calls issued after the last user message, in order. */
  calls: TurnToolCall[];
  /** Concatenated text of the last assistant message (empty when none). */
  finalText: string;
}

/**
 * Collect the settled turn's tool calls and final assistant text.
 *
 * The turn begins after the last user message: every user message is a
 * turn boundary.  The host's own continuation injection also arrives as
 * a user message (a recorded id echo with customType-less text parts),
 * so it too starts a fresh turn — which is exactly the turn being
 * classified.  Tool calls from assistant messages in that span are
 * gathered; `finalText` is the concatenated text of the last assistant
 * message, so a tool-only closing message yields an empty string.
 *
 * @param messages - The session transcript in chronological order.
 * @returns The turn's tool calls and final assistant text.
 */
function collectTurnOutcome(
  messages: readonly IdleMessageEntry[],
): TurnOutcome {
  let start = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.info?.role === "user") {
      start = i + 1;
      break;
    }
  }
  const calls: TurnToolCall[] = [];
  let finalText = "";
  for (let i = start; i < messages.length; i++) {
    const message = messages[i];
    if (message?.info?.role !== "assistant") continue;
    const parts = Array.isArray(message.parts) ? message.parts : [];
    let messageText = "";
    for (const part of parts) {
      if (isToolPart(part)) {
        const name = getPartToolName(part);
        if (name !== undefined) {
          calls.push({
            name,
            agent:
              name === OPENCODE_DELEGATION_TOOL
                ? getPartAgent(part)
                : undefined,
          });
        }
      }
      if (typeof part.text === "string") messageText += part.text;
    }
    finalText = messageText;
  }
  return { calls, finalText };
}

// ---------------------------------------------------------------------------
// Plugin entry point
// ---------------------------------------------------------------------------

/**
 * Build the plugin hooks object from an explicit zoo config.
 *
 * Profile-driven registrations (agents, skills, hook units, tools, slash
 * commands) are composed from the active `[zoo.mode.*]` profile; when the
 * profile is null they are all skipped while the infrastructure hooks
 * (event, experimental.chat.system.transform) keep working.
 *
 * Exported for unit testing — `zookeeper` wires this with the imported
 * config.toml.
 *
 * @param input - OpenCode plugin input (client, directory, ...).
 * @param zooConfig - The `zoo` section of config.toml.
 * @returns Plugin hooks object.
 */
export async function buildPlugin(input: any, zooConfig: any, rawConfig?: any) {
  const limits = parseLimits(zooConfig);
  const contextConfig = parseContextConfig(zooConfig);
  const modeProfile: ModeProfile | null = parseModeProfile(zooConfig);
  // The `agent` table lives at the top level of config.toml, so the
  // fail-closed mode map is parsed from the whole parsed root (empty map
  // when no raw config was supplied).
  const agentModes = parseAgentModes(rawConfig ?? {});
  // Tool-level deny map for the primary-switch unit.  Populated for
  // parity with the pi host; OpenCode never provides `piSwitchHost`, so
  // the switch unit contributes no commands there regardless.
  const agentPermissions = parseAgentPermissions(rawConfig ?? {});
  const client = input.client;
  const directory: string = (input as any).directory ?? "";

  initPluginLogger(zooConfig, "opencode");

  // ── Profile-driven composition ────────────────────────────────────
  // `sessionAgentRegistry` is the shared session → agent registry held
  // by core/session-agent.ts; this entry populates it via
  // `message.updated` events and the units read it through
  // `deps.resolveAgent`.
  const resolveAgent = (sessionID: string): string | undefined =>
    sessionAgentRegistry.resolve(sessionID);
  const deps: Deps = {
    limits,
    contextConfig,
    agentModes,
    agentPermissions,
    client,
    directory,
    resolveAgent,
    toolHost: createV1ToolHost(client, resolveAgent),
    adapter: createV1Adapter(),
    handoffTarget: createOpenCodeHandoffTarget(
      client,
      derivePrimaries(modeProfile?.agents ?? [], agentModes)[0],
      directory,
    ),
  };
  const composed = composeProfile(modeProfile, REGISTRY, deps);
  const profileHooks = assembleOpenCodeHooks(composed, deps, modeProfile);

  // ── Auto-continuation state ───────────────────────────────────────
  // The profile contributes the judgment (`onSettled`); this host owns
  // the settle-cause classification and the per-session reminder
  // budget.  All state is per plugin instance and keyed by session.
  // The reminder ceiling from `[zoo.continuation]`.  No default is
  // invented: when the section is absent or `max_reminders` is
  // missing/invalid the parser yields `undefined` and the continuation
  // branch never acts (fail-closed).
  const maxReminders = parseContinuationConfig(zooConfig)?.maxReminders;
  const hasSettledContributions =
    composed.onSettled.length > 0 && maxReminders !== undefined;
  const settledRunner = buildSettledRunner(composed.onSettled);
  // Reminders already delivered per session.  Cleared by a real user
  // message, never by this host's own injected continuation.
  const continuationUsed = new Map<string, number>();
  // Sessions with an observed abort (`session.error`), consumed once at
  // the next idle so the classification does not linger.
  const abortedSessions = new Set<string>();
  // Sessions with an in-flight continuation whose next user
  // `message.updated` is this host's own `promptAsync` echo.  Keyed by
  // session, valued by the injected user message id: an incoming user
  // message is swallowed only when its id matches, so a real user
  // message arriving in the window still resets the budget.  Consume-once;
  // an assistant update also clears it so a missing echo can never linger
  // into a later real user message.
  const injectedEchoMessages = new Map<string, string>();

  // An agent is an executor when its tool-level permission deny list does
  // not include `edit`; a read-only delegate (e.g. lynx) must not count
  // as work progress.
  const isExecutor = (agent: string): boolean =>
    !(agentPermissions[agent] ?? []).includes("edit");

  /** The classified settle outcome plus the turn's work-progress fact. */
  interface IdleOutcome {
    cause: StopCause;
    progress: boolean;
  }

  /**
   * Classify why a session's turn ended for auto-continuation, and whether
   * the settled turn actually made mutating progress.
   *
   * The `session.error` flag is checked first (cheap and explicit);
   * otherwise the transcript is inspected for an aborted last assistant
   * turn, an unanswered question tool call, or a final assistant text that
   * hands the turn back to the user.  The same transcript fetch also
   * yields the settled turn's tool calls, which are reduced to real work
   * actions (`resolveWorkActions`) against the parsed agent deny map — a
   * `task`/`subagent` delegation only counts when the target is an
   * executor.  When the transcript cannot be read (API absent, rejects,
   * or a non-array payload) the signal is unobservable, so the caller must
   * fail closed and skip — returning `null` here.
   *
   * @param sessionID - The settled session.
   * @returns The cause and progress, or `null` when unobservable.
   */
  async function classifyStopCause(
    sessionID: string,
  ): Promise<IdleOutcome | null> {
    if (abortedSessions.delete(sessionID)) {
      return { cause: "aborted", progress: false };
    }
    if (typeof client?.session?.messages !== "function") {
      log("continuation", "cause_unobservable", sessionID, undefined, "warn", {
        reason: "session.messages unavailable",
      });
      return null;
    }
    let messages: IdleMessageEntry[];
    try {
      const res = await client.session.messages({ path: { id: sessionID } });
      const data = Array.isArray(res)
        ? res
        : (res as { data?: unknown } | undefined)?.data;
      if (!Array.isArray(data)) {
        log(
          "continuation",
          "cause_unobservable",
          sessionID,
          undefined,
          "warn",
          { reason: "messages payload not an array" },
        );
        return null;
      }
      messages = data as IdleMessageEntry[];
    } catch (err) {
      log("continuation", "cause_unobservable", sessionID, undefined, "warn", {
        reason: "messages fetch failed",
        error: String(err),
      });
      return null;
    }
    const outcome = collectTurnOutcome(messages);
    const progress =
      resolveWorkActions(outcome.calls, {
        mutatingTools: OPENCODE_MUTATING_TOOLS,
        isExecutorAgent: isExecutor,
      }).length > 0;
    if (lastAssistantAborted(messages)) return { cause: "aborted", progress };
    if (
      hasUnansweredQuestion(messages) ||
      isAwaitingUserAnswer(outcome.finalText)
    ) {
      return { cause: "awaiting-input", progress };
    }
    return { cause: "settled", progress };
  }

  return {
    // ── Always-on infrastructure hooks ────────────────────────────────
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
        // per-session reminder counter.  This host's own continuation
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
              // Consume-once: the injected continuation echo.
              injectedEchoMessages.delete(info.sessionID);
            } else if (info.synthetic !== true) {
              continuationUsed.delete(info.sessionID);
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
          continuationUsed.delete(info.id);
          abortedSessions.delete(info.id);
          injectedEchoMessages.delete(info.id);
        }
      }

      // Auto-continuation: a dolphin turn settled with unfinished work.
      // Fail-closed — only the orchestrator session, and only when the
      // active profile contributed a settle judge.
      if (type === "session.idle") {
        const sessionID = (properties as { sessionID?: unknown } | undefined)
          ?.sessionID;
        if (typeof sessionID !== "string") return;
        if (resolveAgent(sessionID) !== "dolphin") return;
        if (!hasSettledContributions || maxReminders === undefined) return;

        const outcome = await classifyStopCause(sessionID);
        if (outcome === null) return;

        const budget: Budget = {
          limit: maxReminders,
          used: continuationUsed.get(sessionID) ?? 0,
        };
        const decision = await settledRunner({
          sessionID,
          cause: outcome.cause,
          budget,
          progress: outcome.progress,
        });
        if (decision === null || decision.kind !== "wake") return;

        if (typeof client?.session?.promptAsync !== "function") {
          log(
            "continuation",
            "wake_inject_unavailable",
            sessionID,
            undefined,
            "warn",
          );
          return;
        }
        // Count the reminder before dispatch so a delivery failure
        // cannot become an unbounded retry loop.
        continuationUsed.set(sessionID, budget.used + 1);
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
          log("continuation", "wake_injected", sessionID, undefined, "info", {
            used: budget.used + 1,
            limit: maxReminders,
            cause: outcome.cause,
            progress: outcome.progress,
          });
        } catch (err) {
          injectedEchoMessages.delete(sessionID);
          log(
            "continuation",
            "wake_inject_failed",
            sessionID,
            undefined,
            "warn",
            { error: String(err) },
          );
        }
      }
    },

    async "experimental.chat.system.transform"(
      input: {
        sessionID?: string;
        model: { id: string; limit: { context: number; output: number } };
      },
      _output: { system: string[] },
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
    },

    // ── Profile-driven registrations (from the adapter) ─────────────
    ...profileHooks,
  };
}

/**
 * @param input - OpenCode plugin input (unused).
 * @returns Plugin hooks object.
 */
export async function zookeeper(input: any) {
  return buildPlugin(input, (config as any).zoo ?? {}, config as any);
}

export default { id: "zookeeper", server: zookeeper };

export { createV1Adapter } from "./adapters/opencode/adapter.js";
// ---------------------------------------------------------------------------
// Test-only exports — exposed for unit testing
// ---------------------------------------------------------------------------
export {
  buildToolHooks,
  injectAgentPrompts,
  registerProfileToolsInConfig,
  registerSkills,
  runAfterHandlers,
} from "./compose-opencode.js";
export { sessionAgentRegistry } from "./core/session-agent.js";
