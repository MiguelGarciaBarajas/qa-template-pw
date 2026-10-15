# Knowledge Capture — feed learnings back & LEARN NEW FLOWS (read at the END of every ticket)

**Purpose:** the knowledge base must **grow and improve with every test**. Two things happen on each
ticket: (a) you **confirm/adjust** what's already documented, and (b) you **discover flows/features
not tested before** and add them. Either way the *next* run gets **cheaper** (fewer tokens) and
**more accurate** (fewer wrong verdicts). Run the checklist in §5 before you finish a ticket.

> Core rule (user directive): *every UI flow, selector, business rule, or bug status discovered
> during validation must be codified back into `skills/` — including flows that were never tested
> before.* Undocumented learning is lost the moment the session ends.

---

## 0. Did this ticket exercise a flow NOT yet in `skills/`? (the growth path)
This is the most important case — it's how the agent gets better over time.

1. **Detect the gap.** Before validating, check `skills/INDEX.md`. If no feature file / section
   covers this screen or flow, you're in new territory — plan to document it as you go.
2. **Capture while you explore** (don't rely on memory): note the route/URL, the exact steps, the
   key selectors (prefer role/label/testid), the endpoints + statuses, and the PASS/FAIL rule you
   applied.
3. **Where the new flow lives:**
   - Fits an existing feature (e.g. a new sub-flow of a documented screen) → add a **new section** to
     that `skills/features/<feature>.md`.
   - A genuinely new area (a screen/domain no feature file covers) → **create a new feature file**
     by copying `skills/features/_TEMPLATE.md` (§4), then **register it in `skills/INDEX.md`**
     (routing row + any new open defect).
4. **Extract the rule, not just the steps.** A new flow almost always implies a new PASS/FAIL rule —
   add it to `skills/domain/<rules>.md` (copy `domain/_TEMPLATE.md` if none exists yet) and summarize
   in the feature's `§0`. Steps tell you *how*;
   the rule tells the next run *whether it passed*.
5. **Mark coverage honestly.** Whatever you did NOT reach goes in `result.notValidated` so a PASS
   never overclaims — and so the next run knows what's still uncovered.

---

## 1. Where each kind of learning goes (decision table)
| What you learned | Where it goes | Notes |
|------------------|---------------|-------|
| A UI step / selector / flow mechanic for a feature | `skills/features/<feature>.md` → mechanics section | Prefer role/label/testid; note fallbacks. |
| A PASS/FAIL **business rule** (what SHOULD happen) | `skills/domain/<rules>.md` **and** summarize in that feature's `§0 PASS/FAIL rules` | Rule lives once in domain; feature file links to it. |
| A new/updated **test datum** (identifier, account alias, range…) | `skills/domain/test-data.md` | Single source — never re-list values elsewhere; link. Never store secrets. |
| A **bug** confirmed (reproduced OR verified fixed) | feature file's **Known bugs** table + `skills/INDEX.md` "Known open defects" | Keep both in sync; include ticket + status + 1-line repro. |
| A cross-cutting **automation gotcha** (component commit quirks, `__name`, DPR, tab reuse…) | that feature's `§gotchas`, or `transient-ui-validation` if it's a technique | Don't duplicate across every feature — put it where it's used most and link. |
| A **workflow/process** learning (transition quirks, publish pipeline) | the relevant process skill (`jira-ticket-flow`, `live-ticket-validation`, `bug-filing`) | |
| A durable **cross-session fact or user preference** | `store_memory` (see §2) | Also update the skill if it's procedural. |

## 2. `store_memory` vs. update a skill (do BOTH for high-value flows)
- **Memory** = one atomic, durable fact + citation, for fast recall across sessions. Cheap, always
  surfaced. Use for: conventions, verified commands, user preferences, "X is fixed/verified on DATE".
- **Skill** = the detailed, reusable *procedure/rule* (steps, selectors, tables). Loaded on demand.
- **Best pattern for an important flow:** write the detail in the skill, then store a short memory
  that **points to the skill** (e.g. "Feature X field Y is read-only — see
  `skills/features/<feature>.md §5`"). The memory gets you there; the skill has the depth.
- Before storing, check the memory isn't already present (avoid duplicates) — upvote/downvote instead.
- Scope: **repository** = applies to anyone in this repo (conventions, app behavior); **user** =
  the QA owner's personal preference/workflow. Never store secrets/credentials.

## 3. Rules that keep the base cheap + accurate
- **Single source of truth.** Facts live in ONE file; everywhere else links. Duplication causes drift
  → wrong verdicts.
- **Keep it terminal-dense.** Tables > prose. Cut anything a future run won't act on.
- **Cite evidence.** Ticket key + date + (endpoint/status) so a claim can be re-verified.
- **Update, don't append.** When a bug flips open↔fixed, edit the existing row + INDEX — don't add a
  second contradictory entry.
- **Route through INDEX.** New feature file → add it to `skills/INDEX.md` routing table. New open
  defect → add/adjust the INDEX "Known open defects" row.
- **Never commit** `artifacts/`, `evidence/`, `.env`, or credentials.

## 4. Template for a NEW feature file (`skills/features/<name>.md`)
Copy `skills/features/_TEMPLATE.md` when a ticket opens an area no feature file covers (purpose,
entry URL/nav, mechanics + selectors, PASS/FAIL rules, known bugs, canonical test data, gotchas,
last-verified). Cross-feature rules go in `skills/domain/_TEMPLATE.md`; data in `domain/test-data.md`.
Then add a routing row to `skills/INDEX.md` and, if it revealed an open defect, an INDEX
"Known open defects" row. Keep it terminal-dense (tables > prose).

## 5. End-of-ticket checklist (run every time)
0. **Was this a flow NOT in `skills/`?** → add a section or a new feature file (§0/§4) + register in INDEX.
1. Did I learn a **selector/flow step**? → update `features/<feature>.md`.
2. Did I confirm/deny a **business rule**? → `domain/<rules>.md` + feature `§0`.
3. New/changed **test data**? → `domain/test-data.md`.
4. **Bug** reproduced or verified fixed? → feature Known-bugs table **+** INDEX "Known open defects".
5. A durable fact/preference? → `store_memory` (pointing at the skill when procedural).
6. New feature file or renamed section? → update `skills/INDEX.md`.
7. Anything duplicated? → collapse to one source + link.
