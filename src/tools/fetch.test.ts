/**
 * Tests for the fetch tool unit (`src/tools/fetch.ts`).
 *
 * Covers the fail-closed registration gate (no `loadHtmlConverter` in
 * deps → zero tools; a loader that reports the native addon unavailable
 * → zero tools; a usable converter → exactly one `fetch` tool), the
 * argument-validation branches (non-object args, missing/empty/non-string
 * `url`, non-positive/non-numeric/an over-ceiling `timeout`) with their
 * Chinese guidance text, the caller abort signal forwarded to the request,
 * and an end-to-end execute through the real fetch pipeline with a
 * mocked `globalThis.fetch` (a public IP literal avoids DNS).
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import type { ActiveSet, Deps } from "../core/slots.js";
import type { HtmlConverter } from "../core/webfetch/pipeline.js";
import { createFetchTool, unit as fetchUnit } from "./fetch.js";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const originalFetch = globalThis.fetch;

/** An identity converter — the pipeline's output then equals the body. */
const identity: HtmlConverter = (html) => html;

/** Build deps carrying an optional converter loader. */
function deps(loadHtmlConverter?: () => HtmlConverter | null): Deps {
  return { loadHtmlConverter } as unknown as Deps;
}

/** Replace `globalThis.fetch` with a recorded fake. */
function mockFetch(handler: (url: string) => Response): void {
  globalThis.fetch = ((input: Parameters<typeof fetch>[0]) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    return Promise.resolve(handler(url));
  }) as typeof fetch;
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
  globalThis.fetch = originalFetch;
});

// ---------------------------------------------------------------------------
// Registration gate
// ---------------------------------------------------------------------------

describe("fetch unit registration gate", () => {
  it("contributes no tools without a converter loader", () => {
    const contributions = fetchUnit.create(deps(), {} as ActiveSet);
    assert.equal(contributions.kind, "tool");
    assert.deepEqual(contributions.tools, []);
  });

  it("contributes no tools when the loader reports no addon", () => {
    const contributions = fetchUnit.create(
      deps(() => null),
      {} as ActiveSet,
    );
    assert.deepEqual(contributions.tools, []);
  });

  it("contributes one fetch tool with a usable converter", () => {
    const contributions = fetchUnit.create(
      deps(() => identity),
      {} as ActiveSet,
    );
    assert.equal(contributions.tools.length, 1);
    const tool = contributions.tools[0];
    assert.ok(tool);
    assert.equal(tool.name, "fetch");
    assert.deepEqual(tool.required, ["url"]);
  });
});

// ---------------------------------------------------------------------------
// Argument validation
// ---------------------------------------------------------------------------

describe("fetch tool argument validation", () => {
  const tool = createFetchTool(identity);

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
    const tool = createFetchTool((html) => `MD:${html}`);

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
    });

    const output = await tool.execute(
      { url: "http://93.184.216.34/note.txt", timeout: 5 },
      undefined,
    );

    assert.equal(output, "plain text");
  });

  it("renders a failed fetch as model-readable error text", async () => {
    mockFetch(() => new Response("not found", { status: 404 }));
    const tool = createFetchTool(identity);

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

    const tool = createFetchTool(identity);
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
