---
name: jira-ticket-flow
description: Full workflow for processing a QA ticket from "Ready for Testing" to PASS/FAIL.
---

# Jira Ticket Flow — QA Brain

## Overview

This skill covers the complete ticket validation lifecycle for an PROJ ticket.

## Preconditions

- Edge CDP available at `http://localhost:9222` (see `skills/shared-browser/SKILL.md`)
- `.env` configured with JIRA_TOKEN, JIRA_USER, JIRA_BASE_URL
- Ticket is in **"Ready for Testing"** status

## Step-by-step workflow

### 1. Pick up the ticket

```bash
# Process a single ticket
npx tsx scripts/ticket-flow.ts PROJ-XXXX

# Or process ALL Ready for Testing tickets
npx tsx scripts/ticket-flow.ts --all
```

### 2. What the agent does automatically

1. **Reads** the ticket: summary, description, acceptance criteria, labels
2. **Moves** ticket to `In Testing`
3. **Opens** the QA app (`https://your-app-qa.example.com`) in a new tab
4. **Validates** each acceptance criterion against the live app
5. Based on result:

#### If PASS ✅
- Adds comment: `✅ Tested in QA: PROJ-XXXX`
- Attaches screenshots
- Attaches network log (if any HTTP errors were captured)
- Moves ticket to the configured **post-QA status** (e.g. "Done" / "Performance Test" / "In Acceptance" —
  define the target(s) and any label-based exception in `CONTEXT.md`)

#### If FAIL ❌
- Adds comment: `❌ Testing FAILED: PROJ-XXXX` with details
- Attaches screenshots of the failure
- Attaches network log
- Moves ticket back to development (**"In Progress"**)
- Optional (not implemented in the base template): a bug-board/pipeline sync that mirrors the verdict so a
  fix/deploy/retest watcher can take over — add it in `publish-result.ts` if your team needs it.

## Jira Transition Map (PROJ board — adapt to your workflow)

| From | To | Trigger |
|------|----|---------|
| Ready for Testing | In Testing | Only after a conclusive PASS/FAIL result is ready to publish; never as a pickup side effect |
| In Testing | `<post-QA status>` | AC validation passed |
| In Testing | In Progress | AC validation failed (real defect reproduced) |
| Any status | No Jira change | **Inconclusive** — feature could not be confirmed. Do not post a comment, upload evidence, transition, or sync the bug pipeline; report the blocker locally. |

> Always **check the available transitions** (`GET /rest/api/2/issue/<KEY>/transitions`) before
> transitioning: some statuses (e.g. "In Testing") may have no transition back to "Ready for Testing",
> so never move a ticket into a state you cannot undo. Re-queueing is done by leaving Jira unchanged.

A **confirmed-failed Save** (HTTP ≥ 400) means the record never saved, so a dependent Submit *should*
be disabled — that's `inconclusive`, not a feature bug. Only a Submit that stays disabled
**after a successful Save** is a real FAIL.

## Comment format

Comments are **Jira wiki markup**, built by `buildPassComment` / `buildFailComment`
in `scripts/ticket-validator.ts`. A validator drives this by filling the structured
fields on `ValidationResult` (don't hand-format comment strings):

- `acChecks` → the `||Acceptance Criterion||Expected||Observed||Result||` table
- `notValidated` → "Not Validated / Out of Scope" (coverage honesty — a PASS must not overclaim)
- `environment`, `method`, `testData`, `dealUrl` (URL of the record/page under test; field name kept for compatibility) → the Test Context block
- `reproSteps` → numbered repro (FAIL)
- `consoleErrors` → rendered in a `{code}` block (FAIL)
- `screenshots` / `networkLogPath` → Evidence (final screenshot embedded inline)

### PASS (rendered)
```
h3. ✅ Tested in QA: PROJ-XXXX

*Summary:* <ticket summary>
*Result:* <one-line verdict>

h4. Acceptance Criteria
||Acceptance Criterion||Expected||Observed||Result||
|AC1 — <what>|<expected>|<observed>|✅ PASS|

h4. Test Context
* *Environment:* QA — your-app-qa.example.com
* *Method:* Automated — Playwright over shared Edge (CDP)

h4. Not Validated / Out of Scope
* <anything not covered this run>

h4. Evidence
!<final-screenshot>.png|thumbnail!

_Tested on: <ISO timestamp>_
```

### FAIL (rendered)
```
h3. ❌ Testing FAILED: PROJ-XXXX

*Summary:* <ticket summary>
*Result:* <one-line verdict>

h4. Acceptance Criteria
||Acceptance Criterion||Expected||Observed||Result||
|AC1 — <what>|<expected>|<observed>|❌ FAIL|

h4. Repro Steps
# <step 1>
# <step 2>

h4. Console Errors
{code}
<JS errors if any>
{code}

h4. Test Context
* *Environment:* QA — your-app-qa.example.com

_Tested on: <ISO timestamp>_
```

## Evidence standard

- At minimum: 1 screenshot before testing + 1 screenshot after (pass or fail state)
- For failures: screenshot with the error state visible
- Network log: always attach if HTTP 4xx/5xx occurred
- Console errors: include in comment if any JS errors were captured

## Transition metadata gotcha

The PROJ workflow can list a valid transition but reject the POST with HTTP 400:
`customfield_XXXXX: "The following fields are required to proceed: <fields> and Designated Tester"`.
The other field may already be set while **Designated Tester** is null. `transitionIssue()` fills
Designated Tester from `JIRA_DESIGNATED_TESTER` and retries once. If the retry still fails, report
the response error plus the exact available transitions; never hardcode a tester identity.
