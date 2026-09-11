/**
 * Native HTML→Markdown converter loader for the fetch tool.
 *
 * Resolves the compiled `zweb` N-API addon from the single flat artifact
 * emitted next to the crate (`tools/zweb/zweb.node`) and adapts its
 * `htmlToMarkdown` export to the pipeline's {@link HtmlConverter}
 * signature.
 *
 * Every failure (missing file, wrong architecture, ABI mismatch,
 * malformed addon) degrades to `null` instead of throwing,
 * so callers can fail closed — e.g. the pi host skips registering the
 * fetch tool — without risking the host process.
 *
 * Framework-independent: only Node built-ins are imported.
 *
 * @module
 */

import { existsSync, realpathSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { HtmlConverter } from "./pipeline.js";

/** Overrides for {@link htmlConverterCandidatePaths} (tests inject these). */
export interface ConverterPathOptions {
  /** Repository root. Defaults to the resolved location of this module. */
  root?: string;
}

// ---------------------------------------------------------------------------
// Path resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the repository root from this module's real location.
 *
 * `realpathSync` follows a host auto-discovery symlink (pi) to the real
 * `src/` location, so `../../..` always lands on the repository root even
 * when this module is loaded through a symlink.  On realpath failure the
 * raw module path is used as a fallback (matching `src/registry.ts`).
 *
 * @returns The absolute repository root.
 */
function repositoryRoot(): string {
  const moduleUrl = fileURLToPath(import.meta.url);
  let here: string;
  try {
    here = dirname(realpathSync(moduleUrl));
  } catch {
    here = dirname(moduleUrl);
  }
  // here = <root>/src/core/webfetch
  return resolve(here, "../../..");
}

/**
 * Build the candidate paths for the native converter.
 *
 * `build.sh` drops the flat addon next to the crate, so there is a single
 * candidate location.
 *
 * @param options - Optional root override.
 * @returns Absolute candidate paths, most preferred first.
 */
export function htmlConverterCandidatePaths(
  options: ConverterPathOptions = {},
): string[] {
  const root = options.root ?? repositoryRoot();
  return [resolve(root, "tools/zweb/zweb.node")];
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

/** Cached `createRequire` bound to this module's URL. */
let _require: ReturnType<typeof createRequire> | undefined;

/** The `createRequire` bound to this module (created once). */
function nodeRequire(): ReturnType<typeof createRequire> {
  _require ??= createRequire(import.meta.url);
  return _require;
}

/**
 * Load one candidate path and adapt its `htmlToMarkdown` export.
 *
 * Any error (unreadable file, ABI mismatch, missing export) is caught and
 * reported as `null`, so the caller can try the next candidate or fail
 * closed.
 *
 * @param path - Absolute candidate path.
 * @returns The converter, or `null` when the candidate cannot be used.
 */
function loadCandidate(path: string): HtmlConverter | null {
  try {
    const mod = nodeRequire()(path);
    const fn = (mod as { htmlToMarkdown?: unknown }).htmlToMarkdown;
    if (typeof fn !== "function") return null;
    const convert = fn as (html: string) => string;
    return (html: string) => convert(html);
  } catch {
    return null;
  }
}

/**
 * Load the first usable converter from an explicit candidate list.
 *
 * @param paths - Candidate paths, most preferred first.
 * @returns The converter, or `null` when none of the candidates load.
 */
export function loadHtmlConverterFrom(paths: string[]): HtmlConverter | null {
  for (const path of paths) {
    if (!existsSync(path)) continue;
    const converter = loadCandidate(path);
    if (converter !== null) return converter;
  }
  return null;
}

/**
 * Load the native HTML→Markdown converter for this machine.
 *
 * Probes the standard candidate locations and returns `null` when the
 * addon is absent or unusable — never throws.  Callers fail closed on
 * `null` (the pi host skips registering the fetch tool).
 *
 * @returns The converter, or `null` when unavailable.
 */
export function loadHtmlConverter(): HtmlConverter | null {
  return loadHtmlConverterFrom(htmlConverterCandidatePaths());
}
