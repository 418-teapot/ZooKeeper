/**
 * Framework-independent web fetch pipeline.
 *
 * Validates the target URL against SSRF rules, follows redirects manually
 * while re-validating every hop, decodes bodies with their declared
 * charset, converts HTML to Markdown through an injected converter, and
 * truncates the result through an injected head truncator. When truncation
 * occurs the full text is persisted to a temp file and the output tells
 * the model where to find it.
 *
 * @module
 */

import { randomBytes } from "node:crypto";
import { readdir, stat, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type LookupFn, validateRemoteUrl } from "./ssrf.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Converts an HTML document to Markdown. Provided by the host. */
export type HtmlConverter = (html: string) => string;

/**
 * Outcome of a head truncation.
 *
 * Structurally compatible with pi's `TruncationResult`, but declared here
 * so this module stays free of host imports.
 */
export interface TruncationOutcome {
  /** Truncated content (complete lines only). */
  content: string;
  /** Whether the content exceeded the configured limits. */
  truncated: boolean;
  /** Total lines in the original content. */
  totalLines: number;
  /** Total bytes in the original content. */
  totalBytes: number;
  /** Complete lines kept in the truncated content. */
  outputLines: number;
}

/**
 * Head truncator injected by the host (pi's `truncateHead`), keeping the
 * first N lines / bytes of untrusted content.
 */
export type TruncateHeadFn = (content: string) => TruncationOutcome;

/** Options for {@link fetchWebContent}. */
export interface FetchWebContentOptions {
  /** HTML → Markdown converter injected by the host. */
  converter: HtmlConverter;
  /** Head truncator injected by the host (pi's `truncateHead`). */
  truncate: TruncateHeadFn;
  /** Request timeout in milliseconds. Defaults to 30000. */
  timeoutMs?: number;
  /**
   * Caller abort signal.  Aborting it aborts the in-flight request and
   * body read, in addition to the timeout.
   */
  signal?: AbortSignal;
  /** Directory for truncated full-content files. Defaults to the OS temp dir. */
  tmpDir?: string;
  /** Maximum accepted response body size in bytes. Defaults to 5 MiB. */
  maxBytes?: number;
  /** Maximum number of redirect hops. Defaults to 10. */
  maxRedirects?: number;
  /** Injectable DNS resolver used for SSRF checks. */
  lookup?: LookupFn;
}

/** Successful fetch outcome. */
export interface FetchWebContentSuccess {
  /** Discriminant marking a successful fetch. */
  ok: true;
  /** Final URL after following redirects. */
  url: string;
  /** HTTP status code of the final response. */
  status: number;
  /** Raw `content-type` header of the final response. */
  contentType: string;
  /** Full converted text before truncation. */
  content: string;
  /** Model-facing text: truncated content plus a notice when truncated. */
  output: string;
  /** Whether the content exceeded the head truncation limits. */
  truncated: boolean;
  /** Path to the persisted full content when truncated. */
  fullContentPath?: string;
}

/** Failed fetch outcome; the error is rendered as model-readable text. */
export interface FetchWebContentFailure {
  /** Discriminant marking a failed fetch. */
  ok: false;
  /** Human-readable failure reason. */
  error: string;
  /** Model-facing error text. */
  output: string;
}

/** Result of {@link fetchWebContent}. */
export type FetchWebContentResult =
  | FetchWebContentSuccess
  | FetchWebContentFailure;

/** Error raised internally for fetch failures. */
export class FetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FetchError";
  }
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Response body cap (5 MiB) enforced while streaming. */
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;
/** Maximum number of redirect hops before giving up. */
const MAX_REDIRECTS = 10;
/** Default per-request timeout. */
const DEFAULT_TIMEOUT_MS = 30_000;
/** Bytes inspected when sniffing an HTML `<meta charset>` declaration. */
const META_SNIFF_BYTES = 8192;
/** Bytes inspected when deciding whether a typeless body is binary. */
const BINARY_SNIFF_BYTES = 8192;
/** Age after which stale truncated-content temp files are swept. */
const TEMP_FILE_RETENTION_MS = 24 * 60 * 60 * 1000;
/** Filename prefix of truncated-content temp files. */
const TEMP_FILE_PREFIX = "zoo-fetch-";
/** Status codes treated as redirects. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Desktop Chrome user agent used to discourage bot-only responses. */
const DESKTOP_CHROME_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36";

