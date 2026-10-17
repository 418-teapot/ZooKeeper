/**
 * Web-fetch capability port.
 *
 * Pure types: the native HTML→Markdown converter loader and the host head
 * truncator the fetch pipeline needs.  The file imports types only — never
 * an implementation.
 *
 * @module
 */

import type { HtmlConverter, TruncateHeadFn } from "../webfetch/pipeline.js";

/** The web-fetch capability. */
export interface FetchPort {
  /**
   * Native HTML→Markdown converter loader.
   *
   * Absent on hosts without a native addon — the fetch tool unit then
   * contributes no tools.  A `null` result (missing addon, wrong platform,
   * ABI mismatch) also yields no tool.  Supplied by the host entry point,
   * which wraps the core loader to emit the `converter_unavailable` warn.
   */
  loadHtmlConverter: () => HtmlConverter | null;
  /**
   * Host head truncator for the fetch pipeline.
   *
   * Absent on hosts without one — the fetch tool unit then contributes no
   * tools.  Paired with `loadHtmlConverter`: the unit registers only when
   * BOTH are present, so the pipeline always receives a concrete
   * truncator.
   */
  truncateHead: TruncateHeadFn;
}
