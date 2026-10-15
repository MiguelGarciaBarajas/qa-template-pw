/**
 * Auth Manager
 * Handles automated login to the app under test using the dedicated automation account.
 * Uses TOTP (speakeasy-compatible) to handle MFA automatically.
 *
 * Credentials are loaded from environment variables and must never be stored in this repository.
 * Auth state is cached for 8 hours to avoid repeated logins.
 */

import { chromium } from 'playwright';
import * as OTPAuth from 'otpauth';
import * as fs from 'fs';
import * as path from 'path';
import { fileURLToPath } from 'url';
import { inferAudience, SSO_EMPLOYEE_BUTTON_RE, SSO_EXTERNAL_BUTTON_RE, SSO_EMPLOYEE_BUTTON_TEXT, SSO_EXTERNAL_BUTTON_TEXT } from './run-account.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..');

export const AUTH_STATE_PATH = path.join(REPO_ROOT, '.auth', 'automation.json');
const AUTH_MAX_AGE_MS = 8 * 60 * 60 * 1000; // 8 hours

const EDGE_PATH  = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
const APP_URL_QA = process.env.APP_URL_QA ?? 'https://your-app-qa.example.com';

const AUTO_USER = process.env.AUTO_USER ?? '';
const AUTO_PASS = process.env.AUTO_PASS ?? '';
const AUTO_TOTP = process.env.AUTO_TOTP ?? '';
const AUTO_AUDIENCE = inferAudience(AUTO_USER);

/** Generate a TOTP code from a Base32 secret */
export function generateTOTP(secret: string): string {
  const totp = new OTPAuth.TOTP({
    algorithm: 'SHA1',
    digits: 6,
    period: 30,
    secret: OTPAuth.Secret.fromBase32(secret.toUpperCase()),
  });
  return totp.generate();
}

/** Returns true if a valid (< 8h) auth state file exists */
export function authStateIsValid(): boolean {
  if (!fs.existsSync(AUTH_STATE_PATH)) return false;
  const stat = fs.statSync(AUTH_STATE_PATH);
  return (Date.now() - stat.mtimeMs) < AUTH_MAX_AGE_MS;
}

/**
 * Perform full login with the automation account and save auth state.
 * Returns the path to the saved auth state JSON.
 */
