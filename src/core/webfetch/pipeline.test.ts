/**
 * Unit tests for the web fetch pipeline.
 *
 * `globalThis.fetch` is replaced per test so no real network request is made.
 * URLs use public IP literals to bypass DNS, except where the SSRF guard is
 * the behavior under test.
 */
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import {
  type FetchWebContentResult,
  fetchWebContent,
  type HtmlConverter,
  type TruncateHeadFn,
} from "./pipeline.js";

// ---------------------------------------------------------------------------
// Test harness
// ---------------------------------------------------------------------------

type FetchInput = Parameters<typeof fetch>[0];

const originalFetch = globalThis.fetch;
const tempDirs: string[] = [];
let calls: string[] = [];

/**
 * Install a fake `fetch` that records every requested URL.
 */
function mockFetch(handler: (url: string) => Response): void {
  calls = [];
  globalThis.fetch = ((input: FetchInput) => {
    const url =
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
    calls.push(url);
    return Promise.resolve(handler(url));
  }) as typeof fetch;
}

/**
 * Build a response with optional content type and location headers.
 */
function makeResponse(
  body: string,
  init: { status?: number; contentType?: string; location?: string } = {},
): Response {
  const headers = new Headers();
  if (init.contentType !== undefined) {
    headers.set("content-type", init.contentType);
  }
  if (init.location !== undefined) headers.set("location", init.location);
  return new Response(body, { status: init.status ?? 200, headers });
}

/**
 * Create a temp directory registered for cleanup after the test.
 */
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "zoo-fetch-test-"));
  tempDirs.push(dir);
  return dir;
}

function assertOk(
  result: FetchWebContentResult,
): asserts result is Extract<FetchWebContentResult, { ok: true }> {
  assert.equal(result.ok, true, "expected a successful result");
}

const identity: HtmlConverter = (html) => html;

/**
 * Head truncator matching pi's defaults (2000 lines / 50KB).
 *
 * The pipeline takes truncation as an injected function so it stays free
 * of host imports; this stand-in makes the truncation tests deterministic.
 */
const mockTruncate: TruncateHeadFn = (content) => {
  const maxLines = 2000;
  const maxBytes = 50 * 1024;
  const totalBytes = Buffer.byteLength(content, "utf-8");
  const lines = content.split("\n");
  const totalLines = lines.length;
  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content,
      truncated: false,
      totalLines,
      totalBytes,
      outputLines: totalLines,
    };
  }
  return {
    content: lines.slice(0, maxLines).join("\n"),
    truncated: true,
    totalLines,
    totalBytes,
    outputLines: Math.min(maxLines, totalLines),
  };
};

