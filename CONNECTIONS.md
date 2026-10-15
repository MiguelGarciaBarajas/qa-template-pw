# CONNECTIONS — inventory of every external connection

All connections are configured through `.env` (copy `.env.example`). **Never commit `.env`.**
Verify everything with `npm run preflight` (see the checklist at the bottom).

| # | Connection | Auth | Main env vars | Used by |
|---|-----------|------|---------------|---------|
| 1 | Jira Data Center REST v2 | Bearer PAT | `JIRA_BASE_URL`, `JIRA_USER`, `JIRA_TOKEN`, `JIRA_PROJECT` | `scripts/jira-client.ts` |
| 2 | Tempo Timesheets | Bearer (Jira PAT / Tempo token) | `TEMPO_TOKEN`, `TEMPO_WORKER` | `scripts/tempo/*` |
| 3 | TestRail | Basic (user + API key) | `TESTRAIL_*` | `scripts/testrail/*` |
| 4 | Jenkins | user + API token | `JENKINS_*` | manual / skills |
| 5 | GitHub Models | PAT (`models:read`) | `GITHUB_TOKEN`, `GITHUB_MODELS_*` | `scripts/agent-validate.ts` |
| 6 | Teams webhooks | secret URL | `TEAMS_WEBHOOK_*` | `scripts/send-teams-report.mjs` |
| 7 | SmartLearn | SSO + TOTP (service account) | `SMARTLEARN_*` | `scripts/smartlearn-auth.ts` |
| 8 | Shared Edge (CDP) | none (local) | `CDP_ENDPOINT` | `scripts/cdp-browser.ts`, `scripts/cdp-start.ts` |
| 9 | Playwright MCP | none (local, via CDP) | — | `.mcp.json`, `.vscode/mcp.json` |
| 10 | App SSO login accounts | SSO / email+password+TOTP | `QA_USER_*`, `AUTO_*` | `scripts/run-account.ts`, `cdp-browser.ts` |
| 11 | Outlook (desktop COM) | signed-in Outlook client | — | `skills/release-documentation/scripts/send-outlook-mail.ps1` |
| 12 | Routing flags | — | `MCP_FIRST`, `DEV_FIRST_DISCOVERY`, `LEGACY_ORACLE`, `APP_URL_*` | `scripts/ticket-runner.ts`, `agent-validate.ts` |

---

## 1. Jira Data Center (REST v2)

- **Purpose:** read tickets/ACs, comment, attach evidence, transition, file bugs.
- **Env:** `JIRA_BASE_URL`, `JIRA_USER`, `JIRA_TOKEN` (Personal Access Token, sent as `Bearer`),
  `JIRA_PROJECT`, `JIRA_FIX_VERSION`, `JIRA_DESIGNATED_TESTER`, optional `JIRA_CF_DESIGNATED_TESTER`
  (custom field id), `JIRA_EPIC`, `JIRA_BUG_PRIORITY_ID`, `JIRA_BUG_DEFAULTS_JSON`.
- **Script:** `scripts/jira-client.ts` (also `fetch-epic-snapshot.ts`, `rft-dashboard.ts`, `bug-reporter.ts`, `publish-result.ts`).
- **Gotchas:**
  - Base path is `${JIRA_BASE_URL}/jira/rest/api/2` — the `/jira/` context path is required; without it
    redirects strip the auth header. The client uses `maxRedirects: 0` to fail fast instead.
  - Always check available transitions (`getTransitions`) before transitioning; names differ per workflow.
  - Some transitions require **Designated Tester**; `transitionIssue` retries with
    `JIRA_DESIGNATED_TESTER` (and `JIRA_CF_DESIGNATED_TESTER`) when Jira rejects it.
  - Comments are Jira wiki markup (v2), not ADF.

## 2. Tempo Timesheets

