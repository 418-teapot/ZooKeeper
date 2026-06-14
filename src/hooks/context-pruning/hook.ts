/**
 * Context pruning adapter — converts OpenCode messages to/from MessageRef format
 * and calls the framework-agnostic context-pruning pipeline.
 *
 * Exports four handlers that are wired into OpenCode hooks:
 *   1. `handleMessagesTransform` — for `experimental.chat.messages.transform`
 *   2. `handleToolBefore` — for `tool.execute.before` (dedup tracking)
 *   3. `handleToolAfter` — for `tool.execute.after` (error tracking)
 *   4. `handleSessionCleanup` — for session cleanup
 *
 * All handlers are async and wrap their logic in try-catch so that any failure
 * is logged but never crashes the plugin.
 *
 * @module
 */

import config from "../../../config.toml" with { type: "toml" };
import { loadContextConfig } from "../../context-pruning/config-loader";
import { runPipeline } from "../../context-pruning/pipeline";
import { globalState } from "../../context-pruning/state";
import type {
  ContextPruningConfig,
  MessageRef,
  PipelineOutput,
  ToolCallRef,
  ToolResultRef,
} from "../../context-pruning/types";
import { log } from "../../utils/logger.js";

// ---------------------------------------------------------------------------
// Constants — metadata keys stored on MessageRef for back-mapping
// ---------------------------------------------------------------------------

const OC_METADATA_KEY = "__zoo_oc_idx";

// ── Session lifecycle tracking ──────────────────────────────
let _lastSeenSessionId: string | null = null;
const _lastMessageCountBySession = new Map<string, number>();

const COMPACTION_KEYWORDS: readonly string[] = [
  "compressed",
  "summary",
  "messages have been summarized",
  "context pruning",
  "compression",
];

// ---------------------------------------------------------------------------
// OpenCode message shape types (local interfaces, not from SDK)
// ---------------------------------------------------------------------------

interface OpenCodeMessageInfo {
  id: string;
  role: string;
  sessionID?: string;
  agent?: string;
  [key: string]: unknown;
}

interface TextPart {
  type: "text";
  text: string;
}

interface ToolPart {
  type: "tool";
  tool: string;
  id: string;
  state: {
    status: string;
    input?: Record<string, unknown>;
    output?: string;
    error?: string;
    [key: string]: unknown;
  };
}

type MessagePart = TextPart | ToolPart;

interface OpenCodeMessage {
  info: OpenCodeMessageInfo;
  parts: MessagePart[];
}

interface TransformOutput {
  messages?: OpenCodeMessage[];
}

// ---------------------------------------------------------------------------
// Conversion helpers
// ---------------------------------------------------------------------------

/**
 * Convert OpenCode messages to framework-agnostic MessageRef[].
 *
 * Filters out malformed messages where:
 *   - info.id is absent (undefined/empty)
 *   - info.role is not one of "user", "assistant", "system", "tool"
 *   - parts is not an array or is empty
 *
 * For each valid OpenCode message:
 *   - id      = info.id
 *   - role    = info.role, normalised to the MessageRef union type
 *   - content = concatenation of all text parts
 *   - toolCalls  = extracted from **assistant** messages whose parts include
 *                  tool entries with a "running" or "pending" status
 *   - toolResults = extracted from **tool** role messages
 *
 * A back-reference (`__zoo_oc_idx`) is stored in `metadata` so that pipeline
 * output can be applied back to the correct OpenCode message.
 *
 * @param messages - Raw OpenCode messages from `output.messages`.
 * @returns An array of MessageRef ready for the context-pruning pipeline.
 */
