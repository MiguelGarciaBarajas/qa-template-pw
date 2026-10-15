/**
 * QA Explorer — Autonomous Exploratory QA Agent
 * Navigates the app to discover broken flows, UI issues, and network errors.
 * Reports all found bugs to Jira automatically.
 */

import 'dotenv/config';
import { connectBrowser, navigateWithAuth, disconnectBrowser } from './cdp-browser.js';
import { capture, captureAnnotated } from './screenshot.js';
import { NetworkMonitor } from './network-monitor.js';
import { fileBug } from './bug-reporter.js';

const APP_URL = process.env.APP_URL_QA ?? 'https://your-app-qa.example.com';

export type TestScope = 'smoke' | 'functional' | 'regression' | string;

export interface ExplorationResult {
  scope: TestScope;
  bugsFound: string[];   // Jira issue keys created
  flowsTested: string[];
  errors: string[];
}

/** Smoke test — covers the most critical top-level flows. Extend via APP_SMOKE_FLOWS_JSON='[{"name":"Orders page loads","path":"/orders"}]' */
const SMOKE_FLOWS: Array<{ name: string; path: string }> = [
  { name: 'App loads and auth works', path: '/' },
  ...parseExtraFlows(process.env.APP_SMOKE_FLOWS_JSON),
];

function parseExtraFlows(raw: string | undefined): Array<{ name: string; path: string }> {
  if (!raw?.trim()) return [];
  try {
    const parsed = JSON.parse(raw) as Array<{ name: string; path: string }>;
    return Array.isArray(parsed) ? parsed.filter(f => f?.name && f?.path) : [];
  } catch {
    console.warn('[Explorer] APP_SMOKE_FLOWS_JSON is not valid JSON — ignoring.');
    return [];
  }
}

/**
 * Run the exploratory QA session.
 * The AI agent drives this by:
 *   1. Navigating each flow
 *   2. Observing console errors, network failures, and visual anomalies
 *   3. Filing bugs for anything found broken
 */
export async function runExploration(scope: TestScope): Promise<ExplorationResult> {
  console.log(`\n${'═'.repeat(60)}`);
  console.log(`[Explorer] Starting ${scope.toUpperCase()} exploration`);
  console.log(`${'═'.repeat(60)}\n`);

  const session = await connectBrowser();
  const { page } = session;
  const monitor = new NetworkMonitor();
  const consoleErrors: string[] = [];
  const bugsFound: string[] = [];
  const flowsTested: string[] = [];

  // Attach monitors
  monitor.attach(page);
  page.on('console', msg => {
    if (msg.type() === 'error') {
      const text = msg.text();
      consoleErrors.push(text);
      console.warn(`[Console Error] ${text}`);
    }
  });

  try {
    // Navigate to app with auth
    await navigateWithAuth(page, APP_URL);

    const flows = scope === 'smoke' ? SMOKE_FLOWS : SMOKE_FLOWS; // extend for other scopes

    for (const flow of flows) {
      console.log(`\n[Explorer] Testing: ${flow.name}`);
      monitor.reset();

      try {
        await page.goto(`${APP_URL}${flow.path}`, { waitUntil: 'domcontentloaded', timeout: 30_000 });
        await page.waitForTimeout(2_000);

        const screenshot = await capture(page, `explore-${flow.name.replace(/\s+/g, '-')}`, scope);
        flowsTested.push(flow.name);

        // Check for network errors on this flow
        if (monitor.hasErrors()) {
          const networkLog = monitor.save(flow.name.replace(/\s+/g, '-'), scope);
          const errors = monitor.getErrors();

          console.log(`[Explorer] ⚠️  Network errors on "${flow.name}": ${errors.length}`);

          const bugKey = await fileBug({
            section: flow.name,
            description: `Network errors detected (${errors.map(e => e.status).join(', ')})`,
            issue: `Network errors found while navigating "${flow.name}":\n${errors.map(e => `${e.method} ${e.url} → ${e.status}`).join('\n')}`,
            acceptanceCriteria: 'All API requests should return successful responses (2xx/3xx)',
            reproSteps: `1. Open ${APP_URL}${flow.path}\n2. Observe network tab in DevTools`,
            screenshots: [screenshot],
            networkLog,
            consoleErrors: consoleErrors.slice(-5),
          });

          bugsFound.push(bugKey);
          monitor.reset();
        }

        // Check for JS console errors
        if (consoleErrors.length > 0) {
          console.log(`[Explorer] ⚠️  Console errors on "${flow.name}": ${consoleErrors.length}`);
          // Agent can file a bug here based on severity
        }

        console.log(`[Explorer] ✅ "${flow.name}" — OK`);

      } catch (flowErr) {
        const errMsg = flowErr instanceof Error ? flowErr.message : String(flowErr);
        console.error(`[Explorer] ❌ "${flow.name}" threw: ${errMsg}`);

        const screenshot = await capture(page, `error-${flow.name.replace(/\s+/g, '-')}`, scope).catch(() => '');
        const networkLog = monitor.save(flow.name.replace(/\s+/g, '-'), scope);

        const bugKey = await fileBug({
          section: flow.name,
          description: `Flow throws exception: ${errMsg.slice(0, 80)}`,
          issue: `Navigating to "${flow.name}" (${APP_URL}${flow.path}) threw an exception:\n${errMsg}`,
          acceptanceCriteria: `The "${flow.name}" flow should complete without errors`,
          reproSteps: `1. Open ${APP_URL}${flow.path}\n2. Wait for page to load\n3. Observe error`,
          screenshots: screenshot ? [screenshot] : [],
          networkLog,
          consoleErrors,
        });

        bugsFound.push(bugKey);
      }
    }

  } finally {
    await disconnectBrowser(session);
  }

  const result: ExplorationResult = {
    scope,
    bugsFound,
    flowsTested,
    errors: consoleErrors,
  };

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`[Explorer] Exploration complete`);
  console.log(`  Flows tested: ${flowsTested.length}`);
  console.log(`  Bugs filed:   ${bugsFound.length} ${bugsFound.length ? `(${bugsFound.join(', ')})` : ''}`);
  console.log(`${'═'.repeat(60)}\n`);

  return result;
}

// ─── Entry point ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const scope = (args[0] as TestScope) ?? 'smoke';

runExploration(scope).catch(err => {
  console.error('[Explorer] Fatal error:', err);
  process.exit(1);
});
