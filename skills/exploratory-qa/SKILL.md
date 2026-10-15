---
name: exploratory-qa
description: Autonomous exploratory QA — navigate the app to discover bugs, UI issues, and broken flows.
---

# Exploratory QA — QA Brain

## Overview

This skill drives the autonomous exploratory QA agent. The agent navigates the <Product Name> app,
detects problems, and files Jira bugs automatically.

## Test Types

| Type | Scope | When |
|------|-------|------|
| Smoke | Critical flows only (login, dashboard, one core create/submit flow) | After every deploy |
| Functional | All flows within one UI section | When testing a feature area |
| Regression | Previously passing flows that must stay working | Before a release |

## Running an exploration session

```bash
# Smoke test (quick — critical paths only)
npx tsx scripts/qa-explorer.ts smoke

# Functional test of a specific area (agent-driven)
npx tsx scripts/qa-explorer.ts functional

# Regression test
npx tsx scripts/qa-explorer.ts regression
```

## What the agent checks

For each flow:
1. **Page loads** — no timeout, no blank page
2. **Network health** — no 4xx/5xx HTTP errors
3. **Console health** — no JS errors
4. **UI completeness** — key elements visible (nav, buttons, form fields)
5. **Flow completion** — action (button click, form submit) completes without error

## Bug detection triggers

The agent files a bug when it detects:
- HTTP error (4xx/5xx) during navigation
- Uncaught JS exception in console
- Page throws a Playwright exception (navigation failure, timeout)
- Expected UI element is not visible or not clickable
- Form submit does not produce expected result

## Bug filing format

See `skills/bug-filing/SKILL.md` for the complete standard.
Quick reference:
```
Title: QA | {Section} | {minimal description}
Body:  Issue / AC / Repro Steps / Evidence (screenshots) / Network log
```

## Evidence per flow

- 1 screenshot on entry
- 1 screenshot on error (if bug found)
- Network log JSON (if HTTP errors)
- Console errors in bug description

## Sections to cover (<Product Name>) — fill in per product

| Section | Key flows to test |
|---------|------------------|
| Authentication | Login (see `shared-browser/SKILL.md` login hook), session persistence |
| Dashboard / Home | Load, key widgets/lists display |
| _Core create flow_ | Form loads, all fields work, submit creates the record |
| _Search / list_ | Search, filter, select an item |
| _Detail view_ | View record, edit fields |
| _Print / Documents_ | Generate PDF, download |

When adding a new section, update this list and add flows to `scripts/qa-explorer.ts`.
