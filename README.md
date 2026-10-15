# qa-brain-template

> QA Second Brain template — <Product Name> | <QA Owner>

A product-agnostic QA automation "second brain": Jira Data Center + TestRail + Playwright over a
shared Edge (CDP) + SmartLearn + Teams + Tempo + Jenkins + a GitHub Models autonomous agent.
Copy it, fill the placeholders, and point it at your product.

Two capabilities:

1. **Ticket Flow Manager** — picks up Jira tickets, validates ACs in the app, files evidence, moves tickets
2. **Exploratory QA Agent** — autonomous smoke/functional/regression testing, discovers bugs, files Jira tickets

See `CONNECTIONS.md` for every external connection (env vars, auth, scripts, gotchas).

---

## How to onboard a new product

1. **Fill `CONTEXT.md`** — product name, QA owner, Jira project key, board/epic, environments, contacts, status transitions. Replace every `<PLACEHOLDER>` in `AGENTS.md` and `.github/copilot-instructions.md` too.
2. **Copy `.env.example` to `.env`** and fill the connection variables you need (Jira, TestRail, Tempo, GitHub Models, Teams, SmartLearn, run account). Never commit `.env`.
3. **Configure the TestRail products config** (`scripts/testrail/products.config.json`) with your product codes, project/suite IDs and section mapping.
4. **Add feature guides** — copy `skills/features/_TEMPLATE.md` per feature (and `skills/domain/_TEMPLATE.md` for business rules / canonical test data); register them in `skills/INDEX.md`.
5. **Run `npm run preflight`** — verifies `.env`, run account and CDP (auto-starts Edge with CDP).
6. **Validate your first ticket** — live via the Playwright MCP (default), or `npm run agent:auto -- PROJ-1234`.
7. **Run `skills/knowledge-capture.md` at the end of every ticket** — feed new flows, selectors and gotchas back into `skills/`.

---

## Quick Start

### 1. Clone and install
```bash
git clone <your-repo-url> qa-brain
cd qa-brain
npm install
npx playwright install
```

### 2. Configure environment
```bash
cp .env.example .env
# Edit .env with your Jira token and credentials
```

### 3. Start Edge with CDP
```bat
scripts\start-edge-cdp.bat
```
Verify: http://localhost:9222/json/version

Alternative:
```bash
npm run cdp:start
```

### 4. Run

```bash
# Preflight (checks env + run account + CDP)
npm run preflight

# Typecheck (no linter configured)
npm run build

# Live dashboard (all tickets in queue)
npm run dashboard:rft

# Live dashboard (only active/running tickets)
npm run dashboard:rft -- --active

# Process a specific Jira ticket
npx tsx scripts/ticket-flow.ts PROJ-1234

# Process all "Ready for Testing" tickets
npx tsx scripts/ticket-flow.ts --all

# Runner health/config report (validators + environment flags)
npx tsx scripts/ticket-flow.ts --health

# Import a legacy TestRail suite into the auto-match corpus
npm run testrail:import -- --suite <suite-id>

# Run a smoke test
npx tsx scripts/qa-explorer.ts smoke

# Run functional exploration
npx tsx scripts/qa-explorer.ts functional

# Fully autonomous agent with prechecks
npm run agent:auto -- PROJ-1234

# Legacy-oracle parity mode (new app vs legacy app)
npx tsx scripts/agent-validate.ts PROJ-1234 --legacy-oracle --legacy-url https://<legacy-app>
# (or set LEGACY_ORACLE=true and APP_URL_LEGACY in .env for ticket-flow runs)

# MCP-first operational flow (prepare + publish)
npm run mcp:ticket -- PROJ-1234
npm run mcp:ticket -- PROJ-1234 --publish artifacts\\PROJ-1234\\result.draft.json
```

---

## Structure

```
qa-brain-template/
├── .github/
│   ├── agents/                      ← Agent definitions (ticket-flow-manager, exploratory-qa,
│   │                                  daily-status-reporter, daily-tempo-logger)
│   ├── workflows/                   ← CI (typecheck, scheduled report)
│   └── copilot-instructions.md      ← Copilot global instructions
├── skills/
│   ├── INDEX.md                     ← Routing table (task → skill)
│   ├── knowledge-capture.md         ← Feed learnings back (end of every ticket)
│   ├── features/_TEMPLATE.md        ← Per-feature guide template
│   ├── domain/_TEMPLATE.md          ← Domain rules / test data template
│   └── <name>/SKILL.md              ← Process/technique skills
├── scripts/                         ← Jira/TestRail/Tempo clients, CDP browser, agents, publishing
├── artifacts/                       ← gitignored: screenshots, logs
├── evidence/                        ← gitignored: per-ticket evidence
├── workspace/                       ← gitignored: local scratch/evidence exports
├── AGENTS.md                        ← Agent rules + evidence standard
├── CONTEXT.md                       ← Project context (read first)
├── CONNECTIONS.md                   ← Inventory of all connections / env vars
├── .env.example                     ← Environment variables template
└── package.json
```

---

## Ticket Flow — Status Map (adapt to your board)

```
Ready for Testing
  → In Testing          (only when publishing a conclusive PASS/FAIL)
  → Performance Test    (PASS)
  → In Acceptance       (PASS + label: cae-perf)
  → In Progress         (FAIL)
```
An INCONCLUSIVE result is local-only: no Jira evidence upload, comment, status transition, or
bug-pipeline sync.

## Bug Title Format

```
{Environment} | {Section} | {minimal description}
Example: QA | Inventory | User cannot select any item
```

---

## Environment Variables

Full list with groups and comments: `.env.example`. Per-connection detail: `CONNECTIONS.md`.

| Variable | Description |
|----------|-------------|
| `JIRA_BASE_URL` | `https://jira.example.com` |
| `JIRA_USER` | Your Jira user / email |
| `JIRA_TOKEN` | Personal Access Token from Jira |
| `JIRA_PROJECT` | `<jira project key>` |
| `APP_URL_QA` | `https://your-app-qa.example.com` |
| `APP_URL_DEV` | DEV URL for discovery-first runs (optional) |
| `DEV_FIRST_DISCOVERY` | `true` to run DEV discovery first, then QA publish |
| `APP_URL_LEGACY` | Legacy app URL for parity mode (optional) |
| `LEGACY_ORACLE` | `true` to require legacy oracle parity evidence |
| `MANUAL_LOGIN` | `true` to pause for manual sign-in in the shared Edge tab |
| `MANUAL_LOGIN_TIMEOUT_SEC` | Seconds to wait for manual login (default `240`) |
| `ORACLE_DOCS_DIR` | Optional docs folder used as grounded behavior source |
| `RESEARCH_WIKI_DOCS_DIR` | Optional external research wiki docs folder |
| `LEGACY_FLOW_MAP_FILE` | Optional JSON map: legacy flow → new-app equivalent steps by ticket |
| `SECTION_FLOW_MAP_FILE` | Optional JSON map: section/flow guides auto-matched by ticket summary + AC text |
| `TESTRAIL_CASES_FILE` | Optional JSON corpus of legacy TestRail cases for auto-match by ticket title/AC |
| `TESTRAIL_MATCH_MIN_SCORE` | Minimum similarity score to accept an auto-matched TestRail case |
| `CDP_ENDPOINT` | `http://localhost:9222` |
| `QA_USER_EMAIL` | Run account email for SSO |
| `QA_OWNER_NAME` | Reviewer name in the AI-attribution footer |
