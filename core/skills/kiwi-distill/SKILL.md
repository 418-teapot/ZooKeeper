---
name: kiwi-distill
description: kiwi 知识蒸馏工作流。将源材料分析为结构化页面建议——分析源材料、识别知识单元、去重、起草页面、自审、返回分析报告。kiwi 在使用前加载此技能。
---

# Kiwi Distill — 知识蒸馏工作流

## Phase 0: Resolve Wiki Path and Read SCHEMA

Run `realpath ~/.zoo/wiki` to get the wiki's absolute path. Use this path for all subsequent file reads (the `read` tool does not expand `~`).

Then read `SCHEMA.md` inside the wiki to confirm formatting and naming rules. If already read this session, skip.

If your CONTEXT contains external URLs, use `webfetch`. For additional external sources, use `websearch`.

## Phase 1: Read Distillation Example

Read `{wiki_abs_path}/wiki-system/analysis/distillation-example-karpathy.md` — a complete worked example of good distillation. Study what was created, what was discarded, what was merged, and the key judgment calls. This example demonstrates the principles behind the Self-Review criteria in Phase 4. Keep it in mind as a reference throughout the rest of the workflow.

## Phase 2: Quick Scan → Search → Load

### 2.1: Quick Scan

The source material is already in your CONTEXT (or was fetched via webfetch in Phase 0 if it was a URL). Extract 3-5 core topic terms from it. Topic terms should be substantive concept names from the source material — not generic words like "design", "system", "architecture" — but domain-specific terms like "permission model", "deny list", "prompt injection".

### 2.2: Search

For each topic term, run `zwiki search "<term>" --json`.
Combine results from all searches into a single candidate list, keeping each unique path only once.
Read the full content + frontmatter of each candidate page (pay special attention to `last_validated`, `timeliness`, `supersedes`, `superseded_by`, `contradictions` fields).

### 2.3: Load Related Pages

For each candidate page, read the pages listed in its frontmatter `relations` field (direct relations only, depth 1, no recursion). Also read their content + lifecycle fields.

### 2.4: Establish Claim Map & Learn Density Patterns

Compile an actionable claim map of all existing pages — what facts/principles/design decisions each existing page asserts.

Extract density patterns from the pages you've already read: typical line counts, number of Detail subsections, presence/absence of code blocks, table sizes. This is your baseline for how much a wiki page should hold.

### Fallback: If search returns no results

Case 1: Candidate list is empty (zwiki search returned 0 results) → keywords didn't match any page.
Case 2: Candidate list is non-empty but all pages are unrelated to the source material (same name, different concept; false match) → search hit but content is irrelevant.

Both cases handled identically: read the root `index.md` → based on source material content, determine the domain → read that domain's `index.md` → get all page paths in that domain → read each page's content + lifecycle fields → return to Phase 2.4 to establish the claim map.

---

**Dedup vs Supersede distinction:** Dedup (covered above in Phase 2) is about whether the new source's knowledge unit is already recorded. If yes, recommend updating the existing page. Supersede (Phase 4.7) is different — it's about whether the new source's claim directly contradicts what the existing page asserts. Dedup leads to "update this page," supersede leads to "this new page replaces the old one."

## Phase 3: Analyze & Draft

### 3.1 Understand the source holistically

Read and understand the source material. Pay special attention to the **source profile** in your CONTEXT if present — it describes:
- The knowledge density of the source (concise and direct? argument-heavy? knowledge buried in execution details?)
- Which parts are likely packaging vs core knowledge

The source profile is your primary filter: it tells you what NOT to distill. If no source profile is provided, treat the source as having uniform knowledge density.

### 3.2 Assign density levels

Before drafting any content, assign a **density level** to each proposed page based on its knowledge role:

| Level | Role | Target | When to use |
|-------|------|:------:|-------------|
| L1 | Reference | 40–60 lines, 2–3 short subsections | Most concepts, entities — a reader can consume in 30 seconds |
| L2 | Analysis | 60–100 lines, 3–5 subsections with reasoning | Complex concepts, tradeoff analyses — needs room for a comparison or design rationale |
| L3 | ADR | 100+ lines, full chapters | Only when the source IS an architecture decision record — includes migration plans, risk matrices |

**Default: L1 for concepts and entities, L2 for analysis pages.** Do not use L3 unless the source material is itself an ADR and the caller explicitly needs the full treatment.

### 3.3 Identify knowledge units

Identify knowledge units (concepts, entities, patterns, tradeoffs). For each unit, decide:
- Is this a standalone concept → should it be its own page? Or can it merge into an existing page?
- Does this unit naturally belong at the assigned density level? If a unit needs >5 subsections at L1, split or reconsider the level.

### 3.4 Draft page recommendations

Draft page content within the assigned density level. Produce a rough draft — do NOT finalize yet.

