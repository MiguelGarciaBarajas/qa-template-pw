---
name: autonomous-agent
description: Validate ANY Jira ticket fully autonomously from the terminal — no Claude Code / Copilot needed. Brain = GitHub Models API, hands = Playwright/CDP, mouth = publish-result.
---

# Autonomous QA Agent — `scripts/agent-validate.ts`

A self-contained agent you run from the terminal. It reads a ticket's ACs, drives the real
browser, judges each criterion against what it observes, captures evidence, and posts a rich
verdict comment to Jira — **without any IDE assistant in the loop**.

```bash
npx tsx scripts/agent-validate.ts PROJ-1234 [--max-steps 30] [--no-transition] [--legacy-oracle] [--legacy-url https://<legacy-app>]
# or
npm run agent -- PROJ-1234
# with prechecks (recommended)
npm run agent:auto -- PROJ-1234
# higher budget mode (recommended for complex tickets)
npm run agent:pro -- PROJ-1234
```

## The three pieces

| Piece | What | File |
|-------|------|------|
| **Brain** | GitHub Models API (OpenAI-compatible) — reads ACs + live ARIA tree, decides actions, reaches a verdict | `agent-validate.ts` |
| **Hands** | Playwright over the shared Edge (CDP) — navigate/snapshot/click/fill/select/screenshot | `agent-browser.ts` |
| **Mouth** | attach evidence → post the rich comment → transition | `publish-result.ts` |

This is the difference from the MCP path: the MCP needs an LLM **client** (Claude Code /
Copilot) driving it. This agent carries its own brain (the GitHub Models API), so a plain
`npx tsx` command is fully autonomous.

## Prerequisites

1. **`GITHUB_TOKEN` in `.env`** — a GitHub Personal Access Token with the **`models: read`**
   permission (fine-grained token → Account permissions → Models → Read). Free tier; uses
   your GitHub account, not a paid Anthropic/OpenAI key.
   - Optional: `GITHUB_MODELS_CANDIDATES` (comma-separated, resolved before the run starts).
   - Optional: `GITHUB_MODELS_MODEL` (first candidate if `GITHUB_MODELS_CANDIDATES` is unset; defaults to `openai/gpt-4.1-mini`).
2. **Edge CDP up** at `http://localhost:9222` (`scripts/start-edge-cdp.bat`). Reuses the SSO session.
3. **Jira config** in `.env` (already set): `JIRA_BASE_URL`, `JIRA_USER`, `JIRA_TOKEN`, `JIRA_PROJECT`.
4. Recommended: run `npm run preflight` (or use `npm run agent:auto`) to fail early on missing CDP/env/account config. Preflight auto-starts CDP when possible.
5. Optional: set `GITHUB_MODELS_FALLBACK_MODEL` to keep a secondary candidate in the resolver list.
6. Optional legacy oracle mode:
   - `LEGACY_ORACLE=true`
   - `APP_URL_LEGACY=https://<legacy-app>`
   - or pass `--legacy-oracle --legacy-url ...` on demand.
7. Optional multi-environment strategy in `ticket-flow.ts`:
   - `DEV_FIRST_DISCOVERY=true`
   - `APP_URL_DEV=https://<dev-app>`
   - runs a DEV discovery pass (no Jira publish), then publishes QA validation.
8. Optional grounded oracle docs:
   - `ORACLE_DOCS_DIR=<path to docs>`
   - `RESEARCH_WIKI_DOCS_DIR=<path to external research wiki docs>`
   - agent will inject the most relevant excerpts into the validation prompt.
9. Optional section-aware flow guides:
   - `SECTION_FLOW_MAP_FILE=<path to section-flow-map.json>`
   - defaults to `wiki/docs/section-flow-map.json`
   - agent auto-matches ticket text to section guides (a map of ticket keywords → feature path/steps).
10. Optional manual sign-in mode:
   - `MANUAL_LOGIN=true`
   - `MANUAL_LOGIN_TIMEOUT_SEC=240` (or higher)
   - the run opens the app and waits for you to complete login manually in shared Edge before continuing.

## What it does

1. Fetches the ticket without changing Jira; status transitions are deferred until a conclusive
   PASS/FAIL verdict is ready to publish.
2. Opens the app (handles SSO once), then loops up to `--max-steps` (default 30):
   snapshot → act → screenshot the decisive state → check each AC (Expected vs Observed).
3. Calls `report_result` with the verdict + AC checks, then publishes:
   - **PASS** → forward transition · **FAIL** (real defect) → In Progress.
   - **INCONCLUSIVE** (couldn't confirm) → no Jira comment, evidence upload, transition, or
     bug-pipeline sync; report the blocker locally and leave the issue unchanged.
   - PASS/FAIL evidence (screenshots, network-error JSON), failing network calls, and console
     errors are attached + surfaced inline automatically.
4. On PASS, it auto-generates a reusable validator script in `scripts/validators/` for future unattended reruns.

## Cost & safety

- Each run makes several model calls — bounded by `--max-steps`. Start small (e.g. `--max-steps 20`).
- Use `--no-transition` to comment without moving the ticket while you tune it.
- QA only. Works in its own tab; never launches/closes the browser.

## When to use which

| Path | Use |
|------|-----|
| **`agent-validate.ts`** (this) | Default for any ticket, hands-off, from the terminal |
| `ticket-flow.ts` | Unattended regression for tickets with a codified `validators/*.ts` |
| Live via MCP + `post-validation.ts` | When you (Claude Code/Copilot) validate interactively |

All three publish through the same `publish-result.ts` pipeline, so the Jira output is identical.
