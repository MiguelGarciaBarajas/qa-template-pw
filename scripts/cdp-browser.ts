/**
 * CDP Browser Helper
 * Connects to the shared Edge instance via Chrome DevTools Protocol.
 * Agents MUST use this instead of launching their own browser.
 */

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import 'dotenv/config';
import * as OTPAuth from 'otpauth';
import { inferAudience, type AuthAudience, SSO_EMPLOYEE_BUTTON_RE, SSO_EXTERNAL_BUTTON_RE, SSO_EMPLOYEE_BUTTON_TEXT, SSO_EXTERNAL_BUTTON_TEXT } from './run-account.js';

const CDP_ENDPOINT = process.env.CDP_ENDPOINT ?? 'http://localhost:9222';
const APP_URL_QA   = process.env.APP_URL_QA ?? 'https://your-app-qa.example.com';
const APP_HOSTNAME = new URL(APP_URL_QA).hostname;
const MANUAL_LOGIN = /^(1|true|yes)$/i.test(process.env.MANUAL_LOGIN ?? 'false');
const MANUAL_LOGIN_TIMEOUT_SEC = Number(process.env.MANUAL_LOGIN_TIMEOUT_SEC ?? '240') || 240;

export interface BrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  usedExistingTab: boolean;
}

export interface NavigateAuthOptions {
  email?: string;
  password?: string;
  totpSecret?: string;
  audience?: AuthAudience;
}

/** Verify the shared Edge CDP is available */
export async function verifyCDP(): Promise<boolean> {
  try {
    const res = await fetch(`${CDP_ENDPOINT}/json/version`);
    if (!res.ok) return false;
    const version = await res.json() as { Browser: string };
    console.log(`[CDP] Ready: ${version.Browser}`);
    return true;
  } catch {
    return false;
  }
}

/**
 * Connect to the shared Edge browser via CDP.
 * Prefers reusing an existing authenticated app tab to avoid Azure AD token
 * refresh issues with fresh tabs. Falls back to creating a new tab if none found.
 */
export async function connectBrowser(): Promise<BrowserSession> {
  const ready = await verifyCDP();
  if (!ready) {
    throw new Error(
      `[CDP] Not available at ${CDP_ENDPOINT}.\n` +
      'Run scripts/start-edge-cdp.bat to launch Edge with remote debugging.'
    );
  }

  const browser = await chromium.connectOverCDP(CDP_ENDPOINT);
  const context = browser.contexts()[0];
  if (!context) throw new Error('[CDP] No browser context found.');

  // Prefer an existing authenticated app tab (avoids Azure AD token refresh issues)
  // Use URL hostname parsing — NOT string includes — to avoid false-matching B2C tabs
  // that contain the app hostname as a redirect_uri query param.
  const pages = context.pages();
  const existingTab = pages.find(p => {
    try { return new URL(p.url()).hostname === APP_HOSTNAME; } catch { return false; }
  });

  if (existingTab) {
    await closeExtraBlankTabs(context, existingTab);
    console.log(`[CDP] Reusing existing tab: ${existingTab.url().slice(0, 80)}`);
    await existingTab.bringToFront();
    return { browser, context, page: existingTab, usedExistingTab: true };
  }

  // No existing app tab — reuse a blank tab before creating a new one.
  const reusableBlank = pages.find(isBlankTab);
  if (reusableBlank) {
    await closeExtraBlankTabs(context, reusableBlank);
    await reusableBlank.bringToFront();
    console.log('[CDP] Reusing about:blank tab for this run.');
    return { browser, context, page: reusableBlank, usedExistingTab: false };
  }

  const page = await context.newPage();
  console.log('[CDP] Connected — new tab created.');
  return { browser, context, page, usedExistingTab: false };
}

/**
 * Navigate to a URL and handle the app's SSO flow if needed.
 * Also handles Azure AD silent token refresh that occurs after page load.
 */
