---
name: testrail-test-run
description: Create a TestRail Test Run in the configured project/suite from local ticket validations (artifacts/<KEY>/result.json). Use when the user asks to "make a test run" / build a TestRail run for a batch of validated PROJ tickets.
---

# TestRail Test Run from Validations — <Product Name>

Turns a batch of locally-validated PROJ tickets (each with `artifacts/<KEY>/result.json`) into a
**TestRail Test Run**: one case per ticket + a run over those cases + a result per case that
mirrors the validation verdict. Written in English, AI-attributed.

## When to use

User says things like *"make a test run with the cases we tested"*, *"upload it to TestRail"*,
*"create the run in the <product> suite"*. Each ticket must already have been validated (a
`result.json` in its `artifacts/<KEY>/` folder). Tickets without a `result.json` are still
added but marked **Retest** with a "no evidence" note.

## One command

```bash
npx tsx scripts/testrail/create-run-from-validations.ts PROJ-1234 PROJ-1235 PROJ-1236 ... [flags]
# or
npx tsx scripts/testrail/create-run-from-validations.ts --keys-file keys.txt
```
Always `--dry-run` first to confirm the verdict->status mapping, then run for real.

Flags: `--project` (default `TESTRAIL_PROJECT_ID`), `--suite` (default `TESTRAIL_SUITE_ID`),
`--section <id>` (reuse an existing empty section instead of creating a new one — use this to recover
from a mid-run failure), `--section-name`, `--run-name`, `--dry-run`.

## TestRail structure — configure per product

| Setting | Env var | Value (fill in) |
|---------|---------|-----------------|
| Project id | `TESTRAIL_PROJECT_ID` | `<project-id>` |
| Default suite id (manual cases) | `TESTRAIL_SUITE_ID` | `<suite-id>` |

Document the project's suites here (id → name → use), e.g.:

| Suite id | Name | Use |
|----------|------|-----|
| `<suite-id>` | _Main manual suite_ | **Default target** |
| `<suite-id>` | _Regression suite_ | Regression |
| `<suite-id>` | _Sanity/Smoke_ | Smoke |
| `<suite-id>` | _Automation_ | Where automated runs post results |

In a multi-suite project (`suite_mode=3`) a run MUST target ONE `suite_id` and can only contain
cases that already exist in that suite. Jira tickets usually do NOT map to existing TestRail cases —
so the tool **creates a case per ticket** first.

## Required case fields (depends on your project's case template)

`add_case` fails if the template has **required** custom fields you omit. Inspect your project with
`GET index.php?/api/v2/get_case_fields` and fill the required ones. Typical set:
- `template_id` — the template id of the target suite.
- `custom_automation_status` — numeric option id if your template makes it required.
- `custom_ai_type` — AI attribution, if your template has it (use the "LLM" option id).
- `refs: "PROJ-####"` — standard field, links the case/test back to Jira.
- Content: `custom_preconds` (env + account + test data + Jira link) and `custom_steps_separated`
  (repro steps + `Verify: <AC>` rows with expected).

TestRail dropdown custom fields need the **numeric option id**, not the label.

## Status mapping (verdict -> TestRail status_id)

TestRail statuses: 1 Passed, 2 Blocked, 3 Untested, 4 Retest, 5 Failed, 6 In Progress, 7 Removed.

| Validation verdict (`result.json`) | status_id |
|-------------------------------------|-----------|
| PASS (`passed:true`) | 1 Passed |
| FAIL (`passed:false`, `inconclusive:false`) | 5 Failed |
| INCONCLUSIVE (`inconclusive:true`) | 4 Retest |
| NO-RESULT (no `result.json`) | 4 Retest (+ "no evidence" note) |

> INCONCLUSIVE stays local for Jira (no comment/transition); mapping it to **Retest** in TestRail is
> the only external trace and does not alter the Jira ticket.

Each result `comment` embeds: verdict, environment, method, Jira browse link, test URL, summary, the
AC list (pass/fail/inconclusive from `acChecks`), repro steps, not-validated, and the AI footer.

## API sequence (get_* / add_*)

1. `add_section/{project}` -> `{ suite_id, name, description }` -> sectionId
2. `add_case/{sectionId}` per ticket (required fields above) -> caseId
3. `add_run/{project}` -> `{ suite_id, name, include_all:false, case_ids:[...] }` -> runId
4. `add_results_for_cases/{runId}` -> `{ results:[{ case_id, status_id, comment }] }`

Output written to `artifacts/_tr-run.json` (`{project,suite,sectionId,runId,runUrl,caseMap,counts}`)
for recovery / later edits. Run URL: `${TESTRAIL_BASE_URL}/index.php?/runs/view/{runId}`.

## Env (in `.env`)

`TESTRAIL_BASE_URL` (`https://your-company.testrail.com`), `TESTRAIL_USERNAME`,
`TESTRAIL_API_KEY` (API key, not password), `TESTRAIL_PROJECT_ID`, `TESTRAIL_SUITE_ID`.
Jira: `JIRA_BASE_URL`, `JIRA_TOKEN` (titles fetched via `GET <jira>/rest/api/2/search` JQL
`key in (...)`; browse link is `${JIRA_BASE_URL}/browse/<KEY>` — add the context path if your Jira
has one).

## Gotchas

- **Strip the trailing slash from `TESTRAIL_BASE_URL`** (`.replace(/\/$/, '')`) — otherwise requests go
  to `//index.php?/api/...` and return 404.
- **Plan/run entries must use `include_all: false` with explicit `case_ids`.** `include_all: true` (or
  omitting `case_ids`) pulls in the whole suite.
- **Verify run case counts** after creation (`get_tests/{runId}` or the run page): the number of tests
  must equal the number of intended case ids; fix before posting results.
- The `import-testrail-cases.ts` script only **reads** cases (`get_cases`) into
  `wiki/docs/testrail-legacy-cases.json`; it does not create runs.
- Don't re-run without `--section` after a partial failure or you'll create a **duplicate**
  section; reuse the empty section id printed on the first attempt.