function convertOpenCodeToMessageRefs(
  messages: OpenCodeMessage[],
): MessageRef[] {
  const refs: MessageRef[] = [];

  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];

    // ── Filter malformed messages ──────────────────────────
    const rawId: string | undefined = msg.info?.id;
    const rawRole = msg.info?.role;
    const parts = msg.parts;
    if (!rawId || !rawRole) continue;
    if (!["user", "assistant", "system", "tool"].includes(rawRole)) continue;
    if (!Array.isArray(parts) || parts.length === 0) continue;

    const id = rawId;
    const role = rawRole as MessageRef["role"];

    // Concatenate all text parts into a single content string
    const textParts: TextPart[] = msg.parts.filter(
      (p): p is TextPart => p.type === "text",
    );
    const content: string = textParts.map((p) => p.text).join("");

    const ref: MessageRef = {
      id,
      role,
      content,
      metadata: { [OC_METADATA_KEY]: i },
    };

    // ── Tool calls (assistant messages) ─────────────────
    if (role === "assistant") {
      const toolParts: ToolPart[] = msg.parts.filter(
        (p): p is ToolPart => p.type === "tool",
      );
      const calls: ToolCallRef[] = toolParts
        .filter(
          (p) => p.state?.status === "running" || p.state?.status === "pending",
        )
        .map((p) => ({
          id: p.id,
          toolName: p.tool,
          parameters: (p.state?.input as Record<string, unknown>) ?? {},
        }));
      if (calls.length > 0) {
        ref.toolCalls = calls;
      }
    }

    // ── Tool results (tool role messages) ───────────────
    if (role === "tool") {
      const toolParts: ToolPart[] = msg.parts.filter(
        (p): p is ToolPart => p.type === "tool",
      );
      if (toolParts.length > 0) {
        ref.toolResults = toolParts.map((p) => {
          const result: ToolResultRef = {
            id: p.id,
            toolCallId: p.id,
            output: p.state?.output ?? content,
          };
          if (p.state?.status === "error") {
            result.isError = true;
            result.error = p.state?.error ?? p.state?.output ?? content;
          }
          return result;
        });
      }
    }

    refs.push(ref);
  }

  return refs;
}

/**
 * Update a single OpenCode message's parts from a pipeline-processed MessageRef.
 *
 * - Replaces the first text part's content with the ref's content
 * - Updates any tool part whose `id` matches a `toolCallId` in the ref's
 *   toolResults (handles pruning replacements)
 *
 * @param ocMsg - The OpenCode message to mutate.
 * @param ref - The pipeline-processed MessageRef with updated fields.
 */
function updateOpenCodeMessage(ocMsg: OpenCodeMessage, ref: MessageRef): void {
  // ── Sync info.id with pipeline-assigned ID ──────────
  ocMsg.info.id = ref.id;

  // ── Text content ────────────────────────────────────
  if (ref.content) {
    const textPart = ocMsg.parts.find((p): p is TextPart => p.type === "text");
    if (textPart) {
      textPart.text = ref.content;
    } else {
      ocMsg.parts.push({ type: "text", text: ref.content });
    }
  }

  // Pre-compute tool parts matching for both toolResults and toolCalls
  const toolParts: ToolPart[] = ocMsg.parts.filter(
    (p): p is ToolPart => p.type === "tool",
  );

  // ── Tool results (pruned or otherwise changed) ──────
  if (ref.toolResults && ref.toolResults.length > 0) {
    for (const tr of ref.toolResults) {
      const matching = toolParts.find((p) => p.id === tr.toolCallId);
      if (matching?.state) {
        matching.state.output = tr.output;
        if (tr.isError) {
          matching.state.status = "error";
          matching.state.error = tr.error ?? tr.output;
        }
      }
    }
  }

  // ── Tool calls (pruned parameters) ──────────────────
  if (ref.toolCalls && ref.toolCalls.length > 0) {
    for (const tc of ref.toolCalls) {
      const matching = toolParts.find((p) => p.id === tc.id);
      if (matching?.state && tc.parameters) {
        // Propagate parameter changes (e.g., pruning replaces parameters
        // with {pruned: true, reason: "..."} for errored tool calls)
        if (matching.state.input !== tc.parameters) {
          matching.state.input = tc.parameters as Record<string, unknown>;
        }
      }
    }
  }
}

/**
 * Convert a pipeline MessageRef into an OpenCode message entry.
 *
 * Used for messages the pipeline creates (e.g. compression placeholders)
 * that have no corresponding original OpenCode message.
 *
 * @param ref - The pipeline MessageRef to convert.
 * @param sessionId - Session identifier to attach to the new message.
 * @returns A new OpenCode message object.
 */
