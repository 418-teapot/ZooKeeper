/**
 * Runtime prompt-variant substitution keyed by the active model family.
 *
 * A prompt line may ship in two wordings: a base wording every model
 * receives, and a gpt wording tuned for the gpt family. Hosts call
 * `applyModelVariant` with the live model id so a session that switches
 * models sees the matching wording without rebuilding the prompt.
 *
 * The swap is idempotent: text is normalised toward the target variant,
 * so repeated calls and either starting variant converge. Missing model
 * information fails closed to the base wording.
 *
 * @module
 */

import { DOLPHIN_PROMPT_VARIANTS } from "../agents/dolphin.js";

/**
 * A prompt line in its base and gpt-family wordings.
 */
export interface PromptVariantPair {
  /** Wording used by non-gpt models and when the model is unknown. */
  readonly base: string;
  /** Wording used by the gpt family. */
  readonly gpt: string;
}

/**
 * Whether a model id names the gpt family.
 *
 * The provider prefix (everything up to the last `/`) is stripped before
 * matching, so `openai/gpt-5.5` and `gpt-5.5` agree. Matching is a
 * case-insensitive substring test on `gpt`, covering every gpt release
 * without pinning a version list.
 *
 * @param modelId - The host-reported model identifier.
 * @returns True when the id belongs to the gpt family.
 */
export function isGptModel(modelId: string): boolean {
  const lastSegment = modelId.includes("/")
    ? modelId.slice(modelId.lastIndexOf("/") + 1)
    : modelId;
  return lastSegment.toLowerCase().includes("gpt");
}

/**
 * Normalise prompt text to the variant matching the given model.
 *
 * For a gpt model every base line is replaced by its gpt wording; for any
 * other model, including a missing id, every gpt line is replaced by its
 * base wording. Text that carries neither wording is returned unchanged.
 *
 * @param text - The prompt text to normalise.
 * @param modelId - The live model id, or undefined when unknown.
 * @returns The text in the variant for the model family.
 */
export function applyModelVariant(
  text: string,
  modelId: string | undefined,
): string {
  const useGpt = modelId !== undefined && isGptModel(modelId);
  let result = text;
  for (const pair of DOLPHIN_PROMPT_VARIANTS) {
    result = useGpt
      ? result.split(pair.base).join(pair.gpt)
      : result.split(pair.gpt).join(pair.base);
  }
  return result;
}
