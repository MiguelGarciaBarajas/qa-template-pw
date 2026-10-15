---
name: smartlearn-product-config
description: Drive SmartLearn (smartlearn.example.com) through the `smartlearn` MCP (Playwright MCP Bridge extension in the user's logged-in Chrome; verify the extension is installed first) to generate AI test cases in the Test Case Generation UI (/test-case-gen) and publish them to TestRail. Use when the user asks to use "SmartLearn" to create test cases, mentions "product-config"/"Test Case Gen", or wants a flow that combines SmartLearn output with TestRail.
---

# SmartLearn → TestRail Test Case Creation

SmartLearn (`https://smartlearn.example.com`) is an internal tool that generates test cases with AI.
**The entire generate → review → publish flow happens on one screen: Test Case Generation
(`/test-case-gen`)** — `/product-config` is just the admin table that registers which
Portfolio/Region/Product maps to which TestRail project and Jira instance (see below). This skill
wires SmartLearn into the QA Brain infrastructure and hands the output to the TestRail integration
(`skills/testrail-test-run/SKILL.md`).

## ✅ RECOMMENDED: `smartlearn` MCP via the Playwright MCP Bridge extension

CDP on port 9222 can be unreliable for SmartLearn, and launching a fresh browser lands on an
unauthenticated login. The approach that works: a dedicated `smartlearn` MCP server that
**attaches to the user's real, already-logged-in Chrome** through the "Playwright MCP Bridge"
extension (reuses cookies/SSO, no new profile, no CDP).

### ⚠️ Prerequisites — every new user MUST verify these first

1. **Chrome has the "Playwright MCP Bridge" extension installed** (Chrome Web Store). If not,
   install it and pin it. Without it the `smartlearn` MCP cannot connect.
2. Open the extension and copy its **connection token**; store it as the Windows **User** env var
   `PLAYWRIGHT_MCP_EXTENSION_TOKEN` (never commit it). Restart the terminal/Copilot CLI.
3. Add this server to `~/.copilot/mcp-config.json` (no `env` block; it inherits the User env var):
   ```json
   "smartlearn": { "command": "npx", "args": ["-y", "@playwright/mcp@0.0.80", "--extension", "--browser", "chrome"] }
   ```
4. Restart Copilot CLI, run `/mcp` and confirm `smartlearn` is connected. Log in to SmartLearn in
   Chrome beforehand; if a login page appears, ask the user to log in.

### Working one-call recipe (`smartlearn-browser_run_code_unsafe`)

Run one whole ticket per call with `async (page) => {...}`. Hard-won details:
- Plain `browser_click` can time out on SmartLearn; click via `page.evaluate` with `scrollIntoView()` + `.click()`.
- Screenshots time out when the tab is in the background; use evaluate/snapshot.
- Dropdowns are `button.dropdown-toggle`; open, then click the leaf element inside `[role=listbox]`; wait ~4s after each pick (suite/section load async). Section: match the `PROJ-XXXX —` prefix (other tickets appear in the list).
- Checkboxes: click `span.checkbox__label` for "Include Negative Test Cases" and "Include Pre-conditions"; verify both checked.
- Jira Ticket ID: `page.getByRole('textbox',{name:'e.g. PROJ-'}).fill(KEY)` then `Tab` and wait ~4s. Setting the value via JS leaves Generate disabled; `pressSequentially` duplicates text.
- Flow: Generate → Story Evaluation modal (do NOT click "Add Jira Comment") → PROCEED (answer "Yes" to "already exist") → wait "Test Cases Generated" → check titles are not generic stubs ("Smoke Test - Basic…") → "Edit mandatory values" (retry until `select` exists) → "Not a Candidate" → "Save Mandatory" → "Upload N selected to TestRail" → read "Uploaded: N | Duplicates | Failed".
- Project/suite: pick per the **Project/suite mapping** table below.
- Always verify afterwards via the TestRail API (section case counts); the API user may not be allowed to delete cases (403).

### 📁 Reports & evidence: ALWAYS saved per Fix Version (never in the repo root)

Every SmartLearn / TestRail report, summary, status file, verification output, JSON mapping or
screenshot produced for a release goes in ONE folder per Fix Version (same folder that
`create-release-sections.ts` already uses for `testrail-sections.json`):

```
artifacts/release-<fix-version-slug>/        e.g. artifacts/release-my-product-release-2026-10/
├── testrail-sections.json                   ticket → section mapping (written by the script)
├── smartlearn/
│   ├── <KEY>-upload.json                    per ticket: project, suite, section, N uploaded/duplicates/failed, sample titles
│   └── <KEY>-*.png                          screenshots (Story Evaluation, upload result)
├── testrail/
│   ├── verification-<YYYY-MM-DD>.md|json    section case counts checked via API
│   └── plan-<YYYY-MM-DD>.json               milestone/plan/run ids and case_ids used
└── SUMMARY.md                               one running summary for the release (append, don't create new files)
```

Rules:
- Slug = Fix Version lowercased, non-alphanumerics → `-` (`My Product Release 2026.10` → `my-product-release-2026-10`).
- One `SUMMARY.md` per release, updated in place; no `*_FINAL`, `*_COMPLETE`, `*_REPORT` files, and nothing at the repo root or in `scripts/`.
- Throwaway helper scripts: run them from `artifacts/release-<slug>/tmp/` or delete them when done; never leave them untracked in the repo.
- `artifacts/` is gitignored — never commit it. Only durable learnings go into `skills/`.
- Before deleting untracked files, list them with `git ls-files --others --exclude-standard` (never filter `git status --short` with `??`-style wildcards: that also matches tracked modified files).

> The legacy CDP-based section below remains for reference only; prefer the extension MCP above.

## Legacy: CDP-based approach (no new MCP server)

The Playwright MCP (`.vscode/mcp.json` for VS Code, `~/.copilot/mcp-config.json` for the Copilot CLI)
connects to the **shared Edge over CDP** (`--cdp-endpoint http://localhost:9222`) and can navigate to
**any URL**, reusing the active SSO session:

1. Confirm CDP is up: `http://localhost:9222/json/version` (else run `scripts/start-edge-cdp.bat`).
2. `browser_navigate` to `https://smartlearn.example.com/product-config` in your **own tab**.
3. Handle SSO as in `skills/shared-browser/SKILL.md`.
4. `browser_snapshot` to read the actual page — don't assume selectors; snapshot first.

> If the Copilot CLI's `playwright` MCP entry is missing `--cdp-endpoint`, it launches a fresh
> isolated browser instead of reusing the shared Edge/SSO — fix `~/.copilot/mcp-config.json` to
> match `.vscode/mcp.json`.

## Login + page map

Unauthenticated users are redirected to `/login` → "LOGIN WITH SSO" button → identity provider →
corporate email → **password + MFA code are entered by the human**; the agent must not try to
guess/enter them. After MFA the app redirects back to `https://smartlearn.example.com/?sl_token=...`.
Gotcha: the "LOGIN WITH SSO" button can hang `browser_click` — use `browser_run_code_unsafe` with a DOM
`.click()` instead.

Sidebar pages: **Home**, **Chat Bot** (`/chatbot`), **Test Case Generation** (`/test-case-gen`),
**Data Management** (`/data-management`), **Test Case Management** (`/test-case-management`),
**Product Configuration** (`/product-config`).

### `/product-config` is NOT the generator

It's an admin table: `Portfolio | Region | Product | OpenSearch Index | NFS Storage | JIRA |
TestRail | Active | Actions`. "Edit" only lets an SME update **Swagger URLs** and **Confluence
Spaces** (one per line) — the knowledge sources feeding the AI for that product. Case generation
itself lives on **`/test-case-gen`**.

### Project/suite mapping — configure per product

**The top-nav Portfolio/Region/Product selector only drives the Jira instance / knowledge-base
defaults for the AI — it does NOT restrict which TestRail project/suite/section you can target.** The
`Select a TestRail Project *` dropdown on `/test-case-gen` (and the one on `/test-case-management`)
lists **every TestRail project the account can see**. So you do NOT need your product registered as a
"Product" in `/product-config` to generate cases for it: leave the top nav at any available product
(it affects Jira defaults and AI KB scoping only), then explicitly pick your TestRail project,
suite and section in **Test Management**.

Record the mapping for YOUR product(s) here (fill in as you confirm each live):

| Product | TestRail project (`TESTRAIL_PROJECT_ID`) | Suite to pick for functional cases (`TESTRAIL_SUITE_ID`) | Other suites present (context) |
|---------|------------------------------------------|----------------------------------------------------------|--------------------------------|
| `<PRODUCT-A>` | `<project-name> (id <PLACEHOLDER>)` | `<suite-name> (id <PLACEHOLDER>)` | `<regression / smoke / automation suites>` |
| `<PRODUCT-B>` | `<project-name> (id <PLACEHOLDER>)` | `<suite-name> (id <PLACEHOLDER>)` | |

How to configure per product:
1. Open `/test-case-gen`, pick your TestRail project, and list its suites.
2. **Naming rule of thumb:** most projects expose one suite whose name contains **"Functional"** —
   that is the one for regular functional/AC-driven cases (as opposed to Automation / Regression /
   Smoke / API suites). Projects with no "Functional" suite, or several, need an explicit choice
   matched to the ticket's area — record the decision in the table.
3. Cross-check the suite id against `TESTRAIL_SUITE_ID` used by `skills/testrail-test-run/SKILL.md`
   before publishing real cases (the UI shows names, the API uses ids).
4. Open question per product: whether AI knowledge grounding (Swagger/Confluence sources in
   `/product-config`) scoped to another product measurably hurts case quality — compare against a
   manually QA'd example before relying on it for real publishing.

### ⚠️ After picking a Suite: wait for the "loading" state, then pick the Section named after the ticket

Every dropdown shows an explicit loading indicator while the next one's options are fetched — e.g.
right after picking a TestRail Project the Suite label reads **`Select a Suite (loading…) *`** (button
disabled) until the real list is ready; the same applies to Section after a Suite. **Never click a
still-disabled/loading dropdown or assume the previous option list is still valid** — re-snapshot
until the `(loading…)` label is gone and the button is enabled.

**The Section to select is the one named after (or matching the convention/number of) the Jira ticket**
— don't default to a generic/parent section; search the dropdown for the ticket's own number/name.

1. **Section already exists** (normal case — sections are created ahead of time, see
   `scripts/testrail/create-release-sections.ts`) → select it and continue.
2. **Section does NOT exist yet** → do **not** pick an unrelated section. Create the missing TestRail
   section first (known gap — see Open questions); until then stop and ask the user.

### `/test-case-gen` form fields

- Top nav selects: **Portfolio**, **Region**, **Product** (Jira/KB defaults).
- **Test Case Type**: `UI` / `API` / `Database` (toggle buttons, UI selected by default).
- **Test Management**: TestRail Instance (prefilled), **TestRail Project\*** (prefilled from
  product-config but freely changeable), **Suite\*** (loads after project), **Section\*** (loads after suite).
- **JIRA**: Jira Instance (prefilled), **JIRA Ticket ID\*** (free text, e.g. `PROJ-1234` — feeds the
  AI the story/ACs), **Search Keyword** (optional, narrows KB/Confluence search).
- **Options**: `Include Negative Test Cases`, `Include Pre-conditions` (toggles).
- **Confluence**: `Include Confluence Data` (checkbox).
- **Additional Story Requirements**: free text for extra context.
- **Generate Test Cases** — disabled until required (`*`) fields are filled.

The tool itself publishes to TestRail ("Upload and synchronize TestRail data"). It may make
`scripts/testrail/create-run-from-validations.ts` redundant for *new-case creation* — but that script
still owns *result posting* for live validation runs.

## Auth automation (avoid re-entering MFA every session)

Manual MCP login works but doesn't scale. Generate the OTP programmatically from a **TOTP secret**
(Base32 seed) instead of waiting on a human:

- **`scripts/smartlearn-auth.ts`** (`npm run smartlearn:auth`) — standalone Playwright login using a
  **dedicated QA/service account** (`SMARTLEARN_USER` / `SMARTLEARN_PASS` / `SMARTLEARN_TOTP` in `.env`),
  saves a Playwright `storageState` to `.auth/smartlearn.json` (gitignored), cached ~8h. It also ticks
  "remember this device" during MFA so a fresh login skips the OTP screen for ~30 days on that profile.
- **Never use a personal corporate employee account for this.** `SMARTLEARN_TOTP` is the Base32 secret
  shown once when enrolling MFA ("Can't scan the QR code?" link) — extracting it from someone's personal
  Authenticator is a security/personal-data problem. Only appropriate for a purpose-built service/QA account.
- Until that service account exists, MCP sessions need a human to paste the 6-digit code once per
  ~30 days (if "remember device" is checked) or every ~8h cache expiry otherwise.

## Full `/test-case-gen` flow

Default per-ticket flow. Side-effect warning: never click "Add Jira Comment" / "Comment to Jira" or the
final "Upload to TestRail" during exploration — both have real, irreversible side effects.

1. **Top nav**: Portfolio → Region → Product.
2. **Test Case Type**: `UI` / `API` / `Database`.
3. **Test Management**: TestRail Project auto-selects the one mapped in `/product-config` (takes ~1s to
   load async — don't assume it's empty on the first snapshot); pick **Suite**, then **Section** (auto-
   selects if the suite has only one).
4. **JIRA**: **JIRA Ticket ID** does a **live validation call** as you type/blur — shows `✓ Valid ticket`
   inline. Validation is NOT scoped to the product's Jira project — any ticket the account can read validates.
5. **Options**: **✅ default workflow: always check BOTH** `Include Negative Test Cases` and
   `Include Pre-conditions` (plain `<input type="checkbox">` under a `.checkbox` label, off by default).
   `Generate Test Cases` stays disabled until Project/Suite/Section + a validated Jira Ticket ID are set.
6. **⚠️ Story Evaluation gate (modal, every time you click Generate)** — an LLM scores the Jira story first:
   - `Overall Score: X.X`, `Status: Incomplete|Complete`, sub-scores /5: **Clarity**, **Completeness**, **Testability**.
   - **Improvement Recommendations** — editable textarea (`Ctrl+Enter` applies edits).
   - **"Add Jira Comment"** posts the evaluation **as a real comment on the live Jira ticket**; an equivalent
     **"Comment to Jira"** button sits below the form. **Never click either** unless the user explicitly
     wants Jira feedback posted.
   - Scores are **non-deterministic** (separate LLM call each time).
   - `Cancel` returns to the form (nothing generated/posted). `Proceed` continues regardless of score.
7. **Test Cases Generated** table (after Proceed, ~10s):
   - Search box, `Maximize`, and `Download ▾` (Excel / CSV / XML — export without touching TestRail).
   - Columns, all **editable inline**: checkbox (select for upload; all checked by default), **Title**,
     **Priority** (`1`–`4`, maps to TestRail `priority_id`), **Steps**, **Expected Result**. Paginated.
   - Footer: until mandatory fields are filled, **`Edit mandatory values`** is shown and
     `Upload N selected to TestRail` stays **disabled**.
8. **Mandatory Values modal**: typically one required field — **`Automation Status *`** (a `<select>`),
   matching the TestRail custom field `custom_automation_status`. Option wording differs from the numeric
   enum in `skills/testrail-test-run/SKILL.md` — don't assume a 1:1 id mapping; confirm against the live
   dropdown for the targeted TestRail project. **✅ default: select `Not a Candidate`** (AI-generated
   manual/functional cases, not flagged for automation) unless the user asks otherwise.
   `Save Mandatory Field Values` enables the upload button.
9. **`Upload N selected to TestRail`** — the actual write step; read "Uploaded: N | Duplicates | Failed".

**Batch/list-driven generation across many tickets is out of scope for this skill** — it only owns the
single-ticket UI mechanics; a bulk driver would be a separate skill/agent.

### `/test-case-management` is a SEPARATE, reverse sync (TestRail → SmartLearn)

Pulls **existing** TestRail cases **into** SmartLearn's knowledge base at the **section level**
(`TestRail Project Name` → `Suite` → `Section`, plus a `Regression` filter checkbox), presumably so the
generator can dedupe/ground against what already exists. Has a `Sync Job History` panel.

## Open questions

- What exact TestRail write call `Upload N selected to TestRail` performs (per-case `add_case`? does it
  also set `custom_ai_type`/`refs` like `scripts/testrail/create-run-from-validations.ts`?) — re-check
  with a disposable section before relying on it for real publishing.
- Whether "Automation Status" is the *only* mandatory field for every project/suite, or a stricter case
  template (see `skills/testrail-test-run/SKILL.md`) surfaces more.
- **TODO: a "create missing TestRail section" agent/skill.** When the Section dropdown has no section
  matching a ticket there is no automated way to create it yet (naming convention, parent section per
  product) — not started.

## Rules (same as shared-browser)

- Reuse the authenticated browser session; never launch a separate browser.
- Own tab only; never navigate the user's existing tabs; close your tab when done.
- Never commit anything under `artifacts/`/`evidence/`.
- **Never click "Add Jira Comment" / "Comment to Jira" or "Upload N selected to TestRail"** during
  exploration, dry runs, or on a ticket/product you weren't explicitly asked to act on — both have
  real, irreversible side effects (a live Jira comment, or a real TestRail case). Only click them when
  the user has explicitly asked to publish for a specific ticket.
