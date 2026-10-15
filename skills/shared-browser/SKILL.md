---
name: shared-browser
description: Shared Edge browser management via CDP. Connect to port 9222 before any browser work.
---

# Shared Browser (CDP) — QA Brain

All testing agents connect to a shared Microsoft Edge instance via CDP (port 9222).
**Never launch a new browser.** Always connect to the existing instance.

## Before any browser interaction

1. Verify CDP is available:
   ```powershell
   Invoke-RestMethod -Uri "http://localhost:9222/json/version" -TimeoutSec 5
   ```
   If it fails: run `npm run cdp:start` (or `scripts/start-edge-cdp.bat`).

2. Connect from scripts:
   ```typescript
   import { connectBrowser, navigateWithAuth, disconnectBrowser } from './cdp-browser.js';
   const session = await connectBrowser();
   await navigateWithAuth(session.page, 'https://your-app-qa.example.com');
   // ... do work ...
   await disconnectBrowser(session);
   ```

Use `npm run preflight` before runs to verify CDP + env + run-account resolution.
If CDP is down, preflight auto-starts Edge CDP with a dedicated profile.

## Login hook (per product)

Login is product-specific. `navigateWithAuth` in `scripts/cdp-browser.ts` is the single hook: it must
(1) detect the app's login UI, (2) drive it, and (3) wait until the URL is back on the app host,
failing fast with a clear error if that never happens.

Document your product's login here as you learn it:

| Item | Value (fill in) |
|------|-----------------|
| App base URL (QA) | `https://your-app-qa.example.com` |
| Identity provider | _SSO / B2C / OIDC / form login_ |
| Login entry (button/route) | _e.g. "Sign In" button → IdP_ |
| Page sequence | _email → password → MFA chooser → OTP → app_ |
| "Authenticated" signal | _element / URL / storage key that proves a live session_ |
| Env vars | `QA_USER_EMAIL`, `QA_USER_PASS`, `QA_USER_TOTP` (see `wiki/docs/test-accounts.md`) |

Rules of thumb:
- **Verify `hasAuthUi()`-style detection against the real login page.** If the login UI changes, a
  stale detector can falsely report "Authenticated" while the page still shows the login button —
  assert on a post-login element, not on the absence of the old login UI.
- SSO accounts: enter the email and let the cached IdP session complete the login (no password).
  Username/password accounts: fill email/password, pick the authenticator method if a chooser
  appears, then fill the live TOTP generated in memory from `QA_USER_TOTP`.
- Set `MANUAL_LOGIN=false` in the run env for automated login (`true` short-circuits it and the
  script just waits for a human). **Reading `.env` directly is blocked**; let the tsx scripts load it
  via dotenv, or pass values inline.
- Credentials are never stored in this repo — see `wiki/docs/test-accounts.md`.

> ⚠️ **Don't kill Edge on disconnect:** `disconnectBrowser`/`page.close()` on a fresh tab that is the
> browser's **last** tab closes Edge entirely. When your run creates its own tab, open a keepalive
> `about:blank` tab (`context.newPage()`) before `browser.close()`.

> ⏱ **5-minute idle logout:** sessions can be signed out after ~5 min idle. Before a long flow,
> confirm you are still authenticated (post-login element present) and re-run the login hook if not.

## Direct-navigation / deep-link auth

Verify early whether an authenticated user doing a **full-page load** of a protected deep link
(`page.goto(APP + route)`) lands directly on the route with the session intact.

- **Silent SSO (OK):** a full load may briefly transit the IdP and redirect back to the app with **no
  login form** (token library re-acquiring tokens from the cached session).
- **Bug (FAIL):** the tab gets **stuck on a visible IdP login form** — forced interactive re-auth.

A fresh tab can authenticate silently: `context.newPage()` → `goto` the app root once to seed tokens →
`goto` the deep link. **Wait for the silent flow to settle** before asserting: poll until the URL is
back on the app host AND the body text is not an "initializing/redirecting" placeholder AND it holds
stable ~3s. Guard **every** `page.evaluate` against *"Execution context was destroyed"* thrown
mid-redirect (try/catch → default).

Validation recipe:
1. New tab → `goto` app root → wait-settled → confirm auth tokens exist in storage and **no login form**.
2. For each protected route, `page.goto(APP + route)` and record the redirect chain:
   ```typescript
   const hosts:string[]=[]; page.on("framenavigated", fr => { if (fr===page.mainFrame())
     try { hosts.push(new URL(fr.url()).host); } catch {} });
   ```
