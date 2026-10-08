/**
 * Message and content-part builders for the opencode adapter tests.
 *
 * The opencode adapter test files (`render.test.ts`, `apply-view.test.ts`,
 * `history.test.ts`, and `tui/controller.test.ts`) construct v1 fixture
 * parts through these builders.  `toolPart` and `textPart` carry the
 * superset of the fields the in-scope call sites use; the omitted
 * optional fields never materialise as keys, so the emitted shape stays
 * byte-identical to the call site's former local builder.
 *
 * @module
 */

/**
 * Build a v1 tool part with string or structured input/output.
 *
 * @param tool - The tool name.
 * @param input - The tool input.
 * @param output - The tool output.
 * @param status - Optional host-verbatim call status.
 * @param callID - Optional call identifier.
 * @returns The v1 tool part.
 */
export function toolPart(
  tool: string,
  input: unknown,
  output: unknown,
  status?: string,
  callID?: string,
): Record<string, unknown> {
  return {
    type: "tool",
    tool,
    ...(callID ? { callID } : {}),
    state: {
      input,
      output,
      ...(status ? { status } : {}),
    },
  };
}

/**
 * Build a v1 text part.
 *
 * @param text - The part text.
 * @param ignored - When true, mark the part ignored.
 * @returns The v1 text part.
 */
export function textPart(
  text: string,
  ignored?: boolean,
): Record<string, unknown> {
  return { type: "text", text, ...(ignored ? { ignored: true } : {}) };
}