## Phase 4: Self-Review

Before finalizing, review your draft against ALL criteria below. If a criterion fails, revise — do NOT skip to Phase 5 with a known issue. You may iterate within this phase up to 2 times.

### 4.1 Structure Check
- Does every recommended page have a SINGLE clear knowledge focus? If a page mixes two unrelated concepts, split it.
- Does your page ordering follow the source's narrative sequence? If so, that's narrative leakage — reorganize by knowledge domain, not original paragraph order.

### 4.2 Category Check
- For every page type (concept/entity/analysis/source), ask: "Is this the best fit?" The most common mistake is labeling everything as `concept`. A concrete tool/script/file is an `entity`, not a concept. If a page contains comparison/tradeoff analysis, it should be `analysis`.
- Before creating a new page, verify that the concept isn't already covered by an existing wiki page with a more authoritative description. If an existing page already describes the concept well, reference it via cross-reference instead of creating a redundant page.

### 4.3 Density Check
- Does every page respect its assigned density level? If an L1 page has 6 subsections or an L2 page has 15, compress or split.
- Does every page have ≤4 knowledge points? If a page tries to teach 7 things, split it — regardless of line count. A dense page is harder to consume than two focused ones.
- Can each knowledge point be expressed in ≤1 paragraph (4–6 sentences)? If a point needs more, it's either two points (split) or over-explained (compress).
- Are there multi-tier comparison tables (>5 rows, >4 columns)? Replace with a single-sentence synthesis — the full table belongs in the source document, not the wiki.
- Are there code blocks >5 lines? Delete them — describe the design intent. The code lives in the source file; the wiki should not duplicate it.
- Are there risk matrices, migration timelines, rollback plans, or verification tables? These are execution appendices, not reusable knowledge — remove them.

### 4.4 Noise Check
- Re-read the source material in your mind. Did you include: tangential anecdotes? repeated emphasis of the same point? marketing language? ecosystem-specific tool/plugin recommendations? (remove all)
- If unsure whether something is noise, flag it under `## Notes` with `> **待确认:** ...` rather than including it in main text.

### 4.5 Cross-Reference Check
- For every recommended page, identify at least 1 existing wiki page it should link to via `related`. If none exists, explain why.
- All cross-reference paths are wiki-root-relative and domain-prefixed (e.g. `foo/concepts/bar.md` NOT `wiki/foo/concepts/bar.md`).
- **Inline links in page body:** each independent reading entry point (a section reachable via search or TOC) should have at least one link to each referenced concept. Short pages need only first occurrence.
- **Verify no duplicate inline links:** after adding the first-occurrence link, scan the rest of the page body and remove any additional inline links to the same target — only the first occurrence in each independent section should carry a link.

### 4.6 Self-Deletion Check

Before moving to Phase 5, answer these three questions for EVERY recommended page:

- **"Could a reader who forgot the context, six months from now, find the 'why this page exists' anchor in 10 seconds?"** — If not, the Overview is too vague. Rewrite it.
- **"Is there any subsection that exists only because the source had it, not because the wiki genuinely needs this information?"** — If yes, delete it. "The source mentioned it" is not a reason to keep it.
- **"Is there a table, diagram, or code block that could be replaced with one sentence without losing actionable insight?"** — If yes, replace it.

If any question exposes an issue, fix it before Phase 5.

### 4.7 Claim Reconciliation

For each existing page from your Phase 2.4 claim map that is topically related to the new source:

1. **Extract claims** from the existing page. A claim is a statement about how the system works, what design decision was made, or what principle applies. File paths, timestamps, line counts, and implementation trivia are NOT claims for reconciliation purposes — they don't change what's true about the system.
2. **Extract claims** from the new source on the same topic.
3. **Compare** each pair of claims covering the same subject. Classify the relationship into exactly one of three outcomes:

#### Outcome A: Supersede

Propose supersede ONLY when:
- A specific, identifiable claim in the old page is directly contradicted by the new source
- The contradiction is substantive — changes a decision, principle, or architecture, not cosmetic (renames, reformatting, rewording)
- The contradiction cannot be reconciled as "both true in different contexts or at different times"
- The new source is clearly the authoritative replacement

Do NOT propose supersede when:
- The new source adds information but doesn't contradict → recommend updating the old page instead
- The new source covers a narrower or broader scope → both pages can coexist
- You're uncertain → flag with `> **待确认:**` in the new page's Notes section
- The new source is a different perspective on the same facts → note in the old page's Notes, don't supersede

If supersede is warranted:
- Record the old claim **verbatim** as written in the old page
- Record the new claim **verbatim** as written in the new source
- Document why the new claim supersedes the old one
- This is a **proposal only** — the calling agent must confirm before writing

#### Outcome B: Contradiction

