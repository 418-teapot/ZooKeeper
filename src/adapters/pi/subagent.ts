/**
 * Pi subagent driver — in-process `AgentSession` execution via the pi SDK.
 *
 * Implements the host-agnostic `SubagentDriver` contract against pi's SDK
 * factory (`createAgentSession`): a run creates a sub-session carrying the
 * request's tool allowlist and configured model, subscribes to its events,
 * appends every observed fact to the run's append-only log (`run-log.ts`)
 * untruncated, streams a running assistant message's partial content (text
 * and thinking) onto that log's transient (non-fact) partial as
 * `message_update` events arrive,
 * calls the pi SDK `prompt(text)` with the request's prompt,
 * and classifies the outcome from the final assistant message's
 * `stopReason`.  Termination
 * is wired end to end: the parent
 * abort signal aborts the sub-session, and `dispose()` always runs in
 * `finally`.  Any SDK-level failure collapses into an `error` result — a
 * run never rejects and never throws, per the driver contract.
 *
 * The driver also maintains the run's running token total incrementally: it
 * folds each assistant `message_end`'s usage into the sum as it appends the
 * fact and reports the sum on every progress report, so consumers never
 * have to rescan the fact log to render a counter.
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

import type {
  SubagentDriver,
  SubagentProgress,
  SubagentResult,
} from "../../core/subagent/driver.js";
import type { AgentMessage } from "../../core/subagent/result.js";
import { classifyOutcome, reduceMessages } from "../../core/subagent/result.js";
import type {
  MessagePart,
  RunLog,
  TextPart,
  Usage,
} from "../../core/subagent/run-log.js";
import { usageTokens } from "../../core/subagent/run-log.js";
import { log } from "../../utils/logger.js";

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
 * The driver records `message_end` events (the finalized message) into the
 * `AgentMessage` view and the run's fact log, reads
 * `tool_execution_start` / `tool_execution_end` as tool facts, and reports
 * the run's progress as it advances.
 */
export interface PiSessionEvent {
  type: string;
  message?: unknown;
  toolName?: string;
  toolCallId?: string;
  args?: Record<string, unknown>;
  result?: unknown;
  isError?: boolean;
  toolResults?: unknown;
  /**
   * The raw streaming delta envelope pi attaches to a `message_update`
   * event.  The driver does not read it — pi's `message` field on the same
   * event already carries the accumulated partial message — but it is part
   * of the host's event shape this duck-type mirrors.
   */
  assistantMessageEvent?: unknown;
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
  thinking?: string;
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
 * The finite numeric usage fields of one pi message (`number` only).
 *
 * @param value - The raw usage field.
 * @returns The number, or `undefined` when absent or not finite.
 */
function usageNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value)
    ? value
    : undefined;
}

/**
 * Map a pi usage envelope onto the run-log usage report.
 *
 * @param usage - The raw per-message usage, when the provider reported one.
 * @returns The usage report, or `undefined` when nothing was reported.
 */
