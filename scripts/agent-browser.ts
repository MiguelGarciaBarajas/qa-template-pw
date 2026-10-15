/**
 * AgentBrowser — the "hands" of the autonomous QA agent.
 *
 * Wraps a Playwright Page (connected to the shared Edge via CDP) and exposes a small set
 * of robust, LLM-friendly browser actions. Each method returns a SHORT string describing
 * the outcome — that string is fed straight back to the model as a tool result, so it
 * stays concise to control token cost. Console errors and failing network calls are
 * captured automatically for the whole session.
 */

import type { Page } from 'playwright';
import { navigateWithAuth, spaNavigate, type NavigateAuthOptions } from './cdp-browser.js';
import { capture } from './screenshot.js';
import { NetworkMonitor, type NetworkEntry } from './network-monitor.js';
import * as OTPAuth from 'otpauth';

const SNAPSHOT_MAX = 1800; // keep snapshots compact to avoid model request overflows
const ACTION_TIMEOUT = 8_000;
// Optional "store/tenant selection gate" hook. Leave APP_STORE_GATE_TEXT unset to disable it.
//   APP_STORE_GATE_TEXT          regex source of the text/button shown while no store/tenant is selected
//   APP_STORE_SEARCH_PLACEHOLDER regex source of the placeholder of the search box inside the selection modal
//   APP_DEFAULT_STORE            name of the store/tenant to auto-select
const STORE_GATE_RE = process.env.APP_STORE_GATE_TEXT?.trim() ? new RegExp(process.env.APP_STORE_GATE_TEXT.trim(), 'i') : null;
const STORE_SEARCH_PLACEHOLDER_RE = new RegExp(process.env.APP_STORE_SEARCH_PLACEHOLDER?.trim() || 'search', 'i');
const DEFAULT_STORE = process.env.APP_DEFAULT_STORE?.trim() ?? '';
const APP_HOSTNAME = new URL(process.env.APP_URL_QA ?? 'https://your-app-qa.example.com').hostname;

export interface ClickArgs { role?: string; name?: string; text?: string; }
export interface FillArgs { label?: string; placeholder?: string; name?: string; value: string; submit?: boolean; }
export interface SelectArgs { label?: string; name?: string; option: string; }

export class AgentBrowser {
  readonly screenshots: string[] = [];
  readonly consoleErrors: string[] = [];
  private readonly monitor = new NetworkMonitor();

  constructor(
    private readonly page: Page,
    private readonly subdir: string,
    private readonly authOptions: NavigateAuthOptions = {},
  ) {
    this.monitor.attach(page);
    page.on('console', msg => {
      if (msg.type() === 'error') this.consoleErrors.push(`[error] ${msg.text()}`.slice(0, 300));
    });
  }