Propose a contradiction entry when:
- A specific claim in the old page is contradicted by the new source (cannot both be simultaneously true)
- BUT the new source is NOT clearly the authoritative replacement — both perspectives could be valid in different contexts, different schools of thought, or you cannot confidently determine which is correct
- The contradiction is substantive — not cosmetic (renames, reformatting, rewording)
- The old page remains useful and should NOT be superseded; both pages should coexist with a documented contradiction

Do NOT propose contradiction when:
- The new source adds information but doesn't contradict → recommend updating the old page or creating a complementary page
- The new source clearly supersedes the old claim → use Outcome A (Supersede) instead
- Both claims can be reconciled as true simultaneously without contradiction → note the nuance, don't flag as contradiction
- The new source confirms the existing claim without conflict → use Outcome C (Validation) instead

If contradiction is warranted:
- Record the conflicting claim verbatim from the existing page
- Record the conflicting claim verbatim from the new source
- Describe the nature of the conflict (e.g., "different terminology for the same concept", "different approach to the same problem", "competing design philosophies")
- Do NOT judge which claim is correct — the contradiction entry is a flag for future readers, not a resolution
- Format the proposed entry as a JSON object following the `zwiki contradictions apply` format:

  ```json
  {"page_a": "<existing_page_path>", "page_b": "<proposed_new_page_path>", "claims": ["<conflicting claim description>"], "detected": "<YYYY-MM-DD>", "resolution": "unresolved"}
  ```

- These are **proposals only** — the calling agent will create the page first, then apply contradictions via `zwiki contradictions apply`

#### Outcome C: Validation

Propose validation when:
- A specific claim in the existing page is **independently confirmed** by the new source — both assert the same fact, design decision, or principle without contradiction
- The new source provides additional supporting evidence, reasoning, or real-world confirmation for the same claim
- The confirmation is substantive — not merely a citation or reference to the existing page itself, but an independent statement of the same knowledge
- The existing claim remains accurate and up-to-date; no revision or replacement is needed

Do NOT propose validation when:
- The new source merely cites or references the existing page (loop citation — not independent confirmation)
- The claims are similar but not identical in meaning — note the nuance instead
- You're uncertain about whether the confirmation is genuine → do not flag
- The new source not only confirms but also adds significant new information that changes the scope of the claim → recommend updating the page, not just validating it

If validation is warranted:
- Record the confirmed claim **verbatim** from the existing page
- Record the confirming claim **verbatim** from the new source
- State which page's `last_validated` would be refreshed (the existing page, not the new one)
- Note that validation does NOT change `status` or `timeliness` — it only refreshes `last_validated`
- Validation is scoped to the **specific confirmed claim**, not the entire page. Page-level `last_validated` means "at least one claim confirmed on this date"
- This is a **proposal only** — the calling agent must confirm before writing `last_validated`

### If You Found Issues...

Revise, then re-check. After 2 iterations, if a criterion still fails, flag it explicitly in your return:
> ⚠️ 待确认: [specific issue description]

## Phase 5: Return Analysis