afterEach(() => {
  globalThis.fetch = originalFetch;
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// SSRF pre-checks
// ---------------------------------------------------------------------------

describe("fetchWebContent SSRF pre-check", () => {
  it("blocks localhost without issuing a request", async () => {
    mockFetch(() => makeResponse("nope"));
    const result = await fetchWebContent("http://localhost/", {
      converter: identity,
      truncate: mockTruncate,
      tmpDir: makeTempDir(),
    });
    assert.equal(result.ok, false);
    assert.equal(calls.length, 0);
    assert.match(result.output, /loopback hostnames/);
  });

  it("blocks the cloud metadata address", async () => {
    mockFetch(() => makeResponse("nope"));
    const result = await fetchWebContent("http://169.254.169.254/latest/", {
      converter: identity,
      truncate: mockTruncate,
      tmpDir: makeTempDir(),
    });
    assert.equal(result.ok, false);
    assert.equal(calls.length, 0);
  });

  it("blocks private DNS resolutions", async () => {
    mockFetch(() => makeResponse("nope"));
    const result = await fetchWebContent("http://internal.example.com/", {
      converter: identity,
      truncate: mockTruncate,
      tmpDir: makeTempDir(),
      lookup: async () => ["10.0.0.5"],
    });
    assert.equal(result.ok, false);
    assert.equal(calls.length, 0);
    assert.match(result.output, /resolves to non-public address/);
  });

  it("prefixes failures with the requested URL", async () => {
    mockFetch(() => makeResponse("nope"));
    const result = await fetchWebContent("http://127.0.0.1/", {
      converter: identity,
      truncate: mockTruncate,
      tmpDir: makeTempDir(),
    });
    assert.equal(result.ok, false);
    assert.match(result.output, /^Error fetching http:\/\/127\.0\.0\.1\//);
  });
});

// ---------------------------------------------------------------------------
// Content conversion and dispatch
// ---------------------------------------------------------------------------

describe("fetchWebContent content conversion", () => {
  it("converts HTML through the injected converter", async () => {
    let seen = "";
    const converter: HtmlConverter = (html) => {
      seen = html;
      return `MD:${html}`;
    };
    mockFetch(() =>
      makeResponse("<h1>Hi</h1>", { contentType: "text/html; charset=utf-8" }),
    );

    const result = await fetchWebContent("http://93.184.216.34/", {
      converter,
      truncate: mockTruncate,
      tmpDir: makeTempDir(),
    });

    assertOk(result);
    assert.equal(seen, "<h1>Hi</h1>");
    assert.equal(result.content, "MD:<h1>Hi</h1>");
    assert.equal(result.output, "MD:<h1>Hi</h1>");
    assert.equal(result.contentType, "text/html; charset=utf-8");
    assert.equal(result.truncated, false);
    assert.equal(result.url, "http://93.184.216.34/");
  });

  it("returns text/plain verbatim without converting", async () => {
    const converter: HtmlConverter = () => {
      throw new Error("converter must not run for text/plain");
    };
    mockFetch(() => makeResponse("plain text", { contentType: "text/plain" }));

    const result = await fetchWebContent("http://93.184.216.34/", {
      converter,
      truncate: mockTruncate,
      tmpDir: makeTempDir(),
    });

    assertOk(result);
    assert.equal(result.content, "plain text");
  });

  it("returns JSON verbatim without converting", async () => {
    const converter: HtmlConverter = () => {
      throw new Error("converter must not run for JSON");
    };
    mockFetch(() =>
      makeResponse('{"ok":true}', { contentType: "application/json" }),
    );

    const result = await fetchWebContent("http://93.184.216.34/", {
      converter,
      truncate: mockTruncate,
      tmpDir: makeTempDir(),
    });

    assertOk(result);
    assert.equal(result.content, '{"ok":true}');
  });

  it("returns markdown verbatim without converting", async () => {
    const converter: HtmlConverter = () => {
      throw new Error("converter must not run for markdown");
    };
    mockFetch(() => makeResponse("# Title", { contentType: "text/markdown" }));

    const result = await fetchWebContent("http://93.184.216.34/", {
      converter,
      truncate: mockTruncate,
      tmpDir: makeTempDir(),
    });

    assertOk(result);
    assert.equal(result.content, "# Title");
  });

  it("reports unsupported binary content types", async () => {
    mockFetch(() =>
      makeResponse("%PDF-1.7", { contentType: "application/pdf" }),
    );

    const result = await fetchWebContent("http://93.184.216.34/doc.pdf", {
      converter: identity,
      truncate: mockTruncate,
      tmpDir: makeTempDir(),
    });

    assert.equal(result.ok, false);
    assert.match(result.output, /Unsupported content type/);
    assert.match(result.output, /XML/);
  });
});

// ---------------------------------------------------------------------------
// Redirects
// ---------------------------------------------------------------------------

describe("fetchWebContent redirects", () => {
  it("follows a redirect and reports the final URL", async () => {
    mockFetch((url) => {
      if (url === "http://93.184.216.34/") {
        return makeResponse("", {
          status: 302,
          location: "http://93.184.216.34/final",
        });
      }
      return makeResponse("done", { contentType: "text/plain" });
    });

    const result = await fetchWebContent("http://93.184.216.34/", {
      converter: identity,
      truncate: mockTruncate,
      tmpDir: makeTempDir(),
    });

    assertOk(result);
    assert.equal(calls.length, 2);
    assert.equal(result.url, "http://93.184.216.34/final");
    assert.equal(result.content, "done");
  });

  it("resolves relative Location headers against the current URL", async () => {
    mockFetch((url) => {
      if (url.endsWith("/a/b")) {
        return makeResponse("", { status: 301, location: "/c" });
      }
      return makeResponse("relocated", { contentType: "text/plain" });
    });

    const result = await fetchWebContent("http://93.184.216.34/a/b", {
      converter: identity,
      truncate: mockTruncate,
      tmpDir: makeTempDir(),
    });

    assertOk(result);
    assert.equal(result.url, "http://93.184.216.34/c");
  });

  it("re-validates each hop and blocks a private redirect target", async () => {
    mockFetch(() =>
      makeResponse("", {
        status: 302,
        location: "http://169.254.169.254/latest/meta-data/",
      }),
    );

    const result = await fetchWebContent("http://93.184.216.34/", {
      converter: identity,
      truncate: mockTruncate,
      tmpDir: makeTempDir(),
    });

    assert.equal(result.ok, false);
    assert.equal(calls.length, 1);
    assert.match(result.output, /169\.254\.169\.254/);
  });

  it("blocks a redirect to localhost", async () => {
    mockFetch(() =>
      makeResponse("", { status: 307, location: "http://localhost/admin" }),
    );

    const result = await fetchWebContent("http://93.184.216.34/", {
      converter: identity,
      truncate: mockTruncate,
      tmpDir: makeTempDir(),
    });

    assert.equal(result.ok, false);
    assert.equal(calls.length, 1);
    assert.match(result.output, /loopback hostnames/);
  });

  it("errors after exceeding the redirect limit", async () => {
    mockFetch(() =>
      makeResponse("", { status: 302, location: "http://93.184.216.35/next" }),
    );

    const result = await fetchWebContent("http://93.184.216.34/", {
      converter: identity,
      truncate: mockTruncate,
      tmpDir: makeTempDir(),
      maxRedirects: 3,
    });

    assert.equal(result.ok, false);
    assert.equal(calls.length, 4);
    assert.match(result.output, /Too many redirects/);
  });

  it("errors when a redirect has no Location header", async () => {
    mockFetch(() => makeResponse("", { status: 302 }));

    const result = await fetchWebContent("http://93.184.216.34/", {
      converter: identity,
      truncate: mockTruncate,
      tmpDir: makeTempDir(),
    });

    assert.equal(result.ok, false);
    assert.match(result.output, /missing a Location header/);
  });
});

// ---------------------------------------------------------------------------
// Response limits and status handling
// ---------------------------------------------------------------------------

describe("fetchWebContent response limits", () => {
  it("rejects bodies larger than the 5MB default limit", async () => {
    const oversized = "a".repeat(5 * 1024 * 1024 + 1);
    mockFetch(() => makeResponse(oversized, { contentType: "text/plain" }));

    const result = await fetchWebContent("http://93.184.216.34/big", {
      converter: identity,
      truncate: mockTruncate,
      tmpDir: makeTempDir(),
    });

    assert.equal(result.ok, false);
    assert.match(result.output, /size limit/);
  });

  it("honors a custom byte limit", async () => {
    mockFetch(() => makeResponse("0123456789", { contentType: "text/plain" }));

    const result = await fetchWebContent("http://93.184.216.34/", {
      converter: identity,
      truncate: mockTruncate,
      tmpDir: makeTempDir(),
      maxBytes: 4,
    });

    assert.equal(result.ok, false);
    assert.match(result.output, /size limit/);
  });

  it("turns non-2xx responses into error text", async () => {
    mockFetch(() => makeResponse("not found", { status: 404 }));

    const result = await fetchWebContent("http://93.184.216.34/missing", {
      converter: identity,
      truncate: mockTruncate,
      tmpDir: makeTempDir(),
    });

    assert.equal(result.ok, false);
    assert.match(result.output, /status 404/);
  });
});

// ---------------------------------------------------------------------------
// Truncation
// ---------------------------------------------------------------------------

describe("fetchWebContent truncation", () => {
  it("persists the full content and appends a notice when truncated", async () => {
    const lines = Array.from({ length: 3000 }, (_, i) => `line ${i}`);
    const body = lines.join("\n");
    const dir = makeTempDir();
    mockFetch(() => makeResponse(body, { contentType: "text/plain" }));

    const result = await fetchWebContent("http://93.184.216.34/long", {
      converter: identity,
      truncate: mockTruncate,
      tmpDir: dir,
    });

    assertOk(result);
    assert.equal(result.truncated, true);
    assert.ok(result.fullContentPath);
    assert.match(
      result.output,
      /\[Truncated: .*Full content saved to .*\.md\. Use read\/grep on that file to continue\.\]/,
    );
    assert.ok(result.output.includes(result.fullContentPath as string));
    assert.equal(result.content, body);
    assert.equal(existsSync(result.fullContentPath as string), true);
    assert.equal(readFileSync(result.fullContentPath as string, "utf-8"), body);
  });

  it("does not write a file or add a notice when content fits", async () => {
    const dir = makeTempDir();
    mockFetch(() => makeResponse("short", { contentType: "text/plain" }));

    const result = await fetchWebContent("http://93.184.216.34/short", {
      converter: identity,
      truncate: mockTruncate,
      tmpDir: dir,
    });

    assertOk(result);
    assert.equal(result.truncated, false);
    assert.equal(result.fullContentPath, undefined);
    assert.equal(result.output, "short");
  });
});

// ---------------------------------------------------------------------------
// Charset decoding
// ---------------------------------------------------------------------------

describe("fetchWebContent charset decoding", () => {
  it("decodes a GBK body declared in the content type", async () => {
    const gbk = Uint8Array.from([0xd6, 0xd0, 0xce, 0xc4]);
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(gbk, {
          status: 200,
          headers: { "content-type": "text/plain; charset=GBK" },
        }),
      )) as typeof fetch;

    const result = await fetchWebContent("http://93.184.216.34/gbk", {
      converter: identity,
      truncate: mockTruncate,
      tmpDir: makeTempDir(),
    });

    assertOk(result);
    assert.equal(result.content, "中文");
  });

  it("sniffs a GBK charset from an HTML meta tag", async () => {
    const body = Buffer.concat([
      Buffer.from('<html><head><meta charset="gbk"></head><body>'),
      Buffer.from([0xd6, 0xd0, 0xce, 0xc4]),
      Buffer.from("</body></html>"),
    ]);
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(Uint8Array.from(body), {
          status: 200,
          headers: { "content-type": "text/html" },
        }),
      )) as typeof fetch;

    const result = await fetchWebContent("http://93.184.216.34/gbk.html", {
      converter: identity,
      truncate: mockTruncate,
      tmpDir: makeTempDir(),
    });

    assertOk(result);
    assert.match(result.content, /中文/);
  });

  it("falls back to UTF-8 for an unknown charset", async () => {
    const body = Buffer.from("café", "utf-8");
    globalThis.fetch = (() =>
      Promise.resolve(
        new Response(Uint8Array.from(body), {
          status: 200,
          headers: { "content-type": "text/plain; charset=not-a-charset" },
        }),
      )) as typeof fetch;

    const result = await fetchWebContent("http://93.184.216.34/x", {
      converter: identity,
      truncate: mockTruncate,
      tmpDir: makeTempDir(),
    });

    assertOk(result);
    assert.equal(result.content, "café");
  });
});

