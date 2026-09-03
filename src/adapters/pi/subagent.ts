/**
 * Pi subagent driver — in-process `AgentSession` execution via the pi SDK.
 *
 * Implements the host-agnostic `SubagentDriver` contract against pi's SDK
 * factory (`createAgentSession`): a run creates a sub-session carrying the
 * request's tool allowlist and configured model, subscribes
 * to its events and reduces them into the host-neutral `AgentMessage` view,
 * calls the pi SDK `prompt(text)` with the request's prompt, and classifies
 * the outcome from the final assistant message's `stopReason`.  Termination
 * is wired end to end: the parent
 * abort signal aborts the sub-session, and `dispose()` always runs in
 * `finally`.  Any SDK-level failure collapses into an `error` result — a
 * run never rejects and never throws, per the driver contract.
 *
 * Every pi SDK touch lives in this file (a future subprocess fallback
 * replaces only this layer).  The SDK is never statically imported: pi's
 * extension loader aliases `@earendil-works/pi-coding-agent` to the bundled
 * entry (verified in `docs/pi-subagent.md`), so the default factories
 * resolve it with a lazily-evaluated dynamic import that only runs inside
 * the pi runtime.  Tests and the smoke script inject their own factories
 * and never load the real SDK.
 *
 * @module
 */

import {
  createStructuredProgress,
  recordOutput,
  recordTokens,
  recordToolCall,
  recordToolStart,
  recordTurn,
  type StructuredProgressState,
  summarizeToolCall,
  toSnapshot,
} from "../../core/subagent/accumulate.js";
import type {
  SubagentDriver,
  SubagentProgress,
  SubagentResult,
} from "../../core/subagent/driver.js";
import { formatSnapshotOutput } from "../../core/subagent/progress.js";
import type { AgentMessage } from "../../core/subagent/result.js";
import { classifyOutcome, reduceMessages } from "../../core/subagent/result.js";
import { log } from "../../utils/logger.js";
import { emitTranscriptEvent } from "./live-transcript.js";

/**
 * Duck-type of the pi `AgentSession` surface the driver uses.
 *
 * Structural subset of pi's `AgentSession`: subscribe (returns an
 * unsubscribe function), prompt (resolves on completion including abort),
 * abort (cancels the current run), and dispose (releases resources).
 */
export interface PiAgentSession {
  subscribe(listener: (event: PiSessionEvent) => void): () => void;
  prompt(text: string): Promise<void>;
  abort(): Promise<void> | void;
  dispose(): void;
}

/**
 * Duck-type of pi's on-disk `SessionManager` (the default `create` result).
 *
 * The driver reads the session id and (when available) the on-disk session
 * file path off it; lineage (the parent-session pointer) is applied at
 * construction time by the session-manager factory.  `getSessionFile` is
 * optional — an in-memory session manager reports no file, and the card
 * then simply omits the session path line.
 */
export interface PiSessionManager {
  getSessionId(): string;
  getSessionFile?(): string | undefined;
}

/**
 * Duck-type of the pi `ModelRuntime` used to resolve a configured model.
 *
 * Only `getModel` is needed: it maps a `provider` / `id` pair back to the
 * pi `Model` object that `createAgentSession` accepts.
 */
export interface PiModelRuntimeLike {
  getModel(provider: string, id: string): unknown;
}

/**
 * Duck-type of a resolved configured model plus its owning runtime.
 *
 * Both are passed to `createAgentSession` together so the session reuses
 * the runtime the model was resolved from instead of building a second one.
 */
export interface PiResolvedModel {
  model: unknown;
  modelRuntime: PiModelRuntimeLike;
}

/**
 * Duck-type of the pi `AgentSession` event stream.
 *
 * The driver reduces `message_end` events (the finalized message) into the
 * `AgentMessage` view, and reads `tool_execution_start` / `tool_execution_end`
 * / `agent_end` for progress snapshots.
 */
export interface PiSessionEvent {
  type: string;
  message?: unknown;
  toolName?: string;
  toolCallId?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  toolResults?: unknown;
}

/**
 * Duck-type of a pi LLM message (`Message` from `@earendil-works/pi-ai`).
 *
 * Only the fields needed for result computation are read: role, content
 * parts, the assistant stop reason, the assistant error message, the
 * tool-result error flag, and the assistant usage report (for token
 * accumulation).
 */
export interface PiDuckMessage {
  role?: string;
  content?: unknown;
  stopReason?: string;
  errorMessage?: string;
  isError?: boolean;
  usage?: { input?: number; output?: number; totalTokens?: number };
}

