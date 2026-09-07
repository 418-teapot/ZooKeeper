/**
 * In-memory test double builders for the context lens.
 *
 * New-core module unit tests construct transcript fixtures through
 * these builders.  Regions are backed by real mutable memory, so tests
 * can assert read-back; text replacement goes through the explicit
 * `setRegionText` helper (the core `TextRegion` interface is
 * read-only).
 *
 * Tool-call pairing follows the projection contract: regions carry text
 * only, and every call becomes an `Invocation` table entry.  The
 * builders record each call's pairing relative to its own message in a
 * side table; `projectMessages` resolves the pending entries against
 * transcript positions, mirroring what a host adapter does in its
 * projection pass.  Cross-message pairs (the pi shape) are expressed
 * through a `ToolCallSpec.outputRef` pointing at the result message's
 * ordinal — the invocation is owned by the call message, exactly like
 * the real pi adapter pairs by call id.
 *
 * @module
 */

import type {
  HostMessage,
  Invocation,
  Projection,
  RegionKind,
  Role,
  TextRegion,
  TokenUsage,
} from "./lens.js";
import { project } from "./lens.js";

/**
 * Options for `makeMsg`.
 */
export interface MakeMsgOptions {
  /** Mark the message hidden (occupies an ordinal, skipped by estimation). */
  hidden?: boolean;
  /** API exact token report. */
  usage?: TokenUsage;
}

/**
 * Options for `makeToolMsg`.
 */
export interface MakeToolMsgOptions extends MakeMsgOptions {
  /** Host-verbatim call status; defaults to "completed". */
  status?: string;
}

/**
 * One tool call within an assistant message.
 */
export interface ToolCallSpec {
  /** Tool name. */
  name: string;
  /** Tool input arguments text. */
  input: string;
  /** Tool output text. */
  output: string;
  /** Host-verbatim call status; defaults to "completed". */
  status?: string;
  /**
   * Positional address of the call's tool-output region when it lives in
   * a different message (the cross-message pi shape).  When set, NO
   * sibling tool-output region is emitted in this message and the
   * invocation's output half addresses the referenced position (the
   * region index defaults to 0).
   */
  outputRef?: { ordinal: number; regionIndex?: number };
}

/**
 * Options for `makeAssistantMsg`.
 */
export interface MakeAssistantMsgOptions extends MakeMsgOptions {
  /** Content region text. */
  text?: string;
  /** Thinking region text. */
  thinking?: string;
  /** Tool calls; each contributes a tool-input/tool-output pair. */
  toolCalls?: ToolCallSpec[];
}

/**
 * Mutable in-memory region backing the testkit messages.
 *
 * The text lives in the module-scoped backing table so `setRegionText`
 * can rewrite it without widening the core `TextRegion` interface.
 */
const regionText = new WeakMap<TextRegion, string>();

/**
 * A read-only region whose text is held in the backing table.
 *
 * Construction seeds the backing; the read lens observes it.  Text
 * replacement is performed by `setRegionText`, never through this
 * double's public surface.
 */
class MemoryRegion implements TextRegion {
  constructor(
    readonly kind: RegionKind,
    text: string,
  ) {
    regionText.set(this, text);
  }

  get(): string {
    return regionText.get(this) ?? "";
  }
}

/**
 * Pairing a builder recorded for a message, relative to that message.
 *
 * The ordinal is unknown until the message lands in a transcript, so
 * `projectMessages` fills it in from the message's array position.
 */
interface PendingInvocation {
  name: string;
  status?: string;
  /** Region index of the tool-input region within the message. */
  inputIndex: number;
  /** Region index of a same-message sibling tool-output region. */
  outputIndex?: number;
  /** Cross-message output address (the pi shape). */
  outputRef?: { ordinal: number; regionIndex?: number };
}

const pendingInvocations = new WeakMap<HostMessage, PendingInvocation[]>();

function recordInvocation(
  message: HostMessage,
  pending: PendingInvocation,
): void {
  const list = pendingInvocations.get(message);
  if (list) {
    list.push(pending);
  } else {
    pendingInvocations.set(message, [pending]);
  }
}

/**
 * Assemble a projection snapshot from a fixture transcript.
 *
 * Resolves every builder-recorded pairing against transcript positions
 * (the same pass assembles the reverse index via `project`), and merges
 * `extra` invocations verbatim — the escape hatch for fixtures with a
 * hand-built table (orphan outputs, deliberately unpaired regions).
 *
 * @param messages - The fixture transcript; ordinals are array indices.
 * @param extra - Invocations to include beyond the builder-recorded ones.
 * @returns The projection snapshot.
 */
