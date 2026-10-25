/**
 * Tests for the fetch tool unit (`src/tools/fetch.ts`).
 *
 * Covers the fail-closed registration gate (no `htmlConverter` or no
 * `truncateHead` bound by the host → the planner skips the unit; both
 * present → exactly one `fetch` tool), the
 * argument-validation branches (non-object args, missing/empty/non-string
 * `url`, non-positive/non-numeric/an over-ceiling `timeout`) with their
 * Chinese guidance text, the caller abort signal forwarded to the request,
 * and an end-to-end execute through the real fetch pipeline with a
 * mocked `globalThis.fetch` (a public IP literal avoids DNS).
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ModeProfile } from "../core/config-types.js";
import type { Capabilities } from "../core/ports/index.js";
import type {
  HtmlConverter,
  TruncateHeadFn,
} from "../core/webfetch/pipeline.js";
import { composeForTest, facts } from "../testkits/compose.js";
import { installFetchMock, restoreFetch } from "../testkits/fetch.js";
import { createFetchTool, unit as fetchUnit } from "./fetch.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** An identity converter — the pipeline's output then equals the body. */
const identity: HtmlConverter = (html) => html;

/** A head truncator that keeps the whole body (never flags truncation). */
const keepAll: TruncateHeadFn = (content) => ({
  content,
  truncated: false,
  totalLines: 1,
  totalBytes: new TextEncoder().encode(content).length,
  outputLines: 1,
});

/** Build deps carrying an optional converter and head-truncator port. */
function deps(
  htmlConverter?: HtmlConverter,
  truncateHead?: TruncateHeadFn,
): Partial<Capabilities> {
  return {
    htmlConverter,
    truncateHead,
  } as unknown as Partial<Capabilities>;
}

/** Replace `globalThis.fetch` with a recorded fake. */
function mockFetch(handler: (url: string) => Response): void {
  installFetchMock(handler);
}

/** A single-line HTML response with the given content type. */
function htmlResponse(body: string, contentType = "text/html"): Response {
  return new Response(body, {
    status: 200,
    headers: { "content-type": contentType },
  });
}

/** Assert that executing the tool rejects with the given guidance text. */
async function assertArgError(
  tool: ReturnType<typeof createFetchTool>,
  args: unknown,
  pattern: RegExp,
): Promise<void> {
  await assert.rejects(
    () => tool.execute(args, undefined),
    (error: unknown) => {
      assert.ok(error instanceof Error, "expected an Error instance");
      assert.match(error.message, pattern);
      return true;
    },
  );
}

afterEach(() => {
  restoreFetch();
});

// ---------------------------------------------------------------------------
// Registration gate
// ---------------------------------------------------------------------------

/** A minimal mode profile enabling exactly the fetch tool unit. */
const FETCH_TOOL_PROFILE: ModeProfile = {
  name: "test",
  agents: [],
  skills: [],
  hooks: [],
  tools: ["fetch"],
  commands: [],
};

