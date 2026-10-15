---
name: live-ticket-validation
description: DEFAULT path — the agent validates ANY Jira ticket live via the Playwright MCP, then publishes a rich evidence comment through the shared pipeline. No per-ticket code.
---

# Live Ticket Validation (agent-first) — QA Brain

This is the **default** way to validate a ticket. The agent drives the app live via the
Playwright MCP (works for ANY ticket — any feature, any UI), then publishes
the verdict through the SAME Jira pipeline as the codified flow (AC table, embedded
evidence, failing-network detail, verdict transition).

> Codified validators (`scripts/validators/*.ts` via `ticket-flow.ts`) are an OPTIMIZATION
> for high-frequency regression tickets you re-run unattended — NOT the default. A plain
> Node script cannot call the MCP; the MCP only works with an agent in the loop.

## When to use which

| Situation | Path |
|-----------|------|
| Validate a normal ticket (any UI) | **This skill** — live via MCP |
| Exploratory bug hunting | Live via MCP |
| A scenario you re-run every release, unattended | Codify a validator (page object under `scripts/pages/`) + `ticket-flow.ts` |

## Preconditions

1. Edge CDP up at `http://localhost:9222` (see `skills/shared-browser`). Else run `scripts/start-edge-cdp.bat`.
2. Playwright MCP approved this session (`.mcp.json` / `.vscode/mcp.json`, see `skills/playwright-mcp`).
3. Read the matching feature guide (`skills/features/<feature>.md`, via `skills/INDEX.md`). If the
   ticket needs a multi-step setup flow (e.g. creating a prerequisite record), use the helper/page
   object for your product under `scripts/helpers/` / `scripts/pages/` if one exists — never change
   URLs manually or skip the app's own entry flow. No guide yet? Plan to create one from
   `features/_TEMPLATE.md` (see `skills/knowledge-capture.md`).

## The loop

1. **Read the ticket** — summary, description, ACs, repro, labels (`getIssue`, or the
   Atlassian MCP). Treat the ACs as the checklist; if the AC text is obviously wrong/boilerplate,
   validate the real described behavior and say so under "Not Validated".
2. **Validate without changing Jira.** Defer status changes until a conclusive PASS/FAIL is ready
   to publish; an INCONCLUSIVE result must leave the ticket exactly as it was.
3. **Validate live via the MCP** — `browser_navigate` → `browser_snapshot` → act on what's
   actually there. Check each AC; record Expected vs Observed + pass/fail.
4. **Capture evidence into `artifacts/<KEY>/`**:
   - `browser_take_screenshot` for each meaningful state, ESPECIALLY the error/blocking state.
   - `browser_console_messages` → console errors.
   - `browser_network_requests` → any failing call (endpoint, method, status, response).
   - Keep artifacts local until the verdict is conclusive.
5. **Assemble a `result.json`** (a `ValidationResult`, shape below).
6. **Publish** through the shared pipeline:
   ```bash
   npx tsx scripts/post-validation.ts <KEY> artifacts/<KEY>/result.json
   ```
   PASS/FAIL attach evidence, post a structured comment, and transition the ticket. An
   INCONCLUSIVE result is local-only: the pipeline must not upload evidence, comment, transition,
   or sync to a bug pipeline. Report the blocker and unvalidated criteria to the user and leave
   Jira unchanged.

## Evidence gate and verdict integrity

- Jira status is workflow metadata, not proof of testing. `Performance Test`, `In Acceptance`, and
  `Closed` tickets can have mistaken transitions, code/CI-only evidence, partial acceptance, or an
  agent result explicitly awaiting human review. Inspect the latest QA evidence against every AC
  before treating a ticket as tested or using it to calibrate another ticket.
- Record the environment, persona/store, fixture, and deployed UI/API versions. Confirm the served
  UI bundle/version and the BFF `X-Bff-Version`; a green build or a fix present on a branch does
  not prove that both components are deployed together in QAE. PROJ-1234 had a fixed BFF while the
  SPA deployment was initially blocked, so an early retest would have tested a stale UI.
- Before a state-changing flow, verify the fixture's current authoritative status and use only an
  approved disposable/reversible record. If it is already voided/amended, lacks required data, or
  has no approved cleanup path, stop before mutation and report INCONCLUSIVE locally.
- Distinguish an app defect from a dependent-service failure with a safe control when possible.
  For example, a request-specific 503 with a successful control request does not by itself prove
  an app regression; capture current build, request status, and the matching control before
  assigning FAIL. Do not retry potentially stateful requests blindly.

### MCP operational command (recommended)

Use the MCP-first command to prepare and publish consistently:

```bash
# prepare ticket + create artifacts/<KEY>/result.draft.json
npm run mcp:ticket -- <KEY>

# after MCP validation fills the result JSON
npm run mcp:ticket -- <KEY> --publish artifacts\\<KEY>\\result.draft.json
```

## Verdicts (be honest — never overclaim)

- **PASS** (`passed:true`) — every AC confirmed → forward transition.
- **FAIL** (`passed:false`) — a real defect reproduced → `In Progress` (back to dev).
- **INCONCLUSIVE** (`passed:false, inconclusive:true`) — could NOT confirm the feature
  (blocked, server error, couldn't reach the screen) → no Jira update of any kind. Leave the
  ticket in its current state and report the blocker locally; do not upload evidence or a comment.

## result.json shape

```json
{
  "passed": false,
  "inconclusive": false,
  "summary": "Payment method dropdown is not selectable — bug reproduces.",
  "acChecks": [
    {
      "id": "AC1",
      "description": "Payment method is selectable when adding a payment",
      "expected": "Dropdown opens and a method can be picked; flow proceeds",
      "observed": "Dropdown renders disabled; no options; flow blocked",
      "passed": false,
      "status": "fail"
    }
  ],
  "reproSteps": [
    "Login to the QA app",
    "Billing → Payment → Add payment",
    "Fill mandatory fields",
    "Try to select Payment method → dropdown is not selectable"
  ],
  "consoleErrors": ["[error] ..."],
  "networkCalls": [
    { "method": "GET", "url": "https://your-app-qa.example.com/api/payment-methods",
      "status": 500, "statusText": "Internal Server Error",
      "requestHeaders": {}, "responseBody": "{...}" }
  ],
  "notValidated": ["Ticket AC text was boilerplate ('add new users') — validated the described payment behavior instead."],
  "environment": "QA — your-app-qa.example.com",
  "testData": { "Account": "<alias from domain/test-data.md>" },
  "screenshots": ["artifacts/PROJ-1234/payment-method-blocked.png"],
  "networkLogPath": null
}
```

Only `passed` is strictly required; everything else is filled with safe defaults. The more
you provide (`acChecks`, `reproSteps`, `networkCalls`), the more actionable the comment is
for the next agent that fixes the bug.

## Rules

- Reuse the shared Edge session; never launch/close the browser; work in your own tab.
- Evidence → `artifacts/` (gitignored). QA only — never Production unless told.
