/**
 * MCP Ticket Orchestrator (MCP-first operational command)
 *
 * Usage:
 *   npm run mcp:ticket -- PROJ-1234
 *     -> preflight + ticket fetch + draft result.json (no Jira status change)
 *
 *   npm run mcp:ticket -- PROJ-1234 --publish artifacts\\PROJ-1234\\result.json [--no-transition]
 *     -> publish structured ValidationResult through shared pipeline
 */

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { getIssue } from './jira-client.js';
import { runPreflightChecks } from './preflight.js';
import { publishResult, type Verdict as PublishVerdict } from './publish-result.js';
import type { ValidationResult, AcCheck } from './ticket-validator.js';
import { startRun, startTicket, finishTicket, finishRun, setError } from './run-state.js';

function usage(): void {
  console.log('Usage:');
  console.log('  npm run mcp:ticket -- PROJ-1234');
  console.log('  npm run mcp:ticket -- PROJ-1234 --publish artifacts\\PROJ-1234\\result.json [--no-transition]');
}

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function acFromText(text: string): AcCheck[] {
  const lines = text
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .filter(line => /^(-|\*|\d+[.)])\s+/.test(line))
    .map(line => line.replace(/^(-|\*|\d+[.)])\s+/, '').trim())
    .filter(line => line.length >= 6)
    .slice(0, 12);

  return lines.map((line, idx) => ({
    id: `AC${idx + 1}`,
    description: line,
    expected: '',
    observed: '',
    passed: false,
    status: 'inconclusive',
  }));
}

function draftResult(issue: { acceptanceCriteria: string; description: string; key: string }): ValidationResult {
  const checks = acFromText(issue.acceptanceCriteria || issue.description || '');
  return {
    passed: false,
    inconclusive: true,
    summary: 'Draft result created. Complete AC checks and evidence after MCP validation.',
    details: [],
    screenshots: [],
    networkLogPath: null,
    consoleErrors: [],
    acChecks: checks,
    notValidated: [],
    environment: 'QA — your-app-qa.example.com',
    method: 'Live — Playwright MCP over shared Edge (CDP)',
    testData: {},
    reproSteps: [],
    networkCalls: [],
  };
}

function normalize(raw: Partial<ValidationResult>): ValidationResult {
  if (typeof raw.passed !== 'boolean') {
    throw new Error('result.passed (boolean) is required in the JSON');
  }
  return {
    passed: raw.passed,
    inconclusive: raw.inconclusive ?? false,
    summary: raw.summary ?? (raw.passed ? 'Validated — all checks passed.' : 'Validation failed.'),
    details: raw.details ?? [],
    screenshots: raw.screenshots ?? [],
    networkLogPath: raw.networkLogPath ?? null,
    consoleErrors: raw.consoleErrors ?? [],
    acChecks: raw.acChecks ?? [],
    notValidated: raw.notValidated ?? [],
    environment: raw.environment,
    method: raw.method ?? 'Live — Playwright MCP over shared Edge (CDP)',
    testData: raw.testData,
    dealUrl: raw.dealUrl,
    reproSteps: raw.reproSteps,
    networkCalls: raw.networkCalls ?? [],
  };
}

function mapRunStateVerdict(verdict: PublishVerdict | 'blocked'): 'pass' | 'fail' | 'skipped' | 'blocked' {
  if (verdict === 'pass') return 'pass';
  if (verdict === 'fail') return 'fail';
  if (verdict === 'blocked') return 'blocked';
  return 'skipped'; // inconclusive
}

async function prepareTicket(key: string): Promise<void> {
  await runPreflightChecks({
    requireCDP: true,
    requireRunAccount: true,
    autoStartCDP: true,
    throwOnError: true,
  });

  const issue = await getIssue(key);
  console.log(`[MCP] ${issue.key}: ${issue.summary}`);
  console.log(`[MCP] Current status: ${issue.status}`);

  const dir = path.join(process.cwd(), 'artifacts', issue.key);
  ensureDir(dir);
  const draftPath = path.join(dir, 'result.draft.json');
  fs.writeFileSync(draftPath, JSON.stringify(draftResult(issue), null, 2), 'utf-8');

  console.log(`[MCP] Draft created: ${draftPath}`);
  console.log('[MCP] Next step: validate live via MCP and fill expected/observed/pass per AC.');
  console.log(`[MCP] Publish command: npm run mcp:ticket -- ${issue.key} --publish artifacts\\${issue.key}\\result.draft.json`);
}

async function publishTicket(key: string, resultPath: string, noTransition: boolean): Promise<void> {
  if (!fs.existsSync(resultPath)) {
    throw new Error(`Result file not found: ${resultPath}`);
  }

  startRun('single', [key]);
  try {
    await runPreflightChecks({
      requireCDP: true,
      requireRunAccount: true,
      autoStartCDP: true,
      throwOnError: true,
    });

    const issue = await getIssue(key);
    startTicket(key, issue.summary);

    const raw = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as Partial<ValidationResult>;
    const result = normalize(raw);
    const outcome = await publishResult(issue, result, { transition: !noTransition });
    const verdict = outcome.blockedReason ? 'blocked' : outcome.verdict;

    finishTicket(
      key,
      issue.summary,
      mapRunStateVerdict(verdict),
      'mcp',
      outcome.movedTo ?? '',
      outcome.blockedReason ? 'jira-transition' : null,
      outcome.blockedReason ?? null,
    );
    finishRun();

    console.log(
      `[MCP] Published — verdict=${verdict}, attached=${outcome.attached.length}, movedTo=${outcome.movedTo ?? '(none)'}`,
    );
  } catch (err) {
    setError(err instanceof Error ? err.message : String(err));
    throw err;
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const key = args.find(v => /^PROJ-\d+$/i.test(v));
  if (!key) {
    usage();
    process.exit(1);
  }

  const publishIdx = args.indexOf('--publish');
  const publishPathFlag = publishIdx >= 0 ? args[publishIdx + 1] : '';
  const publishPathPositional = args.find(v => v !== key && !v.startsWith('--') && /\.json$/i.test(v)) ?? '';
  const publishPath = publishPathFlag || publishPathPositional;
  const noTransition = args.includes('--no-transition');

  if (publishPath) {
    await publishTicket(key, publishPath, noTransition);
    return;
  }

  await prepareTicket(key);
}

main().catch(err => {
  console.error('[MCP] Fatal error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
