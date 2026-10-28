/**
 * Deterministic provider of the end-to-end suite.
 *
 * Registered as the `e2e` provider with a private api id, its `streamSimple`
 * never performs a request: every response is derived from the transcript it
 * receives.  A real pi process therefore drives the real tools (todo,
 * subagent) with no network provider involved.
 *
 * The transcript is the whole input: the last user message names the step,
 * and the tool results after it decide which step comes next, so each
 * scenario advances exactly one tool call per assistant turn.
 *
 * The stream options `onPayload` and `onResponse` are intentionally never
 * called.  pi documents them as hooks around a provider request: the payload
 * is inspected or replaced before sending, the response is reported once it
 * is received.  This provider sends no request at all, so it has neither a
 * payload nor a response to hand to them, and synthesising one would report a
 * request that never happened.
 */

import {
  type AssistantMessage,
  type AssistantMessageEventStream,
  createAssistantMessageEventStream,
  type Message,
  type Model,
  type SimpleStreamOptions,
  type TextContent,
  type ToolCall,
  type TranscriptContext,
  type Usage,
} from "@earendil-works/pi-ai/compat";
import {
  ALPHA_PHASE,
  ALPHA_TASKS,
  CHILD_REPLY,
  CHILD_TAG,
  CONTEXT_ANCHOR_PROMPT,
  CONTEXT_BLOCK_TITLE,
  CONTEXT_COMPRESS_PROMPT,
  CONTEXT_DECOMPRESS_PROMPT,
  CONTEXT_FILL_PROMPT,
  CONTEXT_SUMMARY_BODY,
  CONTEXT_TARGET_PROMPT,
  CONTEXT_TARGET_TAGS,
  VIEW_TAGS,
} from "../constants.js";
import { excerpt, record } from "./trace.js";

/** Provider id the harness registers. */
export const PROVIDER_ID = "e2e";

/** API id the provider owns; the harness stream intercepts it. */
export const PROVIDER_API = "e2e-opaque";

/** Model id the harness selects everywhere. */
export const MODEL_ID = "deterministic";

/** The single chat model the provider exposes. */
export const PROVIDER_MODELS = [
  {
    type: "chat" as const,
    id: MODEL_ID,
    name: MODEL_ID,
    api: PROVIDER_API,
    reasoning: false,
    input: ["text"] as ("text" | "image")[],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 8192,
  },
];

/** Child prompt tag the deterministic child model answers. */
const CHILD_TAG_PATTERN = /E2E-CHILD[:\s]+([\w.-]+)/;

/** The structured child prompt the parent asks the subagent tool to send. */
const CHILD_PROMPT = [
  `**SUMMARY:** E2E-CHILD ${CHILD_TAG} 只回复一条确认文本，不调用任何工具。`,
  "**CONTEXT:** 这是 ZooKeeper pi 端到端套件的一次真实子会话运行，用于验证子会话的扩展发现与 SDK 生命周期桥。" +
    "子会话使用进程内确定性 provider，不需要读取文件、执行命令或访问网络；除回复文本外不要产生任何动作。父会话只等待这条确认文本。",
  `**ACCEPTANCE:** 回复中包含 "${CHILD_REPLY}"，且不发起任何工具调用。`,
].join("\n\n");

/** One decision the model produces. */
type Decision =
  | { kind: "tool"; name: string; argumentValue: Record<string, unknown> }
  | { kind: "text"; text: string };

/** The todo tool calls of the alpha plan, in order. */
const TODO_STEPS: Decision[] = [
  {
    kind: "tool",
    name: "todo",
    argumentValue: {
      op: "init",
      list: [{ phase: ALPHA_PHASE, tasks: ALPHA_TASKS }],
    },
  },
  ...ALPHA_TASKS.map(
    (task): Decision => ({
      kind: "tool",
      name: "todo",
      argumentValue: { op: "done", task },
    }),
  ),
  {
    kind: "tool",
    name: "todo",
    argumentValue: { op: "view" },
  },
];

/** Plain text of a message content value. */
function textOf(content: Message["content"] | undefined): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part.type === "text" ? part.text : ""))
    .join("");
}

/**
 * One message of a request, as the model receives it.
 *
 * The context scenarios assert on this: `ref` and `header` are what the
 * render layer of the production pruning pipeline wrote into the messages,
 * and `tags` says which of the scenario's own sentinel strings survived.
 */
export interface ViewMessage {
  /** Message role (`user`, `assistant`, `toolResult`, ...). */
  role: string;
  /** Text the message carries (content parts joined). */
  text: string;
  /** Per-round `[mN]` line ref injected by the render layer, if any. */
  ref: string | null;
  /** Block label when the message is a folded summary, else null. */
  header: string | null;
  /** Which `VIEW_TAGS` occur in the text. */
  tags: string[];
}

/** Line-ref prefix the render layer prepends to an addressed message. */
const LINE_REF_PATTERN = /^\[m(\d+)\] /;

/** Block label of a folded summary message (`[Block b1 · 4 条] title`). */
const BLOCK_LABEL_PATTERN = /\[Block b\d+ · \d+ 条\][^\n]*/;