/** Request headers sent with every hop. */
const REQUEST_HEADERS: Record<string, string> = {
  "User-Agent": DESKTOP_CHROME_UA,
  Accept:
    "text/html,application/xhtml+xml,application/xml;q=0.9," +
    "text/plain;q=0.8,application/json;q=0.8,*/*;q=0.7",
  "Accept-Language": "en-US,en;q=0.9",
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Render a byte count as a compact human-readable size.
 *
 * @param bytes - Size in bytes.
 * @returns A label such as `5MB`, `50KB`, or `900B`.
 */
function describeBytes(bytes: number): string {
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / (1024 * 1024))}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

/**
 * Extract the charset label from a `content-type` header.
 *
 * @param contentType - Raw `content-type` header value.
 * @returns The lowercase charset label, or `null` when absent.
 */
function charsetFromContentType(contentType: string): string | null {
  const match = /;\s*charset\s*=\s*"?([^";\s]+)"?/i.exec(contentType);
  const label = match?.[1]?.trim().toLowerCase();
  return label !== undefined && label.length > 0 ? label : null;
}

/**
 * Sniff an HTML `<meta charset>` declaration from the raw bytes.
 *
 * Scans only the first {@link META_SNIFF_BYTES} bytes as Latin-1 (a
 * byte-preserving view) so a declared legacy charset is found before any
 * lossy decode.  Both `<meta charset="gbk">` and the older
 * `<meta http-equiv="Content-Type" content="...; charset=gbk">` form
 * match.
 *
 * @param body - Raw response body.
 * @returns The lowercase charset label, or `null` when absent.
 */