- **Env:** `TEMPO_TOKEN`, `TEMPO_WORKER` (worker key), `TEMPO_MORNING_TICKET` (pin the weekly admin
  ticket; empty = auto-detect), `TEMPO_AUTOWRITE` (`1` = allow writes without `--write`).
- **Scripts:** `scripts/tempo/run-daily-tempo.mjs`, `detect-day-tickets.mjs`, `fill-day.ts`; skill `skills/tempo/SKILL.md`.
- **Gotchas:** dry-run unless `--write` or `TEMPO_AUTOWRITE=1`; uses the Jira Bearer for tempo-timesheets endpoints.

## 3. TestRail

- **Env:** `TESTRAIL_BASE_URL` (**no trailing slash**, otherwise `//api` → 404), `TESTRAIL_USERNAME`,
  `TESTRAIL_API_KEY`, `TESTRAIL_PROJECT_ID`, `TESTRAIL_SUITE_ID`, optional `TESTRAIL_PRODUCTS_CONFIG`
  (default `scripts/testrail/products.config.json`), `TESTRAIL_RUN_NAME_PREFIX`, `TESTRAIL_CASES_FILE`,
  `TESTRAIL_MATCH_MIN_SCORE`, `TESTRAIL_SUPPLEMENTAL_WHEN_MAPPED`.
- **Scripts:** `scripts/testrail/testrail-client.ts`, `create-run-from-validations.ts`,
  `create-release-sections.ts`, `create-release-milestone-plan.ts`, `import-testrail-cases.ts`, `testrail-oracle.ts`.
  The PowerShell helper `skills/release-documentation/scripts/testrail-api.ps1` reads the aliases
  `TESTRAIL_URL` / `TESTRAIL_EMAIL` / `TESTRAIL_API_KEY` (the Node client also accepts `TESTRAIL_URL`,
  `TESTRAIL_USER`, `TESTRAIL_TOKEN`).
- **Gotchas:**
  - Plan entries default to `include_all: true`, which silently adds the **whole suite**. Always send
    `include_all: false` + explicit `case_ids` (the client does this when `case_ids` is passed).
  - Verify case counts after creating a plan/run (expected vs actual).

## 4. Jenkins

- **Env:** `JENKINS_BASE_URL`, `JENKINS_USER`, `JENKINS_TOKEN` (API token).
- **Used by:** manual checks and report-review workflows (e.g. the weekly admin ticket). No script in
  `scripts/` reads these variables yet — not verified beyond `process.env` grep.

## 5. GitHub Models (autonomous agent brain)

- **Env:** `GITHUB_TOKEN` (PAT with models read), `GITHUB_MODELS_CANDIDATES`, `GITHUB_MODELS_MODEL`,
  `GITHUB_MODELS_FALLBACK_MODEL`, `AGENT_MAX_STEPS`.
- **Scripts:** `scripts/agent-validate.ts`, `scripts/model-resolver.ts`; checked by `preflight.ts`.
- **Gotchas:** OpenAI-compatible endpoint; the resolver falls back through the candidate list if a model is unavailable.

## 6. Teams webhooks (daily status report)

- **Env:** `TEAMS_WEBHOOK_PRIMARY`, `TEAMS_WEBHOOK_SECONDARY` (empty = target skipped with a warning).
- **Scripts:** `scripts/send-teams-report.mjs`, `scripts/run-daily-report.mjs` / `.ps1`,
  `scripts/register-daily-report-task.ps1`, workflow `.github/workflows/daily-status-report.yml`.
- **Setup:** Teams → Apps → Workflows → "When a Teams webhook request is received" → "Post message in a
  chat or channel", Message = `triggerBody()?['text']`. Payload is `{ "text": "<report>" }` (plain text).
- **Gotchas:** corporate TLS inspection may need `scripts/corp-ca-bundle.pem` (gitignored,
  loaded via `NODE_EXTRA_CA_CERTS`). Delivery failure never discards the generated report.
  Webhook URLs are secrets — repo Actions secrets for cloud runs.