export async function authenticate(forceRefresh = false): Promise<string> {
  if (!AUTO_USER) {
    throw new Error('[Auth] Missing AUTO_USER. Configure credentials through the approved secret manager.');
  }
  if (AUTO_AUDIENCE === 'external' && (!AUTO_PASS || !AUTO_TOTP)) {
    throw new Error('[Auth] External (non-employee) login requires AUTO_PASS and AUTO_TOTP.');
  }

  if (!forceRefresh && authStateIsValid()) {
    console.log('[Auth] Using cached auth state (< 8h old)');
    return AUTH_STATE_PATH;
  }

  console.log('[Auth] Performing fresh login with automation account...');
  console.log(`[Auth] User: ${AUTO_USER} (${AUTO_AUDIENCE})`);

  // Ensure .auth directory exists
  fs.mkdirSync(path.dirname(AUTH_STATE_PATH), { recursive: true });

  const browser = await chromium.launch({
    executablePath: EDGE_PATH,
    headless: false,
    args: ['--start-maximized', '--no-sandbox'],
  });

  const context = await browser.newContext({ viewport: null });
  const page = await context.newPage();

  try {
    console.log(`[Auth] Navigating to ${APP_URL_QA}...`);
    await page.goto(APP_URL_QA, { waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(2_000);

    // ── Step 1: Sign-in chooser ───────────────────────────────────────────────
    const employeeBtn = page.getByRole('button', { name: SSO_EMPLOYEE_BUTTON_RE });
    const externalBtn = page.getByRole('button', { name: SSO_EXTERNAL_BUTTON_RE });
    if ((await employeeBtn.isVisible({ timeout: 5_000 }).catch(() => false)) ||
        (await externalBtn.isVisible({ timeout: 1_000 }).catch(() => false))) {
      if (AUTO_AUDIENCE === 'external') {
        if (!await externalBtn.isVisible({ timeout: 1_000 }).catch(() => false)) {
          throw new Error(`[Auth] "${SSO_EXTERNAL_BUTTON_TEXT}" button is not visible for an external account.`);
        }
        console.log(`[Auth] Clicking "${SSO_EXTERNAL_BUTTON_TEXT}"...`);
        await externalBtn.click();
      } else {
        if (!await employeeBtn.isVisible({ timeout: 1_000 }).catch(() => false)) {
          throw new Error(`[Auth] "${SSO_EMPLOYEE_BUTTON_TEXT}" button is not visible for an employee account.`);
        }
        console.log(`[Auth] Clicking "${SSO_EMPLOYEE_BUTTON_TEXT}"...`);
        await employeeBtn.click();
      }
      await page.waitForTimeout(2_000);
    }

    // Wait to land on a Microsoft login page
    await page.waitForURL(/(login\.microsoftonline|b2clogin)\.com/, { timeout: 25_000 })
      .catch(() => console.log('[Auth] No Microsoft login redirect detected — may already be on login form'));

    console.log(`[Auth] Login URL: ${page.url().slice(0, 90)}`);

    // ── Step 2: Email — Azure AD B2C-style forms use input#email (type=text, not type=email) ──
    await page.waitForTimeout(2_000); // Let B2C page fully render
    const emailInput = page.locator(
      'input#email, input[name="signInName"], input[id="signInName"], input[type="email"], input[name="loginfmt"], #i0116'
    ).first();
    if (await emailInput.isVisible({ timeout: 10_000 }).catch(() => false)) {
      console.log(`[Auth] Entering email: ${AUTO_USER}`);
      await emailInput.fill(AUTO_USER);
      await page.waitForTimeout(500);
      const nextBtn = page.locator(
        'button#continue, button[id="next"], button:has-text("Next"), button:has-text("Continue"), ' +
        'input[type="submit"][value*="Next"], input[id="idSIButton9"], button[type="submit"]'
      ).first();
      if (await nextBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await nextBtn.click();
      } else {
        await page.keyboard.press('Enter');
      }
      await page.waitForTimeout(2_000);
    } else {
      console.log('[Auth] Email input not found — saving debug screenshot');
      await page.screenshot({ path: '.auth/debug-email-step.png' });
    }

    // ── Step 3: Password — on combined email+password page after HRD step ─────
    // After email step, B2C shows: input#signInName (pre-filled) + input#password + button#next
    const passInput = page.locator('input#password, input[type="password"], input[name="passwd"], #i0118').first();
    if (await passInput.isVisible({ timeout: 10_000 }).catch(() => false)) {
      console.log('[Auth] Entering password...');
      await passInput.fill(AUTO_PASS);
      await page.waitForTimeout(500);
      // B2C uses button#next with text "Sign in"
      const signInBtn = page.locator(
        'button#next, button[id="next"], button:has-text("Sign in"), button:has-text("Continue"), ' +
        'input[type="submit"][value*="Sign in"], input[id="idSIButton9"], button[type="submit"]'
      ).first();
      if (await signInBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await signInBtn.click();
      } else {
        await page.keyboard.press('Enter');
      }
      await page.waitForTimeout(3_000);
    } else {
      console.log('[Auth] Password input not found — saving debug screenshot');
      await page.screenshot({ path: '.auth/debug-password-step.png' });
    }

    // ── Step 4: TOTP — B2C-style forms use input#otpCode + button#continue (Verify) ──
    const totpInput = page.locator(
      'input#otpCode, input[name="otc"], input[id="otc"], input[id="idTxtBx_SAOTCC_OTC"], ' +
      'input[placeholder*="code" i], input[autocomplete="one-time-code"]'
    ).first();
    if (await totpInput.isVisible({ timeout: 15_000 }).catch(() => false)) {
      const code = generateTOTP(AUTO_TOTP);
      console.log(`[Auth] Entering TOTP code: ${code}`);
      await totpInput.fill(code);
      await page.waitForTimeout(500);
      // Optionally check "Don't ask again for 30 days"
      const rememberCheck = page.locator('input#rememberDeviceInformation_True');
      if (await rememberCheck.isVisible({ timeout: 1_000 }).catch(() => false)) {
        if (!await rememberCheck.isChecked()) await rememberCheck.check();
      }
      // B2C uses button#continue with text "Verify" after password
      const verifyBtn = page.locator(
        'button#continue, button[id="next"], button:has-text("Verify"), button:has-text("Continue"), ' +
        'input[type="submit"], button[type="submit"]'
      ).first();
      if (await verifyBtn.isVisible({ timeout: 3_000 }).catch(() => false)) {
        await verifyBtn.click();
      } else {
        await page.keyboard.press('Enter');
      }
      await page.waitForTimeout(3_000);
    } else {
      console.log('[Auth] No TOTP input found — saving debug screenshot');
      await page.screenshot({ path: '.auth/debug-totp-step.png' });
    }

    // ── Step 5: "Stay signed in?" prompt ─────────────────────────────────────
    const stayBtn = page.locator('#idSIButton9, input[value="Yes"], button:has-text("Yes")').first();
    if (await stayBtn.isVisible({ timeout: 6_000 }).catch(() => false)) {
      console.log('[Auth] Clicking "Yes" on Stay signed in prompt...');
      await stayBtn.click();
      await page.waitForTimeout(2_000);
    }

    // ── Step 6: Wait for app to load — use function to match ONLY app hostname ──
    const appHostname = new URL(APP_URL_QA).hostname;
    console.log('[Auth] Waiting for redirect back to app...');
    // Use a URL predicate to strictly match hostname (avoids matching redirect_uri in B2C query params)
    await page.waitForURL(
      url => url.hostname === appHostname,
      { timeout: 60_000 }
    );

    // Wait for the app to finish MSAL initialization
    await page.waitForFunction(
      () => !document.body?.innerText?.includes('Initializing authentication'),
      { timeout: 30_000, polling: 1000 }
    ).catch(() => console.log('[Auth] App still initializing — saving state anyway'));

    await page.waitForTimeout(2_000);
    console.log(`[Auth] ✅ Authenticated at: ${page.url()}`);

    // ── Step 7: Save state ────────────────────────────────────────────────────
    await context.storageState({ path: AUTH_STATE_PATH });
    console.log(`[Auth] ✅ Auth state saved to ${AUTH_STATE_PATH}`);

    return AUTH_STATE_PATH;
  } catch (err) {
    console.error('[Auth] Login failed:', err instanceof Error ? err.message : err);
    try { await page.screenshot({ path: '.auth/debug-error.png' }); } catch { /**/ }
    try { await context.storageState({ path: AUTH_STATE_PATH + '.partial' }); } catch { /**/ }
    throw err;
  } finally {
    await page.close();
    await browser.close();
  }
}

// Run directly: npx tsx scripts/auth-manager.ts
if (process.argv[1]?.endsWith('auth-manager.ts') || process.argv[1]?.endsWith('auth-manager.js')) {
  const force = process.argv.includes('--force');
  authenticate(force)
    .then(p => console.log(`\n✅ Auth ready: ${p}`))
    .catch(err => { console.error(err); process.exit(1); });
}
