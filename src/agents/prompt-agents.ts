/**
 * The prompt-only agent units, generated from one data table.
 *
 * beaver / lynx / kiwi / eagle / spider carry no runtime behavior: each
 * contributes a fixed prompt under its own name.  Their descriptors are
 * therefore data — one `[name, prompt]` row per agent — rather than five
 * near-identical factories, so each agent name is written exactly once
 * and both the descriptor and the injected contribution share it.
 *
 * Agents with real behavior (dolphin, mola) keep their own module because
 * their prompts depend on the active profile.
 *
 * @module
 */

import { type AgentUnitDescriptor, definePromptAgent } from "../core/unit.js";
import { BEAVER_PROMPT } from "./beaver.js";
import { EAGLE_PROMPT } from "./eagle.js";
import { KIWI_PROMPT } from "./kiwi.js";
import { LYNX_PROMPT } from "./lynx.js";
import { SPIDER_PROMPT } from "./spider.js";

/**
 * Name and prompt of every prompt-only agent, in registry order.
 *
 * The prompt text stays with the agent's own module; this table adds the
 * name to it.
 */
const PROMPT_AGENTS: readonly (readonly [string, string])[] = [
  ["beaver", BEAVER_PROMPT],
  ["lynx", LYNX_PROMPT],
  ["spider", SPIDER_PROMPT],
  ["eagle", EAGLE_PROMPT],
  ["kiwi", KIWI_PROMPT],
];

/** The prompt-only agent units, one per {@link PROMPT_AGENTS} row. */
export const promptAgentUnits: AgentUnitDescriptor[] = PROMPT_AGENTS.map(
  ([name, prompt]) => definePromptAgent(name, prompt),
);