## 7. SmartLearn

- **Env:** `SMARTLEARN_URL`, `SMARTLEARN_USER`, `SMARTLEARN_PASS`, `SMARTLEARN_TOTP`.
- **Script:** `scripts/smartlearn-auth.ts` (`npm run smartlearn:auth`); skill `skills/smartlearn-product-config/SKILL.md`.
- **Gotchas:** use a **dedicated QA/service account**, never a personal corporate account.
  `SMARTLEARN_TOTP` is the Base32 enrollment secret, not a 6-digit code.

## 8. Edge over CDP (shared browser)

- **Env:** `CDP_ENDPOINT` (`http://localhost:9222`), optional `CDP_USER_DATA_DIR`, `MANUAL_LOGIN`,
  `MANUAL_LOGIN_TIMEOUT_SEC`.
- **Start:** `scripts\start-edge-cdp.bat` or `npm run cdp:start`. Verify `http://localhost:9222/json/version`.
- **Rules:** connect only — **never launch or close the browser**; create your own tabs and close them.

## 9. Playwright MCP

- **Config:** `.mcp.json` (Claude Code) and `.vscode/mcp.json` (Copilot):
  `npx -y @playwright/mcp@latest --cdp-endpoint http://localhost:9222`.
- **Gotchas:** reuses the authenticated SSO session of the shared Edge; does not launch a new browser.
  See `skills/playwright-mcp/SKILL.md`.

## 10. SSO login accounts

- **Env:** `QA_USER_EMAIL`, `QA_USER_PASS`, `QA_USER_TOTP`, fallback `AUTO_USER`, `AUTO_PASS`, `AUTO_TOTP`.
- **Scripts:** `scripts/run-account.ts`, `scripts/cdp-browser.ts`, `scripts/auth-manager.ts`.
- **Gotchas:** corporate accounts → corporate SSO sign-in (leave password/TOTP empty);
  dedicated QA accounts → email + password + TOTP flow. `preflight` resolves which account is used.

## 11. Outlook (release notes mail)

- **Script:** `skills/release-documentation/scripts/send-outlook-mail.ps1` — Outlook desktop COM
  automation (no Graph/Azure app). Drafts by default. Use Windows PowerShell 5 if COM issues appear.

## 12. Routing flags

| Flag | Meaning |
|------|---------|
| `MCP_FIRST` | Prefer the live MCP validation path |
| `DEV_FIRST_DISCOVERY` | Discover on `APP_URL_DEV` first, publish from QA |
| `LEGACY_ORACLE` + `APP_URL_LEGACY` | Require legacy-app parity evidence |
| `APP_ENV`, `APP_URL_QA/DEV/PROD` | Environment label and URLs (never test PROD unless told) |

---

## Verify connections — checklist

1. `copy .env.example .env` and fill the variables above.
2. `npm run preflight` — checks `.env`, run account, CDP (auto-starts Edge), GitHub Models token.
3. Jira: `npx tsx scripts/ticket-flow.ts --health` (or open one known ticket via `jira-client.ts`).
4. TestRail: `GET ${TESTRAIL_BASE_URL}/index.php?/api/v2/get_projects` returns 200 (no `//api`).
5. Tempo: `node scripts/tempo/run-daily-tempo.mjs` (dry-run, no `--write`).
6. Teams: run `scripts/send-teams-report.mjs` against a test channel.
7. `npm run build` (typecheck) passes.

## Security notes

- Never commit `.env`, `.auth/`, `artifacts/`, `evidence/` or `scripts/corp-ca-bundle.pem`.
- Never use personal corporate emails/accounts in automation — use dedicated service/QA accounts
  (especially SmartLearn and the run account).
- Treat webhook URLs, PATs, API keys and TOTP secrets as secrets; retrieve from the approved secret manager.
- Do not paste tokens in Jira comments, logs or screenshots; network logs are sanitized before upload.
