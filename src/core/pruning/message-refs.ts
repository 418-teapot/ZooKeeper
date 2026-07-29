/**
 * Deterministic message-ref assign / inject / strip.
 *
 * Maintains a per-session in-memory registry that assigns stable
 * `mNNNN` refs (m0001…m9999) to non-ignored messages based on their
 * position in the messages array.  Refs are used by the future
 * model-driven compress tool so the LLM can address messages by a
 * visible stable identifier.
 *
 * **No disk I/O** — restart determinism comes from re-walking the same
 * message array in the same order (the registry is rebuilt from scratch).
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
 * Per-session ref registry stored in memory only.
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

/** Map of session ID → ref registry (module-scoped, no persistence). */
const registries = new Map<string, SessionRefRegistry>();

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
  let registry = registries.get(sessionId);
  if (!registry) {
    registry = {
      byRawId: new Map(),
      byRef: new Map(),
      nextRef: 1,
      lastCompactionBoundaryId: null,
      warnedCapacity: false,
    };
    registries.set(sessionId, registry);
  }

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
 * @param sessionId - The session identifier to clear.
 */
export function resetMessageRefs(sessionId: string): void {
  registries.delete(sessionId);
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
  let registry = registries.get(sessionId);
  if (!registry) {
    registry = {
      byRawId: new Map(),
      byRef: new Map(),
      nextRef: 1,
      lastCompactionBoundaryId: null,
      warnedCapacity: false,
    };
    registries.set(sessionId, registry);
  }
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
  let registry = registries.get(sessionId);
  if (!registry) {
    registry = {
      byRawId: new Map(),
      byRef: new Map(),
      nextRef: 1,
      lastCompactionBoundaryId: null,
      warnedCapacity: false,
    };
    registries.set(sessionId, registry);
  }
  registry.nextRef = nextRef;
}
