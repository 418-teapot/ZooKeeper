/**
 * Round-view presentation port.
 *
 * The `/view` page is complete logical lines: the core aligns the columns
 * over the whole page and hands the lines over unchanged.  A host that
 * renders persistent session entries in a live client owns the page's
 * final width — it truncates each line to the width its client currently
 * shows, so a resize repaints the same page at the new width without the
 * core ever choosing one.  A host whose notification channel is
 * pre-formatted text does not implement this port, so the command does not
 * register there.
 *
 * @module
 */

/**
 * Host services for presenting a formatted page.
 */
export interface ViewHost {
  /**
   * Present one page of complete logical lines to the human observer.
   *
   * Contract: the page persists with the session record, is never visible
   * to the model, and is best-effort — `present` never throws.  The host
   * truncates each line to the width its client currently shows and never
   * re-flows the columns.
   *
   * @param sessionID - The session the page belongs to.
   * @param lines - The page's complete logical lines, in view order.
   */
  present(sessionID: string, lines: readonly string[]): void;
}

/** The view capability. */
export interface ViewPort {
  /** Host services of the `/view` command. */
  viewHost: ViewHost;
}