export function projectMessages(
  messages: HostMessage[],
  extra: Invocation[] = [],
): Projection {
  const invocations: Invocation[] = [...extra];
  messages.forEach((message, ordinal) => {
    for (const pending of pendingInvocations.get(message) ?? []) {
      const invocation: Invocation = {
        name: pending.name,
        ...(pending.status !== undefined ? { status: pending.status } : {}),
        input: { ordinal, regionIndex: pending.inputIndex },
      };
      if (pending.outputRef !== undefined) {
        invocation.output = {
          ordinal: pending.outputRef.ordinal,
          regionIndex: pending.outputRef.regionIndex ?? 0,
        };
      } else if (pending.outputIndex !== undefined) {
        invocation.output = { ordinal, regionIndex: pending.outputIndex };
      }
      invocations.push(invocation);
    }
  });
  return project(messages, invocations);
}

/**
 * Rewrite the text of a message region through the testkit backing.
 *
 * The testkit equivalent of a host's edit application: the addressed
 * region's in-memory text is replaced in place, so subsequent `get()`
 * reads return the new text.  Out-of-range ordinals, missing regions,
 * and out-range region indices are skipped silently (defensive,
 * mirroring the adapter render loop).
 *
 * @param msg - The message holding the region.
 * @param regionIndex - Index of the region within the message.
 * @param text - The full replacement text.
 */
export function setRegionText(
  msg: HostMessage | undefined,
  regionIndex: number,
  text: string,
): void {
  const region = msg?.regions?.[regionIndex];
  if (!region) return;
  regionText.set(region, text);
}

/**
 * Build a message with content regions, one per given text.
 *
 * @param role - The message role.
 * @param texts - Content region texts, in order.
 * @param options - Optional hidden flag and usage report.
 * @returns The constructed message.
 */
export function makeMsg(
  role: Role,
  texts: string[],
  options?: MakeMsgOptions,
): HostMessage {
  return {
    role,
    hidden: options?.hidden ?? false,
    regions: texts.map((text) => new MemoryRegion("content", text)),
    usage: options?.usage,
  };
}

/**
 * Build an assistant tool-call message.
 *
 * The result carries exactly two regions in order — tool-input then
 * tool-output — and the builder records an invocation pairing them,
 * mirroring the v1 adapter's same-part adjacency.
 *
 * @param name - The tool name.
 * @param input - The tool input arguments text.
 * @param output - The tool output text.
 * @param options - Optional hidden flag, usage report, and call status.
 * @returns The constructed message.
 */
export function makeToolMsg(
  name: string,
  input: string,
  output: string,
  options?: MakeToolMsgOptions,
): HostMessage {
  const message: HostMessage = {
    role: "assistant",
    hidden: options?.hidden ?? false,
    regions: [
      new MemoryRegion("tool-input", input),
      new MemoryRegion("tool-output", output),
    ],
    usage: options?.usage,
  };
  recordInvocation(message, {
    name,
    status: options?.status ?? "completed",
    inputIndex: 0,
    outputIndex: 1,
  });
  return message;
}

/**
 * Build an assistant message with optional content, thinking, and tool
 * calls.
 *
 * Region order: content, thinking, then one tool-input/tool-output pair
 * per tool call — matching the natural host message layout.  Each call
 * records an invocation; a call with an `outputRef` contributes only
 * its tool-input region and pairs cross-message (the pi shape).
 *
 * @param options - The message contents and options.
 * @returns The constructed message.
 */
export function makeAssistantMsg(
  options: MakeAssistantMsgOptions = {},
): HostMessage {
  const regions: TextRegion[] = [];
  if (options.text !== undefined) {
    regions.push(new MemoryRegion("content", options.text));
  }
  if (options.thinking !== undefined) {
    regions.push(new MemoryRegion("thinking", options.thinking));
  }
  const message: HostMessage = {
    role: "assistant",
    hidden: options.hidden ?? false,
    regions,
    usage: options.usage,
  };
  for (const call of options.toolCalls ?? []) {
    const inputIndex = regions.length;
    regions.push(new MemoryRegion("tool-input", call.input));
    if (call.outputRef === undefined) {
      regions.push(new MemoryRegion("tool-output", call.output));
      recordInvocation(message, {
        name: call.name,
        status: call.status ?? "completed",
        inputIndex,
        outputIndex: inputIndex + 1,
      });
    } else {
      // The cross-message shape (pi) keeps the output half in its own
      // message; the invocation is owned by the call, like the real pi
      // adapter pairs toolCall blocks with toolResult messages by id.
      recordInvocation(message, {
        name: call.name,
        status: call.status ?? "completed",
        inputIndex,
        outputRef: call.outputRef,
      });
    }
  }
  return message;
}

/**
 * Build a standalone tool-result message: exactly one tool-output
 * region (the pi toolResult shape).
 *
 * The message carries no pairing of its own — the invocation addressing
 * this region at `(ordinal, 0)` is recorded by the call message that
 * links it via `ToolCallSpec.outputRef`.  A result message with no
 * paired call leaves its region unpaired, and producers abstain from it
 * (fail-closed), mirroring the pi adapter's orphan-result behavior.
 *
 * @param output - The tool output text.
 * @returns The constructed message.
 */
export function makeToolResultMsg(output: string): HostMessage {
  return {
    role: "toolResult",
    hidden: false,
    regions: [new MemoryRegion("tool-output", output)],
  };
}
