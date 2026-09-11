/**
 * Fetch tool — pi-only URL fetching with HTML→Markdown conversion.
 *
 * A thin adapter over the framework-independent fetch pipeline
 * (`src/core/webfetch/pipeline.ts`): validates the arguments, injects the
 * native HTML→Markdown converter and the host head truncator, and
 * returns the pipeline's model-facing `output` (truncation notice
 * included).  The pipeline owns SSRF validation, redirect re-validation,
 * response size limits, and full-content persistence, so this adapter
 * stays policy-free.
 *
 * Host gating is fail-closed and expressed entirely through deps: the
 * unit contributes the tool only when the pi entry point supplies the
 * converter loader (`deps.loadHtmlConverter`).  OpenCode never supplies
 * it, so `fetch` is never registered there; on pi a missing or unusable
 * native addon (the loader returns `null`) also yields no tool, leaving
 * the host unchanged instead of registering a tool that cannot run.
 *
 * @module
 */

import { truncateHead } from "@earendil-works/pi-coding-agent";
import type { ToolContribution, ToolUnitDescriptor } from "../core/slots.js";
import {
  fetchWebContent,
  type HtmlConverter,
} from "../core/webfetch/pipeline.js";

/** Maximum accepted `timeout` argument, in seconds. */
const MAX_TIMEOUT_SECONDS = 300;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Validated fetch tool arguments. */
interface FetchToolInput {
  url: string;
  timeout?: number;
}

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

/** Loud argument error, phrased as guidance for the model (repo idiom). */
function argError(message: string): Error {
  return new Error(`fetch 工具参数错误：${message}`);
}

/**
 * Validate the tool arguments: a required string `url` and an optional
 * positive numeric `timeout` (seconds).
 *
 * @param args - The raw tool arguments.
 * @returns The validated input.
 * @throws A loud Chinese error when the arguments are malformed.
 */
function validateFetchArgs(args: unknown): FetchToolInput {
  if (args === null || typeof args !== "object" || Array.isArray(args)) {
    throw argError("请提供包含 url 字符串参数的对象后重试。");
  }

  const input = args as Record<string, unknown>;
  const url = input.url;
  if (typeof url !== "string" || url.length === 0) {
    throw argError("url 参数必须是非空字符串（http 或 https 地址）。");
  }

  const timeout = input.timeout;
  if (
    timeout !== undefined &&
    (typeof timeout !== "number" || !Number.isFinite(timeout) || timeout <= 0)
  ) {
    throw argError("timeout 参数必须是大于 0 的数字（单位：秒）。");
  }
  if (timeout !== undefined && timeout > MAX_TIMEOUT_SECONDS) {
    throw argError(`timeout 参数不能超过 ${MAX_TIMEOUT_SECONDS} 秒。`);
  }

  return { url, ...(timeout !== undefined ? { timeout } : {}) };
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create the fetch tool bound to a converter.
 *
 * The converter and the host head truncator are captured by the closure;
 * the adapter forwards the caller's abort signal so a cancelled tool call
 * aborts the in-flight request.
 *
 * @param converter - The native HTML→Markdown converter.
 * @returns The fetch tool contribution.
 */
export function createFetchTool(converter: HtmlConverter): ToolContribution {
  return {
    name: "fetch",
    description:
      "获取指定 URL 的内容并返回。HTML 页面会转换为 Markdown，纯文本、Markdown、JSON 和 XML 则按原格式返回。仅支持公网 http/https 地址，每次重定向都会重新进行安全校验，以防止 SSRF 攻击。返回内容最多包含 2000 行或 50KB，超出部分会被截断；截断时，完整内容会保存到临时文件，并在返回结果中附带文件路径。",
    args: {
      url: {
        type: "string",
        description: "要抓取的 http 或 https URL。",
      },
      timeout: {
        type: "number",
        description: "请求超时时间（秒），默认 30，最大 300。",
      },
    },
    required: ["url"],
    async execute(args, _toolCtx, hostCtx) {
      const input = validateFetchArgs(args);
      const result = await fetchWebContent(input.url, {
        converter,
        truncate: truncateHead,
        ...(input.timeout !== undefined
          ? { timeoutMs: input.timeout * 1000 }
          : {}),
        ...(hostCtx?.signal !== undefined ? { signal: hostCtx.signal } : {}),
      });
      return result.output;
    },
  };
}

/**
 * Fetch tool unit descriptor.
 *
 * Fail-closed host gating: without `deps.loadHtmlConverter` (OpenCode) or
 * when the loader reports the native addon unavailable, the unit
 * contributes no tools.  `name` doubles as the registry key and the tool
 * key.
 */
export const unit: ToolUnitDescriptor = {
  name: "fetch",
  kind: "tool",
  create(deps) {
    const load = deps.loadHtmlConverter;
    if (load === undefined) {
      return { kind: "tool", tools: [] };
    }
    const converter = load();
    if (converter === null) {
      return { kind: "tool", tools: [] };
    }
    return { kind: "tool", tools: [createFetchTool(converter)] };
  },
};
