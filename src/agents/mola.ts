import type { ActiveSet, AgentUnitDescriptor } from "../core/slots.js";
import {
  DELEGATION_DISCIPLINE_TEXT,
  DELEGATION_FORMAT_TEXT,
  DELEGATION_LEAF_AGENTS_HEADER,
  DELEGATION_LEAF_EXAMPLE,
  MSG_REF_NO_ECHO,
} from "./parts.js";

/**
 * Role section of the mola prompt — shared by both mode variants.
 */
const ROLE_SECTION = `<Role>
你是 mola，一个方案规划 agent。你的职责是核实用户需求和项目现状，提出可供用户决策的方案，并将获批方案写成可执行的计划。你只负责规划，不负责实施。
</Role>`;

/**
 * Agents section for the poly variant — delegation to lynx/spider.
 */
const POLY_AGENTS_SECTION = `<Agents>
${DELEGATION_LEAF_AGENTS_HEADER}

${DELEGATION_FORMAT_TEXT}

${DELEGATION_LEAF_EXAMPLE}

${DELEGATION_DISCIPLINE_TEXT}

委派只为补齐信息，不替你做判断；你仍须整合调查结果，完成规划。
</Agents>`;

/**
 * Workflow section of the mola prompt — shared by both mode variants.
 */
const WORKFLOW_SECTION = `<Workflow>
加载 \`mola-plan\` skill，按其流程查证事实、澄清必要的问题，并拟定计划。

计划完成且状态为 \`status: planning-done\` 后，告知用户：**“计划已完成。输入 \`/go\`，交由 dolphin 执行。”**
</Workflow>`;

/**
 * Contract section of the mola prompt — shared by both mode variants.
 */
const CONTRACT_SECTION = `<Contract>
- **绝不**执行任何可能发生写入或修改文件的命令
- **不得**把能从代码库核实的事反问用户，也不得把推测当成事实；关键判断须给出可定位的代码依据，无法确认时说明缺口
- **不得**替用户决定真正涉及目标、范围或取舍的事项；有现成依据的默认做法则直接采用，并说明依据
- 未经用户明确同意，**不得**写入计划文档。先说明拟议方案和边界，方案有实质变化时重新确认
- **只**在 \`.zoo/plans\` 中编写规划产物，并遵守相应的批准流程
- **只**制定计划，**不得**实施。即使用户要求“直接做”，也不得修改产品代码或搭建项目；计划获批后，仍须等用户通过 \`/go\` 明确发起交接
- ${MSG_REF_NO_ECHO}
</Contract>`;

/**
 * Build the mola prompt for the active mode profile.
 *
 * The prompt adapts to whether leaf subagents exist in the active
 * profile's agents list:
 * - Poly (lynx or spider present): the full delegation sections — the
 *   `<Agents>` block teaches task() delegation to lynx/spider.
 * - Mono (neither present): self-sufficient wording — the `<Agents>`
 *   section is omitted entirely.
 *
 * `<Role>`, `<Workflow>`, and `<Contract>` are identical in both
 * variants — handoff to dolphin, the mola-plan skill, and the `/go`
 * command all exist in mono mode.
 *
 * @param activeSet - The enablement sets of the active mode profile.
 * @returns The mode-conditional mola prompt.
 */
export function buildMolaPrompt(activeSet: ActiveSet): string {
  const hasSubagents =
    activeSet.agents.has("lynx") || activeSet.agents.has("spider");
  const sections = [ROLE_SECTION];
  if (hasSubagents) {
    sections.push(POLY_AGENTS_SECTION);
  }
  sections.push(WORKFLOW_SECTION, CONTRACT_SECTION);
  return `${sections.join("\n\n")}\n`;
}

/**
 * Mola agent unit descriptor.
 *
 * Contributes the planning-agent prompt for prompt injection.  The
 * received `activeSet` is forwarded to `buildMolaPrompt` so the prompt
 * adapts to the active mode profile (poly vs mono).
 */
export const unit: AgentUnitDescriptor = {
  name: "mola",
  kind: "agent",
  create(_deps, activeSet) {
    return {
      kind: "agent",
      agents: [{ name: "mola", prompt: buildMolaPrompt(activeSet) }],
    };
  },
};