/** One content part of a pi message (`TextContent | ThinkingContent | ...`). */
interface PiContentPart {
  type?: string;
  text?: string;
}

/**
 * Options handed to the session factory.
 *
 * `tools` is the capability allowlist the driver must forward (it is how
 * the sub-session's tool face is restricted).  `model` / `modelRuntime`
 * carry the resolved configured model (strict mode: the request always
 * carries one).  `sessionManager` is the constructed session manager (with
 * the parent-session pointer).
 */
export interface PiCreateSessionOptions {
  cwd: string;
  tools: string[];
  sessionManager: PiSessionManager;
  model?: unknown;
  modelRuntime?: PiModelRuntimeLike;
}

/** Creates the sub-session (injected in tests; defaults to the pi SDK). */
export type PiSessionFactory = (
  options: PiCreateSessionOptions,
) => Promise<{ session: PiAgentSession }>;

/**
 * Creates the on-disk session manager with an optional parent-session
 * pointer (injected in tests; defaults to the pi SDK `SessionManager`).
 */
export type PiSessionManagerFactory = (
  cwd: string,
  parentSession: string | undefined,
) => Promise<PiSessionManager>;

/**
 * Resolves a `"provider/model"` model string to a pi `Model` object plus its
 * runtime.
 *
 * Strict mode: every subagent request carries a configured model (the tool
 * layer guarantees it), so the driver resolves it against the pi model
 * registry and an unresolvable value is an error — never a silent fallback
 * to the sub-session default.
 */
export type PiModelResolver = (
  model: string,
) => Promise<PiResolvedModel | undefined>;

/**
 * The lazy pi SDK shape the default factories resolve.
 */
interface PiSdkLike {
  createAgentSession: PiSessionFactory;
  SessionManager: {
    create(
      cwd: string,
      sessionDir?: string,
      options?: { parentSession?: string },
    ): PiSessionManager;
  };
  ModelRuntime: {
    create(options?: unknown): Promise<PiModelRuntimeLike>;
  };
}

/** The pi package specifier pi's extension loader aliases to its entry. */
const SDK_SPECIFIER = "@earendil-works/pi-coding-agent";

/** Cached lazy resolution of the pi SDK (module singleton, resolved once). */
let sdkPromise: Promise<PiSdkLike> | undefined;

/** Cached pi `ModelRuntime` (module singleton, created once, read-only). */
let modelRuntimePromise: Promise<PiModelRuntimeLike> | undefined;

/**
 * Resolve the pi SDK entry, caching the promise.
 *
 * The dynamic import specifier is not a static import, so this module loads
 * cleanly outside the pi runtime (tests, typecheck); the import itself only
 * runs when a default factory is exercised inside pi, where the loader's
 * alias makes it resolve.
 *
 * @returns A promise of the SDK shape.
 */
function loadSdk(): Promise<PiSdkLike> {
  sdkPromise ??= import(SDK_SPECIFIER) as Promise<PiSdkLike>;
  return sdkPromise;
}

/**
 * Extract the concatenated text of a pi message's text parts.
 *
 * Thinking, image, and tool-call parts are ignored — only text counts as
 * the message's payload.
 *
 * @param content - The message content (parts array or raw string).
 * @returns The joined text (empty when there is none).
 */
function extractText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter(
      (part): part is PiContentPart =>
        part !== null &&
        typeof part === "object" &&
        (part as PiContentPart).type === "text",
    )
    .map((part) => part.text ?? "")
    .join("");
}

/**
 * Project one finalized pi message onto the host-neutral `AgentMessage` view.
 *
 * Assistant messages carry their stop reason and error flag (a non-empty
 * `errorMessage` marks the message errored); tool results carry their error
 * flag.  Unknown roles are dropped.
 *
 * @param raw - The raw pi message.
 * @returns The projected message, or `undefined` for unknown roles.
 */
function projectMessage(raw: unknown): AgentMessage | undefined {
  if (raw === null || typeof raw !== "object") return undefined;
  const message = raw as PiDuckMessage;
  const text = extractText(message.content);
  switch (message.role) {
    case "assistant":
      return {
        role: "assistant",
        text,
        stopReason: message.stopReason,
        errored:
          typeof message.errorMessage === "string" &&
          message.errorMessage.length > 0,
      };
    case "user":
      return { role: "user", text, errored: false };
    case "toolResult":
      return { role: "toolResult", text, errored: message.isError === true };
    default:
      return undefined;
  }
}

/**
 * Read the stop reason of the last assistant message in the view.
 *
 * The final assistant message's stop reason is the source of truth for
 * outcome classification — `prompt()` does not reject on abort, so the
 * abort/error distinction lives on the message, not on the promise.
 *
 * @param messages - The accumulated message view.
 * @returns The stop reason, or `undefined` when no assistant message exists.
 */