function sniffMetaCharset(body: Buffer): string | null {
  const head = body.subarray(0, META_SNIFF_BYTES).toString("latin1");
  const metaTags = head.match(/<meta\b[^>]*>/gi);
  if (metaTags === null) return null;

  for (const tag of metaTags) {
    const match = /charset\s*=\s*["']?\s*([a-z0-9._-]+)/i.exec(tag);
    if (match?.[1] !== undefined) return match[1].toLowerCase();
  }
  return null;
}

/**
 * Decode a response body using its declared or sniffed charset.
 *
 * The `content-type` charset wins; HTML falls back to a `<meta charset>`
 * sniff, and any unknown or invalid label falls back to UTF-8.
 *
 * @param body - Raw response body.
 * @param contentType - Raw `content-type` header value.
 * @param kind - Classified handling strategy.
 * @returns The decoded text.
 */
function decodeBody(
  body: Buffer,
  contentType: string,
  kind: "html" | "text",
): string {
  const declared = charsetFromContentType(contentType);
  const sniffed = kind === "html" ? sniffMetaCharset(body) : null;
  const label = declared ?? sniffed ?? "utf-8";
  try {
    return new TextDecoder(label).decode(body);
  } catch {
    return new TextDecoder("utf-8").decode(body);
  }
}

/**
 * Test whether the first {@link BINARY_SNIFF_BYTES} bytes contain a NUL.
 *
 * A typeless response with an embedded NUL is overwhelmingly likely to be
 * binary, so it is rejected rather than returned as mojibake text.
 *
 * @param body - Raw response body.
 * @returns `true` when a NUL byte is present in the sniff window.
 */
function hasNulByte(body: Buffer): boolean {
  const end = Math.min(body.length, BINARY_SNIFF_BYTES);
  for (let i = 0; i < end; i++) {
    if (body[i] === 0) return true;
  }
  return false;
}

/**
 * Classify a response content type into a handling strategy.
 *
 * @param contentType - Raw `content-type` header (case-insensitive).
 * @returns `"html"` for HTML, `"text"` for directly usable text, and
 *   `"binary"` for anything unsupported.
 */
export function classifyContentType(
  contentType: string,
): "html" | "text" | "binary" {
  const mime = (contentType.split(";")[0] ?? "").trim().toLowerCase();

  if (mime === "text/html" || mime === "application/xhtml+xml") return "html";
  if (mime === "application/json" || mime.endsWith("+json")) return "text";
  if (mime === "application/xml" || mime.endsWith("+xml")) return "text";
  if (mime.startsWith("text/")) return "text";
  if (mime === "") return "text";

  return "binary";
}

/**
 * Read a response body while enforcing an upper byte limit.
 *
 * @param response - Fetch response whose body should be consumed.
 * @param maxBytes - Maximum number of bytes accepted.
 * @returns The body as a buffer.
 * @throws {FetchError} When the body exceeds `maxBytes`.
 */
async function readBody(response: Response, maxBytes: number): Promise<Buffer> {
  if (!response.body) {
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > maxBytes) {
      throw new FetchError(
        `Response exceeds the ${describeBytes(maxBytes)} size limit.`,
      );
    }
    return buffer;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new FetchError(
          `Response exceeds the ${describeBytes(maxBytes)} size limit.`,
        );
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  return Buffer.concat(chunks, total);
}

/**
 * Remove stale `zoo-fetch-*.md` files from a directory.
 *
 * Best effort by design: every filesystem error is swallowed, since a
 * failed sweep must never block the fetch that triggered it.
 *
 * @param dir - Directory to sweep.
 */
async function sweepStaleFetchFiles(dir: string): Promise<void> {
  try {
    const entries = await readdir(dir);
    const cutoff = Date.now() - TEMP_FILE_RETENTION_MS;
    await Promise.all(
      entries.map(async (name) => {
        if (!name.startsWith(TEMP_FILE_PREFIX) || !name.endsWith(".md")) {
          return;
        }
        const path = join(dir, name);
        try {
          const info = await stat(path);
          if (info.mtimeMs < cutoff) await unlink(path);
        } catch {
          // Ignore: the file may have been removed concurrently.
        }
      }),
    );
  } catch {
    // Ignore: the directory may be unreadable or missing.
  }
}

/**
 * Persist the full converted content to a temp file.
 *
 * Stale siblings from earlier runs are swept first so the temp directory
 * does not accumulate `zoo-fetch-*.md` files indefinitely.
 *
 * @param content - Full untruncated content.
 * @param dir - Directory to write into.
 * @returns The absolute path of the written file.
 */
async function persistFullContent(
  content: string,
  dir: string,
): Promise<string> {
  await sweepStaleFetchFiles(dir);
  const filePath = join(
    dir,
    `${TEMP_FILE_PREFIX}${randomBytes(8).toString("hex")}.md`,
  );
  await writeFile(filePath, content, "utf-8");
  return filePath;
}

/** Options resolved from {@link FetchWebContentOptions}. */
interface ResolvedOptions {
  converter: HtmlConverter;
  truncate: TruncateHeadFn;
  timeoutMs: number;
  signal?: AbortSignal;
  maxBytes: number;
  maxRedirects: number;
  lookup?: LookupFn;
}

/** A fully read, non-redirect response. */
interface RawResponse {
  status: number;
  contentType: string;
  body: Buffer;
  finalUrl: string;
}

/** A request-scoped abort controller linked to a timeout and caller signal. */
interface RequestSignal {
  /** Signal handed to `fetch`. */
  signal: AbortSignal;
  /** Whether the timeout (rather than the caller) fired. */
  timedOut(): boolean;
  /** Clear the timer and detach the caller listener. */
  cleanup(): void;
}

/**
 * Build an abort controller that fires on timeout or caller abort.
 *
 * The signal stays live for the whole request — headers AND body — so a
 * slow-drip body cannot outlive the deadline.
 *
 * @param timeoutMs - Milliseconds before the request is aborted.
 * @param external - Optional caller signal to mirror.
 * @returns The linked controller plus its cleanup handle.
 */
function createRequestSignal(
  timeoutMs: number,
  external: AbortSignal | undefined,
): RequestSignal {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);
  const onAbort = () => controller.abort(external?.reason);
  if (external !== undefined) {
    if (external.aborted) controller.abort(external.reason);
    else external.addEventListener("abort", onAbort, { once: true });
  }
  return {
    signal: controller.signal,
    timedOut: () => timedOut,
    cleanup: () => {
      clearTimeout(timer);
      external?.removeEventListener("abort", onAbort);
    },
  };
}

/**
 * Follow redirects manually, re-validating SSRF on every hop.
 *
 * @param startUrl - Already-validated starting URL.
 * @param options - Resolved fetch options.
 * @returns The final non-redirect response.
 * @throws {FetchError} On missing `location`, too many hops, or a bad status.
 */
