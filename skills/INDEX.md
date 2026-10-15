# Skills Index — read this FIRST, load only what you need

> Purpose: route to the ONE file that answers the task instead of loading everything → saves tokens.
> Read the routing table, open only the matching file(s).

## Session bootstrap (minimum viable context)
1. `CONTEXT.md` — environments, Jira, contacts, status transitions
2. `AGENTS.md` — agent rules, evidence standard, verdicts, browser rules
3. This index → open the specific file for the task
4. Account roles and secure credential setup: `wiki/docs/test-accounts.md`
5. **At the END of every ticket:** `skills/knowledge-capture.md` — feed learnings back / add new flows

## Structure
- `skills/features/*.md` — **self-contained per-feature guides** (mechanics + PASS/FAIL rules + known
  bugs + gotchas). Start from `features/_TEMPLATE.md`. Load the one matching the ticket.
- `skills/domain/*.md` — cross-feature **oracle** (business rules, from `domain/_TEMPLATE.md`) +
  **canonical test data** (`domain/test-data.md`). Feature files link here; don't duplicate.
- `skills/<name>/SKILL.md` — **process/technique** skills (how to work, not a feature).
- `skills/knowledge-capture.md` — the maintenance/learning loop.

## Verdict policy (applies to every process skill)
- **PASS** → publish evidence + comment + forward transition.
- **FAIL** (real, reproduced defect) → publish evidence + comment + transition back to development.
- **INCONCLUSIVE** (blocked, no response, Save ≥ 400, missing data…) → **local-only**: report the
  blocker and the unvalidated criteria to the user; do NOT upload evidence, comment, transition or
  file bugs. Leave Jira unchanged.

## Routing table — "I need to…" → open
| Task / symptom | File |
|----------------|------|
| _Feature / screen X_ (add one row per feature guide) | `features/<feature>.md` _(none yet — create from `features/_TEMPLATE.md`)_ |
| Judge PASS/FAIL — cross-feature business rules | `domain/<rules>.md` _(create from `domain/_TEMPLATE.md`)_ |
| Test data (identifiers, accounts, ranges, cards…) | `domain/test-data.md` |
| Account roles + secure credential setup | `wiki/docs/test-accounts.md` |
| **Feed learnings back / document a NEW untested flow** | `knowledge-capture.md` |
| Connect/drive shared Edge, CDP, login hook, switch account | `shared-browser/SKILL.md` |
| Drive the browser via Playwright MCP (accessibility tree) | `playwright-mcp/SKILL.md` |
| Validate a ticket live via MCP, then publish | `live-ticket-validation/SKILL.md` |
| Codified-validator (regression) path | `jira-ticket-flow/SKILL.md` |
| Terminal-autonomous validate + post (no IDE) | `autonomous-agent/SKILL.md` |
| Loading spinners / refetch / double-submit / context-header technique | `transient-ui-validation/SKILL.md` |
| File a Jira bug (format, fields, evidence) | `bug-filing/SKILL.md` |
| Exploratory / smoke / functional discovery session | `exploratory-qa/SKILL.md` |
| Create a TestRail run from validations | `testrail-test-run/SKILL.md` |
| Use SmartLearn (test case generation UI) to generate test cases → publish to TestRail | `smartlearn-product-config/SKILL.md` |
| Release documentation (Jira Fix Version → TestRail plan, Excel, Confluence, email) | `release-documentation/SKILL.md` |
| Local Word (.docx) test plan for a Fix Version | `local-word-test-plan/SKILL.md` |
| Fill Tempo worklogs for the day | `tempo/SKILL.md` |
| Daily / management status report for the epic (`/reporte`; live Jira numbers + deltas) | `epic-status-report/SKILL.md` |
| Regression bug tracking (moved stub) | `regression-bugs/SKILL.md` → feature "Known bugs" + INDEX "Known open defects" |

## Single sources of truth (don't duplicate — link here)
| Topic | Lives in |
|-------|----------|
| Canonical test data | `domain/test-data.md` |
| Business rules / PASS-FAIL oracle | `domain/<rules>.md` _(PLACEHOLDER)_ |
| Known open defects | table below + each feature file's "Known bugs" section |
| Account roles and secure credential setup | `wiki/docs/test-accounts.md` |
| Environments, Jira, contacts, transitions | `CONTEXT.md` |

## Known open defects (quick reference — confirm live before citing)
| Ticket | Area | Defect | Detail in |
|--------|------|--------|-----------|
| _PROJ-XXXX_ | _Feature_ | _One-line defect_ | `features/<feature>.md` §N |

Keep this table and each feature's "Known bugs" table in sync. When a bug flips open ↔ fixed, edit the
existing row — don't add a contradictory one.

## Gotchas that burn tokens if rediscovered
- **ESM + tsx / esbuild `__name` bug:** no nested named functions or arrow-consts inside
  `page.evaluate()` — inline the logic or pass plain data.
- **TestRail:** strip the trailing slash from `TESTRAIL_BASE_URL` (else `//api` → 404); plan entries
  need `include_all: false` with explicit `case_ids`; verify run case counts after creation
  (`testrail-test-run/SKILL.md`).
- **Parallel agents share ONE Edge and ONE `localStorage`:** a store/tenant key written by one agent
  is read by the others. Find your own tab by `window.name` and never navigate someone else's tab.
- **Idle logout (~5 min):** the app signs out idle sessions — re-check you are still authenticated
  before a long flow; keep the session active or re-login via the login hook.
- **Reuse the authenticated tab/session:** a fresh `newPage()` can bounce to the identity provider.
- **A click that "succeeded" is not a saved action:** no throw/timeout ≠ persisted server-side.
  Confirm via an observable state change (DOM text, network response, re-fetched value).
- **UI component libraries may ignore synthetic mouse events** (custom selects/combos) — fall back to
  keyboard (focus → Enter → type → Enter) and document the working recipe in the feature guide.
- **Screenshot annotation:** the shared Edge may run with a device-pixel-ratio ≠ 1 — scale
  `boundingBox()` coordinates by `devicePixelRatio` before drawing boxes.
- **DB-only / non-UI tickets:** tickets whose only verification path is DB, CI, or backend access
  that the agent does not have are not UI-testable. Report them locally as not validated (NOAP /
  INCONCLUSIVE); never fake a UI PASS.
- **Check system/health pages before retry loops:** if a dependency is degraded, repeated retries
  waste time — look for a health indicator first (add the product's health check to its feature guide).

## Agent test difficulty (live queue dashboard)
- **EASY** — one isolated, low-risk UI/content check with a known expected result.
- **MED** — a bounded UI flow using an existing feature skill and known test data.
- **MHARD** — multiple criteria/surfaces, parity or timing-sensitive behavior, or several controlled fixtures.
- **NOAP** — no safe agent-run validation path yet; an owner, approval, environment/runtime/CI/DB access, or deterministic fixture is required. This is testability, **not defect severity or priority**. Do not run production-only or financial writes to force a result.
- Recheck ticket description, acceptance criteria, environment, and prerequisites before retaining a curated tier. A feature word in a Task/Story title does not make an operational ticket UI-testable.