describe("fetch unit registration gate", () => {
  it("skips the unit and reports htmlConverter when the host binds none", () => {
    const result = composeForTest(
      FETCH_TOOL_PROFILE,
      [fetchUnit],
      deps(undefined, keepAll),
    );
    assert.deepEqual(result.tools, {});
    assert.deepEqual(result.report.skipped, [
      { name: "fetch", missing: ["htmlConverter"] },
    ]);
  });

  it("skips the unit and reports truncateHead without a head truncator", () => {
    const result = composeForTest(
      FETCH_TOOL_PROFILE,
      [fetchUnit],
      deps(identity),
    );
    assert.deepEqual(result.tools, {});
    assert.deepEqual(result.report.skipped, [
      { name: "fetch", missing: ["truncateHead"] },
    ]);
  });

  it("contributes exactly one fetch tool once both ports are bound", () => {
    const result = composeForTest(
      FETCH_TOOL_PROFILE,
      [fetchUnit],
      deps(identity, keepAll),
    );
    const tools = Object.values(result.tools);
    assert.equal(tools.length, 1);
    assert.equal(tools[0]?.name, "fetch");
    assert.deepEqual(tools[0]?.required, ["url"]);
    assert.deepEqual(result.report.selected, ["fetch"]);
  });

  it("never contributes an empty tool set for a selected unit", () => {
    const contributions = fetchUnit.create(deps(identity, keepAll), facts());
    assert.equal(contributions.tools.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Argument validation
// ---------------------------------------------------------------------------

describe("fetch tool argument validation", () => {
  const tool = createFetchTool(identity, keepAll);

  it("rejects non-object arguments", async () => {
    const message = /请提供包含 url 字符串参数的对象后重试。/;
    await assertArgError(tool, null, message);
    await assertArgError(tool, ["http://93.184.216.34/"], message);
    await assertArgError(tool, "http://93.184.216.34/", message);
    await assertArgError(tool, 42, message);
  });

  it("rejects a missing, non-string, or empty url", async () => {
    const message = /url 参数必须是非空字符串/;
    await assertArgError(tool, {}, message);
    await assertArgError(tool, { url: 42 }, message);
    await assertArgError(tool, { url: "" }, message);
  });

  it("rejects a non-positive or non-numeric timeout", async () => {
    const message = /timeout 参数必须是大于 0 的数字/;
    const valid = "http://93.184.216.34/";
    await assertArgError(tool, { url: valid, timeout: 0 }, message);
    await assertArgError(tool, { url: valid, timeout: -1 }, message);
    await assertArgError(tool, { url: valid, timeout: Number.NaN }, message);
    await assertArgError(
      tool,
      { url: valid, timeout: Number.POSITIVE_INFINITY },
      message,
    );
    await assertArgError(tool, { url: valid, timeout: "30" }, message);
  });

  it("rejects a timeout above the 300s ceiling", async () => {
    const message = /timeout 参数不能超过 300 秒/;
    const valid = "http://93.184.216.34/";
    await assertArgError(tool, { url: valid, timeout: 301 }, message);
    await assertArgError(tool, { url: valid, timeout: 1e9 }, message);
  });
});

// ---------------------------------------------------------------------------
// End-to-end execute
// ---------------------------------------------------------------------------

describe("fetch tool execute", () => {
  it("converts an HTML page through the injected converter", async () => {
    mockFetch(() => htmlResponse("<h1>Hi</h1>", "text/html; charset=utf-8"));
    const tool = createFetchTool((html) => `MD:${html}`, keepAll);

    const output = await tool.execute(
      { url: "http://93.184.216.34/" },
      undefined,
    );

    assert.equal(output, "MD:<h1>Hi</h1>");
  });

  it("returns plain text verbatim without converting", async () => {
    mockFetch(() => htmlResponse("plain text", "text/plain"));
    const tool = createFetchTool(() => {
      throw new Error("converter must not run for text/plain");
    }, keepAll);

    const output = await tool.execute(
      { url: "http://93.184.216.34/note.txt", timeout: 5 },
      undefined,
    );

    assert.equal(output, "plain text");
  });

  it("renders a failed fetch as model-readable error text", async () => {
    mockFetch(() => new Response("not found", { status: 404 }));
    const tool = createFetchTool(identity, keepAll);

    const output = await tool.execute(
      { url: "http://93.184.216.34/missing" },
      undefined,
    );

    assert.match(output, /status 404/);
  });

  it("forwards the caller abort signal to the request", async () => {
    let captured: AbortSignal | undefined;
    globalThis.fetch = ((
      _input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      captured = init?.signal ?? undefined;
      return Promise.resolve(
        new Response(new TextEncoder().encode("ok"), {
          status: 200,
          headers: { "content-type": "text/plain" },
        }),
      );
    }) as typeof fetch;

    const tool = createFetchTool(identity, keepAll);
    const controller = new AbortController();
    controller.abort();

    const output = await tool.execute(
      { url: "http://93.184.216.34/" },
      undefined,
      { signal: controller.signal },
    );

    assert.equal(captured?.aborted, true);
    assert.equal(output, "ok");
  });
});
