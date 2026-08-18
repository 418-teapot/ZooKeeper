import type { ContextMessageEntry } from "../adapters/opencode/types.js";

/** Category values for sidebar breakdown display. */
export interface CategoryInfo {
  user: number;
  assistant: number;
  tool: number;
  system: number;
  total: number;
}

// ── Sub-agent types ─────────────────────────────────────────

/** Status for a sub-agent entry tracked in the sidebar panel. */
export type SubStatus = "running" | "done" | "error";

/** A single sub-agent entry shown in the sub-agent section. */
export interface SubEntry {
  id: string;
  title: string;
  agent: string;
  status: SubStatus;
  sessionId?: string;
  tokens?: number;
  error?: string;
  model?: string;
  /** Epoch ms when the sub-agent started (from state.time.start). */
  startedAt?: number;
  /** Epoch ms when the sub-agent ended (from state.time.end). */
  endedAt?: number;
}

/**
 * Map a tool-part state status to the SubStatus enum.
 *
 * - "completed" → "done"
 * - "error" → "error"
 * - everything else (running, pending, unknown) → "running"
 */
export function subStatusFromState(stateStatus: string): SubStatus {
  if (stateStatus === "completed") return "done";
  if (stateStatus === "error") return "error";
  return "running";
}

/**
 * Extract the agent name from a task tool call state.
 *
 * Reads `state.input.subagent_type` and falls back to `"task"`.
 */
export function extractAgent(
  input: Record<string, unknown> | undefined,
): string {
  const raw = input?.subagent_type;
  return raw !== undefined ? String(raw) : "task";
}

/**
 * Extract the model identifier from task call metadata.
 *
 * Reads `metadata.model.modelID` and returns it as a string.
 * Returns `undefined` when the metadata is absent, the model field
 * is not an object, or the modelID is missing / not a string.
 */
export function extractModel(
  metadata: Record<string, unknown> | undefined,
): string | undefined {
  if (!metadata) return undefined;
  const model = metadata.model;
  if (typeof model !== "object" || model === null) return undefined;
  const modelID = (model as Record<string, unknown>).modelID;
  return typeof modelID === "string" ? modelID : undefined;
}

/**
 * Extract timestamp fields from a task tool call state.
 *
 * Reads `state.time.start` and `state.time.end` (epoch ms).
 * Only finite numbers are accepted — all other values yield
 * undefined.  This mirrors the DB schema where running entries
 * have `start` but no `end`.
 */
export function extractTimes(state: Record<string, unknown>): {
  startedAt?: number;
  endedAt?: number;
} {
  const time = state.time;
  if (typeof time !== "object" || time === null) {
    return { startedAt: undefined, endedAt: undefined };
  }
  const raw = time as Record<string, unknown>;
  const start = raw.start;
  const end = raw.end;
  return {
    startedAt:
      typeof start === "number" && Number.isFinite(start) ? start : undefined,
    endedAt: typeof end === "number" && Number.isFinite(end) ? end : undefined,
  };
}

/**
 * Extract the total context tokens (input + cache.read) from the last
 * valid assistant message in a message list.
 *
 * Messages are expected in the {info, parts}[] shape returned by
 * api.client.session.messages.  Traverses in reverse order and skips
 * placeholder assistant messages where the token sum is zero (created
 * at step start before actual tokens are recorded).
 *
 * Returns the token sum for the first valid assistant message found,
 * or undefined when no assistant message has non-zero tokens.
 *
 * @param messages - Array of {info, parts} message objects.
 * @returns Sum of input + cache.read tokens, or undefined.
 */
export function extractContextTokens(
  messages: Record<string, unknown>[],
): number | undefined {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const info = m?.info as Record<string, unknown> | undefined;
    if (info?.role !== "assistant") continue;
    const t = info.tokens as
      | { input?: unknown; cache?: { read?: unknown } }
      | undefined;
    // Skip messages with missing tokens field (no token data yet).
    if (!t) continue;
    // Defensive typeof checks (matches extractTimes): a non-numeric
    // value must not poison the sum (e.g. string concatenation).
    const input = typeof t.input === "number" ? t.input : 0;
    const cacheRead = typeof t.cache?.read === "number" ? t.cache.read : 0;
    const sum = input + cacheRead;
    // Skip zero-sum placeholder messages created at step start.
    if (sum === 0) continue;
    return sum;
  }
  return undefined;
}

/**
 * Format a duration in milliseconds to a human-readable string.
 *
 * - < 60 s  →  "12s"
 * - ≥ 60 s  →  "2m05s" (seconds zero-padded)
 * - negative, NaN, Infinity  →  "—"
 */
export function formatDuration(ms: number): string {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return "—";
  const totalSec = Math.round(ms / 1000);
  if (totalSec < 60) return `${totalSec}s`;
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  return `${min}m${String(sec).padStart(2, "0")}s`;
}

/**
 * Extract a human-readable title from a task tool call state.
 *
 * Priority: state.title → input.description → input.prompt (first 40 chars)
 * → partId slice (first 8 chars) → empty string.
 */
export function extractTitle(
  state: Record<string, unknown>,
  partId?: string,
): string {
  const st = state.title;
  if (typeof st === "string" && st.length > 0) return st;

  const input = state.input as Record<string, unknown> | undefined;

  const desc = input?.description;
  if (typeof desc === "string" && desc.length > 0) return desc;

  const prompt = input?.prompt;
  if (typeof prompt === "string" && prompt.length > 0) {
    return prompt.slice(0, 40);
  }

  if (partId) return partId.slice(0, 8);

  return "";
}

