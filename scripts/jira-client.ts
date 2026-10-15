/**
 * Jira REST API v3 Client
 * Handles all Jira interactions: read issues, transitions, comments, attachments.
 */

import axios, { type AxiosInstance } from 'axios';
import FormData from 'form-data';
import fs from 'fs';
import path from 'node:path';
import 'dotenv/config';

const BASE_URL = process.env.JIRA_BASE_URL ?? '';
const USER     = process.env.JIRA_USER ?? '';
const TOKEN    = process.env.JIRA_TOKEN ?? '';

export interface JiraIssue {
  key: string;
  summary: string;
  description: string;
  status: string;
  labels: string[];
  assignee: string | null;
  acceptanceCriteria: string;
  issuetype: string;
}

export interface JiraTransition {
  id: string;
  name: string;
}

export interface CreateBugPayload {
  project: string;
  summary: string;       // Format: "{Env} | {Section} | {description}"
  issue: string;
  acceptanceCriteria: string;
  reproSteps: string;
  environment: string;
}

function createClient(): AxiosInstance {
  if (!BASE_URL || !TOKEN) {
    throw new Error('Missing Jira config. Check JIRA_BASE_URL and JIRA_TOKEN in .env');
  }
  // Jira Data Center has /jira/ context path — include it to avoid auth-stripping redirects
  const baseURL = `${BASE_URL}/jira/rest/api/2`;
  return axios.create({
    baseURL,
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${TOKEN}`,
    },
    maxRedirects: 0, // fail fast on unexpected redirects instead of silently losing auth
  });
}

/** Fetch a single Jira issue with all relevant fields */
export async function getIssue(issueKey: string): Promise<JiraIssue> {
  const client = createClient();
  const res = await client.get(`/issue/${issueKey}`, {
    params: { fields: 'summary,description,status,labels,assignee,issuetype,customfield_10016' },
  });

  const f = res.data.fields;
  const descText = extractTextFromADF(f.description);

  return {
    key: issueKey,
    summary: f.summary ?? '',
    description: descText,
    status: f.status?.name ?? '',
    labels: f.labels ?? [],
    assignee: f.assignee?.displayName ?? null,
    acceptanceCriteria: extractAcceptanceCriteria(descText),
    issuetype: f.issuetype?.name ?? '',
  };
}

/** Get all available transitions for an issue */
export async function getTransitions(issueKey: string): Promise<JiraTransition[]> {
  const client = createClient();
  const res = await client.get(`/issue/${issueKey}/transitions`);
  return res.data.transitions.map((t: { id: string; name: string }) => ({ id: t.id, name: t.name }));
}

/** Move an issue to a new status by transition name */
export async function transitionIssue(issueKey: string, transitionName: string): Promise<void> {
  const transitions = await getTransitions(issueKey);
  const match = transitions.find(t => t.name.toLowerCase() === transitionName.toLowerCase());
  if (!match) {
    const available = transitions.map(t => t.name).join(', ');
    throw new Error(`Transition "${transitionName}" not found. Available: ${available}`);
  }
  const client = createClient();
  try {
    await client.post(`/issue/${issueKey}/transitions`, { transition: { id: match.id } });
  } catch (err) {
    const data = axios.isAxiosError(err)
      ? err.response?.data as { errors?: Record<string, string> } | undefined
      : undefined;
    const designatedTesterField = process.env.JIRA_CF_DESIGNATED_TESTER?.trim();
    const designatedTesterError = (designatedTesterField ? data?.errors?.[designatedTesterField] : '') ?? '';
    const designatedTester = process.env.JIRA_DESIGNATED_TESTER?.trim();
    if (!designatedTesterField || !/designated tester/i.test(designatedTesterError) || !designatedTester) throw err;

    // Some PROJ transitions enforce Designated Tester even when Jira does not expose it
    // as required in the transition list. Fill it from approved config and retry once.
    await updateIssueFields(issueKey, {
      [designatedTesterField]: { name: designatedTester },
    });
    await client.post(`/issue/${issueKey}/transitions`, { transition: { id: match.id } });
  }
  console.log(`[Jira] ${issueKey} → "${transitionName}"`);
}

/** Add a comment to an issue (Jira wiki markup for Data Center API v2) */
export async function addComment(issueKey: string, commentText: string): Promise<void> {
  const client = createClient();
  await client.post(`/issue/${issueKey}/comment`, { body: commentText });
  console.log(`[Jira] Comment added to ${issueKey}`);
}

/** Update issue description (wiki markup string for Jira Data Center API v2) */
export async function updateIssueDescription(issueKey: string, description: string): Promise<void> {
  const client = createClient();
  await client.put(`/issue/${issueKey}`, {
    fields: { description },
  });
  console.log(`[Jira] Description updated for ${issueKey}`);
}

/** Fetch selected raw Jira fields for workflow metadata not included in JiraIssue. */
export async function getIssueFields(
  issueKey: string,
  fields: string[],
): Promise<Record<string, unknown>> {
  const client = createClient();
  const res = await client.get(`/issue/${issueKey}`, {
    params: { fields: fields.join(',') },
  });
  return (res.data.fields ?? {}) as Record<string, unknown>;
}

/** Update arbitrary Jira fields, for example required transition metadata. */
export async function updateIssueFields(
  issueKey: string,
  fields: Record<string, unknown>,
): Promise<void> {
  const client = createClient();
  await client.put(`/issue/${issueKey}`, { fields });
  console.log(`[Jira] Fields updated for ${issueKey}`);
}

/** Get recent comments for an issue — returns body text of last N comments */
export async function getRecentComments(issueKey: string, maxResults = 10): Promise<string[]> {
  const client = createClient();
  const res = await client.get(`/issue/${issueKey}/comment`, {
    params: { maxResults, orderBy: '-created' },
  });
  return (res.data.comments ?? []).map((c: { body: string }) => c.body as string);
}

/** Attach a file to a Jira issue (robust multipart upload) */
export async function attachFile(issueKey: string, filePath: string): Promise<void> {
  if (!BASE_URL || !TOKEN) {
    throw new Error('Missing Jira config. Check JIRA_BASE_URL and JIRA_TOKEN in .env');
  }
  if (!fs.existsSync(filePath)) {
    throw new Error(`Attachment file not found: ${filePath}`);
  }

  const form = new FormData();
  form.append('file', fs.createReadStream(filePath));

  // Use a dedicated request, NOT the shared maxRedirects:0 client:
  //  - the attachment endpoint commonly 302-redirects (must follow it), and
  //  - the multipart Content-Type + boundary from form.getHeaders() must be sent
  //    verbatim. The previous code overrode it with `Content-Type: undefined`,
  //    which stripped the boundary and silently broke every upload.
  const baseURL = `${BASE_URL}/jira/rest/api/2`;
  await axios.post(`${baseURL}/issue/${issueKey}/attachments`, form, {
    headers: {
      ...form.getHeaders(),
      'Authorization': `Bearer ${TOKEN}`,
      'X-Atlassian-Token': 'no-check',
    },
    maxRedirects: 5,
    maxBodyLength: Infinity,
    maxContentLength: Infinity,
  });
  console.log(`[Jira] Attached ${path.basename(filePath)} to ${issueKey}`);
}

/** Create a new bug ticket in Jira */
export async function createBug(payload: CreateBugPayload): Promise<string> {
  const client = createClient();
  const designatedTester = process.env.JIRA_DESIGNATED_TESTER?.trim();
  const designatedTesterField = process.env.JIRA_CF_DESIGNATED_TESTER?.trim();
  if (designatedTesterField && !designatedTester) {
    throw new Error('Missing JIRA_DESIGNATED_TESTER (required because JIRA_CF_DESIGNATED_TESTER is set). Configure it in .env before filing Jira bugs.');
  }

  // Project-specific required fields (custom fields, severity, etc.) come from env — nothing is hardcoded.
  let bugDefaults: Record<string, unknown> = {};
  const rawDefaults = process.env.JIRA_BUG_DEFAULTS_JSON?.trim();
  if (rawDefaults) {
    try {
      bugDefaults = JSON.parse(rawDefaults) as Record<string, unknown>;
    } catch {
      throw new Error('JIRA_BUG_DEFAULTS_JSON is not valid JSON. Expected an object like {"customfield_10000":{"id":"123"}}.');
    }
  }
  const fixVersion = process.env.JIRA_FIX_VERSION?.trim();
  const priorityId = process.env.JIRA_BUG_PRIORITY_ID?.trim();

  const AI_FOOTER = '\n----\n🤖 This bug was filed by the QA AI Agent (GitHub Copilot). Reviewed by: the QA owner.';

  // Jira wiki markup (Data Center API v2)
  const description = [
    `*Issue:* ${payload.issue}`,
    '',
    `*Acceptance Criteria:* ${payload.acceptanceCriteria}`,
    '',
    `*Repro Steps:*`,
    payload.reproSteps,
    '',
    `*Environment:* ${payload.environment}`,
    AI_FOOTER,
  ].join('\n');

  const res = await client.post('/issue', {
    fields: {
      project:            { key: payload.project },
      summary:            payload.summary,
      issuetype:          { name: 'Bug' },
      ...(priorityId ? { priority: { id: priorityId } } : {}),
      description,
      labels:             [payload.environment.toLowerCase(), 'ai-generated'],
      ...(fixVersion ? { fixVersions: [{ name: fixVersion }] } : {}),
      ...bugDefaults,
      ...(designatedTesterField && designatedTester ? { [designatedTesterField]: { name: designatedTester } } : {}),
    },
  });

  const key = res.data.key as string;
  console.log(`[Jira] Bug created: ${key} — ${payload.summary}`);
  return key;
}

/** Get issues in "Ready for Testing" status for the project */
export async function getReadyForTestingIssues(projectKey: string): Promise<JiraIssue[]> {
  const client = createClient();
  const jql = `project = ${projectKey} AND status = "Ready for Testing" ORDER BY updated DESC`;
  const res = await client.get('/search', {
    params: { jql, fields: 'summary,description,status,labels,assignee,issuetype', maxResults: 50 },
  });

  return res.data.issues.map((issue: { key: string; fields: Record<string, unknown> }) => {
    const f = issue.fields as Record<string, unknown>;
    const descText = extractTextFromADF(f.description as Record<string, unknown> | null);
    return {
      key: issue.key,
      summary: (f.summary as string) ?? '',
      description: descText,
      status: (f.status as { name: string })?.name ?? '',
      labels: (f.labels as string[]) ?? [],
      assignee: (f.assignee as { displayName: string } | null)?.displayName ?? null,
      acceptanceCriteria: extractAcceptanceCriteria(descText),
      issuetype: (f.issuetype as { name: string })?.name ?? '',
    };
  });
}

/**
 * Get Story/Bug/Defect issues for a Jira Fix Version — used by the release
 * documentation flow to drive TestRail section creation + SmartLearn test case
 * generation. Excludes Task/Sub-task on purpose (per release-doc flow rules).
 */
export async function getIssuesByFixVersion(projectKey: string, fixVersion: string): Promise<JiraIssue[]> {
  const client = createClient();
  const jql = `project = ${projectKey} AND fixVersion = "${fixVersion}" AND issuetype in (Story, Bug, Defect) ORDER BY issuetype, key`;
  const res = await client.get('/search', {
    params: { jql, fields: 'summary,description,status,labels,assignee,issuetype', maxResults: 200 },
  });

  return res.data.issues.map((issue: { key: string; fields: Record<string, unknown> }) => {
    const f = issue.fields as Record<string, unknown>;
    const descText = extractTextFromADF(f.description as Record<string, unknown> | null);
    return {
      key: issue.key,
      summary: (f.summary as string) ?? '',
      description: descText,
      status: (f.status as { name: string })?.name ?? '',
      labels: (f.labels as string[]) ?? [],
      assignee: (f.assignee as { displayName: string } | null)?.displayName ?? null,
      acceptanceCriteria: extractAcceptanceCriteria(descText),
      issuetype: (f.issuetype as { name: string })?.name ?? '',
    };
  });
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/** Handle both Jira API v2 (plain string) and v3 (ADF object) description formats */
function extractTextFromADF(adf: unknown): string {
  if (!adf) return '';
  if (typeof adf === 'string') return adf;
  if (typeof adf !== 'object') return '';
  const node = adf as { content?: unknown[]; text?: string; type?: string };
  if (node.text) return node.text;
  if (!node.content) return '';
  return node.content.map(extractTextFromADF).join(' ');
}

function extractAcceptanceCriteria(text: string): string {
  const match = text.match(/acceptance criteria[:\s]+([\s\S]+?)(?=\n\n|\n[A-Z]|$)/i);
  return match ? match[1].trim() : text.slice(0, 500);
}
