/**
 * SmartLearn Auth Manager
 * Handles automated SSO login to https://smartlearn.example.com using a dedicated
 * QA/service account (NOT a personal employee account — see
 * skills/smartlearn-product-config/SKILL.md "Auth automation").
 *
 * Uses TOTP (otpauth, Base32 secret) to answer the MFA challenge automatically instead
 * of a human typing a code — mirrors the exact pattern used for the app under test in
 * scripts/auth-manager.ts, and the one used by typical Playwright/C#
 * automation repos (UserTOTPAuthenticable / OTPVerificationPage).
 *
 * Credentials are loaded from environment variables and must never be stored in this
 * repository. Auth state (storageState) is cached for 8 hours to avoid repeated logins,
 * and the MFA "remember this device" checkbox is ticked so a fresh login (after the
 * cache expires) skips the OTP screen entirely for ~30 days on the same browser profile.
 */

import { chromium } from 'playwright';
import * as OTPAuth from 'otpauth';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

export const SMARTLEARN_AUTH_STATE_PATH = path.join(REPO_ROOT, '.auth', 'smartlearn.json');
const AUTH_MAX_AGE_MS = 8 * 60 * 60 * 1000; // 8 hours

const EDGE_PATH = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const SMARTLEARN_URL = process.env.SMARTLEARN_URL ?? 'https://smartlearn.example.com';

const SMARTLEARN_USER = process.env.SMARTLEARN_USER ?? '';
const SMARTLEARN_PASS = process.env.SMARTLEARN_PASS ?? '';
const SMARTLEARN_TOTP = process.env.SMARTLEARN_TOTP ?? '';

/** Generate a TOTP code from a Base32 secret (same helper as scripts/auth-manager.ts). */
export function generateTOTP(secret: string): string {
  const totp = new OTPAuth.TOTP({
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret.toUpperCase()),
  });
  return totp.generate();
}

/** Returns true if a valid (< 8h) SmartLearn auth state file exists. */
export function smartlearnAuthStateIsValid(): boolean {
  if (!fs.existsSync(SMARTLEARN_AUTH_STATE_PATH)) return false;
  const stat = fs.statSync(SMARTLEARN_AUTH_STATE_PATH);
  return (Date.now() - stat.mtimeMs) < AUTH_MAX_AGE_MS;
}

/**
 * Perform full SSO login to SmartLearn with the service account and save auth state.
 * Returns the path to the saved storageState JSON, for reuse via
 * `browser.newContext({ storageState: SMARTLEARN_AUTH_STATE_PATH })`.
 */
