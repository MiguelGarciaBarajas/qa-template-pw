/**
 * Ticket Flow Manager
 * Orchestrates the full QA ticket lifecycle.
 * Routing (codified validator vs autonomous agent) and health tracking are
 * delegated to scripts/ticket-runner.ts — this file only manages the
 * Jira queue, run-state bookkeeping, and error handling.
 */

import 'dotenv/config';
import {
  getIssue,
  getReadyForTestingIssues,
} from './jira-client.js';
import { startRun, startTicket, finishTicket, finishRun, setError } from './run-state.js';
import { runTicket, printHealthReport } from './ticket-runner.js';
import { runPreflightChecks } from './preflight.js';

const PROJECT = process.env.JIRA_PROJECT ?? 'PROJ';
let preflightDone = false;

async function ensurePreflight(): Promise<void> {
  if (preflightDone) return;
  await runPreflightChecks({
    requireCDP: true,
    requireRunAccount: true,
    autoStartCDP: true,
    throwOnError: true,
  });
  preflightDone = true;
}

/**
 * Run the ticket flow for a specific ticket key.
 * Usage: npx tsx scripts/ticket-flow.ts PROJ-1234
 */
async function runTicketFlow(issueKey: string): Promise<void> {
  await ensurePreflight();
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`[TicketFlow] Starting: ${issueKey}`);
  console.log(`${'─'.repeat(60)}`);

  const issue = await getIssue(issueKey);
  console.log(`[TicketFlow] Ticket: ${issue.summary}`);
  console.log(`[TicketFlow] Status: ${issue.status}`);

  startTicket(issueKey, issue.summary);

  const outcome = await runTicket(issue);
  console.log(`[TicketFlow] ${issueKey} → verdict=${outcome.verdict} method=${outcome.method} movedTo=${outcome.movedTo ?? '(none)'}`);

  const verdict =
    outcome.verdict === 'pass' ? 'pass' :
    outcome.verdict === 'blocked' ? 'blocked' :
    outcome.verdict === 'inconclusive' ? 'skipped' :
    outcome.verdict === 'error' ? 'error' : 'fail';

  finishTicket(
    issueKey,
    issue.summary,
    verdict,
    outcome.method,
    outcome.movedTo ?? '',
    outcome.blockerClass ?? null,
    outcome.error ?? null,
  );
}

/**
 * Process all "Ready for Testing" tickets in the project.
 * Usage: npx tsx scripts/ticket-flow.ts --all
 */
async function runAllReadyTickets(): Promise<void> {
  console.log(`[TicketFlow] Fetching "Ready for Testing" tickets for project ${PROJECT}...`);
  const issues = await getReadyForTestingIssues(PROJECT);
  console.log(`[TicketFlow] Found ${issues.length} ticket(s)\n`);

  startRun('batch', issues.map(i => i.key));

  for (const issue of issues) {
    await runTicketFlow(issue.key);
  }

  finishRun();
  console.log('\n[TicketFlow] All tickets processed.');
}

// ─── Entry point ─────────────────────────────────────────────────────────────
const args = process.argv.slice(2);

if (args[0] === '--all') {
  runAllReadyTickets().catch(err => {
    setError(err.message);
    console.error('[TicketFlow] Fatal error:', err);
    process.exit(1);
  });
} else if (args[0] === '--health') {
  printHealthReport();
} else if (args[0]) {
  startRun('single', [args[0]]);
  runTicketFlow(args[0])
    .then(() => finishRun())
    .catch(err => {
      finishRun();
      console.error('[TicketFlow] Fatal error:', err);
      process.exit(1);
    });
} else {
  console.log('Usage:');
  console.log('  npx tsx scripts/ticket-flow.ts PROJ-1234    # Validate one ticket (auto-routes: codified → agent)');
  console.log('  npx tsx scripts/ticket-flow.ts --all       # Validate all Ready for Testing tickets');
  console.log('  npx tsx scripts/ticket-flow.ts --health    # Print validator health report');
}