function messageRefToOpenCode(
  ref: MessageRef,
  sessionId: string,
): OpenCodeMessage {
  const parts: MessagePart[] = [{ type: "text", text: ref.content }];

  if (ref.toolCalls) {
    for (const tc of ref.toolCalls) {
      parts.push({
        type: "tool" as const,
        tool: tc.toolName,
        id: tc.id,
        state: {
          status: "running",
          input: tc.parameters as Record<string, unknown>,
        },
      });
    }
  }

  if (ref.toolResults) {
    for (const tr of ref.toolResults) {
      parts.push({
        type: "tool" as const,
        tool: "",
        id: tr.toolCallId,
        state: {
          status: tr.isError ? "error" : "success",
          output: tr.output,
          ...(tr.isError && tr.error ? { error: tr.error } : {}),
        },
      });
    }
  }

  return {
    info: {
      id: ref.id,
      role: ref.role,
      sessionID: sessionId,
    },
    parts,
  };
}

/**
 * Apply pipeline results back to OpenCode output.messages.
 *
 * Mutates `output.messages` in place:
 *   1. Updates existing messages whose MessageRef carries a back-reference
 *   2. Appends new messages created by the pipeline (compression placeholders)
 *   3. Removes messages that were filtered out (malformed) by the pipeline
 *   4. Prepends nudge system messages
 *
 * @param output - The OpenCode transform output to mutate.
 * @param pipelineOutput - The result returned by `runPipeline`.
 * @param sessionId - Current session identifier for new messages.
 */
function applyPipelineToOpenCode(
  output: TransformOutput,
  pipelineOutput: PipelineOutput,
  sessionId: string,
): void {
  const { messages: pipelineMessages, nudges } = pipelineOutput;
  const ocMessages = output.messages;
  if (!ocMessages) return;

  const newMessages: OpenCodeMessage[] = [];

  // ── Pass 1: update existing or append new ──────────
  for (const ref of pipelineMessages) {
    const ocIdx = ref.metadata?.[OC_METADATA_KEY] as number | undefined;
    if (ocIdx !== undefined && ocIdx < ocMessages.length) {
      // This ref originated from an OpenCode message — update it in place
      // and carry it forward into the new message array.
      updateOpenCodeMessage(ocMessages[ocIdx], ref);
      newMessages.push(ocMessages[ocIdx]);
    } else {
      // Pipeline-created message (e.g. compression placeholder)
      newMessages.push(messageRefToOpenCode(ref, sessionId));
    }
  }

  // ── Pass 2: inject nudges as system messages ──────
  if (nudges && nudges.length > 0) {
    const now = Date.now();
    const nudgeMessages: OpenCodeMessage[] = nudges.map((text, idx) => ({
      info: {
        id: `nudge-${now}-${idx}`,
        role: "system",
        sessionID: sessionId,
      },
      parts: [{ type: "text" as const, text }],
    }));
    newMessages.unshift(...nudgeMessages);
  }

  // Replace the entire array with our reconstructed one
  output.messages = newMessages;
}

// ---------------------------------------------------------------------------
// Sub-agent session detection
// ---------------------------------------------------------------------------

/**
 * Set of agent names that indicate a sub-agent session.
 *
 * In OpenCode, sub-agent sessions are spawned by `task()` and carry one of
 * these agent names in the first message's `info.agent` field.
 */
const SUB_AGENT_NAMES = new Set(["explore", "general", "spider"]);

/**
 * Detect whether the messages belong to a sub-agent session.
 *
 * Sub-agent sessions should be skipped by the context-pruning pipeline to
 * avoid wasting resources and interfering with sub-agent operation.
 *
 * Two detection strategies:
 *   1. **Primary** — check `messages[0]?.info?.agent` against known
 *      sub-agent names (`explore`, `general`, `spider`).
 *   2. **Fallback** — scan the first few system messages for textual
 *      patterns that suggest task delegation to a sub-agent.
 *
 * @param messages - Raw OpenCode messages from the transform output.
 * @returns The detected sub-agent name, or `null` if this is not a sub-agent
 *   session.
 */
