# Intent Unclear: Research & Defaults

> Load this reference when the user's outcome is fuzzy: "make auth better",
> "improve the module", "add something useful". The PRIME DIRECTIVE is:
> don't interrogate — resolve by research.

## Entry Conditions

At least one signal is present:
- Request uses qualitative language without specific targets ("better", "faster", "cleaner")
- Codebase exploration reveals multiple valid approaches with real tradeoffs
- The scope of what "done" means is itself the question

## Prime Directive: Resolve by Research, Not Questions

Do NOT ask the user to make decisions you can make for them with defensible reasoning. Interrogation feels unhelpful: "what framework do you want?" when the codebase already uses Express and there's no reason to change.

Instead: **research the best defensible default, adopt it, record it, and inform the user.**

## Protocol

### 1. Research Phase

Gather evidence from three sources (parallel when independent):
- **Codebase** — existing patterns, established conventions, prior decisions to reference
- **External docs** — best practice for the domain via spider if needed
- **User history** — prior plans under this project (check `.zoo/plans/` in the project root)

### 2. Default Adoption

For each unresolved design decision, find a defensible default:

| Source | Preference |
|---|---|
| Industry standard practice | Highest |
| Established codebase convention | Highest |
| Simpler alternative | High |
| Author's best judgment | Medium (label as such) |

Record each adopted default in your working notes:

```
Decision: Error response format
Adopted:  Follow existing ErrorResponse pattern from src/types/errors.ts
Rationale: Consistency with 4 existing call sites
Reversible?: Yes — easy to change later
```

### 3. Assumptions Ledger

When the brief is ready, present all adopted defaults as a ledger:

```
Assumptions I'm making for you (say "change" to override any):
• Error format: existing ErrorResponse pattern (consistency)
• No new config: env-var based config matches project style (simplicity)
• Testing: unit tests only, no integration (scope appropriate)
```

This is a one-time presentation, not a per-decision interrogation.

### 4. Question Budget: 0-2, Not Interrogation

Ask ONLY about things that you genuinely cannot determine:
- Security posture and trust boundaries
- Scaling expectations (not visible in code)
- UX / user-facing priorities
- Tradeoffs between competing valid approaches

**Do NOT ask:**
- "What framework should we use?" → check what's already used
- "Should we write tests?" → always yes
- "Where should this file go?" → check existing directory conventions
- "What's the scope?" → you determine this, present it, let user confirm

### 5. Brief and Approval Gate

Present the structured brief — but it **leads with**: "Here is the approach I derived based on [evidence]":

- **Context**: what I found in the codebase
- **Approach**: what I decided and why
- **Assumptions**: adopted defaults ledger
- **Risks**: what I might be wrong about

Wait for explicit user confirmation. If user says "ask me more" or "let me decide" → this is an **override**. Route to intent-clear.md and increase question budget accordingly.

## Key Differences from Intent-Clear

| Dimension | Intent-Clear | Intent-Unclear |
|---|---|---|
| Question budget | 2-4 decision-forks | 0-2 unresolvable items |
| Primary mode | Interview the user | Research + adopt defaults |
| Brief opening | "Here's what I found" | "Here's what I decided" |
| Assumptions ledger | Optional | Mandatory |
| Override path | None | Switch to intent-clear if user asks |

## Anti-Patterns

- Asking the user to specify implementation details you can research
- Presenting questions as a numbered list (feels like interrogation)
- Adopting defaults silently without recording them
- Asking "what do you think?" about decisions you can determine
- Delaying the brief to perfect every detail instead of presenting what you have