function lastAssistantStopReason(messages: AgentMessage[]): string | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === "assistant") {
      return messages[i].stopReason;
    }
  }
  return undefined;
}

/**
 * Reduce one session event into the message view and progress snapshots.
 *
 * `message_end` events append the finalized message; `tool_execution_start`,
 * `tool_execution_end`, and `agent_end` drive the progress snapshots.  Every
 * snapshot output is the compact form — the last non-empty line of the
 * assistant message text (or the reduced run text), capped by the
 * compact-snapshot formatter — never the full transcript.  The structured
 * view (recent tool calls, recent output, turn/tool counters) is accumulated
 * in `state` and merged into every snapshot so the transcript card can render
 * live state.
 *
 * @param event - The pi session event.
 * @param messages - The accumulating message view.
 * @param state - The structured progress accumulator.
 * @param agent - The subagent (target) name.
 * @param onProgress - Optional progress callback (driver ctx).
 * @param model - The resolved model id (the id part of a `"provider/model"`
 *   string), carried on every snapshot so the transcript card's badge shows
 *   the model actually in use.
 */
function reduceEvent(
  event: PiSessionEvent,
  messages: AgentMessage[],
  state: StructuredProgressState,
  agent: string,
  onProgress?: (progress: SubagentProgress) => void,
  model?: string,
): void {
  // Project the finalized message once; the push and the assistant progress
  // snapshot share the same projected view.
  const projected =
    event.type === "message_end" ? projectMessage(event.message) : undefined;
  if (projected !== undefined) messages.push(projected);
  if (onProgress === undefined) return;
  const modelField = model !== undefined ? { model } : {};
  if (event.type === "tool_execution_start") {
    recordToolStart(state, event.args);
    onProgress({
      agent,
      ...toSnapshot(state),
      ...modelField,
      currentTool: event.toolName,
      output: "",
      done: false,
    });
  } else if (event.type === "tool_execution_end") {
    recordToolCall(
      state,
      event.toolName ?? "tool",
      summarizeToolCall(event.toolName ?? "tool", state.lastToolArgs),
    );
    onProgress({
      agent,
      ...toSnapshot(state),
      ...modelField,
      output: "",
      done: false,
    });
  } else if (event.type === "message_end") {
    if (projected?.role === "assistant") {
      recordTurn(state);
      recordOutput(state, formatSnapshotOutput(projected.text));
      // pi reports per-message usage on assistant messages (input+output+
      // caches, with a totalTokens convenience field).  The total is
      // accumulated so the transcript card can show a running token count;
      // prefer the provider's totalTokens, falling back to input+output.
      const raw = event.message as PiDuckMessage | undefined;
      const usage = raw?.usage;
      const total = usage?.totalTokens ?? 0;
      const tokens =
        total > 0 ? total : (usage?.input ?? 0) + (usage?.output ?? 0);
      recordTokens(state, tokens);
      onProgress({
        agent,
        ...toSnapshot(state),
        ...modelField,
        output: formatSnapshotOutput(projected.text),
        done: false,
      });
    }
  } else if (event.type === "agent_end") {
    onProgress({
      agent,
      ...toSnapshot(state),
      ...modelField,
      output: formatSnapshotOutput(reduceMessages(messages)),
      done: true,
    });
  }
}

/**
 * Extract the model id from a `"provider/model"` model string.
 *
 * The transcript badge shows only the id part (`deepseek-v4-flash`), never
 * the full `provider/model` pair — the provider is implied by the session.
 * A malformed string (no `/`, empty parts) yields `undefined` so the badge
 * stays silent rather than showing a broken id.  For a concatenated value
 * whose model half is a provider-prefixed registry id (e.g.
 * `Volces/volces/deepseek-v4-flash`), the id part is the FULL registry id
 * (`volces/deepseek-v4-flash`) — the badge shows the real id.
 *
 * @param model - The full `"provider/model"` model string.
 * @returns The id part, or `undefined` when the string is malformed.
 */
function modelIdOf(model: string | undefined): string | undefined {
  if (model === undefined) return undefined;
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) return undefined;
  const id = model.slice(slash + 1);
  return id.length > 0 ? id : undefined;
}

/**
 * Options for `createPiSubagentDriver`.
 *
 * Every factory is injectable so tests and the smoke script never load the
 * real SDK; the defaults resolve it lazily inside the pi runtime.
 */
