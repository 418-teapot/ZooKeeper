/**
 * Pruning placeholder contract for the core apply/release pipeline.
 *
 * The single source of truth for the verbatim placeholder strings the
 * core apply/release machinery writes and the metrics/release layers
 * read.  Every constant here must be used verbatim — paraphrase breaks
 * the apply/release contract and silently corrupts downstream consumers.
 *
 * Has zero imports: keeps this module safe to pull from any layer
 * (metrics, producers, release) without import-cycle risk.
 *
 * @module
 */

/**
 * Placeholder text used in place of a pruned tool output.
 *
 * Must be used verbatim — never paraphrase.
 */
export const PRUNED_TOOL_OUTPUT_REPLACEMENT =
  "[Output removed to save context - information superseded or no longer needed]";

/**
 * Placeholder text used in place of a failed tool call's input.
 *
 * Must be used verbatim — never paraphrase.
 */
export const PRUNED_TOOL_ERROR_INPUT_REPLACEMENT =
  "[Input removed due to failed tool call - information no longer relevant]";
