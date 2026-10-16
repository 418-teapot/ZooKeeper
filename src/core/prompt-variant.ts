/**
 * Runtime prompt-variant substitution keyed by the active model family.
 *
 * A prompt line may ship in two wordings: a base wording every model
 * receives, and a gpt wording tuned for the gpt family. Hosts call
 * `applyModelVariant` with the live model id and the variant list so a
 * session that switches models sees the matching wording without
 * rebuilding the prompt.
 *
 * The swap is idempotent: text is normalised toward the target variant,
 * so repeated calls and either starting variant converge. Missing model
 * information fails closed to the base wording; a missing or empty
 * variant list leaves the text untouched. When several agents contribute
 * variants to one shared prompt, `filterDisjointVariants` drops the pairs
 * whose wordings overlap an earlier pair before they are applied.
 *
 * @module
 */

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
 * @param variants - The variant wordings to swap; an absent or empty
 *   list leaves the text untouched (fail-closed).
 * @returns The text in the variant for the model family.
 */
export function applyModelVariant(
  text: string,
  modelId: string | undefined,
  variants: readonly PromptVariantPair[] | undefined,
): string {
  const useGpt = modelId !== undefined && isGptModel(modelId);
  let result = text;
  for (const pair of variants ?? []) {
    result = useGpt
      ? result.split(pair.base).join(pair.gpt)
      : result.split(pair.gpt).join(pair.base);
  }
  return result;
}

/**
 * Whether two wordings overlap: either one is a substring of the other.
 *
 * Equality counts (a string is a substring of itself), so two agents
 * shipping the identical wording are treated as overlapping.
 *
 * @param a - One wording.
 * @param b - The other wording.
 * @returns True when the two wording strings overlap.
 */
function wordingsOverlap(a: string, b: string): boolean {
  return a.includes(b) || b.includes(a);
}

/**
 * The pairs kept by {@link filterDisjointVariants} and the pairs dropped
 * as overlapping.
 */
export interface DisjointVariantList {
  /** The retained pairs, in input order; safe to apply as one list. */
  readonly kept: readonly PromptVariantPair[];
  /** The dropped pairs, in input order, each overlapping a kept pair. */
  readonly dropped: readonly PromptVariantPair[];
}

/**
 * Keep only the pairwise non-overlapping prompt variants.
 *
 * `applyModelVariant` rewrites the text pair by pair in input order, so a
 * pair whose wording is a substring of another pair's wording rewrites
 * the other pair's output. Assembling one shared prompt from several
 * agents' variants therefore filters conflicts out first: the earliest
 * pair is kept and any later pair that overlaps a kept one is dropped. A
 * pair whose own base and gpt wordings overlap each other is dropped too
 * — its two wordings cannot be told apart, so the swap is ill-defined.
 *
 * The filter is fail-closed: a conflicting pair is discarded rather than
 * guessed at, and `kept` is always safe to apply together.
 *
 * @param variants - The variant pairs in application order.
 * @returns The kept and dropped pairs, each in input order.
 */
export function filterDisjointVariants(
  variants: readonly PromptVariantPair[],
): DisjointVariantList {
  const kept: PromptVariantPair[] = [];
  const dropped: PromptVariantPair[] = [];
  for (const pair of variants) {
    const selfConflict = wordingsOverlap(pair.base, pair.gpt);
    const keptConflict = kept.some(
      (other) =>
        wordingsOverlap(pair.base, other.base) ||
        wordingsOverlap(pair.base, other.gpt) ||
        wordingsOverlap(pair.gpt, other.base) ||
        wordingsOverlap(pair.gpt, other.gpt),
    );
    if (selfConflict || keptConflict) {
      dropped.push(pair);
      continue;
    }
    kept.push(pair);
  }
  return { kept, dropped };
}