/**
 * Project the messages of one request into what the assertions observe.
 *
 * @param messages - Provider-facing transcript.
 * @returns One entry per message, in request order.
 */
export function analyzeView(messages: readonly Message[]): ViewMessage[] {
  return messages.map((message) => {
    const text = textOf(message.content);
    const ref = LINE_REF_PATTERN.exec(text);
    const header = BLOCK_LABEL_PATTERN.exec(text);
    return {
      role: message.role,
      text,
      ref: ref === null ? null : `m${ref[1]}`,
      header: header === null ? null : header[0],
      tags: VIEW_TAGS.filter((tag) => text.includes(tag)),
    };
  });
}

/**
 * Compact trace form of one request message.
 *
 * @param message - The analysed message.
 * @param index - Position in the request.
 * @returns The entry written to the trace.
 */
function traceView(message: ViewMessage, index: number) {
  return {
    i: index,
    role: message.role,
    text: excerpt(message.text, 60),
    ...(message.ref === null ? {} : { ref: message.ref }),
    ...(message.header === null ? {} : { header: message.header }),
    ...(message.tags.length === 0 ? {} : { tags: message.tags }),
  };
}

/**
 * The last message of a request that carries a harness tag.
 *
 * @param view - Analysed request messages.
 * @param tag - Tag to look for.
 * @returns Index of the last match, or -1.
 */
function lastTagged(view: readonly ViewMessage[], tag: string): number {
  for (let index = view.length - 1; index >= 0; index -= 1) {
    if (view[index]?.tags.includes(tag)) return index;
  }
  return -1;
}

/**
 * The endpoint refs of the two target segments of a context scenario.
 *
 * The start is the line the first target message was shown on; the end is
 * the line of the message right after the second target (its reply), so the
 * range covers both target prompts and their replies.
 *
 * @param view - Analysed request messages.
 * @returns The refs, or null when a target or its follow-up is not visible.
 */
function targetRange(
  view: readonly ViewMessage[],
): { fromRef: string; toRef: string } | null {
  const first = lastTagged(view, CONTEXT_TARGET_TAGS[0]);
  const second = lastTagged(view, CONTEXT_TARGET_TAGS[1]);
  if (first < 0 || second <= first) return null;
  const from = view[first]?.ref ?? null;
  let to: string | null = null;
  for (let index = second + 1; index < view.length; index += 1) {
    const ref = view[index]?.ref ?? null;
    if (ref !== null) {
      to = ref;
      break;
    }
  }
  if (from === null || to === null) return null;
  return { fromRef: from, toRef: to };
}

/**
 * The id of the first block label the request carries.
 *
 * @param view - Analysed request messages.
 * @returns The `bN` id, or null when no folded summary is visible.
 */
function visibleBlockId(view: readonly ViewMessage[]): string | null {
  for (const message of view) {
    const id = message.header === null ? null : /b(\d+)/.exec(message.header);
    if (id !== null) return `b${id[1]}`;
  }
  return null;
}

/**
 * Decide the next assistant step from the transcript.
 *
 * @param view - Analysed request messages, in request order.
 * @returns The tool call or text the assistant produces.
 */
export function decide(view: readonly ViewMessage[]): Decision {
  let lastUser = -1;
  for (let index = view.length - 1; index >= 0; index -= 1) {
    if (view[index]?.role === "user") {
      lastUser = index;
      break;
    }
  }
  if (lastUser < 0) return { kind: "text", text: "NO-USER-MESSAGE" };

  const userText = view[lastUser]?.text ?? "";
  const results = view
    .slice(lastUser + 1)
    .filter((message) => message.role === "toolResult");
  const lastResultText = results[results.length - 1]?.text ?? "";

  const childTag = CHILD_TAG_PATTERN.exec(userText);
  if (childTag !== null) {
    return { kind: "text", text: `CHILD-OK:${childTag[1]}` };
  }

  if (userText.includes("E2E-TODO")) {
    const step = TODO_STEPS[results.length];
    if (step !== undefined) return step;
    return { kind: "text", text: `VIEW:${lastResultText}` };
  }

  if (userText.includes("E2E-VIEW")) {
    if (results.length === 0) {
      return { kind: "tool", name: "todo", argumentValue: { op: "view" } };
    }
    return { kind: "text", text: `VIEW:${lastResultText}` };
  }

  if (userText.includes("E2E-SUBAGENT")) {
    if (results.length === 0) {
      return {
        kind: "tool",
        name: "subagent",
        argumentValue: {
          agent: "lynx",
          description: "e2e child run",
          // ZooKeeper's delegation gate requires the structured prompt
          // format, so the child prompt carries the three sections.
          prompt: CHILD_PROMPT,
        },
      };
    }
    return { kind: "text", text: `SUBAGENT:${lastResultText}` };
  }

  if (userText.includes(CONTEXT_COMPRESS_PROMPT)) {
    if (results.length === 0) {
      const range = targetRange(view);
      if (range === null) {
        return { kind: "text", text: "COMPRESS-NO-VISIBLE-TARGET" };
      }
      return {
        kind: "tool",
        name: "compress",
        argumentValue: {
          ranges: [
            {
              ...range,
              title: CONTEXT_BLOCK_TITLE,
              summary: CONTEXT_SUMMARY_BODY,
            },
          ],
        },
      };
    }
    return { kind: "text", text: `COMPRESS-ACK:${lastResultText}` };
  }

  if (userText.includes(CONTEXT_DECOMPRESS_PROMPT)) {
    if (results.length === 0) {
      const blockId = visibleBlockId(view);
      if (blockId === null) {
        return { kind: "text", text: "DECOMPRESS-NO-VISIBLE-BLOCK" };
      }
      return { kind: "tool", name: "decompress", argumentValue: { blockId } };
    }
    return { kind: "text", text: `DECOMPRESS-ACK:${lastResultText}` };
  }

  if (userText.includes(CONTEXT_ANCHOR_PROMPT)) {
    return { kind: "text", text: "ANCHOR-ACK" };
  }

  const targetTag = CONTEXT_TARGET_TAGS.find((tag) => userText.includes(tag));
  if (targetTag !== undefined && userText.includes(CONTEXT_TARGET_PROMPT)) {
    const position = targetTag.replace("CTX-TARGET-", "");
    return { kind: "text", text: `TARGET-ACK:${position}` };
  }

  if (userText.includes(CONTEXT_FILL_PROMPT)) {
    const turn = /E2E-CTX-FILL[:\s]+(\d+)/.exec(userText);
    return { kind: "text", text: `FILL-ACK:${turn?.[1] ?? "?"}` };
  }

  return { kind: "text", text: `ECHO:${excerpt(userText, 120)}` };
}