function isSubAgentSession(messages: OpenCodeMessage[]): string | null {
  if (!messages || messages.length === 0) return null;

  const firstMsg = messages[0];
  if (firstMsg?.info?.agent && SUB_AGENT_NAMES.has(firstMsg.info.agent)) {
    return firstMsg.info.agent;
  }

  // Fallback: scan the first 5 messages for delegation-related system messages
  const maxScan = Math.min(messages.length, 5);
  for (let i = 0; i < maxScan; i++) {
    const msg = messages[i];
    if (msg?.info?.role === "system") {
      const textParts =
        msg.parts?.filter((p): p is TextPart => p.type === "text") ?? [];
      const content = textParts
        .map((p) => p.text)
        .join(" ")
        .toLowerCase();

      for (const name of SUB_AGENT_NAMES) {
        if (
          content.includes(name) &&
          (content.includes("task") ||
            content.includes("delegat") ||
            content.includes("assign") ||
            content.includes("agent"))
        ) {
          return name;
        }
      }
    }
  }

  return null;
}

// ── Session lifecycle helpers ───────────────────────────────

/**
 * Find sessionID from the last user message (iterate backward).
 *
 * This is authoritative over fallback session IDs from other sources
 * because the last user message always carries the current session.
 *
 * @param messages - The OpenCode messages array.
 * @returns The sessionID string, or null if no user message has one.
 */
function findLastUserSessionId(messages: OpenCodeMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    const sid = msg?.info?.sessionID;
    if (msg?.info?.role === "user" && sid) {
      return sid;
    }
  }
  return null;
}

/**
 * Scan messages for compaction indicators.
 *
 * Two detection methods:
 *   1. Scans all system messages for compaction-related keywords that
 *      OpenCode adds when it compacts conversation history.
 *   2. Scans all assistant messages for `info.summary === true`, which
 *      is OpenCode's authoritative compaction marker.
 *
 * @param messages - The OpenCode messages array.
 * @returns True when compaction is detected via either method.
 */
