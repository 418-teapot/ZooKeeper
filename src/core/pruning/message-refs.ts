/**
 * Deterministic message-ref assign / inject / strip.
 *
 * Maintains a per-session in-memory registry that assigns stable
 * `mNNNN` refs (m0001…m9999) to non-ignored messages based on their
 * position in the messages array.  Refs are used by the future
 * model-driven compress tool so the LLM can address messages by a
 * visible stable identifier.
 *
 * **Restart persistence:** the registry is snapshotted into the session
 * state file (`~/.zoo/storage/{sessionId}.json`) at `saveSessionState`
 * call sites (piggyback — never per-turn writes).  On process restart
 * `ensureRegistry` hydrates from the persisted snapshot, so refs stay
 * stable even after compression has folded messages away (a folded view
 * would otherwise renumber every ref after the folded region and
 * invalidate the provider prompt cache).  Messages assigned refs after
 * the last snapshot re-derive identical numbers from the restored
 * `nextRef` in identical view order.  Folded-away messages keep stale
 * entries in `byRef` — harmless, never queried.
 *
 * Pipeline invariant (prefix-cache neutral):
 * ```
 * stripHallucinatedRefs → assignMessageRefs → injectMessageRefs
 * ```
 * Running this pipeline twice over the same input produces byte-identical
 * output because strip removes trailing (end-anchored) injected tags
 * before re-injection.  Only trailing fragments are stripped; mid-text
 * occurrences and bare refs are preserved.
 *
 * @module
 */

import { log } from "../../utils/logger.js";
import type { ContextMessageEntry } from "../metrics.js";
import { isMessageIgnored } from "../metrics.js";
import type { PersistedRefs } from "./marks.js";
import { clearPersistedRefs, readPersistedRefs } from "./marks.js";
import {
  MAX_INDEX,
  ZOO_MSG_ID_ORPHAN_REGEX,
  ZOO_MSG_ID_REGEX,
  ZOO_MSG_ID_TAG,
} from "./types.js";

// ---------------------------------------------------------------------------
// Module-level registry
// ---------------------------------------------------------------------------

/**
 * Per-session ref registry stored in memory.
 *
 * The registry is snapshotted to disk at `saveSessionState` call sites
 * (`snapshotRefs`) and hydrated on first use after a restart
 * (`ensureRegistry`).
 */
interface SessionRefRegistry {
  /** OpenCode message ID → ref string (e.g. `"msg_abc123"` → `"m0001"`). */
  byRawId: Map<string, string>;
  /** Ref string → OpenCode message ID (reverse lookup). */
  byRef: Map<string, string>;
  /**
   * Next ref index (1-based).  `nextRef = 1` means the next assigned
   * ref will be `m0001`.
   */
  nextRef: number;
  /** Boundary ID for compaction tracking. */
  lastCompactionBoundaryId: string | null;
  /** Whether a capacity-warning has already been logged this session. */
  warnedCapacity: boolean;
}

/** Map of session ID → ref registry (module-scoped). */
const registries = new Map<string, SessionRefRegistry>();

// ---------------------------------------------------------------------------
// Registry lifecycle
// ---------------------------------------------------------------------------

/**
 * Get (or create + hydrate) the runtime registry for a session.
 *
 * On first creation, tries to hydrate from the persisted refs snapshot
 * (`readPersistedRefs`) so refs survive a process restart without
 * renumbering.  When no snapshot exists, starts fresh from `m0001`.
 * The persisted `byRef` (ref → message ID) is inverted into `byRawId`
 * (message ID → ref) on restore — only the forward map is persisted.
 *
 * @param sessionId - The session identifier.
 * @returns The per-session ref registry.
 */
