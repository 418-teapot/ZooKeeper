/**
 * Web-fetch capability port.
 *
 * Pure types: the native HTML→Markdown converter and the host head
 * truncator the fetch pipeline needs.  The file imports types only — never
 * an implementation.
 *
 * @module
 */

import type { HtmlConverter, TruncateHeadFn } from "../webfetch/pipeline.js";

/** The web-fetch capability. */
export interface FetchPort {
  /**
   * The loaded native HTML→Markdown converter.
   *
   * Hosts probe their addon BEFORE the selection pass and bind the loaded
   * converter as a value; a host whose addon is missing (wrong platform,
   * ABI mismatch, not built) declares no `htmlConverter` key at all, so
   * the fetch tool unit is skipped by its `needs` list.  There is no
   * loader and no `null` value: availability is static, decided by the
   * host's binding declaration, never by a runtime fetch failure.
   */
  htmlConverter: HtmlConverter;
  /**
   * Host head truncator for the fetch pipeline.
   *
   * Absent on hosts without one — the fetch tool unit then contributes no
   * tools.  Paired with `htmlConverter`: the unit registers only when BOTH
   * are present, so the pipeline always receives a concrete truncator.
   */
  truncateHead: TruncateHeadFn;
}