// ---------------------------------------------------------------------------
// Missing content type
// ---------------------------------------------------------------------------

describe("fetchWebContent missing content type", () => {
  it("rejects a typeless binary body containing NUL bytes", async () => {
    const body = Uint8Array.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x01]);
    globalThis.fetch = (() =>
      Promise.resolve(new Response(body, { status: 200 }))) as typeof fetch;

    const result = await fetchWebContent("http://93.184.216.34/blob", {
      converter: identity,
      truncate: mockTruncate,
      tmpDir: makeTempDir(),
    });

    assert.equal(result.ok, false);
    assert.match(result.output, /Unsupported content type/);
  });

  it("treats a typeless non-NUL body as text", async () => {
    const body = new TextEncoder().encode("plain bytes");
    globalThis.fetch = (() =>
      Promise.resolve(new Response(body, { status: 200 }))) as typeof fetch;

    const result = await fetchWebContent("http://93.184.216.34/plain", {
      converter: identity,
      truncate: mockTruncate,
      tmpDir: makeTempDir(),
    });

    assertOk(result);
    assert.equal(result.content, "plain bytes");
  });
});

// ---------------------------------------------------------------------------
// Timeouts and aborts
// ---------------------------------------------------------------------------

/** A stream that emits one chunk and never closes until aborted. */
function dripResponse(init?: RequestInit): Response {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      controller = c;
      c.enqueue(new TextEncoder().encode("first chunk"));
    },
  });
  const signal = init?.signal;
  if (signal) {
    const fail = () =>
      controller?.error(new DOMException("aborted", "AbortError"));
    if (signal.aborted) fail();
    else signal.addEventListener("abort", fail, { once: true });
  }
  return new Response(stream, {
    status: 200,
    headers: { "content-type": "text/plain" },
  });
}

