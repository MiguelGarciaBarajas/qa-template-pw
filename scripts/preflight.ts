import 'dotenv/config';
import { verifyCDP } from './cdp-browser.js';
import { resolveRunAccount, type RunAccount } from './run-account.js';
import { ensureCDPRunning } from './cdp-start.js';

export interface PreflightCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface PreflightReport {
  ok: boolean;
  checks: PreflightCheck[];
  runAccount?: RunAccount;
}

export interface PreflightOptions {
  requireCDP?: boolean;
  requireRunAccount?: boolean;
  requireGitHubToken?: boolean;
  autoStartCDP?: boolean;
  throwOnError?: boolean;
}

const DEFAULT_REQUIRED_ENV = [
  'JIRA_BASE_URL',
  'JIRA_USER',
  'JIRA_TOKEN',
  'JIRA_PROJECT',
  'APP_URL_QA',
] as const;

export async function runPreflightChecks(options: PreflightOptions = {}): Promise<PreflightReport> {
  const {
    requireCDP = true,
    requireRunAccount = true,
    requireGitHubToken = false,
    autoStartCDP = false,
    throwOnError = false,
  } = options;

  const checks: PreflightCheck[] = [];
  let runAccount: RunAccount | undefined;

  for (const key of DEFAULT_REQUIRED_ENV) {
    const value = process.env[key];
    checks.push({
      name: `env:${key}`,
      ok: !!value?.trim(),
      detail: value?.trim() ? 'set' : 'missing',
    });
  }

  if (requireGitHubToken) {
    const token = process.env.GITHUB_TOKEN?.trim() ?? '';
    checks.push({
      name: 'env:GITHUB_TOKEN',
      ok: !!token,
      detail: token ? 'set' : 'missing',
    });
  }

  if (requireRunAccount) {
    try {
      runAccount = resolveRunAccount();
      checks.push({
        name: 'run-account',
        ok: true,
        detail: `${runAccount.email} (${runAccount.audience}) from environment`,
      });
    } catch (err) {
      checks.push({
        name: 'run-account',
        ok: false,
        detail: err instanceof Error ? err.message : String(err),
      });
    }
  }

  if (requireCDP) {
    let ready = await verifyCDP();
    let detail = ready ? 'reachable at http://localhost:9222' : 'unreachable — run scripts/start-edge-cdp.bat';
    if (!ready && autoStartCDP) {
      try {
        const started = await ensureCDPRunning();
        ready = true;
        detail = started.alreadyRunning
          ? `reachable at ${started.endpoint}`
          : `auto-started at ${started.endpoint} with dedicated profile`;
      } catch (err) {
        detail = err instanceof Error ? err.message : String(err);
      }
    }
    checks.push({
      name: 'cdp',
      ok: ready,
      detail,
    });
  }

  const ok = checks.every(c => c.ok);
  const report: PreflightReport = { ok, checks, runAccount };

  if (!ok && throwOnError) {
    const failed = checks.filter(c => !c.ok).map(c => `${c.name}: ${c.detail}`).join('\n- ');
    throw new Error(`[Preflight] Failed checks:\n- ${failed}`);
  }

  return report;
}

async function main(): Promise<void> {
  const requireGitHubToken = process.argv.includes('--agent');
  const autoStartCDP = process.argv.includes('--auto-start-cdp');
  const report = await runPreflightChecks({
    requireGitHubToken,
    requireCDP: true,
    requireRunAccount: true,
    autoStartCDP,
  });

  console.log('\n[Preflight] QA Brain readiness');
  for (const check of report.checks) {
    console.log(`${check.ok ? '✅' : '❌'} ${check.name} — ${check.detail}`);
  }

  if (report.ok) {
    console.log('[Preflight] Ready.');
    return;
  }

  process.exitCode = 1;
}

const invokedPath = process.argv[1] ?? '';
if (/(^|[\\/])preflight\.(ts|js)$/i.test(invokedPath)) {
  main().catch(err => {
    console.error('[Preflight] Fatal error:', err instanceof Error ? err.message : err);
    process.exit(1);
  });
}