3. **PASS** = final URL is exactly the requested route, `hosts` contain **only** the app host, no
   interactive login form. **FAIL** = stuck on an IdP login form / never reaches the route. Detect the
   form by URL being a login host AND an `input[type=email]/[type=password]` present.

## Switching account / tenant on the shared Edge

Two different needs — pick the lighter one:

### A. Switch tenant / store / organization (same user, no re-login)

If the product has a context selector (store, tenant, org), use the app's own switcher. Notes:
- Search boxes backed by async queries need **real keystrokes** (MCP `browser_type`, or
  `page.keyboard.type(..., {delay:90})`) — setting `input.value` + firing `input` events does NOT
  trigger the search.
- The selected context usually persists in `localStorage`; it can keep the previous user's value
  after a user switch → `removeItem` + reload.
- Only elevated-role accounts can usually pick an arbitrary context; scoped users see only their own.
  Choose the account from the secure QA account catalog (`wiki/docs/test-accounts.md`).

### B. Switch to a different USER (force re-login)

The app "Logout" may only do a local logout — SSO can silently re-log the same user in. Follow these
steps **in order** or the old user comes back.

#### B.0 — Reliable teardown (do this FIRST, every time)

1. **Leaked tabs re-seed `localStorage`.** Any extra tab on the app origin re-writes the context key
   (and token keys) the instant you clear them. **Consolidate to ONE tab** before wiping: enumerate
   `context.pages()` and `page.close()` every app tab except the one you drive.
2. **`page.evaluate` storage-clears get swallowed by the reload.** Clear via **CDP** so it survives
   navigation:
   ```typescript
   const cdp = await page.context().newCDPSession(page);
   await cdp.send('Storage.clearDataForOrigin', {
     origin: 'https://your-app-qa.example.com',
     storageTypes: 'local_storage,indexeddb,service_workers,cache_storage',
   });
   ```
3. **Clear identity-provider cookies by exact `{name, domain}`.** Playwright's
   `clearCookies({domain})` filter is **exact-match**, so a dotted-domain filter misses host-only
   cookies. Read them all, then clear each IdP cookie by its exact name+domain:
   ```typescript
   const cookies = await page.context().cookies();
   for (const c of cookies.filter(k => k.domain.includes('<idp-domain>')))
     await page.context().clearCookies({ name: c.name, domain: c.domain });
   ```
   - **NEVER clear the corporate directory (employee SSO) cookies** — that is the QA owner's own
     cached corporate session; keeping it is *why* employee SSO needs no password.
4. (Optional but clean) hit the IdP logout URL with a `post_logout_redirect_uri` back to the app.
5. Reload the app → the IdP email / home-realm page appears.

#### B.1 — Switch TO an SSO employee account
Fast path, no password/TOTP (relies on the cached corporate session from B.0): type the configured
`QA_USER_EMAIL` on the email page → Continue → federated SSO returns to the app. Confirm the expected
identity and scope.

#### B.2 — Switch TO a username/password QA account
Full interactive login: email → Continue → password → MFA chooser (authenticator app) → code input →
Verify. Generate the TOTP from `QA_USER_TOTP` **immediately before** submitting (30s expiry); retrieve
the secret from the approved secret manager, never copy it into source or docs.

> **Determine a user's REAL role from the server, not from "Access Denied" alone.** Query the
> product's users/claims endpoint (document it in the feature guide) and read the admin flag and the
> assigned scope. The account-scoping table may become outdated — verify on every run.

> Any user switch logs the previous user out of the shared Edge. Only switch when a flow genuinely
> requires it (e.g. an admin-only area).

## Parallel agents on one Edge

All agents share ONE Edge and ONE `localStorage`. Never rely on "the active tab": give your tab a
unique `window.name` (set it right after `newPage()`) and find it again by that name. Never navigate
or close another agent's tab.

## Rules

- Connect via CDP `http://localhost:9222` — never launch Edge yourself
- Create your own tab with `context.newPage()` — don't navigate existing user tabs
- Close your tab when done: `page.close()`
- Never call `context.close()` — that destroys all tabs
- Never call `browser.terminate()` — `browser.close()` only disconnects (and never close the browser)

## CDP Quick Reference

| Item | Value |
|------|-------|
| CDP URL | `http://localhost:9222` |
| Tab list | `http://localhost:9222/json` |
| Version check | `http://localhost:9222/json/version` |
| Launch script | `scripts/start-edge-cdp.bat` |