export interface PiSubagentDriverOptions {
  /** Create the sub-session. Defaults to the pi SDK `createAgentSession`. */
  createSession?: PiSessionFactory;
  /**
   * Create the on-disk session manager with a parent-session pointer.
   * Defaults to the pi SDK `SessionManager.create(cwd, undefined, { parentSession })`.
   */
  createSessionManager?: PiSessionManagerFactory;
  /**
   * Resolve a `"provider/model"` model string to a pi model plus runtime.
   * Defaults to a lazy pi SDK resolution via `ModelRuntime`.
   */
  resolveModel?: PiModelResolver;
}

/**
 * Default session-manager factory: the pi SDK's on-disk `SessionManager`
 * with an optional parent-session pointer.
 *
 * @param cwd - The working directory for the sub-session.
 * @param parentSession - Optional parent-session id for lineage.
 * @returns A promise of the constructed session manager.
 */
async function defaultCreateSessionManager(
  cwd: string,
  parentSession: string | undefined,
): Promise<PiSessionManager> {
  const sdk = await loadSdk();
  return sdk.SessionManager.create(
    cwd,
    undefined,
    parentSession !== undefined ? { parentSession } : undefined,
  );
}

/**
 * Default model resolver: pi SDK `ModelRuntime`, reading `~/.pi/agent`.
 *
 * `allowModelNetwork: false` keeps resolution local (no network model
 * refresh on every delegation).  The runtime is created once and cached —
 * it is a read-only model registry, so reuse across delegations is safe
 * and avoids re-reading `models.json` on every run.
 *
 * @param model - The `"provider/model"` model string to resolve.
 * @returns The resolved model and runtime, or `undefined` when unresolvable.
 */
async function defaultResolveModel(
  model: string,
): Promise<PiResolvedModel | undefined> {
  const sdk = await loadSdk();
  modelRuntimePromise ??= sdk.ModelRuntime.create({
    allowModelNetwork: false,
  });
  const modelRuntime = await modelRuntimePromise;
  const slash = model.indexOf("/");
  if (slash <= 0 || slash === model.length - 1) return undefined;
  const provider = model.slice(0, slash);
  const id = model.slice(slash + 1);
  const resolved = modelRuntime.getModel(provider, id);
  if (resolved === undefined) return undefined;
  return { model: resolved, modelRuntime };
}

/**
 * Create the pi subagent driver.
 *
 * The driver executes a subagent as a fresh pi `AgentSession` created
 * through the injected (or default) session factory, reducing the session
 * event stream to the host-neutral message view and classifying the outcome
 * from the final assistant message's stop reason.  The parent abort signal
 * is forwarded to `session.abort()`, and `session.dispose()` always runs in
 * `finally`.  Every SDK-level failure collapses into an `error` result.
 *
 * @param options - Injected factories (defaults resolve the pi SDK lazily).
 * @returns The driver.
 */
