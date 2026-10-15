# Project Context — <QA Owner>, <Company / Team>

> Read this file at the start of every session. Fill every `<PLACEHOLDER>` when onboarding a product.

## Role

<QA Owner> — QA Automation + QA Manual engineer on the <Product Name> project.

## Repos

| Repo | Role |
|------|------|
| `qa-brain-template` (rename for your product) | **This repo** — QA Second Brain: ticket flow + exploratory QA agent |
| `<product-ui-repo>` | Application under test (UI) |
| `<other-reference-repo>` | Optional: reference QA repos / second brains |

## Environments

| Environment | URL | When to use |
|-------------|-----|-------------|
| QA | `https://your-app-qa.example.com` | Primary testing |
| DEV (optional) | `https://your-app-dev.example.com` | Discovery-first runs (`DEV_FIRST_DISCOVERY`) |
| Production | `https://your-app-prod.example.com` | Reference only — never test here unless told |

## Jira

| Item | Value |
|------|-------|
| Project | `<jira project key>` (e.g. PROJ) |
| Board | `https://jira.example.com/jira/secure/RapidBoard.jspa?rapidView=<id>` |
| Epic | `https://jira.example.com/jira/browse/<JIRA_EPIC>` |
| Base URL | `https://jira.example.com` |

### Ticket status transitions (adapt to your board)

```
Ready for Testing
  → In Testing          (only once a conclusive PASS/FAIL is ready to publish)
  → Performance Test    (ticket PASSED QA)
  → In Acceptance       (ticket PASSED the performance gate)
  → In Progress         (ticket FAILED — back to dev)
```

INCONCLUSIVE validations do not change Jira status or write anything to the issue.
Always list the issue's available transitions before transitioning — names differ per workflow.

### Special-label rule (example — keep or delete)

If a ticket has label `cae-perf` / `CAE-PERF` and passes validation, move to
**"In Acceptance"** instead of "Performance Test".

## Browser / CDP

- Shared Edge on port 9222 via CDP
- Run `scripts/start-edge-cdp.bat` (or `npm run cdp:start`) to launch Edge with debugging enabled
- Auth: set `QA_USER_EMAIL` for SSO passthrough; keep credentials in the approved secret manager
- Never launch a new browser — always connect via CDP

## Key Contacts

| Person | Role |
|--------|------|
| <Engineering Manager> | Engineering Manager |
| <QA Reference> | QA / testing reference |
| <QA Owner> | QA Automation + Manual (this repo) |

## Session Startup Checklist

1. Read this file (`CONTEXT.md`)
2. Read `AGENTS.md` for agent rules
3. Read `skills/INDEX.md` — routing table; load ONLY the skill(s) your task needs (saves tokens)
4. Verify CDP is available: `http://localhost:9222/json/version`
   - If not: run `scripts/start-edge-cdp.bat`
5. Connections and env vars: see `CONNECTIONS.md`
