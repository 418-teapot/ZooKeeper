/**
 * Tests for the runtime prompt-variant substitution (`prompt-variant.ts`).
 *
 * Covers provider-prefix stripping and gpt-family detection, the
 * idempotent bidirectional swap between the base and gpt wordings of an
 * explicit variant list, and the fail-closed default when no variants are
 * supplied or the model id is missing.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  applyModelVariant,
  filterDisjointVariants,
  isGptModel,
  type PromptVariantPair,
} from "./prompt-variant.js";

/** Base (non-gpt) dolphin prompt lines, written out independently. */
const BASE_WORKFLOW = "- 获取新证据：委派给职责匹配的可用 agent；";
const BASE_CONTRACT = "- 有职责匹配的 agent 时，**不得**因省事自行接管其工作；";

/** gpt-variant counterparts of the two base lines. */
const GPT_WORKFLOW =
  "- 获取新证据：先用低成本方式确认材料的规模、范围和筛选难度；确认这些因素都在可控范围内后，再比较当前 agent 直接处理与委派的完整交付成本，选择成本更低者；如果规模或筛选难度无法确认，且材料可能超出当前上下文，优先委派给职责匹配的可用 agent；";
const GPT_CONTRACT =
  "- 职责匹配只决定可以委派给谁，不决定一定委派或不委派；**不得**因为下一步动作更方便，或因为存在匹配的 agent，就跳过完整交付成本判断；";

/** The two-line variant list the swap tests exercise. */
const VARIANTS: readonly PromptVariantPair[] = [
  { base: BASE_WORKFLOW, gpt: GPT_WORKFLOW },
  { base: BASE_CONTRACT, gpt: GPT_CONTRACT },
];

/** A prompt body carrying both base lines. */
const BASE_TEXT = `<Workflow>\n${BASE_WORKFLOW}\n<Contract>\n${BASE_CONTRACT}\n`;

/** The same body carrying both gpt-variant lines. */
const GPT_TEXT = `<Workflow>\n${GPT_WORKFLOW}\n<Contract>\n${GPT_CONTRACT}\n`;

describe("isGptModel", () => {
  it("detects the gpt family across the source forms", () => {
    for (const id of ["gpt-5.5", "openai/gpt-5.5", "OpenAI/GPT-6-astra"]) {
      assert.equal(isGptModel(id), true, `${id} must be gpt`);
    }
  });

  it("rejects non-gpt families and empty ids", () => {
    for (const id of ["claude-x", "deepseek-v4-pro", "gemini-2.5-pro", ""]) {
      assert.equal(isGptModel(id), false, `${id} must not be gpt`);
    }
  });
});

describe("applyModelVariant", () => {
  it("swaps base lines to the gpt variant for a gpt model", () => {
    assert.equal(
      applyModelVariant(BASE_TEXT, "openai/gpt-5.5", VARIANTS),
      GPT_TEXT,
    );
  });

  it("keeps base lines for non-gpt and missing model ids", () => {
    assert.equal(applyModelVariant(BASE_TEXT, "claude-x", VARIANTS), BASE_TEXT);
    assert.equal(applyModelVariant(BASE_TEXT, undefined, VARIANTS), BASE_TEXT);
  });

  it("swaps gpt lines back to base for a non-gpt model", () => {
    assert.equal(
      applyModelVariant(GPT_TEXT, "deepseek-v4-pro", VARIANTS),
      BASE_TEXT,
    );
  });

  it("is idempotent in both directions", () => {
    const onceGpt = applyModelVariant(BASE_TEXT, "gpt-5.5", VARIANTS);
    assert.equal(applyModelVariant(onceGpt, "gpt-5.5", VARIANTS), onceGpt);
    const onceBase = applyModelVariant(GPT_TEXT, "claude-x", VARIANTS);
    assert.equal(applyModelVariant(onceBase, "claude-x", VARIANTS), onceBase);
  });

  it("leaves text without the variant lines untouched", () => {
    const plain = "no variant lines here";
    assert.equal(applyModelVariant(plain, "gpt-5.5", VARIANTS), plain);
    assert.equal(applyModelVariant(plain, "claude-x", VARIANTS), plain);
    assert.equal(applyModelVariant(plain, undefined, VARIANTS), plain);
  });

  it("swaps only the wordings in the supplied variant list", () => {
    const fixture: readonly PromptVariantPair[] = [{ base: "AAA", gpt: "BBB" }];
    assert.equal(applyModelVariant("x AAA y", "gpt-5.5", fixture), "x BBB y");
    assert.equal(applyModelVariant("x BBB y", "claude-x", fixture), "x AAA y");
  });

  it("returns text unchanged when no variants are supplied", () => {
    assert.equal(applyModelVariant(BASE_TEXT, "gpt-5.5", undefined), BASE_TEXT);
    assert.equal(applyModelVariant(BASE_TEXT, "gpt-5.5", []), BASE_TEXT);
    assert.equal(applyModelVariant(GPT_TEXT, "claude-x", undefined), GPT_TEXT);
    assert.equal(applyModelVariant(GPT_TEXT, "claude-x", []), GPT_TEXT);
  });
});

describe("filterDisjointVariants", () => {
  const first: PromptVariantPair = { base: "AAA", gpt: "BBB" };
  const second: PromptVariantPair = { base: "CCC", gpt: "DDD" };
  /** `base` is a substring of `first.base`, so the two pairs overlap. */
  const overlapping: PromptVariantPair = { base: "AA", gpt: "EEE" };
  /** The pair's own gpt wording contains its base wording. */
  const selfOverlapping: PromptVariantPair = { base: "foo", gpt: "foobar" };

  it("keeps a list whose pairs are mutually disjoint", () => {
    assert.deepEqual(filterDisjointVariants([first, second]), {
      kept: [first, second],
      dropped: [],
    });
  });

  it("drops a later pair that overlaps an earlier kept pair", () => {
    assert.deepEqual(filterDisjointVariants([first, overlapping]), {
      kept: [first],
      dropped: [overlapping],
    });
    // Order decides which pair survives: the earlier one is retained.
    assert.deepEqual(filterDisjointVariants([overlapping, first]), {
      kept: [overlapping],
      dropped: [first],
    });
  });

  it("drops a pair whose own two wordings overlap", () => {
    assert.deepEqual(filterDisjointVariants([selfOverlapping]), {
      kept: [],
      dropped: [selfOverlapping],
    });
  });

  it("returns empty kept and dropped for an empty list", () => {
    assert.deepEqual(filterDisjointVariants([]), { kept: [], dropped: [] });
  });
});