function toUsage(usage: PiDuckMessage["usage"]): Usage | undefined {
  if (usage === null || typeof usage !== "object") return undefined;
  const input = usageNumber(usage.input);
  const output = usageNumber(usage.output);
  const totalTokens = usageNumber(usage.totalTokens);
  if (
    input === undefined &&
    output === undefined &&
    totalTokens === undefined
  ) {
    return undefined;
  }
  return {
    ...(input !== undefined ? { input } : {}),
    ...(output !== undefined ? { output } : {}),
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}

/**
 * The text parts of a finalized pi message, or of a pi tool result.
 *
 * Thinking, image, and tool-call parts are dropped: no projection renders
 * them yet, so the run log records only text for these two fact kinds.
 *
 * @param content - The raw content (parts array or plain string).
 * @returns The text parts in order (empty when there are none).
 */
function toTextParts(content: unknown): TextPart[] {
  const parts: TextPart[] = [];
  for (const part of contentParts(content)) {
    if (part.type === "text" && typeof part.text === "string") {
      parts.push({ type: "text", text: part.text });
    }
  }
  return parts;
}

/**
 * The content parts (text + thinking) of a pi message.
 *
 * Used for both a finalized `message_end` and the accumulated partial message
 * a `message_update` carries, so a streamed message and its finalized fact
 * project through one mapping and can never disagree on shape or order.
 * Tool-call and image parts are dropped (no projection renders them).
 *
 * @param content - The raw content (parts array or plain string).
 * @returns The message parts in order (empty when there are none).
 */
function toMessageParts(content: unknown): MessagePart[] {
  const parts: MessagePart[] = [];
  for (const part of contentParts(content)) {
    if (part.type === "text" && typeof part.text === "string") {
      parts.push({ type: "text", text: part.text });
    } else if (part.type === "thinking" && typeof part.thinking === "string") {
      parts.push({ type: "thinking", thinking: part.thinking });
    }
  }
  return parts;
}

/**
 * Normalize a pi content payload into its object-shaped parts.
 *
 * pi reports message and tool-result content either as a plain string or as
 * an array of typed parts; anything else yields no parts.
 *
 * @param content - The raw content (parts array or plain string).
 * @returns The parts worth inspecting (a string becomes a single text part).
 */
function contentParts(content: unknown): PiContentPart[] {
  if (typeof content === "string") return [{ type: "text", text: content }];
  if (!Array.isArray(content)) return [];
  return content.filter(
    (part): part is PiContentPart => part !== null && typeof part === "object",
  );
}

/**
 * Stream one observed pi session event onto the run log's forming head.
 *
 * Assistant content arrives token by token as `message_update` events, each
 * carrying the accumulated partial message — pi's own stream state, whose
 * `content` array already holds every text and thinking block assembled so
 * far, in order.  The driver therefore maps that message with the SAME
 * projection the finalized fact uses (`toMessageParts`) rather than
 * re-accumulating the `assistantMessageEvent` deltas itself: re-summing
 * would duplicate bookkeeping pi already does, and would have to reinvent
 * the interleaving order pi's content array gives for free.  The log holds
 * the result as transient projection state (never a fact) so an open
 * transcript overlay can render it live — thinking included.
 *
 * The finalized `message_end` retires it mechanically: `RunLog.append`
 * delivers the empty-partial event before its fact event, so the driver
 * never clears on that path.  A stream cut before any fact lands — the turn
 * ending at `agent_end` — sends the end-of-stream marker (`setPartial([])`)
 * so no half-message outlives the run.
 *
 * Only assistant messages stream: pi emits user and tool-result messages
 * whole (their `message_start` / `message_end` back to back), so their update
 * events carry nothing to render incrementally.
 *
 * @param log - The run's data stream.
 * @param event - The pi session event.
 */
function streamRunPartial(log: RunLog, event: PiSessionEvent): void {
  if (event.type === "agent_end") {
    log.setPartial([]);
    return;
  }
  if (event.type !== "message_update") return;
  const message = event.message as PiDuckMessage | undefined;
  if (message?.role !== "assistant") return;
  log.setPartial(toMessageParts(message.content));
}

/**
 * Append one observed pi session event to the run's fact log.
 *
 * The log's fact kinds mirror pi's events one-to-one, so the driver appends
 * them without adaptation: `tool_execution_start` records the FULL
 * untruncated call args, `tool_execution_end` records the result's text
 * parts and its error flag, and an assistant `message_end` records the
 * message's content parts with its usage report.  Any other event (user or
 * tool-result messages, lifecycle markers) carries no run-level fact.
 *
 * The user-message fact is NOT derived here: pi does echo the sent prompt
 * back as a user `message_end`, but the driver appends that fact once at the
 * send point instead (see `run()`), so the transcript always opens with the
 * instruction.  The assistant-only guard on the `message_end` branch is what
 * keeps that prompt from being recorded twice.
 *
 * @param log - The run's append-only fact log.
 * @param event - The pi session event.
 */
function appendRunFact(log: RunLog, event: PiSessionEvent): void {
  switch (event.type) {
    case "tool_execution_start":
      log.appendToolStart(
        event.toolName ?? "tool",
        event.args ?? {},
        undefined,
        event.toolCallId,
      );
      break;
    case "tool_execution_end":
      log.appendToolEnd(
        event.toolName ?? "tool",
        toTextParts(
          (event.result as { content?: unknown } | undefined)?.content,
        ),
        event.isError === true,
        undefined,
        event.toolCallId,
      );
      break;
    case "message_end": {
      const message = event.message as PiDuckMessage | undefined;
      // Assistant messages only.  The user branch is load-bearing, not
      // dead: pi emits a `message_end` for the prompt it was handed
      // (pi-agent-core agent-loop), and the run's `user_message` fact is
      // appended once at the send point — falling through here would render
      // the instruction twice in the transcript overlay.
      if (message?.role !== "assistant") break;
      log.appendMessage(
        toMessageParts(message.content),
        toUsage(message.usage),
      );
      break;
    }
    default:
      break;
  }
}

/**
 * Record one observed session event.
 *
 * Finalized messages are projected onto the host-neutral `AgentMessage`
 * view — the outcome classifier reads that view when the run settles — and
 * every loggable fact is appended to the run's log, untruncated.  Streamed
 * assistant content (text and thinking) is pushed onto the log's transient
 * partial before the fact paths run, so a finalized message's append always
 * wins over the partial it streamed into.
 *
 * @param event - The pi session event.
 * @param messages - The accumulating message view (mutated in place).
 * @param log - The run's append-only fact log, when the caller owns one.
 */
function observe(
  event: PiSessionEvent,
  messages: AgentMessage[],
  log?: RunLog,
): void {
  if (log !== undefined) streamRunPartial(log, event);
  const projected =
    event.type === "message_end" ? projectMessage(event.message) : undefined;
  if (projected !== undefined) messages.push(projected);
  if (log !== undefined) appendRunFact(log, event);
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
      // The run's append-only fact log, owned by the caller (the run
      // registry).  Every observed fact is appended to it untruncated;
      // views project from it at their own render boundary.
      const runLog = ctx.log;
      const messages: AgentMessage[] = [];
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
      // The running token total, folded in from each assistant message's
      // usage report as its fact is appended.  Stays undefined while no
      // message has reported positive usage, so the progress line omits the
      // token segment instead of showing a zero.
      let tokensTotal: number | undefined;
      let session: PiAgentSession | undefined;
      let unsubscribe: (() => void) | undefined;
      let aborted = false;
      const onAbort = (): void => {
        aborted = true;
        void session?.abort();
      };
      // Report one progress update to the caller, carrying the resolved
      // child-session id on every report once the session manager exists (so
      // the run registry can associate the run with its sub-session and the
      // fleet widget can rebuild the parent/child tree).  The on-disk
      // sub-session file path is known the moment the session manager is
      // created, so it is carried on every report too — the transcript
      // overlay can be opened (enter-inspect) while the run is still
      // running, reading the growing JSONL at open time.  The running token
      // total rides along once any message has reported usage.  Before the
      // session manager materialises both are absent and the report passes
      // through unchanged.
      const report = (p: SubagentProgress): void => {
        if (typeof onProgress !== "function") return;
        onProgress({
          ...p,
          ...(modelId !== undefined ? { model: modelId } : {}),
          ...(sessionId !== "" ? { childSession: sessionId } : {}),
          ...(sessionPath !== undefined ? { sessionPath } : {}),
          ...(tokensTotal !== undefined ? { tokens: tokensTotal } : {}),
        });
      };
      // Report the progress for one observed event.  The tool layer patches
      // the report's fields (current tool, token total, model, session ids)
      // onto the registry run; structure never travels here — the log
      // already carries it.
      const reportEvent = (event: PiSessionEvent): void => {
        switch (event.type) {
          case "tool_execution_start":
            report({ currentTool: event.toolName ?? "tool", done: false });
            break;
          case "tool_execution_end":
            // Explicit clear: the finished tool's name must not linger as
            // the running title between calls.  `null` is the "no current
            // tool" signal — an absent field would mean "leave unchanged".
            report({ currentTool: null, done: false });
            break;
          case "message_end": {
            const message = event.message as PiDuckMessage | undefined;
            if (message?.role !== "assistant") break;
            // Fold this message's usage into the running total the report
            // carries (the fact log holds the same numbers; rescanning it
            // per tick would cost O(n) for every advance).
            const reported = usageTokens(toUsage(message.usage));
            if (reported !== undefined)
              tokensTotal = (tokensTotal ?? 0) + reported;
            report({ done: false });
            break;
          }
          default:
            break;
        }
      };
      // Emit the terminal progress report marking the stream settled; the
      // full result text goes to the log with the run's messages.
      // Defensive: a throwing progress callback must not break the run.
      const emitDone = (): void => {
        try {
          report({ done: true });
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
          emitDone();
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
          // Record the event: the message view feeds the outcome
          // classification, the run's fact log is the durable, untruncated
          // record that every view projects from.
          observe(event, messages, runLog);
          reportEvent(event);
        });

        // The abort listener is attached only when the run has not already
        // been cancelled; a pre-aborted signal skips the prompt entirely.
        if (signal.aborted) {
          aborted = true;
        } else {
          signal.addEventListener("abort", onAbort, { once: true });
        }

        if (!aborted) {
          // Record the instruction the run was started with before sending
          // it: the transcript overlay projects this fact as the head of the
          // transcript (pi's native user-message box).  Appending it at the
          // send point — rather than from the echoed user `message_end` —
          // fixes both its presence and its position, whatever the host's
          // event ordering is.
          runLog?.appendUserMessage(request.prompt);
          await session.prompt(request.prompt);
        }
        if (aborted) {
          const result: SubagentResult = {
            kind: "aborted",
            text: reduceMessages(messages),
          };
          emitDone();
          return result;
        }

        const stopReason = lastAssistantStopReason(messages);
        const result = classifyOutcome({ stopReason, messages });
        emitDone();
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
        emitDone();
        return result;
      } finally {
        signal.removeEventListener("abort", onAbort);
        unsubscribe?.();
        // A run that ended without its final `message_end` (abort, SDK
        // failure) must not leave a transient partial behind for a surface
        // that might still be reading the log.  The empty list is the
        // stream's end-of-stream marker, not a fact.
        runLog?.setPartial([]);
        session?.dispose();
      }
    },
  };
}
