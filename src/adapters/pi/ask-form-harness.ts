/**
 * Shared fakes for driving the ask dialog through a fake `ui.custom`.
 *
 * Both the ask tool's contribution tests (`src/tools/ask.test.ts`) and the
 * presentation tests (`src/adapters/pi/ask-form.test.ts`) mount the real
 * dialog behind a fake host surface, so the fakes live here once:
 *  - `fakeTui` swallows render requests;
 *  - `fakeTheme` is an identity theme — no ANSI, so text assertions match
 *    literally;
 *  - `formHarness` implements pi's `ui.custom` contract over the real
 *    `createAskDialog` factory, exposing the mounted component and a
 *    resolver for the pending outcome.
 *
 * @module
 */

import type {
  AskDialogComponent,
  AskDialogOutcome,
  AskDialogThemeLike,
  AskDialogTuiLike,
} from "./tui/ask-dialog.js";

/** A TUI that swallows render requests. */
export function fakeTui(): AskDialogTuiLike {
  return { requestRender() {}, terminal: { rows: 24, columns: 80 } };
}

/** An identity theme — no ANSI, so the assembled text matches literally. */
export function fakeTheme(): AskDialogThemeLike {
  return { fg: (_color, text) => text, bold: (text) => text };
}

/** A `ui.custom` surface that mounts the real dialog and exposes it. */
export function formHarness(): {
  custom(factory: unknown, options: unknown): unknown;
  /** The mounted component (undefined until the factory ran). */
  component(): AskDialogComponent | undefined;
  /** Resolve the pending `ui.custom` call with an arbitrary outcome. */
  resolve(outcome: AskDialogOutcome | undefined): void;
} {
  let mounted: AskDialogComponent | undefined;
  let resolver: ((outcome: AskDialogOutcome | undefined) => void) | undefined;
  return {
    custom(factory, _options) {
      // The promise resolver is installed BEFORE the factory runs: a dialog
      // that closes during its own mount (the abort-before-mount replay)
      // must not lose its result.
      const pending = new Promise<AskDialogOutcome | undefined>((resolve) => {
        resolver = resolve;
      });
      mounted = (
        factory as (
          tui: unknown,
          theme: unknown,
          keybindings: unknown,
          done: (outcome: AskDialogOutcome) => void,
        ) => AskDialogComponent
      )(fakeTui(), fakeTheme(), {}, (outcome) => resolver?.(outcome));
      return pending;
    },
    component: () => mounted,
    resolve: (outcome) => resolver?.(outcome),
  };
}