export async function navigateWithAuth(page: Page, url: string, options: NavigateAuthOptions = {}): Promise<void> {
  const audience = options.audience ?? inferAudience(options.email ?? process.env.QA_USER_EMAIL ?? '');
  const email = (options.email ?? process.env.QA_USER_EMAIL ?? '').trim();
  const password = (options.password ?? process.env.QA_USER_PASS ?? process.env.AUTO_PASS ?? '').trim();
  const totpSecret = (options.totpSecret ?? process.env.QA_USER_TOTP ?? process.env.AUTO_TOTP ?? '').trim();

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });

  if (MANUAL_LOGIN) {
    if (await isAuthenticatedAppState(page)) {
      console.log('[Auth] MANUAL_LOGIN enabled, but session is already authenticated — skipping manual auth wait.');
      return;
    }
    await waitForManualAuth(page);
    console.log(`[Auth] Authenticated at: ${page.url()}`);
    return;
  }

  const employeeBtn = page.getByRole('button', { name: SSO_EMPLOYEE_BUTTON_RE });
  const externalBtn = page.getByRole('button', { name: SSO_EXTERNAL_BUTTON_RE });
  if ((await employeeBtn.isVisible({ timeout: 3_000 }).catch(() => false)) ||
      (await externalBtn.isVisible({ timeout: 1_000 }).catch(() => false))) {
    if (audience === 'external') {
      if (!await externalBtn.isVisible({ timeout: 1_000 }).catch(() => false)) {
        throw new Error(`[Auth] "${SSO_EXTERNAL_BUTTON_TEXT}" button is not visible, cannot continue external login.`);
      }
      console.log(`[Auth] Clicking "${SSO_EXTERNAL_BUTTON_TEXT}"...`);
      await externalBtn.click();
    } else {
      if (!await employeeBtn.isVisible({ timeout: 1_000 }).catch(() => false)) {
        throw new Error(`[Auth] "${SSO_EMPLOYEE_BUTTON_TEXT}" button is not visible, cannot continue employee login.`);
      }
      console.log(`[Auth] Clicking "${SSO_EMPLOYEE_BUTTON_TEXT}"...`);
      await employeeBtn.click();
    }
    await page.waitForTimeout(2_000);
  }

  await settleAuthState(page, { audience, email, password, totpSecret });

  console.log(`[Auth] Authenticated at: ${page.url()}`);
}

/**
 * Navigate to a page in the app under test without the 30-90s MSAL re-init delay.
 *
 * Strategy:
 *   1. If NOT on the app: go to app home via navigateWithAuth() so MSAL refreshes tokens ONCE.
 *   2. Wait for MSAL to fully finish (no "Initializing authentication" text).
 *   3. For in-app sub-routes: use client-side navigation (pushState) to avoid triggering
 *      a MSAL re-auth redirect that happens with page.goto() on MSAL-protected routes.
 *
 * If already on the app: go directly to step 2 (skip home navigation).
 */
export async function spaNavigate(page: Page, url: string): Promise<void> {
  const targetPath = url.startsWith('http') ? new URL(url).pathname : url;

  const isOnApp = (() => {
    try { return new URL(page.url()).hostname === APP_HOSTNAME; } catch { return false; }
  })();

  if (!isOnApp) {
    // Not on the app — navigate to home first so MSAL refreshes tokens
    console.log('[SPA] Navigating to app home — MSAL will refresh tokens here...');
    await navigateWithAuth(page, APP_URL_QA);
  }

  // Wait for MSAL to fully finish — can take up to 90 seconds on first navigation
  console.log('[SPA] Waiting for MSAL to complete (up to 90s)...');
  await page.waitForFunction(
    () => {
      const text = document.body?.innerText ?? '';
      return !text.includes('Initializing authentication') && text.trim().length > 10;
    },
    { timeout: 90_000, polling: 1_000 }
  ).catch(() => console.log('[SPA] MSAL 90s timeout — proceeding'));

  await page.waitForTimeout(800);

  // Check if we already are at the target path
  const currentPath = (() => {
    try { return new URL(page.url()).pathname; } catch { return ''; }
  })();

  if (currentPath === targetPath) {
    console.log(`[SPA] Already at ${targetPath}`);
    return;
  }

  // Use client-side SPA navigation (pushState) to avoid triggering MSAL re-auth.
  // page.goto() causes a full reload which MSAL intercepts and redirects to B2C even
  // when tokens are fresh. pushState + popstate keeps MSAL tokens intact and lets
  // the React Router handle the route change without a page reload.
  console.log(`[SPA] Client-side navigate to ${targetPath} (avoids MSAL reload)...`);
  const navigated = await page.evaluate((path) => {
    try {
      window.history.pushState({}, '', path);
      window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
      return true;
    } catch {
      return false;
    }
  }, targetPath);

  if (!navigated) {
    // Fallback: use goto only if pushState failed
    console.warn('[SPA] pushState failed — falling back to page.goto (may trigger MSAL re-auth)...');
    const targetUrl = `${APP_URL_QA}${targetPath}`;
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 30_000 });
  }

  // Wait for any brief MSAL init to complete
  await page.waitForFunction(
    () => !document.body?.innerText?.includes('Initializing authentication'),
    { timeout: 15_000, polling: 500 }
  ).catch(() => {});

  await page.waitForTimeout(800);

  // If MSAL redirected us to B2C despite pushState, recover via navigateWithAuth
  const finalHost = (() => {
    try { return new URL(page.url()).hostname; } catch { return ''; }
  })();
  if (finalHost !== APP_HOSTNAME) {
    console.warn(`[SPA] Ended up outside app after navigation (${page.url().slice(0, 80)}). Recovering via auth...`);
    await navigateWithAuth(page, `${APP_URL_QA}${targetPath}`);
    await page.waitForTimeout(800);
  }

  console.log(`[SPA] Ready at: ${page.url()}`);
}