function ensureRegistry(sessionId: string): SessionRefRegistry {
  const existing = registries.get(sessionId);
  if (existing) return existing;

  const persisted = readPersistedRefs(sessionId);
  let registry: SessionRefRegistry;
  if (persisted) {
    registry = {
      byRawId: new Map(),
      byRef: new Map(Object.entries(persisted.byRef)),
      nextRef: persisted.nextRef,
      lastCompactionBoundaryId: null,
      warnedCapacity: false,
    };
    // Derive the inverse map (message ID → ref) from the persisted
    // ref → message ID entries.
    for (const [ref, rawId] of registry.byRef) {
      registry.byRawId.set(rawId, ref);
    }
  } else {
    registry = {
      byRawId: new Map(),
      byRef: new Map(),
      nextRef: 1,
      lastCompactionBoundaryId: null,
      warnedCapacity: false,
    };
  }
  registries.set(sessionId, registry);
  return registry;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Assign deterministic `mNNNN` refs to non-ignored messages in order.
 *
 * Scans `messages` left-to-right.  The first non-ignored message whose
 * ID has not yet been assigned gets `m0001`, the next gets `m0002`, and
 * so on up to `m9999` (`MAX_INDEX`).  Ignores messages whose IDs are
 * already in the registry (idempotent re-entry).
 *
 * When `nextRef` exceeds `MAX_INDEX`, assignment stops and a warning
 * is logged once per session (no throw).
 *
 * **Sub-agent sessions: skip ref assignment for the first user message (positional, resume-safe):** When `isSubAgent` is true, the
 * first non-ignored user message encountered in the array scan is
 * skipped (no ref assigned).  Uses a per-call local flag so the skip
 * applies fresh on every invocation — resume-safe because the task
 * prompt stays at the array head and the local flag resets each call.
 *
 * @param sessionId - The session identifier.
 * @param messages - The message array to scan (not mutated).
 * @param isSubAgent - When true, skip ref assignment for the first
 *   non-ignored user message (DCP positional semantics).
 * @returns Count of newly assigned refs this call.
 */
export function assignMessageRefs(
  sessionId: string,
  messages: ContextMessageEntry[],
  isSubAgent?: boolean,
): number {
  const registry = ensureRegistry(sessionId);

  let newAssignments = 0;

  // Per-call local flag — skip the first non-ignored user message
  // in a sub-agent session.  Resets every call so the flag is never
  // persisted across transforms.
  let skippedFirstUser = false;

  for (const msg of messages) {
    if (isMessageIgnored(msg)) continue;

    // Sub-agent sessions: skip ref assignment for the first user message (positional semantics).
    if (isSubAgent && !skippedFirstUser && msg.info?.role === "user") {
      skippedFirstUser = true;
      continue;
    }

    const msgId = msg.info?.id;
    if (!msgId) continue;

    // Already assigned in a previous call — skip.
    if (registry.byRawId.has(msgId)) continue;

    // Capacity exhausted — stop assigning, warn once.
    if (registry.nextRef > MAX_INDEX) {
      if (!registry.warnedCapacity) {
        log(
          "message-refs",
          "refs_capacity_exhausted",
          sessionId,
          undefined,
          "warn",
          { maxIndex: MAX_INDEX },
        );
        registry.warnedCapacity = true;
      }
      break;
    }

    const ref = `m${String(registry.nextRef).padStart(4, "0")}`;
    registry.byRawId.set(msgId, ref);
    registry.byRef.set(ref, msgId);
    registry.nextRef++;
    newAssignments++;
  }

  return newAssignments;
}

/**
 * Reverse-lookup the OpenCode message ID for a ref string.
 *
 * Reads the per-session `byRef` registry directly.  Returns `undefined`
 * when the session has no registry entry or the ref is unknown.
 *
 * **Does NOT trigger hydration:** unlike `ensureRegistry`, this function
 * only reads the in-memory registry — on a fresh process it returns
 * `undefined` even when a persisted snapshot exists, until some other
 * call (`assignMessageRefs` / `setLastCompactionBoundaryId`) has created
 * the runtime registry.
 *
 * @param sessionId - The session identifier.
 * @param ref - The ref string (e.g. `"m0001"`).
 * @returns The assigned message ID, or `undefined` if unknown.
 */
export function getMessageIdByRef(
  sessionId: string,
  ref: string,
): string | undefined {
  const registry = registries.get(sessionId);
  return registry ? registry.byRef.get(ref) : undefined;
}

/**
 * Look up the assigned ref for an OpenCode message ID.
 *
 * Reads the per-session `byRawId` registry directly.  Returns
 * `undefined` when the session has no registry entry or the message ID
 * is unknown.
 *
 * **Does NOT trigger hydration:** like `getMessageIdByRef`, this
 * function only reads the in-memory registry — on a fresh process it
 * returns `undefined` even when a persisted snapshot exists, until some
 * other call (`assignMessageRefs` / `setLastCompactionBoundaryId`) has
 * created the runtime registry.
 *
 * @param sessionId - The session identifier.
 * @param messageId - The OpenCode message ID.
 * @returns The assigned ref string (e.g. `"m0001"`), or `undefined`.
 */
export function getMessageRefById(
  sessionId: string,
  messageId: string,
): string | undefined {
  const registry = registries.get(sessionId);
  return registry ? registry.byRawId.get(messageId) : undefined;
}

/**
 * Build the formatted tag string for a given ref.
 */
function formatTag(ref: string): string {
  return `<${ZOO_MSG_ID_TAG}>${ref}</${ZOO_MSG_ID_TAG}>`;
}

/**
 * Append `\n<tag>` to a text part with a dedup guard.
 *
 * If the tag (bare, no leading newline) is already present in the text
 * the part is left untouched and `true` is returned (idempotent).
 *
 * @param part - A text part with a string `text` field.
 * @param tag - Bare tag string (e.g. `<zoo-msg-id>m0001</zoo-msg-id>`).
 * @returns `true` if the tag is now present (was already there or was
 *   just appended).
 */
function appendToTextPart(
  part: { type: string; text: string },
  tag: string,
): boolean {
  if (part.text.includes(tag)) return true;
  part.text += `\n${tag}`;
  return true;
}

/**
 * Inject `<zoo-msg-id>mNNNN</zoo-msg-id>` tags into messages that have
 * an assigned ref.
 *
 * Placement follows DCP semantics per role:
 *
 * **Assistant:**
 *   (a) Append tag to `state.output` of every completed tool part
 *       (part.type === "tool" with string `state.output`).  If at least
 *       one tool part received the tag, the message is done.
 *   (b) Else append to the last text part.
 *   (c) Else create a synthetic `{ type: "text", text: "<tag>" }` part
 *       inserted **before** the first tool part (pushed to end if no
 *       tool parts exist).
 *
 * **User:**
 *   (a) Append tag to **every** text part.
 *   (b) If no text parts exist, push a synthetic text part to the end.
 *
 * Both paths use a dedup guard: if the bare tag string is already
 * present in a text part or tool output, that element is not modified.
 * This makes inject self-idempotent.
 *
 * Non-user/non-assistant roles are skipped (no tag injected).
 *
 * @param sessionId - The session identifier.
 * @param messages - The message array (parts mutated in place).
 * @returns Count of non-ignored messages that received an injected tag.
 */
export function injectMessageRefs(
  sessionId: string,
  messages: ContextMessageEntry[],
): number {
  const registry = registries.get(sessionId);
  if (!registry) return 0;

  let injected = 0;

  for (const msg of messages) {
    if (isMessageIgnored(msg)) continue;

    const msgId = msg.info?.id;
    if (!msgId) continue;

    const ref = registry.byRawId.get(msgId);
    if (!ref) continue;
    if (!msg.parts || msg.parts.length === 0) continue;

    const tag = formatTag(ref);
    const role = msg.info?.role ?? "";

    if (role === "user") {
      // ── User: append to EVERY text part ────────────────
      let anyTextPart = false;
      for (const part of msg.parts) {
        if (part && part.type === "text" && typeof part.text === "string") {
          appendToTextPart(part as { type: string; text: string }, tag);
          anyTextPart = true;
        }
      }
      if (!anyTextPart) {
        // No text parts — push synthetic text part to end.
        msg.parts.push({ type: "text", text: tag });
      }
      injected++;
    } else if (role === "assistant") {
      // ── Assistant ──────────────────────────────────────
      // (a) Append tag to every completed tool part with string output.
      //     Skip parts whose status is defined and not "completed"
      //     (matching dedup.ts semantics — tolerate undefined status).
      let anyToolOutput = false;
      for (const part of msg.parts) {
        if (part && part.type === "tool") {
          const p = part as unknown as Record<string, unknown>;
          const state = p.state as Record<string, unknown> | undefined;
          if (state && typeof state.output === "string") {
            const status = state.status as string | undefined;
            if (status !== undefined && status !== "completed") continue;
            anyToolOutput = true;
            if (!state.output.includes(tag)) {
              state.output = `${state.output}\n${tag}`;
            }
          }
        }
      }
      if (anyToolOutput) {
        injected++;
        continue;
      }

      // (b) Append to the last text part.
      let lastTextIdx = -1;
      for (let i = msg.parts.length - 1; i >= 0; i--) {
        const part = msg.parts[i];
        if (part && part.type === "text" && typeof part.text === "string") {
          lastTextIdx = i;
          break;
        }
      }
      if (lastTextIdx !== -1) {
        appendToTextPart(
          msg.parts[lastTextIdx] as { type: string; text: string },
          tag,
        );
        injected++;
        continue;
      }

      // (c) Create synthetic text part.
      const syntheticPart: { type: string; text: string } = {
        type: "text",
        text: tag,
      };
      const firstToolIdx = msg.parts.findIndex(
        (p) => p && (p as unknown as Record<string, unknown>).type === "tool",
      );
      if (firstToolIdx === -1) {
        msg.parts.push(syntheticPart);
      } else {
        msg.parts.splice(firstToolIdx, 0, syntheticPart);
      }
      injected++;
    }
    // Non-user/non-assistant roles: skip entirely.
  }

  return injected;
}

/**
 * Strip helper: apply Rule 1 then Rule 2 REPEATEDLY until the string
 * stops changing.
 *
 * With `$`-anchored regexes only one trailing fragment is exposed per
 * pass.  Looping handles stacked trailing fragments like
 * `m0001...</zoo-msg-id>m0002...</zoo-msg-id>` by stripping the
 * outermost first, then exposing the next.
 */
function stripFromString(text: string): string {
  let prev: string;
  let result = text;
  do {
    prev = result;
    result = result
      .replace(ZOO_MSG_ID_REGEX, "")
      .replace(ZOO_MSG_ID_ORPHAN_REGEX, "");
  } while (result !== prev);
  return result;
}

/**
 * Strip trailing (end-anchored) zoo-msg-id tags and refs from a string.
 *
 * Only trailing fragments (at end-of-string) are removed; mid-text
 * occurrences and bare/standalone refs are preserved.  Stacked
 * trailing fragments are handled via loop-until-stable.
 *
 * Exported so the `text.complete` streaming hook can reuse the same
 * logic without logging or message-array overhead.
 *
 * @param text - Raw text potentially containing zoo-msg-id tags.
 * @returns The cleaned text with trailing tags/refs removed.
 */
export function stripRefsFromString(text: string): string {
  return stripFromString(text);
}

/**
 * Strip trailing (end-anchored) zoo-msg-id tags and refs from text parts
 * **and** completed-tool-part outputs of every message regardless of role.
 *
 * Only trailing fragments (at end-of-string) are removed; mid-text
 * occurrences and bare/standalone refs are preserved.  Stacked trailing
 * fragments are handled via loop-until-stable (the per-string helper
 * applies Rule 1 then Rule 2 repeatedly until no further change).
 *
 * Applied to:
 * - Text parts (any role): stripped via stripFromString.
 * - Tool parts with string `state.output`: same treatment applied to
 *   the output string.
 *
 * Mutates parts **in place** on the passed array.  This is a stateless
 * pure function over the array — it does not read or write the registry.
 *
 * @param messages - The message array (parts mutated in place).
 */
export function stripHallucinatedRefs(messages: ContextMessageEntry[]): void {
  for (const msg of messages) {
    if (!msg.parts) continue;

    for (const part of msg.parts) {
      if (part && part.type === "text" && typeof part.text === "string") {
        part.text = stripFromString(part.text);
      }

      if (part && part.type === "tool") {
        const p = part as unknown as Record<string, unknown>;
        const state = p.state as Record<string, unknown> | undefined;
        if (state && typeof state.output === "string") {
          state.output = stripFromString(state.output);
        }
      }
    }
  }
}

/**
 * Reset the ref registry for a session.
 *
 * Used on compaction boundary change so that refs are renumbered from
 * `m0001` when the session history is compacted.
 *
 * Also invalidates the persisted refs snapshot (`clearPersistedRefs`):
 * without this, the next `ensureRegistry` would re-hydrate the stale
 * nextRef/byRef from disk and silently defeat the renumber semantics.
 *
 * @param sessionId - The session identifier to clear.
 */
export function resetMessageRefs(sessionId: string): void {
  registries.delete(sessionId);
  // Drop the persisted snapshot too — otherwise the very next
  // ensureRegistry would re-hydrate the stale counter from disk and
  // refs would continue from the old state instead of restarting at m0001.
  clearPersistedRefs(sessionId);
}

/**
 * Get the last compaction boundary ID for a session.
 *
 * Returns `null` when no boundary has been recorded or the session
 * has no registry entry.
 *
 * @param sessionId - The session identifier.
 * @returns The last compaction boundary message ID, or `null`.
 */
export function getLastCompactionBoundaryId(sessionId: string): string | null {
  const registry = registries.get(sessionId);
  return registry ? registry.lastCompactionBoundaryId : null;
}

/**
 * Set the last compaction boundary ID for a session.
 *
 * Creates the registry entry if it does not exist.  The boundary ID
 * is used by the hook layer to detect compaction boundary changes.
 *
 * @param sessionId - The session identifier.
 * @param boundaryId - The new boundary message ID (or `null` to clear).
 */
export function setLastCompactionBoundaryId(
  sessionId: string,
  boundaryId: string | null,
): void {
  const registry = ensureRegistry(sessionId);
  registry.lastCompactionBoundaryId = boundaryId;
}

// ---------------------------------------------------------------------------
// Testing seams
// ---------------------------------------------------------------------------

/**
 * Clear all session registries.
 *
 * Call in test teardown to prevent cross-test pollution.
 */
export function _clearAllRefsForTesting(): void {
  registries.clear();
}

/**
 * Set the next-ref counter for a session (testing only).
 *
 * Allows tests to simulate near-capacity conditions without assigning
 * thousands of refs.
 *
 * @param sessionId - The session identifier.
 * @param nextRef - The next ref index to set (1-based).
 */
export function _setNextRefForTesting(
  sessionId: string,
  nextRef: number,
): void {
  const registry = ensureRegistry(sessionId);
  registry.nextRef = nextRef;
}

/**
 * Snapshot the runtime ref registry for persistence.
 *
 * Returns a plain-object copy of the registry (ref string → message ID)
 * plus the next-ref counter.  Returns `null` when the session has no
 * runtime registry (nothing to persist).  Called at `saveSessionState`
 * call sites; the snapshot is written into `state.refs` before saving.
 *
 * @param sessionId - The session identifier.
 * @returns The persisted refs snapshot, or `null`.
 */
export function snapshotRefs(sessionId: string): PersistedRefs | null {
  const registry = registries.get(sessionId);
  if (!registry) return null;
  return {
    nextRef: registry.nextRef,
    byRef: Object.fromEntries(registry.byRef),
  };
}