export function createPiSubagentDriver(
  options: PiSubagentDriverOptions = {},
): SubagentDriver {
  const createSession =
    options.createSession ??
    (async (opts) => {
      const sdk = await loadSdk();
      return sdk.createAgentSession(opts);
    });
  const createSessionManager =
    options.createSessionManager ?? defaultCreateSessionManager;
  const resolveModel = options.resolveModel ?? defaultResolveModel;

  return {
    async run(request, ctx): Promise<SubagentResult> {
      const { signal, onProgress } = ctx;
      const messages: AgentMessage[] = [];
      // Structured view accumulated for the transcript card; bounded by the
      // accumulator's recency caps.
      const structured = createStructuredProgress();
      // Carries the child session id for the failure log once the session
      // manager exists; stays empty when the failure predates its creation.
      let sessionId = "";
      // The on-disk sub-session file path (pi persists sessions).  Read off
      // the session manager once it exists; stays undefined on hosts without
      // a session-file concept.
      let sessionPath: string | undefined;
      // The model id the sub-session actually runs on (the id part of a
      // `"provider/model"` string).  Strict mode: every run carries a
      // configured model, so the id is set once resolution succeeds.
      let modelId: string | undefined;
      let session: PiAgentSession | undefined;
      let unsubscribe: (() => void) | undefined;
      let aborted = false;
      const onAbort = (): void => {
        aborted = true;
        void session?.abort();
      };
      // Report one progress snapshot to the caller, carrying the resolved
      // child-session id on every snapshot once the session manager exists
      // (so the run registry can associate the run with its sub-session and
      // the fleet widget can rebuild the parent/child tree).  The on-disk
      // sub-session file path is known the moment the session manager is
      // created, so it is carried on every snapshot too — the transcript
      // overlay can be opened (enter-inspect) while the run is still
      // running, reading the growing JSONL at open time.  Before the session
      // manager materialises both are empty and snapshots pass through
      // unchanged.
      const report = (p: SubagentProgress): void => {
        if (typeof onProgress !== "function") return;
        onProgress(
          sessionId !== "" || sessionPath !== undefined
            ? {
                ...p,
                ...(sessionId !== "" ? { childSession: sessionId } : {}),
                ...(sessionPath !== undefined ? { sessionPath } : {}),
              }
            : p,
        );
      };
      // Emit the final done snapshot carrying the run result, so the
      // transcript card transitions to its terminal state.  The compact
      // text stays capped (never the full transcript); the structured
      // `result` carries the full text for the card's terminal rendering.
      // Defensive: a throwing progress callback must not break the run.
      const emitDone = (result: SubagentResult): void => {
        if (typeof onProgress !== "function") return;
        try {
          report({
            agent: request.agent,
            ...toSnapshot(structured),
            ...(modelId !== undefined ? { model: modelId } : {}),
            ...(sessionPath !== undefined ? { sessionPath } : {}),
            output: formatSnapshotOutput(result.text),
            done: true,
            result,
          });
        } catch {
          // A throwing progress callback is logged and swallowed — live
          // observability never breaks the run.
        }
      };

      try {
        const cwd = process.cwd();
        const sessionManager = await createSessionManager(
          cwd,
          request.parentSession,
        );
        sessionId = sessionManager.getSessionId();
        sessionPath =
          typeof sessionManager.getSessionFile === "function"
            ? sessionManager.getSessionFile()
            : undefined;
        log("subagent-driver", "session_start", sessionId, undefined, "debug", {
          agent: request.agent,
          ...(sessionPath !== undefined ? { sessionPath } : {}),
        });

        // Resolve the configured model against the pi model registry.  The
        // tool layer guarantees `request.model` is present (strict mode:
        // agents.json is the sole source); an unresolvable value is an
        // error — never a silent fallback to the sub-session default.
        const resolved = await resolveModel(request.model);
        if (resolved === undefined) {
          const errorMessage = `子 agent 模型解析失败：配置的模型 "${request.model}" 无法在 pi 模型注册表中解析（provider 或 id 不存在）。请检查 ~/.pi/agent/agents.json 中 "${request.agent}" 的 provider/model 配置后重试。`;
          log(
            "subagent-driver",
            "model_resolution_failed",
            sessionId,
            undefined,
            "warn",
            {
              agent: request.agent,
              model: request.model,
            },
          );
          const result: SubagentResult = {
            kind: "error",
            text: "",
            errorMessage,
          };
          emitDone(result);
          return result;
        }
        modelId = modelIdOf(request.model);
        const { session: created } = await createSession({
          cwd,
          tools: request.tools,
          sessionManager,
          model: resolved.model,
          modelRuntime: resolved.modelRuntime,
        });
        session = created;
        unsubscribe = session.subscribe((event) => {
          // Forward the raw session events onto the live-transcript bus so
          // an open transcript overlay renders the run's new content
          // event-driven: assistant streaming partials, finalized messages,
          // the tool-execution bookends (live tool components), and the
          // `agent_end` run-end marker.  The bus is keyed by the child
          // session id — the same pointer the registry run carries, which
          // the overlay looks up to subscribe.  Emitting is a no-op when no
          // overlay is open for this session; events the overlay does not
          // render are dropped at the bus boundary.
          emitTranscriptEvent(sessionId, event);
          reduceEvent(
            event,
            messages,
            structured,
            request.agent,
            report,
            modelId,
          );
        });

        // The abort listener is attached only when the run has not already
        // been cancelled; a pre-aborted signal skips the prompt entirely.
        if (signal.aborted) {
          aborted = true;
        } else {
          signal.addEventListener("abort", onAbort, { once: true });
        }

        if (!aborted) {
          await session.prompt(request.prompt);
        }
        if (aborted) {
          const result: SubagentResult = {
            kind: "aborted",
            text: reduceMessages(messages),
          };
          emitDone(result);
          return result;
        }

        const stopReason = lastAssistantStopReason(messages);
        const result = classifyOutcome({ stopReason, messages });
        emitDone(result);
        return result;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);
        log("subagent-driver", "sdk_error", sessionId, undefined, "warn", {
          agent: request.agent,
          error: errorMessage,
        });
        const result: SubagentResult = {
          kind: "error",
          text: reduceMessages(messages),
          errorMessage,
        };
        emitDone(result);
        return result;
      } finally {
        signal.removeEventListener("abort", onAbort);
        unsubscribe?.();
        session?.dispose();
      }
    },
  };
}