async function requestWithRedirects(
  startUrl: URL,
  options: ResolvedOptions,
): Promise<RawResponse> {
  let current = startUrl;

  for (let hop = 0; hop <= options.maxRedirects; hop++) {
    const request = createRequestSignal(options.timeoutMs, options.signal);
    try {
      let response: Response;
      try {
        response = await fetch(current, {
          redirect: "manual",
          signal: request.signal,
          headers: REQUEST_HEADERS,
        });
      } catch (err) {
        throw request.timedOut()
          ? new FetchError(`Request timed out after ${options.timeoutMs}ms.`)
          : err;
      }

      if (REDIRECT_STATUSES.has(response.status)) {
        const location = response.headers.get("location");
        if (!location) {
          throw new FetchError(
            `Redirect response (${response.status}) is missing a Location header.`,
          );
        }

        if (response.body) {
          await response.body.cancel().catch(() => {});
        }

        const target = new URL(location, current);
        current = await validateRemoteUrl(target.toString(), {
          lookup: options.lookup,
        });
        continue;
      }

      const contentType = response.headers.get("content-type") ?? "";
      let body: Buffer;
      try {
        body = await readBody(response, options.maxBytes);
      } catch (err) {
        throw request.timedOut()
          ? new FetchError(
              `Timed out after ${options.timeoutMs}ms while reading ` +
                "the response body.",
            )
          : err;
      }

      if (response.status < 200 || response.status >= 300) {
        throw new FetchError(
          `Request failed with status ${response.status} ${response.statusText}`.trim(),
        );
      }

      return {
        status: response.status,
        contentType,
        body,
        finalUrl: current.toString(),
      };
    } finally {
      request.cleanup();
    }
  }

  throw new FetchError(
    `Too many redirects (more than ${options.maxRedirects}).`,
  );
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetch a remote URL and return model-ready content.
 *
 * URLs are SSRF-validated before the first request and again after every
 * redirect. Bodies are decoded with their declared charset (or an HTML
 * `<meta charset>` sniff). HTML is converted with the injected converter,
 * while `text/*`, JSON, and XML bodies are returned verbatim. Truncation
 * uses the injected head truncator (pi's 2000 lines / 50KB); the full text
 * is written to `tmpDir` and referenced in the output.
 *
 * @param rawUrl - URL to fetch.
 * @param options - Converter, truncator, timeout, temp directory, and limits.
 * @returns A structured result; failures are returned as text, never thrown.
 */
export async function fetchWebContent(
  rawUrl: string,
  options: FetchWebContentOptions,
): Promise<FetchWebContentResult> {
  const resolved: ResolvedOptions = {
    converter: options.converter,
    truncate: options.truncate,
    timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    signal: options.signal,
    maxBytes: options.maxBytes ?? MAX_RESPONSE_BYTES,
    maxRedirects: options.maxRedirects ?? MAX_REDIRECTS,
    lookup: options.lookup,
  };
  const dir = options.tmpDir ?? tmpdir();

  try {
    const startUrl = await validateRemoteUrl(rawUrl, {
      lookup: resolved.lookup,
    });
    const response = await requestWithRedirects(startUrl, resolved);

    const header = response.contentType;
    let kind = classifyContentType(header);
    if (header.trim() === "" && hasNulByte(response.body)) {
      kind = "binary";
    }
    if (kind === "binary") {
      throw new FetchError(
        `Unsupported content type "${header || "unknown"}": ` +
          "only HTML, text, Markdown, JSON, and XML are supported.",
      );
    }

    const decoded = decodeBody(response.body, header, kind);
    const content = kind === "html" ? resolved.converter(decoded) : decoded;
    const truncation = resolved.truncate(content);

    if (!truncation.truncated) {
      return {
        ok: true,
        url: response.finalUrl,
        status: response.status,
        contentType: response.contentType,
        content,
        output: content,
        truncated: false,
      };
    }

    const fullContentPath = await persistFullContent(content, dir);
    const notice =
      `[Truncated: showing first ${truncation.outputLines} of ` +
      `${truncation.totalLines} lines (${describeBytes(truncation.totalBytes)} ` +
      `total). Full content saved to ${fullContentPath}. ` +
      "Use read/grep on that file to continue.]";

    return {
      ok: true,
      url: response.finalUrl,
      status: response.status,
      contentType: response.contentType,
      content,
      output: `${truncation.content}\n\n${notice}`,
      truncated: true,
      fullContentPath,
    };
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      error,
      output: `Error fetching ${rawUrl}: ${error}`,
    };
  }
}
