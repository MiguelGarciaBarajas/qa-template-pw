---
name: release-documentation
description: End-to-end release documentation workflow - pulls all Jira issues for a given Fix Version, creates the matching TestRail Milestone/Suite/Test Plan, builds an Excel release summary, publishes a Confluence release page with screenshots, and prepares a release-notes email in Outlook. Use whenever the user asks to "document a release", "generate the release documentation", gives a Jira Fix Version to document, or asks to create the TestRail milestone/plan/suite for a release.
license: MIT
---

# Release Documentation Skill

Produces a complete, consistent release documentation package from a single
input: a **Jira project + Fix Version**. Always confirm the project key and
exact Fix Version name with the user before starting if not given explicitly.

## Prerequisites (check before running, don't assume)

1. **Atlassian MCP** (`mcp-atlassian`) registered and connected — provides
   Jira + Confluence tools. If not available, tell the user to run:
   ```
   /mcp add
   ```
   and register it with command `uvx` args `["mcp-atlassian"]` and env vars
   `JIRA_URL`, `JIRA_USERNAME`, `JIRA_API_TOKEN`, `CONFLUENCE_URL`,
   `CONFLUENCE_USERNAME`, `CONFLUENCE_API_TOKEN` (Atlassian Cloud API token
   from https://id.atlassian.com/manage-profile/security/api-tokens).
   Requires `uv`/`uvx` installed (`pip install uv` or the Astral installer).
2. **Playwright MCP** registered (local, `npx @playwright/mcp@<pinned-version>`)
   — used only for screenshots of Jira/TestRail/Confluence pages that the
   Atlassian MCP can't render visually (e.g. board views, TestRail UI which
   has no MCP at all).
3. **TestRail env vars** available in the shell: `TESTRAIL_URL`,
   `TESTRAIL_EMAIL`, `TESTRAIL_API_KEY`. TestRail has no MCP — all TestRail
   calls go through `scripts/testrail-api.ps1` in this skill folder (wraps
   the TestRail REST API v2 with Basic auth).
4. **Outlook desktop** signed in on this machine — `scripts/send-outlook-mail.ps1`
   drives it via COM automation (no OAuth/API needed). Sending mail is a
   **consequential action**: always create the message as a **draft**
   (default) and only pass `-Send` if the user has explicitly reviewed and
   approved the content in this conversation.
5. **xlsx skill** (built-in) — used to build the Excel summary, no setup
   needed.
6. This machine's PowerShell execution policy blocks unsigned scripts by
   default. Run the two `.ps1` helpers with
   `powershell -ExecutionPolicy Bypass -Command ". '<script>'; <call>"`
   (scoped to that one process, doesn't change the system-wide policy).
7. **Corporate TLS interception**: if any `npx tsx scripts/testrail/*.ts`
   call fails with `self-signed certificate in certificate chain` (Node) even
   though the site loads fine in a browser, the corporate VPN/proxy is doing
   TLS interception and Node doesn't trust its root CA by default (unlike
   Windows/curl, which do). Fix: set
   `$env:NODE_EXTRA_CA_CERTS = (Resolve-Path scripts\corp-ca-bundle.pem).Path`
   before running the script (from the `qa-brain-template` repo). If that
   file doesn't exist yet, regenerate it by exporting the live TLS chain for
   the failing host (e.g. `your-company.testrail.com`) via .NET
   (`SslStream`/`X509Certificate2`) into a PEM bundle at
   `scripts\corp-ca-bundle.pem` — it's gitignored, machine-specific, safe to
   regenerate anytime.

If any prerequisite is missing, tell the user exactly what's missing and
stop that step rather than improvising a workaround (e.g. don't hand-roll
Jira REST calls with a bearer token if the MCP isn't connected — ask the
user to connect it first).

## Workflow

