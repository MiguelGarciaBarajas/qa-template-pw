/**
 * Authenticated Browser
 * Launches a dedicated Edge instance with the automation account's auth state.
 * This bypasses the Azure AD / MSAL token refresh issue that occurs when using
 * the QA owner's CDP session — the automation account owns its own browser context
 * with fresh, valid tokens.
 *
 * Usage:
 *   const session = await getAuthenticatedPage('https://your-app-qa.example.com/record/create');
 *   // ... use session.page ...
 *   await session.close();
 */

import { chromium, type Browser, type BrowserContext, type Page } from 'playwright';
import { authenticate } from './auth-manager.js';
import 'dotenv/config';

const EDGE_PATH  = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const APP_URL_QA = process.env.APP_URL_QA ?? 'https://your-app-qa.example.com';

export interface AuthBrowserSession {
  browser: Browser;
  context: BrowserContext;
  page: Page;
  close: () => Promise<void>;
}

/**
 * Launch a fresh Edge browser with the automation account's stored auth state,
 * optionally navigating to a target URL.
 *
 * The stored auth tokens (cookies + localStorage MSAL tokens) ensure that
 * navigation to any app URL does NOT trigger Azure AD re-initialization.
 */
export async function getAuthenticatedPage(targetUrl?: string): Promise<AuthBrowserSession> {
  // Ensure auth state is fresh (will prompt login if expired or missing)
  const statePath = await authenticate();

  const browser = await chromium.launch({
    executablePath: EDGE_PATH,
    headless: false,
    args: [
      '--start-maximized',
      '--disable-extensions',
      '--disable-popup-blocking',
    ],
  });

  const context = await browser.newContext({
    storageState: statePath,
    viewport: null,
  });

  const page = await context.newPage();

  if (targetUrl) {
    const appHostname = new URL(APP_URL_QA).hostname;
    console.log(`[AuthBrowser] Navigating to ${targetUrl}...`);
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 60_000 });

    // If MSAL kicks in (rare but possible if tokens partially expired)
    const afterNav = page.url();
    if (!afterNav.includes(appHostname)) {
      console.log('[AuthBrowser] Unexpected redirect — waiting to return to app...');
      await page.waitForURL(`**${appHostname}**`, { timeout: 60_000 });
    }

    // Wait for app to finish initializing
    await page.waitForFunction(
      () => !document.body?.innerText?.includes('Initializing authentication'),
      { timeout: 30_000, polling: 1000 }
    ).catch(() => console.log('[AuthBrowser] App still initializing — proceeding anyway'));

    console.log(`[AuthBrowser] Ready at: ${page.url()}`);
  }

  const close = async () => {
    try { await page.close(); } catch { /**/ }
    try { await context.close(); } catch { /**/ }
    try { await browser.close(); } catch { /**/ }
    console.log('[AuthBrowser] Browser closed.');
  };

  return { browser, context, page, close };
}
