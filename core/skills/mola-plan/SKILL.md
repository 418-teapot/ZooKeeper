---
name: mola-plan
description: "Used for all planning operations. Automatically adjusts interview depth based on task clarity — clear tasks get fast-track decomposition, fuzzy requirements trigger research-and-adopt defaults, and architecture-class tasks get deep decision-tree grilling with scenario stress testing. Produces structured plan files (and design specs for architecture tasks). Load this skill whenever the request involves requirement clarification, task decomposition, design decisions, or implementation planning."
---

# Planning — from ground-check to approved plan

Produces a structured plan file decomposing work into sequenced, verifiable tasks.
For Architecture-class tasks, also produces a design spec before the plan.

## Anti-Patterns

- **"This Is Too Simple To Need A Spec"** — The most expensive mistakes come from unexamined assumptions on "simple" changes. A spec is 1-2 pages, not 50. Spec the simple things; save the expensive surprises for later.
- **Skipping ground before classify** — Ground reveals what is actually involved. Classify without ground is guessing. Always explore first.
- **Beginning implementation** — NEVER begin implementation (even "quick scaffolding" or "just a skeleton"). Outputs are plan files (+ optional spec for Architecture).
- **Skipping approval gates** — Present brief → wait for OK → write. Every section, every artifact.
- **Asking what the codebase can answer** — Explore first. User time is more expensive than search time.

## Workflow

Complete all 6 phases in order.

### Phase 1 - Ground Check

Explore the codebase to validate the problem exists and understand what is involved.
Run these in parallel when independent.

1. **Search** — affected files, entry points, call sites, dependency graph
2. **Pattern discovery** — existing implementations to reference, established conventions
3. **Context gathering** — codebase docs (`AGENTS.md`, README), external documentation, prior plans in `.zoo/plans/`

**Scope assessment:** If the work spans 2+ independent subsystems, stop and request decomposition: "Request decomposition needed: this spans [subsystems] which should be planned independently." Otherwise confirm scope coherent and proceed.

**Output of Ground:** A mental model answering four questions:
- Where do changes go? (files, modules, entry points)
- What exists already? (patterns to follow, tests to update)
- What is the scope? (how many files, how many modules, cross-boundary?)
- What is unknown? (gaps that need classification and user questions)

Do NOT interview the user during Ground. Note questions for Phase 3.

### Phase 2 - Classify

Based on Ground findings, determine the reference strategy:

| Ground signals | References to load |
|---|---|
| Files + approach + boundaries all clear, simple | `references/intent-clear.md` |
| Standard task, intent fuzzy, defaults needed | `references/intent-unclear.md` |
| Architecture-class, real tradeoffs, scope ambiguity | `grill` skill |
| ON THE FENCE | default to `grill` skill |

State the classification once: "Classification: [Clear|Unclear|Architecture]. Loading references: [...]."

**Graceful upgrade:** If mid-flow you realize the task is heavier than classified, load the `grill` skill. No need to restart or re-enter the Workflow. You can load the skill mid-interview and continue.

### Phase 3 - Interview

Load the classified reference(s) and execute their protocol. All three references share:

- **Two Filter discipline** for every question candidate:

  Filter 1: Can the codebase/docs answer this? → research it, don't ask. | Filter 2: Do best-practice defaults answer this? → adopt and inform, don't ask. | Genuine owner-decision → ask (≤2 per turn, recommended answer first).

- ≤2 questions per turn, multi-select when possible, recommended answer first (C3)
- Adopt defaults, inform user — do not interrogate (C4)

**intent-clear.md:** Topology lock → decision-fork questions only → clearance check.
**intent-unclear.md:** Research defaults → adopt → present assumptions ledger → minimal questions (0-2).
**grill skill:** Decision-tree traversal → depth-first branch resolution →
scenario stress testing → domain vocabulary refinement. The `grill` skill
is the single source of truth for Architecture-class interview — do not duplicate its protocol here. Load it via the skill tool.

Do NOT duplicate reference content in this SKILL. Each reference owns its protocol.

### Phase 4 - Present Design (Incremental)

After the interview resolves, present the design one section at a time. Scale each section to its complexity:

1. **Context** — what triggered this, code involved, user need
2. **Goals** — specific, measurable design objectives
3. **Key Decisions** — chosen approach with rationale
4. **Scope** — Must have + Must NOT have (explicit guardrails)
5. **Risks** — known risks and mitigations
6. **Success Criteria** — how we will know the design achieves its goals

2-3 sentences if straightforward, up to 200-300 words if nuanced. After EACH section, ask for user approval. If the user requests revision, revise that section and continue.

