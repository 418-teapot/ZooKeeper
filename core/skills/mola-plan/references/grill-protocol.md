# Decision-Tree Grill Protocol

> Based on Matt Pocock grilling + domain-modeling. Walk every branch of the design tree
> depth-first, one question at a time, with recommended answers. Stress-test decisions
> with concrete scenarios. Capture resolved vocabulary inline. Continue until every
> branch resolves or remaining branches are genuinely user-only.

## What You're Doing

You are stress-testing a design direction, not a pre-written plan. The user has fuzzy
intent or architectural tradeoffs. Your job: make it concrete by exploring the design
space depth-first, surface decisions that must be made, identify which have obvious
defaults.

## 1. Build the Design Tree

Before grilling, enumerate the major decision areas (branches). 3-7 branches typical.
Order them by dependency — decisions that OTHER branches depend on go FIRST:

- **Data model / schema** — other things shape around these
- **API boundaries / interfaces** — consumers depend on these
- **Error handling / failure modes** — informed by data + API design
- **Configuration surface** — informed by everything above
- **Integration with existing systems** — depends on all of the above

Present the tree briefly:

```
I see these decision areas in dependency order. Let's walk through them:
1. Data model — what gets persisted and how
2. API boundaries — what the new module exposes
3. Error handling — what happens at each failure point
4. Configuration — what is tunable and how
5. Integration — how this plugs into existing routing/middleware
```

## 2. Depth-First Traversal

Pick the first branch (highest-dependency). For each decision node:

1. State the decision in one sentence
2. Provide your recommended answer WITH reasoning (cite code, pattern, or best-practice)
3. Wait for user response

On user response:
- **Accept** → adopt, move DEEPER in the branch (not across)
- **Override** → adopt, record rationale, continue
- **Discuss** → explore alternatives depth-first, then resolve

Move deeper before moving across — resolve ALL decisions in one branch before jumping
to the next.

## 3. Scenario Stress Testing

For each MAJOR decision (not every one), invent 1-2 concrete scenarios that probe its
edge cases:

```
"Let me test this decision: what happens when [specific failure case]?"
"And what about [specific concurrency / scale / backward-compat / ambiguous-input case]?"
```

If the decision holds up under the scenarios, move on. If the decision fails, this
often reveals a refinement or a sibling decision that needs addressing. Note refinements
inline.

**Anti-pattern:** skipping scenarios because the decision "seems obvious" — the obvious
decisions are where hidden assumptions live.

## 4. Domain Vocabulary Refinement

During grill, actively sharpen language:

- If a term is used ambiguously, stop and clarify: "When you say 'X' — do you mean A or B?"
- Propose a precise canonical term for overloaded concepts
- Cross-reference code: "Your code currently calls this X, but you just described it as
  Y — which is the canonical term?"
- As terms resolve, maintain a running **Domain Notes** list (captured inline, not batched)
- Include the Domain Notes as a section in the final spec

This is continuous — not a separate stage. Vocabulary issues surface during traversal,
resolve during traversal.

## 5. Explore Before Asking (Two Filters)

Before each question, run two filters — this is the decision discipline:

**Filter 1: Can the codebase answer it?**
- YES → state the finding with file:line evidence, adopt, move on (don't ask)
- NO → proceed to Filter 2

**Filter 2: Is there a defensible best-practice default?**
- YES → adopt it, inform the user ("adopting X because Y, say 'change' to override"),
  move on
- NO → genuine fork requiring user input → ask (recommended answer first)

**Anti-patterns:**
- Asking "where should I put this?" when the codebase structure makes it obvious
- Asking "what framework?" without proposing one
- Asking "what do you think?" about decisions you can derive
- Adopting defaults silently without telling the user

## 6. Question Format Discipline

ONE question per turn. Each question includes:

- **Decision** — what is being decided (one sentence)
- **Recommendation** — your proposed answer with reasoning
- **Alternatives** — other options briefly described
- **Question** — the actual ask

```
Decision: Error response format for the new API endpoint
Recommendation: Match existing ErrorResponse interface from src/api/errors.ts (pattern
  used in 4 other handlers)
Alternatives: Inline error shape; wrap all errors in a Result type
Question: "Use existing ErrorResponse, define new inline shape, or introduce Result
  pattern?"
```

## 7. Zero-Questions Criterion

If EVERY branch in the design tree is resolvable via:
- Codebase evidence (Filter 1)
- Best-practice defaults (Filter 2)
- Prior decisions (earlier grill + Domain Notes)

...then adopt everything, present an "adopted decisions ledger," and jump straight to
the design presentation (skip asking). The user can override any adopted decision.

```
Here's the approach I derived — all decisions have defensible defaults:
Branch 1 (Data model): Extends existing ProjectConfig table (matches schema pattern)
Branch 2 (API): Single new endpoint POST /api/validate (follows controller convention)
Branch 3 (Error handling): Returns existing ValidationError shape (4 existing handlers)
Say "change" to override any of these.
```

## 8. Stop Conditions

The grill ends when:

- ✓ Every branch in the design tree has a resolved decision (chosen or adopted)
- ✓ No remaining questions where answers would change the design
- ✓ Any open questions are explicitly recorded as deferred-with-rationale
- ✓ Scenario stress testing did not reveal unresolvable cracks

**Not stop conditions:**
- "User says we've covered enough" while branches remain → note unresolved, flag in
  design presentation
- Time pressure (be thorough, not fast)
- Feeling repetitive (repetition verifies understanding)

## Anti-Patterns

- **Breadth-first:** jumping between branches without resolving one
- **Question without recommendation:** "what framework?" with no suggestion
- **Asking the codebase's questions**
- **Grilling past resolution:** continuing to ask after all branches done
- **Silent adoption:** adopting defaults without telling the user
- **Parallel questions:** 3+ in one message
- **Skipping scenarios:** "seems obvious so I won't stress-test"
- **Ignoring vocabulary drift:** same term used two different ways in one grill