  networkErrors(): NetworkEntry[] { return this.monitor.getErrors(); }
  hasNetworkErrors(): boolean { return this.monitor.hasErrors(); }
  saveNetworkLog(): string | null { return this.monitor.save(this.subdir.replace(/\//g, '-'), this.subdir); }
  currentUrl(): string { return this.page.url(); }

  /** Navigate to a URL (handles the app's SSO sign-in flow). */
  async navigate(url: string): Promise<string> {
    try {
      if (isAppTarget(url)) {
        await spaNavigate(this.page, url);
      } else {
        await navigateWithAuth(this.page, url, this.authOptions);
      }
      const storeContext = await this.ensureDefaultStoreContext();
      const suffix = storeContext ? ` ${storeContext}` : '';
      return `Navigated. Current URL: ${this.page.url()}${suffix}`;
    } catch (err) {
      return `Navigation error: ${msg(err)}. Current URL: ${this.page.url()}`;
    }
  }

  /** Return the page's ARIA accessibility tree (roles + names) — read this before acting. */
  async snapshot(): Promise<string> {
    try {
      await this.ensureDefaultStoreContext();
      const tree = await this.page.locator('body').ariaSnapshot({ timeout: ACTION_TIMEOUT });
      const clipped = tree.length > SNAPSHOT_MAX ? tree.slice(0, SNAPSHOT_MAX) + '\n…[truncated]' : tree;
      return `URL: ${this.page.url()}\n${clipped}`;
    } catch (err) {
      return `Snapshot error: ${msg(err)}. URL: ${this.page.url()}`;
    }
  }

  /** Click an element by role+name, or by visible text. */
  async click(args: ClickArgs): Promise<string> {
    try {
      await this.ensureDefaultStoreContext();
      if (await this.shouldBlockGlobalSearchClick(args)) {
        return 'Workflow guard: Do NOT use top Search while the store/tenant selection gate is shown. Select a store first, then continue the ticket flow (or the exact path in the ACs).';
      }

      const loc = this.locate(args);
      if (!loc) return 'click: provide role+name or text.';
      await loc.first().scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT }).catch(() => {});
      await loc.first().click({ timeout: ACTION_TIMEOUT });
      await this.page.waitForTimeout(800);
      return `Clicked ${describe(args)}. URL: ${this.page.url()}`;
    } catch (err) {
      return `Click failed for ${describe(args)}: ${msg(err)}`;
    }
  }

  /** Fill a text field (by label, placeholder, or accessible name) and optionally press Enter. */
  async fill(args: FillArgs): Promise<string> {
    try {
      await this.ensureDefaultStoreContext();
      if (await this.shouldBlockGlobalVinSearchFill(args)) {
        return 'Workflow guard: an identifier entered in top Search is not the right path for this state. Select a store/tenant first, then follow the ticket-specific steps.';
      }
      const effective = await this.resolveAuthAwareFill(args);
      const loc = args.label ? this.page.getByLabel(args.label, { exact: false })
        : args.placeholder ? this.page.getByPlaceholder(args.placeholder, { exact: false })
        : args.name ? this.page.getByRole('textbox', { name: args.name })
        : null;
      if (!loc) return 'fill: provide label, placeholder, or name.';
      await loc.first().scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT }).catch(() => {});
      await loc.first().fill(effective.value, { timeout: ACTION_TIMEOUT });
      if (args.submit) await loc.first().press('Enter');
      else await loc.first().press('Tab');
      await this.page.waitForTimeout(500);
      const masked = effective.maskedValue ?? effective.value;
      const source = effective.overridden ? ' (auth-enforced)' : '';
      return `Filled "${masked}" into ${describe(args)}${source}.`;
    } catch (err) {
      return `Fill failed for ${describe(args)}: ${msg(err)}`;
    }
  }

  /** Select an option from a dropdown (native <select> or a custom combobox). */
  async select(args: SelectArgs): Promise<string> {
    const { label, name, option } = args;
    await this.ensureDefaultStoreContext();
    // Try a native <select> first.
    try {
      const sel = label ? this.page.getByLabel(label, { exact: false }) : this.page.locator('select');
      if (await sel.first().count() > 0) {
        await sel.first().selectOption({ label: option }, { timeout: ACTION_TIMEOUT });
        await this.page.waitForTimeout(400);
        return `Selected "${option}" in ${label ?? name ?? 'select'}.`;
      }
    } catch { /* fall through to combobox */ }

    // Combobox: click the control, then click the option by text.
    try {
      const combo = label ? this.page.getByRole('combobox', { name: label })
        : name ? this.page.getByRole('combobox', { name })
        : this.page.locator('button[role="combobox"]').first();
      await combo.first().click({ timeout: ACTION_TIMEOUT });
      await this.page.waitForTimeout(600);
      const opt = this.page.locator('[role="option"]:visible').filter({ hasText: option }).first();
      await opt.click({ timeout: ACTION_TIMEOUT });
      await this.page.waitForTimeout(400);
      return `Selected "${option}" via combobox ${label ?? name ?? ''}.`.trim();
    } catch (err) {
      return `Select failed for "${option}": ${msg(err)}. Is the dropdown disabled or not open?`;
    }
  }

  /** Capture a screenshot into artifacts/<subdir>/ and remember it as evidence. */
  async screenshot(name: string): Promise<string> {
    try {
      const safe = name.replace(/[^a-z0-9-_]/gi, '-').slice(0, 60) || 'state';
      const path = await capture(this.page, safe, this.subdir);
      this.screenshots.push(path);
      return `Screenshot saved: ${path}`;
    } catch (err) {
      return `Screenshot failed: ${msg(err)}`;
    }
  }

  /** Recently captured console errors. */
  getConsole(): string {
    return this.consoleErrors.length ? this.consoleErrors.slice(-10).join('\n') : 'No console errors captured.';
  }

  /** Failing network calls (HTTP >= 400). */
  getNetwork(): string {
    const errs = this.monitor.getErrors();
    if (!errs.length) return 'No failing network calls (HTTP >= 400) captured.';
    return errs.slice(0, 8).map(e => `${e.method} ${e.url} → ${e.status} ${e.statusText}: ${(e.responseBody || '').slice(0, 200)}`).join('\n');
  }

  private locate(args: ClickArgs) {
    if (args.role && args.name) return this.page.getByRole(args.role as Parameters<Page['getByRole']>[0], { name: args.name });
    if (args.text) return this.page.getByText(args.text, { exact: false });
    if (args.name) return this.page.getByText(args.name, { exact: false });
    if (args.role) return this.page.getByRole(args.role as Parameters<Page['getByRole']>[0]);
    return null;
  }

  private async resolveAuthAwareFill(args: FillArgs): Promise<{ value: string; overridden: boolean; maskedValue?: string }> {
    const host = safeHostname(this.page.url());
    const onLoginHost = host.includes('b2clogin.com') || host.includes('microsoftonline.com');
    if (!onLoginHost) {
      return { value: args.value, overridden: false };
    }

    const hint = `${args.label ?? ''} ${args.placeholder ?? ''} ${args.name ?? ''}`.toLowerCase();
    const looksOtp =
      /otp|otc|code|verification|authenticator|mfa|one[-\s]?time/i.test(hint) ||
      await this.page.locator('input#otpCode, input[name="otc"], input[autocomplete="one-time-code"]').first().isVisible({ timeout: 200 }).catch(() => false);
    if (looksOtp) {
      const secret = this.authOptions.totpSecret?.trim();
      if (secret) {
        const code = generateTOTP(secret);
        return { value: code, overridden: true, maskedValue: `${code.slice(0, 2)}****` };
      }
    }

    const looksPassword =
      /password|passwd/i.test(hint) ||
      await this.page.locator('input#password, input[type="password"], input[name="passwd"], #i0118').first().isVisible({ timeout: 200 }).catch(() => false);
    if (looksPassword) {
      const password = this.authOptions.password?.trim();
      if (password) return { value: password, overridden: true, maskedValue: '********' };
    }

    const looksEmail =
      /email|signinname|loginfmt|username|user name/i.test(hint) ||
      await this.page.locator('input#email, input[name="signInName"], input[id="signInName"], input[name="loginfmt"], #i0116').first().isVisible({ timeout: 200 }).catch(() => false);
    if (looksEmail) {
      const email = this.authOptions.email?.trim();
      if (email) return { value: email, overridden: true, maskedValue: email };
    }

    return { value: args.value, overridden: false };
  }

  private async shouldBlockGlobalSearchClick(args: ClickArgs): Promise<boolean> {
    const hasStoreGate = await this.hasStoreSelectionGate();
    if (!hasStoreGate) return false;
    const needle = `${args.text ?? ''} ${args.name ?? ''}`.toLowerCase();
    return /\bsearch\b/.test(needle);
  }

  private async shouldBlockGlobalVinSearchFill(args: FillArgs): Promise<boolean> {
    const hasStoreGate = await this.hasStoreSelectionGate();
    if (!hasStoreGate) return false;
    const fieldHint = `${args.label ?? ''} ${args.placeholder ?? ''} ${args.name ?? ''}`.toLowerCase();
    const isSearchField = /\bsearch\b/.test(fieldHint);
    const looksLikeId = /^[a-z0-9-]{11,17}$/i.test((args.value ?? '').trim());
    return isSearchField && looksLikeId;
  }

  private async hasStoreSelectionGate(): Promise<boolean> {
    if (!STORE_GATE_RE) return false;
    const panel = this.page.getByText(STORE_GATE_RE).first();
    const button = this.page.getByRole('button', { name: STORE_GATE_RE }).first();
    const panelVisible = await panel.isVisible({ timeout: 200 }).catch(() => false);
    if (panelVisible) return true;
    return button.isVisible({ timeout: 200 }).catch(() => false);
  }

  /**
   * If the workspace is blocked by the store gate, auto-select the default QA store
   * (APP_DEFAULT_STORE) before continuing with any flow.
   */
  private async ensureDefaultStoreContext(): Promise<string | null> {
    if (!STORE_GATE_RE || !DEFAULT_STORE) return null;
    if (!await this.hasStoreSelectionGate()) return null;

    const cardButton = this.page.getByRole('button', { name: STORE_GATE_RE }).first();
    if (await cardButton.isVisible({ timeout: 500 }).catch(() => false)) {
      await cardButton.click({ timeout: ACTION_TIMEOUT });
      await this.page.waitForTimeout(400);
    }

    const search = this.page.getByPlaceholder(STORE_SEARCH_PLACEHOLDER_RE).first();
    if (!await search.isVisible({ timeout: 3_000 }).catch(() => false)) {
      return 'Store-gate detected but the selection modal did not open.';
    }

    await search.fill(DEFAULT_STORE, { timeout: ACTION_TIMEOUT });
    await this.page.waitForTimeout(500);

    const option = this.page.getByText(new RegExp(escapeRegExp(DEFAULT_STORE), 'i')).first();
    if (await option.isVisible({ timeout: 2_000 }).catch(() => false)) {
      await option.click({ timeout: ACTION_TIMEOUT });
    } else {
      return `Store-gate detected but the store option was not found: ${DEFAULT_STORE}.`;
    }

    await this.page.waitForTimeout(700);
    return ` Store context set: ${DEFAULT_STORE}.`;
  }
}

function msg(err: unknown): string {
  return (err instanceof Error ? err.message : String(err)).slice(0, 200);
}

function describe(args: ClickArgs | FillArgs): string {
  const parts: string[] = [];
  if ('role' in args && args.role) parts.push(`role=${args.role}`);
  if ('name' in args && args.name) parts.push(`name="${args.name}"`);
  if ('text' in args && args.text) parts.push(`text="${args.text}"`);
  if ('label' in args && args.label) parts.push(`label="${args.label}"`);
  if ('placeholder' in args && args.placeholder) parts.push(`placeholder="${args.placeholder}"`);
  return parts.join(' ') || 'element';
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

function safeHostname(rawUrl: string): string {
  try {
    return new URL(rawUrl).hostname;
  } catch {
    return '';
  }
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isAppTarget(rawUrl: string): boolean {
  if (rawUrl.startsWith('/')) return true;
  try {
    return new URL(rawUrl).hostname === APP_HOSTNAME;
  } catch {
    return false;
  }
}