**Scale by classification:** Clear/Unclear → lightweight brief (Context/Approach/Scope/Risks in one pass). Architecture → section-by-section with full depth.

**Anti-patterns:**
- Dumping the whole design at once → user cannot give focused feedback
- Skipping pauses for approval → user surprise on final write
- Continuing past clear objections without resolving

### Phase 5 - Produce

#### If spec path (Architecture classification):

**Step 5a: Scaffold spec file**

Read `templates/spec-template.md` and adapt it into a spec file:

1. Derive the title from the slug (kebab-case → title case).
2. Compute today's date as `YYYYMMDD`.
3. Write the spec via the `write` tool to `.zoo/plans/<slug>-spec-<YYYYMMDD>.md`
   with this frontmatter:

   ```yaml
   ---
   title: "<Title>"
   slug: "<slug>-spec-<YYYYMMDD>"
   created: "<ISO timestamp>"
   updated: "<ISO timestamp>"
   status: awaiting-approval
   ---
   ```

   Then write the template body, replacing `{{TITLE}}` with the title and filling placeholder sections from the design interview.

**Step 5b: Fill sections** — via edit tool, fill each section per the inline placeholder guidance. Each decision entry includes: Chosen option, Alternatives considered, Scenarios tested.

**Step 5c: Self-review** — run 4 checks, fix findings inline:

1. **Placeholder scan** — no TBD / TODO / "decide later" / "needs discussion" / "implement and see" in any section
2. **Internal consistency** — Goals align with Success Criteria; Non-Goals do not contradict Goals; decisions do not contradict each other
3. **Scope check** — spec covers exactly what came out of interview + design presentation; no silent additions or subtractions
4. **Ambiguity check** — each decision specific, each success criterion measurable, each non-goal has a clear reason

**Step 5d: Adversarial review pass** — simulate an independent reviewer. Re-read the full spec and check five categories (completeness, consistency, clarity, scope, YAGNI).
Calibrate: only flag issues that would cause real problems during planning. Output:

```
## Spec Review
**Status:** Approved | Issues Found
**Issues (if any):** ...
**Recommendations:** ...
```

If Issues Found, fix inline and re-run the adversarial pass.

**Step 5e: User review gate** — present the spec path and key decisions, wait for explicit OK. If changes requested, revise → re-run 5c + 5d → wait again. After approval, update frontmatter status to `approved`.

Then load plan references (intent-clear.md or intent-unclear.md based on how much was clarified during the spec process) and continue to plan production below.

#### Then — for ALL paths — produce the plan:

**Step 5p: Scaffold plan file**

Read `templates/plan-template.md` and adapt it into a plan file:

1. Derive the title from the slug (kebab-case → title case).
2. Compute today's date as `YYYYMMDD`.
3. Write the plan via the `write` tool to `.zoo/plans/<slug>-<YYYYMMDD>.md` with this frontmatter:

   ```yaml
   ---
   status: planning
   slug: "<slug>-<YYYYMMDD>"
   project_root: "<path to project root>"
   created_at: "<ISO timestamp>"
   updated_at: "<ISO timestamp>"
   active_sessions: []
   ---
   ```

   Then write the template body, replacing `{{TITLE}}` with the title and filling placeholder sections from the interview + design presentation.

If a spec was also produced, use it as input context: Decisions + Domain Notes from the spec flow into the plan's Approach section. Add an optional `## Domain Notes` section if vocabulary was sharpened during the spec process.

**Step 5q: Fill sections** — via edit tool, fill each section using the inline
placeholder guidance from the template. Do NOT hand-build the file from scratch — always use the template.

**Step 5r: Self-review** — same 4 checks adapted for the plan file:
1. **Placeholder scan** — no TBD / TODO-as-value / "implement later"
2. **Internal consistency** — TODOs cover the Approach steps; Critical Files match the TODOs
3. **Scope check** — TODOs align with Scope Must have; nothing leaks from Must NOT have
4. **Ambiguity check** — each TODO has specific, verifiable acceptance criteria

Fix findings before presenting to the user. Update frontmatter `status` to
`"planning-done"`.

### Phase 6 - Handoff Signal

After the plan file is written and self-review passes, output:

```
[Plan approved and written. Ready for handoff to build orchestrator.]
```

The plan-lifecycle hook detects this signal. Do NOT proceed further. Do NOT begin implementation.

## Hard Rules

- NEVER begin implementation — even "quick scaffolding" or "just a skeleton"
- NEVER skip the approval gate — present brief → wait for explicit OK → write
- NEVER ask questions that the codebase can answer — check first
- NEVER include "user manually tests" as acceptance — all criteria must be agent-executable
- NEVER invoke another skill or begin execution work — the only outputs are plan files (+ optional spec file for Architecture tasks)
