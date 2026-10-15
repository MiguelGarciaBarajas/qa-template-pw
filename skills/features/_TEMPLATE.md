---
name: <feature-slug>
feature: <Human feature name>
when: <which tickets / screens should load this guide>
last-verified: <YYYY-MM-DD> on <ticket key> / <build or version>
---
# <Feature> — self-contained feature guide

> Copy this file to `skills/features/<feature-slug>.md`, fill every section, delete the hints, then
> register the file in `skills/INDEX.md` (routing row + any open defect). Keep it terminal-dense
> (tables > prose). Facts live in ONE place — link to `domain/*.md` instead of duplicating.

## 0. Purpose + PASS/FAIL rules for THIS feature
- **Purpose:** one or two lines — what the feature does and who uses it.
- **PASS/FAIL rules:** the subset of `domain/<rules>.md` that applies here (link, then summarize).

| # | Rule (what SHOULD happen) | PASS when | FAIL when |
|---|---------------------------|-----------|-----------|
| 1 | _rule_ | _observable result_ | _observable defect_ |

## 1. Preconditions / access
| Item | Value |
|------|-------|
| Account / role needed | _see `wiki/docs/test-accounts.md` — never write credentials here_ |
| Tenant / store / context gate | _what must be selected before the flow_ |
| Required test data | _link to `domain/test-data.md` rows_ |
| Feature flags / environment caveats | |

## 2. Entry URL + navigation
- **Route / URL:** `<base-url>/<path>`
- **Navigation:** menu → submenu → screen
- **Ready signal:** what proves the page finished loading (element / network call).

## 3. Mechanics (UI + selectors)
Prefer `data-testid` → role/label → text. Note the fallback when a stable id is missing.

| Element | Selector (testid / role / label) | Notes |
|---------|----------------------------------|-------|
| _field/button_ | `getByTestId('…')` | |

## 4. The flow, step by step
| Step | Action | Endpoint + expected status | Observable result |
|------|--------|----------------------------|-------------------|
| 1 | | `GET /api/…` → 200 | |

## 5. Known bugs
| Ticket | Status (open/fixed + date) | 1-line defect + repro | Evidence |
|--------|----------------------------|-----------------------|----------|
| _PROJ-XXXX_ | open | | |

Keep in sync with the "Known open defects" table in `skills/INDEX.md`.

## 6. Canonical test data
Link to `domain/test-data.md` — list here only the **keys/ids** of the rows this feature uses.

## 7. Gotchas (automation + app quirks)
- _e.g. a component that ignores synthetic clicks → keyboard recipe; a required header; timing._

## 8. Coverage + last verified
| Area | Covered? | Last verified (date / ticket / build) |
|------|----------|----------------------------------------|
| _sub-flow_ | yes / partial / no | |

What is NOT covered must go into `result.notValidated` on every publish so a PASS never overclaims.
