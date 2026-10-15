---
name: playwright-mcp
description: Drive the live app through the Playwright MCP (accessibility tree) for one-off / exploratory AC validation, instead of hand-writing brittle Playwright TS.
---

# Playwright MCP — Live UI Validation

Use this when you need to **validate ACs or explore the app interactively** and there
is no codified validator yet. The agent drives the browser through the Playwright MCP
server, reading the **accessibility snapshot** (structured text) rather than guessing
DOM selectors or relying on screenshots.

## When to use this vs a codified validator

| Situation | Use |
|-----------|-----|
| First-pass validation of a new ticket / one-off AC | **Playwright MCP** (this skill) |
| Exploratory bug hunting | **Playwright MCP** |
| A scenario that repeats every release (regression) | Codify a validator with a page object under `scripts/pages/` for your product |

Rule of thumb: **explore with the MCP, codify what repeats.** Once an MCP session
proves out a stable flow worth re-running, move it into a `scripts/validators/*.ts`
file built on your page object so it runs unattended via `ticket-flow.ts`.

## Why the MCP, not more hand-written TS

The agent struggled with UI testing because every ticket needed a bespoke ~1000-line
Playwright file with text/`nth()` selectors written **blind, before seeing the page**.
The MCP flips that: navigate → snapshot → act on what's actually there. Far fewer
wrong-selector failures.

## Preconditions

1. Shared Edge CDP must be running at `http://localhost:9222`
   (see `skills/shared-browser/SKILL.md`). If not: run `scripts/start-edge-cdp.bat`.
2. The MCP server is configured to **connect to that existing Edge over CDP**
   (`--cdp-endpoint http://localhost:9222`), so it **reuses the QA owner's authenticated SSO
   session** — it does NOT launch a fresh browser. Config lives in:
   - `.mcp.json` (Claude Code)
   - `.vscode/mcp.json` (GitHub Copilot in VS Code)

## Core tools

| Tool | Use |
|------|-----|
| `browser_navigate` | Go to a URL (e.g. `https://your-app-qa.example.com/<route>`) |
| `browser_snapshot` | Get the accessibility tree — **read this before acting** |
| `browser_click` / `browser_type` / `browser_select_option` | Interact, referencing snapshot elements |
| `browser_wait_for` | Wait for text/state to appear (SPA + MSAL are slow) |
| `browser_take_screenshot` | Capture evidence → save into `artifacts/` |
| `browser_console_messages` | Collect JS console errors for the comment |
| `browser_network_requests` | Inspect HTTP (e.g. confirm Save returned 200) |
| `browser_tabs` | Open your own tab; never drive the user's active tab |

## Validation workflow

1. Verify CDP is up; navigate to the target app page (handle SSO per `shared-browser`).
2. `browser_snapshot` → read the actual page structure.
3. Drive the flow step by step, snapshotting after each meaningful action.
4. For each AC, record **Expected vs Observed** and a `pass/fail` (this maps directly
   to the `acChecks` rows in the Jira comment).
5. Capture evidence: screenshot(s) to `artifacts/`, console errors, key network calls.
6. Be honest about coverage — note any AC you could NOT validate (→ `notValidated`).
7. Report the verdict so it can be written into Jira via the ticket-flow comment
   builders (`buildPassComment` / `buildFailComment`). Never hand-format the comment;
   fill the structured `ValidationResult` fields.

## Known gotchas & workarounds

Recurring MCP issues on the shared Edge and how to get past them:

- **`browser_click` hangs / times out** → use `browser_run_code_unsafe` with a DOM click:
  `page.evaluate(() => document.querySelector(sel)?.click())`. This bypasses overlays/inert.
  `.fill()` / typing on textboxes works fine.
- **Background-tab throttling** (options render 0-height, screenshots blank) → `await page.bringToFront()`
  first; for stubborn virtualized Selects, attach a CDP session and
  `Emulation.setFocusEmulationEnabled(true)` + `Page.setWebLifecycleState('active')`.
- **Async search boxes ignore programmatic value** (context/store switcher, lookups, autocomplete) →
  set `input.value` + `input` event is NOT enough; type with **real keystrokes**
  (`page.keyboard.type(text, {delay: 90})`) so the debounced fetch fires.
- **React-controlled inputs** → set the value via the native setter so React sees it:
  `Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype,'value').set.call(el, val)`
  then dispatch `input`+`change`.
- **Identity / context check** → the auth token lives in `sessionStorage`/`localStorage` (key
  usually contains `idtoken`/`msal`); the active tenant/store context is a `localStorage` key —
  record the key name for your product in the feature guide.
- **Switching account / tenant** → see `skills/shared-browser` → "Switching account / tenant".

## Rules (same as shared-browser)

- Reuse the shared Edge session; **never launch a new browser** and **never close it**.
- Open and work in your own tab; don't navigate the user's existing tabs.
- Screenshots go to `artifacts/` (gitignored) — never commit evidence.
- Don't test Production unless explicitly told.