### 1. Gather Jira release data
- Ask for / confirm: Jira project key, Fix Version name, target release date.
- Use the Atlassian MCP to search issues: JQL
  `project = <KEY> AND fixVersion = "<version>" AND issuetype in (Story, Bug, Defect) ORDER BY issuetype, status`.
  **Only Story/Bug/Defect** — Task and Sub-task are explicitly excluded from
  this flow (confirmed with the user; they don't get test cases generated).
- Group results by issue type (Story/Bug/Defect) and by status. Flag
  any issue not in a "Done"/"Closed"-equivalent status — these are release
  risks and must be called out explicitly to the user, not silently included.

### 1.5. Create TestRail sections + generate test cases per ticket (SmartLearn)
> **SmartLearn driver:** use the `smartlearn` MCP (Playwright MCP Bridge extension in the
> user's logged-in Chrome). **Before starting, verify the user has the "Playwright MCP Bridge"
> Chrome extension installed, the `PLAYWRIGHT_MCP_EXTENSION_TOKEN` User env var set, and the
> `smartlearn` server connected in `/mcp`.** Setup + the working one-call recipe are in
> `skills/smartlearn-product-config/SKILL.md`. Do not use CDP/Edge on port 9222.
>
> **Reports:** save every report/summary/JSON/screenshot for the release under
> `artifacts/release-<fix-version-slug>/` (subfolders `smartlearn/`, `testrail/`, one
> `SUMMARY.md`); never at the repo root. See that same skill for the layout.
>
> **Word test plan:** if the user also wants the local Word plan, ask them for the path where
> the .docx must be created (`skills/local-word-test-plan/SKILL.md`).

This targets each product's *existing, real* Functional suite (see the naming
table in `skills/smartlearn-product-config/SKILL.md` in the `qa-brain-template`
repo) — never an ad-hoc new suite. Step 2 (Milestone + Test Plan) runs
**after** this step finishes and reuses these same sections/cases.

**Multi-product Fix Versions** (e.g. "<Product> Release 2026.09" spanning products A + B,
with no single product in the title): the scripts detect this per-ticket
instead of from the Fix Version title alone —
1. Each ticket's **own summary/title** is scanned for a product token.
2. A ticket whose summary contains "All Products" is **replicated into every
   concrete product** found among the release's other tickets (e.g. a
   licensing ticket that applies to both A and B gets its own section in
   each product's suite).
3. Only if a ticket has neither its own token nor is an "All Products" ticket
   does it fall back to the Fix Version title's product (if any) — if that's
   also absent, the scripts stop and ask to resolve manually.
4. Both `create-release-sections.ts` and `create-release-milestone-plan.ts`
   run this resolution **per product** and produce one full set of
   outputs (sections, and later Milestone + Test Plan with all 3 entries) for
   **each** product touched by the release — report each product's results
   separately to the user.

Steps:
1. **Determine the target TestRail project(s)** from the Fix Version
   name/title and/or each ticket's own text (see multi-product note above) —
   scan for a known product token (it isn't always a strict prefix; releases
   can be titled `Expedited <Product> ...`). Supported products are the ones configured in the
   scripts' product map (`scripts/testrail/`) and in the project/suite table of
   `skills/smartlearn-product-config/SKILL.md`. Note the per-product Functional suite
   is looked up by name, not assumed to always be literally "Functional" —
   some products name it differently (record such exceptions in that table).
2. **Ask the user, every run** (never assume/reuse a prior answer): *"Do you want one
   shared section for all bugs/defects of this release, or does each bug/defect get its own
   section like the stories?"* → maps
   to `--bugs-mode shared` or `--bugs-mode individual`.
3. Run, from the `qa-brain-template` repo:
   ```powershell
   cd <path-to-qa-brain-template>
   npx tsx scripts/testrail/create-release-sections.ts `
     --fix-version "<Fix Version name>" `
     --project-key <Jira project key> `
     --bugs-mode <shared|individual> `
     --dry-run   # run once dry, review the plan, then re-run without --dry-run
   ```
   This creates one TestRail section per ticket (idempotent — re-runs skip
   tickets that already have a matching section) and writes
   `artifacts/release-<slug>/testrail-sections.json` with each ticket's
   `sectionId`.
4. **For each ticket** in that JSON (and each bug/defect, if applicable), run
   the `smartlearn-product-config` skill's single-ticket flow
   (`qa-brain-template/skills/smartlearn-product-config/SKILL.md`) with the
   TestRail Project/Suite/Section already fixed to that ticket's `sectionId`,
   and the ticket key as the JIRA Ticket ID input. Follow that skill's
   defaults exactly (both Options checkboxes checked, Automation Status
   `Not a Candidate`) unless the user says otherwise for this run.
   - Switching the TestRail Project dropdown (e.g. product A → B between tickets)
     resets Suite and Section — always reselect both after switching.
   - The sidebar "Select Product" selector is cosmetic only in current
     SmartLearn UI (it only drives Jira/KB defaults) — ignore it; the real
     Project/Suite/Section fields in the main form drive generation
     correctly regardless.
   - The JIRA Ticket ID "✓ Valid ticket" check is async — after typing it,
     blur/Tab and wait a couple seconds before checking if "Generate Test
     Cases" is enabled.
   - Regenerating for a Jira ticket that already has cases elsewhere (e.g.
     an "All Products" ticket replicated into a second product's section)
     triggers a "Test cases already exist for this Jira ID" confirm dialog —
     click **Yes** to proceed; the Story Evaluation modal may be skipped on
     that repeat run.
   - If a button (Generate/Proceed/Upload) is below the fold and
     `browser_click` times out, use `browser_evaluate` to find it by text,
     `scrollIntoView({block:'center'})`, then call `.click()` directly.
5. Report back per-ticket: section created/reused, test cases generated,
   uploaded to TestRail — or flag any ticket that failed the SmartLearn Story
   Evaluation gate or has no matching section (per that skill's two-branch
   rule) so the user can resolve it manually.

### 2. Create the TestRail Milestone + Test Plan (after step 1.5 test cases exist)
This **replaces** the old ad-hoc "create a brand-new suite per release" model —
confirmed with the user, it now reuses the product's real Functional + Smoke
suites (the same ones from step 1.5), never creates a new suite.

Run, from the `qa-brain-template` repo, only AFTER step 1.5's SmartLearn
generation has finished for all tickets:
```powershell
cd <path-to-qa-brain-template>
npx tsx scripts/testrail/create-release-milestone-plan.ts `
  --fix-version "<Fix Version name>" `
  --dry-run   # run once dry, review the plan, then re-run without --dry-run
```
This is idempotent (reuses an existing milestone/plan by exact name match) and:
1. Creates a **Milestone** named exactly like the Fix Version — **name only,
   no due date** (dates change later, per the user).
2. Creates a **Test Plan** (in TestRail's "Test Runs & Results" section) named
   exactly like the Fix Version, linked to that Milestone.
3. Adds 3 suite entries to the plan:
   - The product's **Functional** suite, scoped to just this release's ticket
     sections (whole folders — all their cases, not hand-picked individual
     cases) → renamed **"Functional Test"**.
   - The **same** Functional suite + same sections again → renamed
     **"Rollback Test"**.
   - The product's **Smoke** suite, taken **complete** (no filtering,
     `include_all`) → renamed **"Manual Regression"**.
   - ⚠️ **TestRail API gotcha (fixed in code, but verify if editing runs by
     hand)**: `add_plan_entry` defaults `include_all` to `true` if it's
     omitted — passing `case_ids` alone does NOT scope the run, it silently
     includes the whole suite. Always confirm Functional Test/Rollback Test
     show the expected count (e.g. "28 test cases included"), not "All
     cases included", before trusting a plan. If a run was created wrong,
     `update_run_in_plan_entry` can error unpredictably — the reliable fix
     is `delete_plan_entry` + re-`add_plan_entry` with `include_all:false`
     explicit.
4. Writes `artifacts/release-<slug>/testrail-milestone-plan.json` with the
   milestone/plan IDs and the plan URL.
- Report back the milestone/plan IDs and the plan URL
  (`{TESTRAIL_URL}/index.php?/plans/view/{plan_id}`).

### 3. Build the Excel release summary
Use the built-in `xlsx` skill to create a workbook with:
- Sheet "Summary": Fix Version, release date, totals by issue type/status,
  links to the TestRail plan and (once created) the Confluence page.
- Sheet "Jira Issues": one row per issue (key, type, summary, status,
  assignee, link).
- Sheet "Test Coverage": TestRail suite/plan name, case count, milestone link.

### 4. Take screenshots
Use the Playwright MCP to capture:
- The Jira Fix Version report/board for this version.
- The TestRail milestone page and the test plan page.
Save them under a temp folder and reference/upload them in the Confluence
page (step 5) — Confluence pages support image attachments via the MCP's
attach-file tool; if that tool isn't available, tell the user which images
to attach manually.

### 5. Publish the Confluence release page
Use the Atlassian MCP to create a page (ask the user for the target space
key if not already known) with:
- Title: `Release <Fix Version> - Release Notes`.
- Body: release date, summary counts, the Jira issues table, the TestRail
  plan/milestone links, and the screenshots from step 4.
- Attach the Excel file from step 3.

### 6. Draft the release email
Use `scripts/send-outlook-mail.ps1` (dot-source, then call):
```powershell
powershell -ExecutionPolicy Bypass -Command "
  . '$env:USERPROFILE\.copilot\skills\release-documentation\scripts\send-outlook-mail.ps1';
  Send-OutlookMail -To '<distribution list>' -Subject 'Release <Fix Version> - Release Notes' -BodyHtml \$html -Attachments @(<excel path>, <screenshot paths>)
"
```
- Compose `$html` from the same summary used in the Confluence page (short
  version: counts, risks/open issues, links to Confluence + TestRail).
- **Always leave it as a draft** (no `-Send`) and tell the user it's ready
  for review in Outlook, unless they've explicitly asked you to send it now.

## Output checklist to report back to the user
- [ ] Jira issues pulled and categorized (Story/Bug/Defect only), open/at-risk issues flagged
- [ ] TestRail sections created per ticket in the product's real Functional suite, SmartLearn test cases generated/uploaded per ticket
- [ ] TestRail Milestone + Test Plan created (Functional Test / Rollback Test / Manual Regression entries), IDs/link given
- [ ] Excel summary created (path given)
- [ ] Screenshots captured
- [ ] Confluence page published (link given)
- [ ] Outlook draft created (not sent, unless explicitly requested)