Explain to the calling agent what should be created/updated:
- What pages to create or update (full paths including domain prefix, frontmatter, page content following SCHEMA.md conventions). If a similar page already exists, recommend updating it instead of creating a duplicate — describe what sections to add or revise
- What index entries to add to the relevant domain's `index.md` (NOT the root index.md, which only lists domains)
- What cross-references to update (add new page to existing pages' `related` field)
- Whether `overview.md` needs rewriting
- What log entries to append via `zwiki log`

### Supersede Proposals

If supersede candidates were found (per 4.7, Outcome A):
  List each affected old page. If a page has multiple contradicted claims, list each separately so the calling agent can confirm or reject each one individually:
    - `<old_page_path>` → superseded by `<superseding_page_path>`:
      - Old claim: "..." (exact quote from the old page)
        New claim: "..." (exact quote from the new source)
        Reason: [why this specific new claim supersedes the old one]
      - Old claim: "..."  (if additional claims are contradicted)
        New claim: "..."
        Reason: [...]
  **THESE ARE PROPOSALS ONLY. The calling agent must confirm with the user before writing `supersedes` / `superseded_by` to frontmatter.**

If no supersede candidates:
  No existing page claims are contradicted by this source.

### Contradiction Proposals

If contradiction entries were identified (per 4.7, Outcome B):
  Output a JSON array suitable for piping to `zwiki contradictions apply`:

  ```json
  [
    {"page_a": "domain/existing.md", "page_b": "domain/proposed-new.md", "claims": ["描述冲突的具体声明"], "detected": "YYYY-MM-DD", "resolution": "unresolved"},
    ...
  ]
  ```

  **Each entry MUST include:**
  - `page_a`: path of the existing wiki page (wiki-root-relative, domain-prefixed)
  - `page_b`: path of the proposed new page (the page kiwi is drafting — does not exist yet)
  - `claims`: array of human-readable descriptions of the conflicting claims (one per conflict, use multiple entries for distinct conflicts)
  - `detected`: today's date in YYYY-MM-DD format
  - `resolution`: always `"unresolved"` — Outcome B explicitly forbids resolving contradictions

  **THESE ARE PROPOSALS ONLY. The calling agent creates the page first, then runs `zwiki contradictions apply` with this JSON.**

If no contradiction entries:
  No contradictions found between existing pages and the new source.

### Validation Proposals

If validation candidates were found (per 4.7, Outcome C):
  List each confirmed claim:
    - `<existing_page_path>` — confirmed by `<new_page_path>`:
      - Existing claim: "..." (exact quote from the existing page)
        Confirming claim: "..." (exact quote from the new source)
        Status: proposal only — calling agent must confirm before refreshing `last_validated`
  **THESE ARE PROPOSALS ONLY. The calling agent must confirm with the user before using `zwiki property last_validated --page <path> --value <value>` on any page.**

If no validation candidates:
  No existing page claims are independently confirmed by this source.

Do NOT perform any writes yourself. Return a complete, actionable analysis.

---

## QualityGate

Before returning your analysis, confirm ALL of the following:

### Distillation Quality (knowledge extraction)
- [ ] Each page captures ONE knowledge unit (concept/entity/decision), not a section of the source's narrative
- [ ] Page content is organized by knowledge domain, not by the source's paragraph order
- [ ] Tangential anecdotes, repeated points, marketing language, and ecosystem-specific tool/plugin recommendations have been discarded
- [ ] Each recommended page has a clear `type` decision with rationale
- [ ] Before recommending a new page, confirmed no existing wiki page already covers the same concept with a more authoritative description (dedup check against existing wiki state, not just the source)
- [ ] All external references (URLs, citations) are in the References section, not inline in main text
- [ ] Inline wiki links follow the "independent reading entry point" rule: short pages link at first occurrence; long pages link at first occurrence within each independently-reachable section
- [ ] **No duplicate inline links:** the page body contains only one inline link per target (first occurrence only), with no repeated links to the same concept/entity later in the page

### Density & Conciseness
- [ ] Every page is within its assigned density level (L1: 40–60 lines, L2: 60–100 lines)
- [ ] No page has >4 knowledge points (split or merge if it does)
- [ ] No multi-tier comparison tables (>5 rows, >4 columns) — replaced with concise synthesis
- [ ] No code blocks >5 lines — design intent described instead
- [ ] No risk matrices, migration timelines, rollback plans, or verification tables — these are execution appendices, not wiki knowledge
- [ ] All three Self-Deletion questions passed for every page

### Format Compliance (SCHEMA.md rules)
- [ ] All recommended frontmatter includes: title, type, timestamp, tags, status
- [ ] Cross-reference paths are wiki-root-relative and domain-prefixed (e.g. `foo/concepts/bar.md`)
- [ ] No references to system files (index.md, overview.md, SCHEMA.md) in any page's `related` field
- [ ] Every recommended knowledge page has a corresponding `<domain>/sources/<type>/<slug>.md` entry recording the ingested raw material
- [ ] Uncertainty is marked with `> **待确认:**` blockquote, not stated as fact

### Raw Source Awareness
- [ ] Checked `raw/` directory for an existing full-text copy of the source. If found, read it directly instead of re-fetching
- [ ] If the source has an external URL and no `raw/` copy exists, noted in the analysis that the calling agent should save a raw copy to `raw/`

### Supersede Integrity
- [ ] For every existing page in the Phase 2.4 claim map, checked whether any specific claim is contradicted by the new source — no claim assumed compatible without explicit comparison
- [ ] Supersede proposals (if any) include verbatim old and new claims — no summaries, no paraphrasing

### Contradiction Integrity
- [ ] For each existing page in the Phase 2.4 claim map where a contradiction was detected but supersede was NOT warranted, a contradiction entry is proposed
- [ ] No contradiction proposed without explicit claim comparison (verbatim old claim vs. verbatim new claim)
- [ ] All contradiction proposals include descriptions of the conflicting claims — not just "they disagree"
- [ ] `resolution` is always `"unresolved"` — contradictions are flagged, never resolved
- [ ] Every contradiction entry includes the exact `zwiki contradictions apply` JSON format with all required fields

### Validation Integrity
- [ ] For every existing page claim that is independently confirmed by the new source, a validation proposal exists — no confirmed claim silently skipped
- [ ] Validation proposals include verbatim existing claim AND verbatim confirming claim — not summaries, not paraphrasing
- [ ] The confirming claim is genuinely independent (not a citation or reference to the existing page itself)
- [ ] Validation proposals clearly state which page's `last_validated` would be refreshed
- [ ] No validation proposed for claims where the new source adds scope-changing information — those should be recommendations to update the page, not validation proposals