/**
 * Scan an array of message entries for completed/in-flight task tool
 * calls and return the corresponding sub-agent entries.
 *
 * Only parts where `type === "tool"` and `tool === "task"` are
 * considered.  Parts with `state.status === "pending"` are skipped
 * (not yet started).  Entries are built using the same helper
 * functions as the live event handler: `subStatusFromState`,
 * `extractAgent`, and `extractTitle`.
 */
export function collectSubEntries(messages: ContextMessageEntry[]): SubEntry[] {
  const entries: SubEntry[] = [];

  for (const msg of messages) {
    if (!msg.parts || !Array.isArray(msg.parts)) continue;

    for (const partRaw of msg.parts) {
      const part = partRaw as unknown as Record<string, unknown>;
      if (part.type !== "tool" || part.tool !== "task") continue;

      const state = part.state as Record<string, unknown> | undefined;
      if (!state) continue;

      const stateStatus = state.status as string;
      // pending → not yet started, skip like the magazine does.
      if (stateStatus === "pending") continue;

      const partId = part.id as string | undefined;
      if (!partId) continue;

      const status = subStatusFromState(stateStatus);
      const input = state.input as Record<string, unknown> | undefined;
      const agent = extractAgent(input);
      const title = extractTitle(state, partId);
      const meta = state.metadata as Record<string, unknown> | undefined;
      const sessionId = String(meta?.session_id ?? meta?.sessionId ?? "");
      const model = extractModel(meta);
      const error = status === "error" ? String(state.error ?? "") : undefined;
      const { startedAt, endedAt } = extractTimes(state);

      entries.push({
        id: partId,
        title,
        agent,
        status,
        sessionId: sessionId || undefined,
        model,
        tokens: undefined,
        error,
        startedAt,
        endedAt,
      });
    }
  }

  return entries;
}

// ── Scan-merge pure function ──────────────────────────────────

/**
 * Merge scanned sub-entries into the existing map.
 *
 * Rules (in priority order):
 * 1. New entries (not in prev) are inserted as-is.
 * 2. Existing entries in a terminal state (done/error) are never
 *    overwritten — terminal is irreversible from a real-time event.
 * 3. Existing "running" entries are overwritten when the scanned
 *    entry is in a terminal state (done/error).  This fixes the
 *    case where a sub-agent completed while the panel was unmounted
 *    and the live event was missed.
 * 4. In all other cases only the missing sessionId is patched;
 *    status / tokens / error from the existing entry are preserved
 *    (live events are fresher).
 * 5. Tokens from scanned entries are never applied — token values
 *    come from polling or one-shot reads, not from the scanned
 *    message state (which always has `tokens: undefined`).
 *
 * Pure function — no side effects (no timer management).
 */
export function mergeScannedEntries(
  prev: Map<string, SubEntry>,
  scanned: SubEntry[],
): Map<string, SubEntry> {
  const next = new Map(prev);

  for (const entry of scanned) {
    const existing = next.get(entry.id);

    if (!existing) {
      // Rule 1: brand new entry → insert as-is.
      next.set(entry.id, entry);
      continue;
    }

    // Rule 2: existing terminal entry → never overwrite.
    if (existing.status === "done" || existing.status === "error") {
      // Still patch missing sessionId / model / startedAt / endedAt.
      if (
        (!existing.sessionId && entry.sessionId) ||
        (!existing.model && entry.model) ||
        (!existing.startedAt && entry.startedAt) ||
        (!existing.endedAt && entry.endedAt)
      ) {
        next.set(entry.id, {
          ...existing,
          sessionId: entry.sessionId || existing.sessionId,
          model: entry.model || existing.model,
          startedAt: entry.startedAt ?? existing.startedAt,
          endedAt: entry.endedAt ?? existing.endedAt,
        });
      }
      continue;
    }

    // Rule 3: existing running + scanned terminal → overwrite status.
    if (
      existing.status === "running" &&
      (entry.status === "done" || entry.status === "error")
    ) {
      next.set(entry.id, {
        ...existing,
        status: entry.status,
        // Preserve existing tokens (they come from polling, not scan).
        error: entry.status === "error" ? entry.error : existing.error,
        // Patch model from scanned if existing doesn't have one yet.
        model: existing.model || entry.model,
        // Use scanned times — DB has authoritative start/end for
        // terminal states (fixes missing endedAt from live events).
        startedAt: entry.startedAt ?? existing.startedAt,
        endedAt: entry.endedAt ?? existing.endedAt,
      });
      continue;
    }

    // Rule 4: fallback — only patch missing sessionId / model /
    // startedAt / endedAt; never overwrite status / tokens / error.
    if (
      (!existing.sessionId && entry.sessionId) ||
      (!existing.model && entry.model) ||
      (!existing.startedAt && entry.startedAt) ||
      (!existing.endedAt && entry.endedAt)
    ) {
      next.set(entry.id, {
        ...existing,
        sessionId: entry.sessionId || existing.sessionId,
        model: entry.model || existing.model,
        startedAt: entry.startedAt ?? existing.startedAt,
        endedAt: entry.endedAt ?? existing.endedAt,
      });
    }
  }

  return next;
}
