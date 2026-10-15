/**
 * Bug Reporter
 * Creates Jira bug tickets with full evidence: screenshots, network logs, console errors.
 */

import fs from 'fs';
import path from 'path';
import {
  createBug,
  attachFile,
  addComment,
  type CreateBugPayload,
} from './jira-client.js';

export interface BugReport {
  /** The UI section where the bug was found: e.g. "Orders", "Checkout" */
  section: string;
  /** One-line minimal description: e.g. "User cannot select any item" */
  description: string;
  /** Full issue narrative */
  issue: string;
  /** What the correct behavior should be */
  acceptanceCriteria: string;
  /** Numbered steps to reproduce */
  reproSteps: string;
  /** Paths to screenshot files */
  screenshots: string[];
  /** Path to network errors JSON file (optional) */
  networkLog?: string | null;
  /** Console error messages captured during the session */
  consoleErrors?: string[];
}

const ENV = process.env.APP_ENV ?? 'QA';
const PROJECT = process.env.JIRA_PROJECT ?? 'PROJ';

/**
 * File a bug in Jira with the standard format.
 * Returns the created issue key (e.g. "PROJ-1234").
 */
export async function fileBug(report: BugReport): Promise<string> {
  // Title: {Env} | {Section} | {minimal description}
  const summary = `${ENV} | ${report.section} | ${report.description}`;

  const consoleSection = report.consoleErrors?.length
    ? `\n\nConsole Errors:\n${report.consoleErrors.slice(0, 10).map(e => `- ${e}`).join('\n')}`
    : '';

  const payload: CreateBugPayload = {
    project: PROJECT,
    summary,
    issue: report.issue,
    acceptanceCriteria: report.acceptanceCriteria,
    reproSteps: report.reproSteps + consoleSection,
    environment: ENV,
  };

  const issueKey = await createBug(payload);

  // Attach screenshots
  for (const screenshotPath of report.screenshots) {
    if (fs.existsSync(screenshotPath)) {
      await attachFile(issueKey, screenshotPath);
    }
  }

  // Attach network log if present
  if (report.networkLog && fs.existsSync(report.networkLog)) {
    await attachFile(issueKey, report.networkLog);
  }

  console.log(`[BugReporter] Bug filed: ${issueKey} — ${summary}`);
  return issueKey;
}

/** Save console errors to a text file for attachment */
export function saveConsoleLog(errors: string[], name: string, subdir = ''): string | null {
  if (errors.length === 0) return null;
  const dir = subdir ? path.join('artifacts', subdir) : 'artifacts';
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, `console-errors-${name}-${Date.now()}.txt`);
  fs.writeFileSync(filePath, errors.join('\n'), 'utf-8');
  return filePath;
}