function detectCompactionInMessages(messages: OpenCodeMessage[]): boolean {
  // Method 1: keyword match in system messages (heuristic)
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.info?.role !== "system") continue;
    const textParts = (msg.parts ?? []).filter(
      (p): p is TextPart => p.type === "text",
    );
    if (textParts.length === 0) continue;
    const content = textParts
      .map((p) => p.text)
      .join(" ")
      .toLowerCase();
    for (const keyword of COMPACTION_KEYWORDS) {
      if (content.includes(keyword)) {
        return true;
      }
    }
  }

  // Method 2: info.summary flag on assistant messages (authoritative marker)
  for (const msg of messages) {
    if (msg?.info?.role === "assistant" && msg.info.summary === true) {
      return true;
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// Config loading helper
// ---------------------------------------------------------------------------

/**
 * Load context pruning configuration from config.toml.
 *
 * When the TOML is unavailable or malformed the function logs a warning and
 * returns a conservative default with pruning **disabled** (enabled=false)
 * so that a broken config never silently enables pruning.
 *
 * @param enabledDefault - Default for the `enabled` flag when config loading
 *   fails entirely (catch block). The normal loading path reads `enabled`
 *   from config.toml directly.
 * @returns A fully resolved ContextPruningConfig.
 */
function loadConfig(enabledDefault: boolean = false): ContextPruningConfig {
  try {
    const rawToml = config as Record<string, unknown>;
    const zooSection = (rawToml?.zoo ?? {}) as Record<string, unknown>;
    return loadContextConfig(zooSection);
  } catch (err) {
    log("context-pruning", "config_load_failed", "", undefined, "warn", {
      error: String(err),
      enabledDefault,
    });
    // Return a minimal default config with pruning disabled — conservative
    // when the TOML is unavailable or malformed.
    return loadContextConfig(
      { context: { enabled: enabledDefault } },
      undefined,
    );
  }
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * Handle `experimental.chat.messages.transform`.
 *
 * Steps:
 *   1. Extract session ID from the **last user message** (iterate backward)
 *   2. Detect session changes and clean up stale state
 *   3. Detect compaction (message count drop >50% or compaction keywords in system messages)
 *   4. Skip if sub-agent session
 *   5. Skip if no session ID or pruning is disabled in config
 *   6. Convert OpenCode messages → MessageRef[] (filters malformed messages)
 *   7. Call `runPipeline` every turn (dedup + purge-errors + prune + nudge)
 *   8. Apply pipeline results back to OpenCode output.messages
 *
 * syncCompressionBlocks runs inside runPipeline after ID assignment (P3),
 * so it sees the final mNNNN-format IDs.  There is no separate
 * prepareSession call — state init is handled by runPipeline.
 *
 * All errors are caught and logged — the hook never crashes.
 *
 * @param _input - Hook input (unused).
 * @param output - Hook output whose `messages` array is mutated in place.
 */
export async function handleMessagesTransform(
  _input: Record<string, never>,
  output: TransformOutput,
): Promise<void> {
  try {
    const messages = output.messages;
    if (!messages || messages.length === 0) return;

    // ── 1. Session ID from last user message (authoritative) ──
    const sessionId = findLastUserSessionId(messages);
    if (!sessionId) {
      log("context-pruning", "transform_skipped", "", undefined, "debug", {
        reason: "no_session_id",
      });
      return;
    }

    // ── 2. Session change detection ───────────────────────────
    if (_lastSeenSessionId !== null && sessionId !== _lastSeenSessionId) {
      globalState.delete(_lastSeenSessionId);
      _lastMessageCountBySession.delete(_lastSeenSessionId);
      log("context-pruning", "session_change", sessionId, undefined, "info", {
        from: _lastSeenSessionId,
        to: sessionId,
      });
    }
    _lastSeenSessionId = sessionId;

    // ── 2.5 TTL eviction check ────────────────────────────
    // globalState periodically TTL-evicts stale sessions via setInterval.
    // When a session was evicted, clean our local tracking Maps as well.
    if (globalState.get(sessionId) === undefined) {
      _lastMessageCountBySession.delete(sessionId);
      if (_lastSeenSessionId === sessionId) {
        _lastSeenSessionId = null;
      }
    }

    // ── 3. Compaction detection ───────────────────────────────
    const prevCount = _lastMessageCountBySession.get(sessionId);
    const countDropped =
      prevCount !== undefined && messages.length <= prevCount * 0.5;
    const hasCompactionContent = detectCompactionInMessages(messages);
    if (countDropped || hasCompactionContent) {
      globalState.delete(sessionId);
      _lastMessageCountBySession.delete(sessionId);
      log(
        "context-pruning",
        "compaction_detected",
        sessionId,
        undefined,
        "info",
        {
          messageCountDrop: countDropped,
          compactionContent: hasCompactionContent,
          previousCount: prevCount,
          currentCount: messages.length,
        },
      );
    }
    _lastMessageCountBySession.set(sessionId, messages.length);

    // Check for sub-agent sessions — skip pruning to avoid interfering with
    // sub-agent operation and to conserve resources.
    const subAgent = isSubAgentSession(messages);
    if (subAgent) {
      log(
        "context-pruning",
        "transform_skipped",
        sessionId,
        undefined,
        "debug",
        {
          reason: "sub_agent",
          agent: subAgent,
        },
      );
      return;
    }

    // ── Load config and gate on enabled ──────────────────────
    const ctxConfig = loadConfig();
    if (!ctxConfig.enabled) {
      log(
        "context-pruning",
        "transform_skipped",
        sessionId,
        undefined,
        "debug",
        {
          reason: "disabled",
        },
      );
      return;
    }

    // Convert OpenCode messages to MessageRef[]
    const refs = convertOpenCodeToMessageRefs(messages);

    // ── Every-turn pipeline (state init + ID assignment + sync blocks + dedup + prune + nudge) ──
    const pipelineResult = runPipeline({
      sessionId,
      messages: refs,
      config: ctxConfig,
    });

    log("context-pruning", "pipeline_complete", sessionId, undefined, "info", {
      inputCount: messages.length,
      outputCount: pipelineResult.messages.length,
      nudgeCount: pipelineResult.nudges.length,
      stats: pipelineResult.stats,
    });

    // ── Apply results back to OpenCode messages ─────────
    applyPipelineToOpenCode(output, pipelineResult, sessionId);
  } catch (err) {
    const sid = (output as any)?.messages?.[0]?.info?.sessionID ?? "";
    log("context-pruning", "transform_error", sid, undefined, "error", {
      error: String(err),
    });
  }
}

/**
 * Handle `tool.execute.before` — tracks tool calls for dedup detection.
 *
 * Extracts session ID, tool name, and parameters from the hook input/output
 * and delegates to `globalState.trackToolCall`.
 *
 * @param input - Hook input with tool metadata.
 * @param input.tool - Tool name being executed.
 * @param input.sessionID - Current session identifier.
 * @param input.callID - Unique tool call identifier.
 * @param output - Hook output containing tool call arguments.
 * @param output.args - Arguments passed to the tool.
 */
export async function handleToolBefore(
  input: { tool: string; sessionID: string; callID: string },
  output: { args?: Record<string, unknown> },
): Promise<void> {
  try {
    const { sessionID, tool, callID } = input;
    const parameters = output.args ?? {};
    const isDuplicate = globalState.trackToolCall(
      sessionID,
      tool,
      parameters,
      callID,
    );

    log("context-pruning", "tool_before", sessionID, callID, "debug", {
      tool,
      isDuplicate,
    });
  } catch (err) {
    log(
      "context-pruning",
      "tool_before_error",
      input.sessionID ?? "",
      input.callID,
      "error",
      { error: String(err) },
    );
  }
}

/**
 * Handle `tool.execute.after` — tracks tool execution errors for
 * purge-errors strategy.
 *
 * Checks the hook output for error indicators (explicit `error` field or
 * missing `output` field) and, when found, calls
 * `globalState.trackError`.
 *
 * @param input - Hook input with tool metadata.
 * @param input.tool - Tool name that was executed.
 * @param input.sessionID - Current session identifier.
 * @param input.callID - Unique tool call identifier.
 * @param output - Hook output containing the tool result or error info.
 * @param output.output - Tool output on success (absent/undefined on error).
 */
export async function handleToolAfter(
  input: { tool: string; sessionID: string; callID: string },
  output: { output?: string; error?: string },
): Promise<void> {
  try {
    const { sessionID, tool, callID } = input;

    // Detect errors: explicit error field, or absent output (failure)
    const errorMessage: string | undefined =
      output?.error ??
      (output && "output" in output && output.output === undefined
        ? "Tool execution returned no output"
        : undefined);

    if (errorMessage) {
      globalState.trackError(sessionID, callID, tool, errorMessage);
      log("context-pruning", "tool_error", sessionID, callID, "warn", {
        tool,
        error: errorMessage,
      });
    } else {
      log("context-pruning", "tool_after", sessionID, callID, "debug", {
        tool,
        status: "success",
      });
    }
  } catch (err) {
    log(
      "context-pruning",
      "tool_after_error",
      input.sessionID ?? "",
      input.callID,
      "error",
      { error: String(err) },
    );
  }
}

/**
 * Handle session cleanup — releases in-memory state for the given session.
 *
 * Removes the session from `globalState` so that a future session with the
 * same ID will be cold-started.
 *
 * @param input - Hook input with session identifier.
 * @param input.sessionID - The session to clean up.
 * @param _output - Hook output (unused).
 */
export async function handleSessionCleanup(
  input: { sessionID: string },
  _output: Record<string, never>,
): Promise<void> {
  try {
    const { sessionID } = input;
    globalState.delete(sessionID);
    _lastMessageCountBySession.delete(sessionID);
    if (_lastSeenSessionId === sessionID) {
      _lastSeenSessionId = null;
    }

    log("context-pruning", "session_cleanup", sessionID, undefined, "info", {});
  } catch (err) {
    log(
      "context-pruning",
      "session_cleanup_error",
      input.sessionID ?? "",
      undefined,
      "error",
      { error: String(err) },
    );
  }
}