describe("fetchWebContent timeouts and aborts", () => {
  it("times out while reading a slow-drip body", async () => {
    globalThis.fetch = ((_input: FetchInput, init?: RequestInit) =>
      Promise.resolve(dripResponse(init))) as typeof fetch;

    const result = await fetchWebContent("http://93.184.216.34/slow", {
      converter: identity,
      truncate: mockTruncate,
      tmpDir: makeTempDir(),
      timeoutMs: 20,
    });

    assert.equal(result.ok, false);
    assert.match(result.output, /timed out.*body/i);
  });

  it("aborts an in-flight body read when the caller signal aborts", async () => {
    const controller = new AbortController();
    globalThis.fetch = ((_input: FetchInput, init?: RequestInit) =>
      Promise.resolve(dripResponse(init))) as typeof fetch;

    setTimeout(() => controller.abort(), 5);
    const result = await fetchWebContent("http://93.184.216.34/slow", {
      converter: identity,
      truncate: mockTruncate,
      tmpDir: makeTempDir(),
      signal: controller.signal,
      timeoutMs: 10_000,
    });

    assert.equal(result.ok, false);
    assert.match(result.output, /aborted/i);
  });
});

// ---------------------------------------------------------------------------
// Temp-file retention
// ---------------------------------------------------------------------------

describe("fetchWebContent temp file retention", () => {
  it("sweeps stale zoo-fetch files, keeping fresh and unrelated files", async () => {
    const dir = makeTempDir();
    const stale = join(dir, "zoo-fetch-aaaaaaaaaaaaaaaa.md");
    const fresh = join(dir, "zoo-fetch-bbbbbbbbbbbbbbbb.md");
    const unrelated = join(dir, "keep.txt");
    writeFileSync(stale, "old");
    writeFileSync(fresh, "new");
    writeFileSync(unrelated, "keep");
    const past = new Date(Date.now() - 25 * 60 * 60 * 1000);
    utimesSync(stale, past, past);

    const lines = Array.from({ length: 3000 }, (_, i) => `line ${i}`);
    mockFetch(() =>
      makeResponse(lines.join("\n"), { contentType: "text/plain" }),
    );

    const result = await fetchWebContent("http://93.184.216.34/long", {
      converter: identity,
      truncate: mockTruncate,
      tmpDir: dir,
    });

    assertOk(result);
    assert.equal(existsSync(stale), false, "stale temp file should be swept");
    assert.equal(existsSync(fresh), true, "fresh temp file should be kept");
    assert.equal(existsSync(unrelated), true, "unrelated file should be kept");
  });
});
