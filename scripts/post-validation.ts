/**
 * Post Validation — publish an AGENT-produced validation result to Jira.
 *
 * The agent validates a ticket LIVE via the Playwright MCP, captures evidence into
 * artifacts/PROJ-XXXX/, assembles a ValidationResult as JSON, then runs this CLI to
 * publish it through the SAME pipeline as the codified flow: rich AC-by-AC table,
 * embedded evidence, failing-network detail, coverage honesty, and the verdict-based
 * transition. This is what makes "the agent validates every ticket live" first-class.
 *
 * Usage:
 *   npx tsx scripts/post-validation.ts PROJ-1234 path/to/result.json [--no-transition]
 *
 * result.json is a ValidationResult (see scripts/ticket-validator.ts). Minimum fields:
 *   {
 *     "passed": false,
 *     "summary": "Validation of the feature — bug reproduces.",
 *     "acChecks": [
 *       { "id": "AC1", "description": "Dropdown option is selectable",
 *         "expected": "Dropdown opens and an option can be picked",
 *         "observed": "Dropdown is rendered disabled; no options selectable",
 *         "passed": false }
 *     ],
 *     "screenshots": ["artifacts/PROJ-1234/dropdown-blocked.png"]
 *   }
 * Optional but recommended: reproSteps, consoleErrors, networkCalls, notValidated,
 * environment, testData, networkLogPath. Set "inconclusive": true if you could not
 * confirm the feature (it re-queues to Ready for Testing instead of failing to dev).
 */

import 'dotenv/config';
import fs from 'node:fs';
import { getIssue } from './jira-client.js';
import { publishResult } from './publish-result.js';
import type { ValidationResult } from './ticket-validator.js';

/** Fill in defaults so a partial, agent-authored result is safe to publish. */
function normalize(raw: Partial<ValidationResult>): ValidationResult {
  if (typeof raw.passed !== 'boolean') {
    throw new Error('result.passed (boolean) is required in the JSON');
  }
  return {
    passed:        raw.passed,
    inconclusive:  raw.inconclusive ?? false,
    summary:       raw.summary ?? (raw.passed ? 'Validated — all checks passed.' : 'Validation failed.'),
    details:       raw.details ?? [],
    screenshots:   raw.screenshots ?? [],
    networkLogPath: raw.networkLogPath ?? null,
    consoleErrors: raw.consoleErrors ?? [],
    acChecks:      raw.acChecks ?? [],
    notValidated:  raw.notValidated ?? [],
    environment:   raw.environment,
    method:        raw.method ?? 'Live — Playwright MCP over shared Edge (CDP)',
    testData:      raw.testData,
    dealUrl:       raw.dealUrl,
    reproSteps:    raw.reproSteps,
    networkCalls:  raw.networkCalls ?? [],
  };
}

async function main(): Promise<void> {
  const [key, resultPath, ...rest] = process.argv.slice(2);
  if (!key || !resultPath) {
    console.log('Usage: npx tsx scripts/post-validation.ts PROJ-1234 result.json [--no-transition]');
    process.exit(1);
  }
  const noTransition = rest.includes('--no-transition');

  if (!fs.existsSync(resultPath)) {
    console.error(`[PostValidation] Result file not found: ${resultPath}`);
    process.exit(1);
  }

  const raw = JSON.parse(fs.readFileSync(resultPath, 'utf-8')) as Partial<ValidationResult>;
  const result = normalize(raw);

  const issue = await getIssue(key);
  console.log(`[PostValidation] ${issue.key}: ${issue.summary}`);
  console.log(`[PostValidation] Verdict in: passed=${result.passed} inconclusive=${result.inconclusive} | ${result.acChecks?.length ?? 0} AC check(s), ${result.screenshots.length} screenshot(s)`);

  const outcome = await publishResult(issue, result, { transition: !noTransition });
  console.log(`[PostValidation] Done — verdict=${outcome.verdict}, attached=${outcome.attached.length}, movedTo=${outcome.movedTo ?? '(none)'}`);
}

main().catch(err => {
  console.error('[PostValidation] Fatal error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