/** Usage block; this provider consumes no tokens. */
function zeroUsage(): Usage {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

/**
 * `streamSimple` implementation registered on the `e2e` provider.
 *
 * Emits the documented event protocol: one `start`, balanced content
 * events, then exactly one terminal `done` (or `error` when aborted).
 *
 * @param model - The model pi resolved for this request.
 * @param context - Normalized transcript (the only input considered).
 * @param options - pi stream options (no request is performed).
 * @param rec - Trace recorder of the extension runtime that registered the
 *   provider, so a child session's calls are attributable to its runtime.
 * @returns The assistant message event stream.
 */
export function streamSimple(
  model: Model<string>,
  context: TranscriptContext,
  options?: SimpleStreamOptions,
  rec: (event: string, data?: Record<string, unknown>) => void = record,
): AssistantMessageEventStream {
  const messages = context.messages;
  const view = analyzeView(messages);
  const decision = decide(view);
  rec("provider_call", {
    model: `${model.provider}/${model.id}`,
    api: model.api,
    decision: decision.kind === "tool" ? `tool:${decision.name}` : "text",
    requestMessages: messages.length,
    view: view.map(traceView),
  });

  const stream = createAssistantMessageEventStream();
  const message: AssistantMessage = {
    role: "assistant",
    content: [],
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: zeroUsage(),
    stopReason: "pending",
    timestamp: Date.now(),
  };
  const snapshot = (): AssistantMessage => ({
    ...message,
    content: message.content.map((block) => ({ ...block })),
  });

  if (options?.signal?.aborted === true) {
    stream.push({
      type: "error",
      reason: "aborted",
      error: {
        ...snapshot(),
        stopReason: "aborted",
        errorMessage: "aborted before start",
      },
    });
    return stream;
  }

  stream.push({ type: "start", partial: snapshot() });

  if (decision.kind === "tool") {
    const callId = `e2e-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
    const pending: ToolCall = {
      type: "toolCall",
      id: callId,
      name: decision.name,
      arguments: {},
    };
    const call: ToolCall = {
      type: "toolCall",
      id: callId,
      name: decision.name,
      arguments: decision.argumentValue as ToolCall["arguments"],
    };
    message.content.push(pending);
    stream.push({
      type: "toolcall_start",
      contentIndex: 0,
      partial: snapshot(),
    });
    message.content[0] = call;
    stream.push({
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: call,
      partial: snapshot(),
    });
    const finalMessage: AssistantMessage = {
      ...snapshot(),
      stopReason: "toolUse",
    };
    stream.push({ type: "done", reason: "toolUse", message: finalMessage });
    stream.end(finalMessage);
    return stream;
  }

  const block: TextContent = { type: "text", text: "" };
  message.content.push(block);
  stream.push({ type: "text_start", contentIndex: 0, partial: snapshot() });
  block.text = decision.text;
  stream.push({
    type: "text_delta",
    contentIndex: 0,
    delta: decision.text,
    partial: snapshot(),
  });
  stream.push({
    type: "text_end",
    contentIndex: 0,
    content: decision.text,
    partial: snapshot(),
  });
  const finalMessage: AssistantMessage = {
    ...snapshot(),
    stopReason: "stop",
  };
  stream.push({ type: "done", reason: "stop", message: finalMessage });
  stream.end(finalMessage);
  return stream;
}
