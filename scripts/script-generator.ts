/**
 * script-generator.ts — Converts recorded agent steps into a reusable Playwright validator.
 *
 * Called automatically by agent-validate.ts after a PASS run.
 * Output: scripts/validators/proj-XXXX.ts  + registry.json entry.
 *
 * The generated script exports `validate(page, issue): Promise<ValidationResult>` —
 * the interface that ticket-runner.ts uses for dynamic loading.
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import type { ClickArgs, FillArgs, SelectArgs } from './agent-browser.js';

const VALIDATORS_DIR = resolve(process.cwd(), 'scripts/validators');
const REGISTRY_PATH  = resolve(VALIDATORS_DIR, 'registry.json');

// ── Step types ────────────────────────────────────────────────────────────────

export type RecordedStep =
  | { tool: 'browser_navigate'; args: { url: string } }
  | { tool: 'browser_click';    args: ClickArgs }
  | { tool: 'browser_fill';     args: FillArgs }
  | { tool: 'browser_select';   args: SelectArgs };

// ── Registry helpers (mirrors ticket-runner.ts — kept local to avoid a circular dep) ──

interface HealthEntry {
  totalRuns: number;
  passes: number;
  fails: number;
  consecutiveFails: number;
  lastRun: string | null;
  lastResult: 'pass' | 'fail' | null;
}

interface RegistryEntry {
  title: string;
  scriptPath?: string;
  generated?: boolean;
  generatedAt?: string;
  health: HealthEntry;
}

function loadRegistry(): Record<string, RegistryEntry> {
  if (!existsSync(REGISTRY_PATH)) return {};
  const raw = JSON.parse(readFileSync(REGISTRY_PATH, 'utf-8')) as Record<string, unknown>;
  const { _meta: _, ...entries } = raw;
  return entries as Record<string, RegistryEntry>;
}

function saveRegistry(entries: Record<string, RegistryEntry>): void {
  const dir = dirname(REGISTRY_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const file = {
    _meta: {
      description: 'Health tracker for codified ticket validators. consecutiveFails >= 3 → stale → falls back to autonomous agent.',
      updated: new Date().toISOString(),
    },
    ...entries,
  };
  writeFileSync(REGISTRY_PATH, JSON.stringify(file, null, 2));
}

// ── Code generation helpers ───────────────────────────────────────────────────

function q(s: unknown): string {
  return JSON.stringify(String(s ?? ''));
}

function stepToCode(step: RecordedStep, index: number): string {
  const lines: string[] = [];
  const stepNum = String(index + 1).padStart(2, '0');

  switch (step.tool) {
    case 'browser_navigate': {
      lines.push(`    // Step ${stepNum}: navigate`);
      lines.push(`    await navigateWithAuth(page, ${q(step.args.url)});`);
      lines.push(`    screenshots.push(await capture(page, \`\${issue.key}-${stepNum}-nav\`, issue.key).catch(() => ''));`);
      lines.push(`    await page.waitForTimeout(800);`);
      break;
    }
    case 'browser_click': {
      const { role, name, text } = step.args;
      lines.push(`    // Step ${stepNum}: click`);
      if (role && name) {
        lines.push(`    await page.getByRole(${q(role)}, { name: ${q(name)} }).first().click({ timeout: 8000 });`);
      } else if (text) {
        lines.push(`    await page.getByText(${q(text)}, { exact: false }).first().click({ timeout: 8000 });`);
      } else if (name) {
        lines.push(`    await page.getByText(${q(name)}, { exact: false }).first().click({ timeout: 8000 });`);
      }
      lines.push(`    await page.waitForTimeout(800);`);
      break;
    }
    case 'browser_fill': {
      const { label, placeholder, name, value, submit } = step.args;
      lines.push(`    // Step ${stepNum}: fill`);
      let locator: string;
      if (label)       locator = `page.getByLabel(${q(label)}, { exact: false }).first()`;
      else if (placeholder) locator = `page.getByPlaceholder(${q(placeholder)}, { exact: false }).first()`;
      else             locator = `page.getByRole('textbox', { name: ${q(name ?? '')} }).first()`;
      lines.push(`    await ${locator}.fill(${q(value)}, { timeout: 8000 });`);
      lines.push(submit
        ? `    await ${locator}.press('Enter');`
        : `    await ${locator}.press('Tab');`);
      lines.push(`    await page.waitForTimeout(500);`);
      break;
    }
    case 'browser_select': {
      const { label, name, option } = step.args;
      lines.push(`    // Step ${stepNum}: select "${option}"`);
      lines.push(`    try {`);
      if (label) {
        lines.push(`      const sel = page.getByLabel(${q(label)}, { exact: false });`);
        lines.push(`      if (await sel.first().count() > 0) {`);
        lines.push(`        await sel.first().selectOption({ label: ${q(option)} }, { timeout: 8000 });`);
        lines.push(`      } else {`);
        lines.push(`        const combo = page.getByRole('combobox', { name: ${q(label)} });`);
        lines.push(`        await combo.first().click({ timeout: 8000 });`);
        lines.push(`        await page.waitForTimeout(600);`);
        lines.push(`        await page.locator('[role="option"]:visible').filter({ hasText: ${q(option)} }).first().click({ timeout: 8000 });`);
        lines.push(`      }`);
      } else {
        lines.push(`      const combo = page.getByRole('combobox', { name: ${q(name ?? '')} });`);
        lines.push(`      await combo.first().click({ timeout: 8000 });`);
        lines.push(`      await page.waitForTimeout(600);`);
        lines.push(`      await page.locator('[role="option"]:visible').filter({ hasText: ${q(option)} }).first().click({ timeout: 8000 });`);
      }
      lines.push(`    } catch { /* combobox may not be available — agent-validate fallback will handle */ }`);
      lines.push(`    await page.waitForTimeout(400);`);
      break;
    }
  }
  return lines.join('\n');
}

// ── Main export ───────────────────────────────────────────────────────────────

export interface GenerateResult {
  scriptPath: string;
  registered: boolean;
}

/**
 * Generate a reusable Playwright validator from agent-recorded steps and register it.
 * Safe to call even if steps is empty — produces a commented-out template.
 */
export function generateScript(
  key: string,
  title: string,
  steps: RecordedStep[],
): GenerateResult {
  if (!existsSync(VALIDATORS_DIR)) mkdirSync(VALIDATORS_DIR, { recursive: true });

  const fileName = `${key.toLowerCase()}.ts`;
  const scriptPath = `scripts/validators/${fileName}`;
  const absPath = resolve(VALIDATORS_DIR, fileName);
  const generatedAt = new Date().toISOString();

  const stepsCode = steps
    .filter(s => s.tool !== 'browser_navigate' || (s.args as { url: string }).url)
    .map((s, i) => stepToCode(s, i))
    .join('\n\n');

  const noStepsComment = steps.length === 0
    ? `\n    // ⚠️  No action steps were recorded (agent may have used snapshot/report only).\n    // Add your validation logic here manually.\n`
    : '';

  const fileContent = `/**
 * Auto-generated validator — ${key}
 * Title : ${title}
 * Source: Autonomous agent PASS run (GitHub Models)
 * Generated: ${generatedAt}
 *
 * Steps were recorded from a live agent run and converted to Playwright calls.
 * Review selectors before relying on this for regression — role/label locators
 * are stable but 'text=' fallbacks may drift if the UI copy changes.
 *
 * Interface: exports \`validate(page, issue)\` consumed by ticket-runner.ts.
 */

import type { Page } from 'playwright';
import { navigateWithAuth } from '../cdp-browser.js';
import { capture } from '../screenshot.js';
import { NetworkMonitor } from '../network-monitor.js';
import type { JiraIssue } from '../jira-client.js';
import type { ValidationResult } from '../ticket-validator.js';

export async function validate(page: Page, issue: JiraIssue): Promise<ValidationResult> {
  const monitor = new NetworkMonitor();
  monitor.attach(page);
  const consoleErrors: string[] = [];
  const screenshots: string[] = [];

  page.on('console', msg => {
    if (msg.type() === 'error') consoleErrors.push(\`[error] \${msg.text()}\`.slice(0, 300));
  });

  try {
    // ── Recorded steps (${steps.length} action step${steps.length === 1 ? '' : 's'}) ──
${noStepsComment}${stepsCode}

    // ── Final state screenshot ──
    screenshots.push(await capture(page, \`\${issue.key}-final\`, issue.key).catch(() => ''));

    const networkErrors = monitor.getErrors();

    return {
      passed: networkErrors.length === 0,
      summary: networkErrors.length === 0
        ? 'All recorded steps completed without network errors.'
        : \`\${networkErrors.length} network error(s) detected during recorded flow.\`,
      details: [],
      screenshots: screenshots.filter(Boolean),
      networkLogPath: monitor.hasErrors() ? monitor.save(issue.key, issue.key) : null,
      consoleErrors,
      environment: \`QA — your-app-qa.example.com\`,
      method: \`Auto-generated script — recorded ${generatedAt.slice(0, 10)}\`,
      networkCalls: networkErrors,
    };

  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    try { screenshots.push(await capture(page, \`\${issue.key}-ERROR\`, issue.key)); } catch { /* ok */ }
    return {
      passed: false,
      summary: \`Script error: \${message.slice(0, 200)}\`,
      details: [message],
      screenshots: screenshots.filter(Boolean),
      networkLogPath: null,
      consoleErrors,
    };
  }
}
`;

  writeFileSync(absPath, fileContent, 'utf-8');

  // Register in registry.json
  const entries = loadRegistry();
  const existing = entries[key];
  entries[key] = {
    title,
    scriptPath,
    generated: true,
    generatedAt,
    health: existing?.health ?? {
      totalRuns: 0,
      passes: 0,
      fails: 0,
      consecutiveFails: 0,
      lastRun: null,
      lastResult: null,
    },
  };
  saveRegistry(entries);

  return { scriptPath, registered: true };
}