export async function authenticateSmartLearn(forceRefresh = false): Promise<string> {
  if (!SMARTLEARN_USER || !SMARTLEARN_PASS || !SMARTLEARN_TOTP) {
    throw new Error(
      '[SmartLearn Auth] Missing SMARTLEARN_USER / SMARTLEARN_PASS / SMARTLEARN_TOTP. ' +
      'Use a dedicated QA/service account (never a personal employee account) ' +
      'and retrieve its secrets from the approved secret manager.',
    );
  }

  if (!forceRefresh && smartlearnAuthStateIsValid()) {
    console.log('[SmartLearn Auth] Using cached auth state (< 8h old)');
    return SMARTLEARN_AUTH_STATE_PATH;
  }

  console.log('[SmartLearn Auth] Performing fresh SSO login...');
  console.log(`[SmartLearn Auth] User: ${SMARTLEARN_USER}`);

  fs.mkdirSync(path.dirname(SMARTLEARN_AUTH_STATE_PATH), { recursive: true });

  const browser = await chromium.launch({
    executablePath: EDGE_PATH,
    headless: false,
    args: ['--start-maximized', '--no-sandbox'],
  });

  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();

  try {
    console.log(`[SmartLearn Auth] Navigating to ${SMARTLEARN_URL}...`);
    await page.goto(SMARTLEARN_URL, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(2_000);

    // ── Step 1: "LOGIN WITH SSO" button ───────────────────────────────────────
    const ssoBtn = page.getByRole('button', { name: /LOGIN WITH SSO/i });
    if (await ssoBtn.isVisible({ timeout: 10_000 }).catch(() => false)) {
      console.log('[SmartLearn Auth] Clicking "LOGIN WITH SSO"...');
      // .click() can hang on this button (same class of overlay issue as the app under test) —
      // dispatch via DOM instead.
      await page.evaluate(() => {
        const btn = Array.from(document.querySelectorAll('button'))
          .find(b => /LOGIN WITH SSO/i.test(b.textContent ?? ''));
        (btn as HTMLButtonElement | undefined)?.click();
      });
      await page.waitForTimeout(2_000);
    }

    await page.waitForURL(/(login\.microsoftonline|b2clogin)\.com/, { timeout: 25_000 })
      .catch(() => console.log('[SmartLearn Auth] No Microsoft login redirect detected — may already be signed in'));

    console.log(`[SmartLearn Auth] Login URL: ${page.url().slice(0, 90)}`);

    // ── Step 2: Email ──────────────────────────────────────────────────────────
    await page.waitForTimeout(2_000);
    const emailInput = page.locator(
      'input#email, input[name="signInName"], input[id="signInName"], input[type="email"], input[name="loginfmt"], #i0116'
    ).first();
    if (await emailInput.isVisible({ timeout: 10_000 }).catch(() => false)) {
      console.log(`[SmartLearn Auth] Entering email: ${SMARTLEARN_USER}`);
      await emailInput.fill(SMARTLEARN_USER);
      await page.waitForTimeout(500);
      const continueBtn = page.getByRole('button', { name: /Continue|Next/i }).first();
      if (await continueBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await continueBtn.click();
      } else {
        await page.keyboard.press('Enter');
      }
      await page.waitForTimeout(2_000);
    }

    // ── Step 3: Password ────────────────────────────────────────────────────────
    const passInput = page.locator('input#password, input[type="password"], input[name="passwd"], #i0118').first();
    if (await passInput.isVisible({ timeout: 10_000 }).catch(() => false)) {
      console.log('[SmartLearn Auth] Entering password...');
      await passInput.fill(SMARTLEARN_PASS);
      await page.waitForTimeout(500);
      const signInBtn = page.locator(
        'button#next, button:has-text("Sign in"), button:has-text("Continue"), input[id="idSIButton9"], button[type="submit"]'
      ).first();
      if (await signInBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await signInBtn.click();
      } else {
        await page.keyboard.press('Enter');
      }
      await page.waitForTimeout(3_000);
    }

    // ── Step 4: TOTP (Authenticator app code) ───────────────────────────────────
    const totpInput = page.getByRole('textbox', { name: /Enter your code/i }).or(
      page.locator('input#otpCode, input[name="otc"], input[placeholder*="code" i], input[autocomplete="one-time-code"]')
    ).first();
    if (await totpInput.isVisible({ timeout: 15_000 }).catch(() => false)) {
      const code = generateTOTP(SMARTLEARN_TOTP);
      console.log(`[SmartLearn Auth] Entering TOTP code: ${code}`);
      await totpInput.fill(code);
      await page.waitForTimeout(500);

      // Tick "remember this device" so future fresh logins (after the 8h cache expires)
      // skip MFA entirely for ~30 days on this browser profile.
      const rememberCheck = page.getByRole('checkbox', { name: /remember this device/i });
      if (await rememberCheck.isVisible({ timeout: 1_000 }).catch(() => false)) {
        if (!await rememberCheck.isChecked().catch(() => false)) await rememberCheck.check();
      }

      const verifyBtn = page.getByRole('button', { name: /Verify|Continue/i }).first();
      if (await verifyBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await verifyBtn.click();
      } else {
        await page.keyboard.press('Enter');
      }
      await page.waitForTimeout(3_000);
    } else {
      console.log('[SmartLearn Auth] No TOTP input found — device may already be remembered');
    }

    // ── Step 5: Wait for redirect back to SmartLearn (?sl_token=...) ───────────
    const appHostname = new URL(SMARTLEARN_URL).hostname;
    console.log('[SmartLearn Auth] Waiting for redirect back to SmartLearn...');
    await page.waitForURL(url => url.hostname === appHostname, { timeout: 60_000 });
    await page.waitForTimeout(2_000);
    console.log(`[SmartLearn Auth] ✅ Authenticated at: ${page.url()}`);

    // ── Step 6: Save state ───────────────────────────────────────────────────────
    await context.storageState({ path: SMARTLEARN_AUTH_STATE_PATH });
    console.log(`[SmartLearn Auth] ✅ Auth state saved to ${SMARTLEARN_AUTH_STATE_PATH}`);

    return SMARTLEARN_AUTH_STATE_PATH;
  } catch (err) {
    console.error('[SmartLearn Auth] Login failed:', err instanceof Error ? err.message : err);
    try { await page.screenshot({ path: '.auth/smartlearn-debug-error.png' }); } catch { /**/ }
    throw err;
  } finally {
    await page.close();
    await browser.close();
  }
}

// Run directly: npx tsx scripts/smartlearn-auth.ts [--force]
if (process.argv[1]?.endsWith('smartlearn-auth.ts') || process.argv[1]?.endsWith('smartlearn-auth.js')) {
  const force = process.argv.includes('--force');
  authenticateSmartLearn(force)
    .then(p => console.log(`\n✅ SmartLearn auth ready: ${p}`))
    .catch(err => { console.error(err); process.exit(1); });
}