/**
 * Disconnect from the shared browser.
 * Only disconnects — does NOT close Edge.
 * If we reused an existing user tab, we do NOT close it.
 */
export async function disconnectBrowser(session: BrowserSession): Promise<void> {
  if (!session.usedExistingTab) {
    await session.page.close();
  }
  await session.browser.close(); // disconnects only
  console.log('[CDP] Disconnected — Edge remains open.');
}

interface InteractiveLoginArgs {
  audience: AuthAudience;
  email: string;
  password: string;
  totpSecret: string;
}

async function completeInteractiveLogin(page: Page, args: InteractiveLoginArgs): Promise<void> {
  const { audience, email, password, totpSecret } = args;
  if (!email) {
    throw new Error('[Auth] Missing login email for interactive auth flow.');
  }

  const emailInput = page.locator(
    'input#email, input[name="signInName"], input[id="signInName"], input[type="email"], input[name="loginfmt"], #i0116'
  ).first();
  if (await emailInput.isVisible({ timeout: 10_000 }).catch(() => false)) {
    console.log(`[Auth] Entering email for ${audience} flow: ${email}`);
    await emailInput.fill(email);
    await clickPrimaryContinue(page);
    await page.waitForTimeout(1_000);
  }

  const passInput = page.locator('input#password, input[type="password"], input[name="passwd"], #i0118').first();
  if (await passInput.isVisible({ timeout: 10_000 }).catch(() => false)) {
    if (!password) throw new Error('[Auth] Password is required but not configured for interactive auth flow.');
    console.log('[Auth] Entering password...');
    await passInput.fill(password);
    await clickPrimaryContinue(page);
    await page.waitForTimeout(1_500);
  }

  const totpInput = page.locator(
    'input#otpCode, input[name="otc"], input[id="otc"], input[id="idTxtBx_SAOTCC_OTC"], input[placeholder*="code" i], input[autocomplete="one-time-code"]'
  ).first();
  if (await totpInput.isVisible({ timeout: 10_000 }).catch(() => false)) {
    if (!totpSecret) throw new Error('[Auth] TOTP is required but no secret key is configured.');
    const code = generateTOTP(totpSecret);
    console.log(`[Auth] Entering TOTP code (${code.slice(0, 2)}****)...`);
    await totpInput.fill(code);
    const rememberCheck = page.locator('input#rememberDeviceInformation_True');
    if (await rememberCheck.isVisible({ timeout: 1_000 }).catch(() => false) && !await rememberCheck.isChecked()) {
      await rememberCheck.check().catch(() => {});
    }
    await clickPrimaryContinue(page);
    await page.waitForTimeout(1_500);
  }

  const staySignedIn = page.locator('#idSIButton9, input[value="Yes"], button:has-text("Yes")').first();
  if (await staySignedIn.isVisible({ timeout: 5_000 }).catch(() => false)) {
    console.log('[Auth] Confirming stay signed in...');
    await staySignedIn.click();
  }

  await waitForAppHost(page);
}

