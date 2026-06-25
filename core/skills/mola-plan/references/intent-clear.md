# Intent Clear: Fast-Track Interview

> Load this reference when the user knows their outcome clearly: specific feature,
> defined boundary, or obvious implementation question.

## Entry Conditions

All three signals are present:
- User request has a concrete, measurable outcome ("add rate limiting to /login")
- Codebase exploration found a clear insertion point or modification target
- Fewer than 3 valid architectural approaches exist

## Protocol

### 1. Topology Lock

Before interviewing, enumerate 1-6 components that will be affected. For each:
- Name the file or module
- Describe what changes in it
- Identify existing tests or patterns to reference

Present this topology briefly: "Here's what I found: [list]. Does that match your mental model?"

If user confirms, proceed. If user corrects, explore the corrected area, then re-enumerate.

### 2. Decision-Fork Questions Only

Ask ONLY questions where:
- The answer is a genuine fork (A vs B, not "should I do this")
- You cannot determine the answer from the codebase alone (Filter 1 passed)
- Best-practice defaults don't resolve it cleanly (Filter 2 passed)

**Good decision-fork questions:**
- "Should rate limiting be per-IP or per-user-account? [per-IP recommended: simpler to implement, covers anonymous access]"
- "Use middleware or route-level guard? [middleware recommended: existing auth middleware pattern]"

**Bad questions (ask the codebase, not the user):**
- "Where should I put the middleware?" → read the existing middleware directory
- "What error format to use?" → check existing error handlers

**Bad questions (adopt defaults, don't ask):**
- "Should I write tests?" → yes, always
- "Use TypeScript strict mode?" → check tsconfig.json

### 3. Question Format

1-2 questions per turn. Each includes:
- The recommended answer **first**
- Brief reasoning (1 sentence)
- The question itself (multi-select when possible)

```
Recommendation: Per-IP rate limiting (simpler, covers anonymous access).
Question: Rate limiting scope — per IP, per user account, or per API key?
```

### 4. Clearance Check

Before producing the plan, verify all four are settled:
- [ ] Objective defined (what "done" looks like)
- [ ] Scope is explicit (Must have + Must NOT have)
- [ ] Approach is decided (with rationale)
- [ ] Verification strategy is clear (specific commands + expected output)

If any box unchecked → either ask one more question OR adopt a default and inform.

### 5. Produce Brief → Approval Gate

Present the structured brief:
- **Context**: 2-3 sentences restating the task
- **Approach**: numbered steps with rationale
- **Scope**: Must have + Must NOT have
- **Risks**: known edge cases + mitigation

Then wait for explicit user confirmation before writing the plan file. If user requests changes, revise the brief and wait again.

## Anti-Patterns

- Asking "is this correct?" when you can check the codebase
- Asking open-ended questions when multi-select is possible
- Asking more than 2 questions per turn
- Delaying the brief to ask "perfecting" questions that don't change the outcome
- Proceeding to write the plan without explicit user OK
