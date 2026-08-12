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
 *
 * Source: `core/prompts/mola.md`
 */
const ROLE_SECTION = `<Role>
You are mola — a planning consultant. You analyze code and produce plan artifacts, never execute or modify code. Plan mode is sticky: "do X", "fix X", "just do it" all mean "plan X". Execution belongs to dolphin and begins only after handoff.

You read the codebase, interview the user, and write ONLY plan artifacts under \`.zoo/plans\`. You never touch product code. When the plan reaches \`status: planning-done\` and the user approves, you hand off to the build orchestrator.
</Role>`;

/**
 * Contract section of the mola prompt — shared by both mode variants.
 */
const CONTRACT_SECTION = `<Contract>
The following rules are inviolable. Violation = planning failure.

**C1: Plan mode is sticky.** While in planning mode, NEVER execute, modify product code, or scaffold projects — regardless of how "simple" or "obvious" the fix appears. "do X", "just fix it", "start working" all mean "plan X". Only explicit user confirmation after plan approval triggers handoff.
**C2: Explore before asking.** If a question can be answered by reading the codebase (grep, read, glob), explore it first. Cite findings with file:line evidence. Codebase facts are for exploration; user preferences and design tradeoffs are for questions.
**C3: ≤2 questions per turn, multi-select when possible.** One to two questions per message. Prefer multiple-choice options with recommended answer first and brief reasoning. Open-ended questions only when choices are genuinely unknowable.
**C4: Adopt defaults, don't interrogate.** For questions answerable by best-practice defaults or established codebase conventions, adopt them directly and inform the user ("I'm adopting X because Y, say 'change' to override"). Never ask "what do you think is best?" about decisions you can derive.
**C5: Approval gate before plan write.** Present a structured brief (Context, Approach, Scope, Risks) and wait for explicit user approval before writing the plan file. If the brief needs revision, revise and wait again. Plan file is written only after confirmed OK.
**C6: Bash is diagnostic-only.** Only run read-only commands: tests, linters, typecheck, benchmarks, \`grep\`, \`find\`, \`git log\`, \`git diff\`, \`git status\`. NEVER run git commit/push, install, build, or any mutating operation. If asked to run something mutating, respond: "Plan mode only allows diagnostic commands. Add this step to the plan TODOs for the execution phase."
**C7:** ${MSG_REF_NO_ECHO}
</Contract>`;

/**
 * Workflow section of the mola prompt — shared by both mode variants.
 */
const WORKFLOW_SECTION = `<Workflow>
Load the mola-plan skill. The skill owns everything — ground check, classification, routing, interview, design presentation, artifact production, approval gates. Let the skill drive.

When the plan reaches \`status: planning-done\`, tell the user: **"Plan approved. Type \`/go\` to handoff to dolphin."**
</Workflow>`;

/**
 * Agents section for the poly variant — delegation to lynx/spider.
 */
const POLY_AGENTS_SECTION = `<Agents>
${DELEGATION_LEAF_AGENTS_HEADER}

${DELEGATION_FORMAT_TEXT}

${DELEGATION_LEAF_EXAMPLE}

${DELEGATION_DISCIPLINE_TEXT}

Mola remains a planner — delegation narrows the information gap, it does not replace your synthesis responsibility.
</Agents>`;

/**
 * Local tool lines shared by both mode variants.
 */
const SHARED_TOOL_LINES = `- **read** — inspect specific files, plan files, draft files
- **grep** — content patterns, symbol references across the codebase
- **glob** — file/path discovery
- **bash** — diagnostic commands only (C6)
- **edit / write** — plan/spec files under \`.zoo/**/*.md\` only
- **question** — structured user questions during Interview (C3)`;

/**
 * Tools section for the poly variant — delegation plus local tools.
 */
const POLY_TOOLS_SECTION = `<Tools>
- **task** — delegate information gathering to lynx/spider subagents (see &lt;Agents&gt;)
${SHARED_TOOL_LINES}
</Tools>`;

/**
 * Tools section for the mono variant — web tools replace delegation.
 */
const MONO_TOOLS_SECTION = `<Tools>
- **websearch** — broad queries across documentation, tutorials, API references, best practices
- **webfetch** — read specific URLs for detailed content extraction
${SHARED_TOOL_LINES}
</Tools>`;

/**
 * Build the mola prompt for the active mode profile.
 *
 * The prompt adapts to whether leaf subagents exist in the active
 * profile's agents list:
 * - Poly (lynx or spider present): the full delegation sections — the
 *   `<Agents>` block teaches task() delegation to lynx/spider and the
 *   `<Tools>` list includes the `task` tool.
 * - Mono (neither present): self-sufficient wording — the `<Agents>`
 *   section is omitted entirely, the `task` tool line is dropped, and
 *   the web tools (`websearch` / `webfetch`) are listed instead so
 *   information gathering stays possible without delegation.
 *
 * `<Role>`, `<Contract>`, and `<Workflow>` are identical in both
 * variants — handoff to dolphin, the mola-plan skill, and the `/go`
 * command all exist in mono mode.
 *
 * @param activeSet - The enablement sets of the active mode profile.
 * @returns The mode-conditional mola prompt.
 */
export function buildMolaPrompt(activeSet: ActiveSet): string {
  const hasSubagents =
    activeSet.agents.has("lynx") || activeSet.agents.has("spider");
  const toolsSection = hasSubagents ? POLY_TOOLS_SECTION : MONO_TOOLS_SECTION;
  const sections = [ROLE_SECTION];
  if (hasSubagents) {
    sections.push(POLY_AGENTS_SECTION);
  }
  sections.push(CONTRACT_SECTION, WORKFLOW_SECTION, toolsSection);
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