function generateTOTP(secret: string): string {
  const totp = new OTPAuth.TOTP({
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret.toUpperCase()),
  });
  return totp.generate();
}

async function clickPrimaryContinue(page: Page): Promise<void> {
  const btn = page.locator(
    'button#continue, button#next, button[id="next"], button:has-text("Next"), button:has-text("Continue"), button:has-text("Sign in"), button:has-text("Verify"), input[type="submit"][value*="Next"], input[type="submit"][value*="Sign in"], input[id="idSIButton9"], button[type="submit"]'
  ).first();
  if (await btn.isVisible({ timeout: 2_000 }).catch(() => false)) {
    await btn.click();
    return;
  }
  await page.keyboard.press('Enter');
}

async function waitForAppHost(page: Page): Promise<void> {
  await page.waitForURL(
    current => current.hostname === APP_HOSTNAME,
    { timeout: 60_000 },
  );
}

function safeHostname(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return '';
  }
}

async function settleAuthState(page: Page, args: InteractiveLoginArgs): Promise<void> {
  let waited = 0;
  while (waited < 45_000) {
    const currentHost = safeHostname(page.url());
    if (currentHost.includes('microsoftonline.com') || currentHost.includes('b2clogin.com')) {
      console.log('[Auth] Interactive login detected — completing email/password/TOTP flow...');
      await completeInteractiveLogin(page, args);
      continue;
    }

    if (currentHost === APP_HOSTNAME) {
      if (!await hasAuthUi(page)) {
        return;
      }
      // App host can still render the unauthenticated chooser while redirects settle.
      await page.waitForTimeout(1_000);
      waited += 1_000;
      continue;
    }

    await page.waitForTimeout(1_000);
    waited += 1_000;
  }

  const host = safeHostname(page.url());
  if (host !== APP_HOSTNAME) {
    throw new Error(`[Auth] Login did not return to app host (${APP_HOSTNAME}). Current URL: ${page.url()}`);
  }
  throw new Error('[Auth] Still on unauthenticated sign-in UI after auth flow; Continue/Sign in may not have completed.');
}

async function hasAuthUi(page: Page): Promise<boolean> {
  const selectors = [
    `button:has-text("${SSO_EMPLOYEE_BUTTON_TEXT.replace(/"/g, '\\"')}")`,
    `button:has-text("${SSO_EXTERNAL_BUTTON_TEXT.replace(/"/g, '\\"')}")`,
    'input#email',
    'input#password',
    'input#otpCode',
    'input[name="signInName"]',
  ];
  for (const selector of selectors) {
    if (await page.locator(selector).first().isVisible({ timeout: 250 }).catch(() => false)) {
      return true;
    }
  }
  return false;
}

async function waitForManualAuth(page: Page): Promise<void> {
  const timeoutMs = MANUAL_LOGIN_TIMEOUT_SEC * 1000;
  const started = Date.now();
  console.log(
    `[Auth] MANUAL_LOGIN enabled. Complete sign-in manually in the opened Edge tab (timeout ${MANUAL_LOGIN_TIMEOUT_SEC}s).`,
  );

  while (Date.now() - started < timeoutMs) {
    if (await isAuthenticatedAppState(page)) {
      return;
    }
    await page.waitForTimeout(1_000);
  }

  throw new Error(
    `[Auth] Manual login timed out after ${MANUAL_LOGIN_TIMEOUT_SEC}s. ` +
    'Enable a longer wait with MANUAL_LOGIN_TIMEOUT_SEC=300 (or higher) if needed.',
  );
}

async function isAuthenticatedAppState(page: Page): Promise<boolean> {
  const host = safeHostname(page.url());
  if (host !== APP_HOSTNAME) return false;
  if (await hasAuthUi(page)) return false;

  const text = await page.locator('body').innerText().catch(() => '');
  if (text.includes('Initializing authentication')) return false;
  return text.trim().length > 20;
}

function isBlankTab(page: Page): boolean {
  const url = page.url().trim();
  return !url || url === 'about:blank';
}

async function closeExtraBlankTabs(context: BrowserContext, keep: Page): Promise<void> {
  const pages = context.pages();
  for (const page of pages) {
    if (page === keep) continue;
    if (!isBlankTab(page)) continue;
    await page.close().catch(() => {});
  }
}
