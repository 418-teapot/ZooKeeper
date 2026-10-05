/**
 * Tests for the runtime prompt-variant substitution (`prompt-variant.ts`).
 *
 * Covers provider-prefix stripping and gpt-family detection, the
 * idempotent bidirectional swap between the base and gpt dolphin prompt
 * lines, and the fail-closed default for a missing model id.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyModelVariant, isGptModel } from "./prompt-variant.js";

/** Base (non-gpt) dolphin prompt lines, written out independently. */
const BASE_WORKFLOW = "- 获取新证据：委派给职责匹配的可用 agent；";
const BASE_CONTRACT = "- 有职责匹配的 agent 时，**不得**因省事自行接管其工作；";

/** gpt-variant counterparts of the two base lines. */
const GPT_WORKFLOW =
  "- 获取新证据：先用低成本方式确认材料的规模、范围和筛选难度；确认这些因素都在可控范围内后，再比较当前 agent 直接处理与委派的完整交付成本，选择成本更低者；如果规模或筛选难度无法确认，且材料可能超出当前上下文，优先委派给职责匹配的可用 agent；";
const GPT_CONTRACT =
  "- 职责匹配只决定可以委派给谁，不决定一定委派或不委派；**不得**因为下一步动作更方便，或因为存在匹配的 agent，就跳过完整交付成本判断；";

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
    assert.equal(applyModelVariant(BASE_TEXT, "openai/gpt-5.5"), GPT_TEXT);
  });

  it("keeps base lines for non-gpt and missing model ids", () => {
    assert.equal(applyModelVariant(BASE_TEXT, "claude-x"), BASE_TEXT);
    assert.equal(applyModelVariant(BASE_TEXT, undefined), BASE_TEXT);
  });

  it("swaps gpt lines back to base for a non-gpt model", () => {
    assert.equal(applyModelVariant(GPT_TEXT, "deepseek-v4-pro"), BASE_TEXT);
  });

  it("is idempotent in both directions", () => {
    const onceGpt = applyModelVariant(BASE_TEXT, "gpt-5.5");
    assert.equal(applyModelVariant(onceGpt, "gpt-5.5"), onceGpt);
    const onceBase = applyModelVariant(GPT_TEXT, "claude-x");
    assert.equal(applyModelVariant(onceBase, "claude-x"), onceBase);
  });

  it("leaves text without the variant lines untouched", () => {
    const plain = "no variant lines here";
    assert.equal(applyModelVariant(plain, "gpt-5.5"), plain);
    assert.equal(applyModelVariant(plain, "claude-x"), plain);
    assert.equal(applyModelVariant(plain, undefined), plain);
  });
});
