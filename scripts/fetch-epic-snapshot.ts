import 'dotenv/config';
import axios from 'axios';
import fs from 'fs';

// Aggregated epic snapshot for the boss status report.
// Pulls ALL issues with Epic Link = PROJ-1 live from Jira, paginating,
// and writes scripts/epic-live-snapshot-<date>.json with statusCounts,
// typeCounts and bugCounts (mirrors the structure the report generator expects).

const BASE_URL = process.env.JIRA_BASE_URL ?? '';
const USER = process.env.JIRA_USER ?? '';
const TOKEN = process.env.JIRA_TOKEN ?? '';

// Fail early with a clear message instead of a cryptic ERR_INVALID_URL later.
if (!BASE_URL || !TOKEN) {
  const missing = [!BASE_URL && 'JIRA_BASE_URL', !TOKEN && 'JIRA_TOKEN'].filter(Boolean).join(', ');
  console.error(`ERROR: Missing required env vars: ${missing}`);
  console.error('Set them in .env (local) or as GitHub repo secrets (CI).');
  process.exit(1);
}

const client = axios.create({
  baseURL: `${BASE_URL}/jira/rest/api/2`,
  headers: {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${TOKEN}`,
  },
});

const EPIC = process.env.JIRA_EPIC ?? process.argv[3] ?? '';
if (!EPIC) {
  console.error('Set JIRA_EPIC in .env (or pass the epic key as 2nd arg).');
  process.exit(1);
}
const JQL = `"Epic Link" = ${EPIC}`;

async function fetchAll() {
  const issues: Array<{ key: string; status: string; type: string; priority: string; summary: string }> = [];
  let startAt = 0;
  const maxResults = 100;
  while (true) {
    const res = await client.get('/search', {
      params: { jql: JQL, fields: 'status,issuetype,priority,summary', startAt, maxResults },
    });
    const batch = res.data.issues as Array<{ key: string; fields: any }>;
    for (const i of batch) {
      issues.push({
        key: i.key,
        status: i.fields.status?.name ?? '?',
        type: i.fields.issuetype?.name ?? '?',
        priority: i.fields.priority?.name ?? '?',
        summary: i.fields.summary ?? '',
      });
    }
    startAt += batch.length;
    if (startAt >= res.data.total || batch.length === 0) break;
  }
  return issues;
}

function count<T extends string>(arr: string[]): Record<string, number> {
  const m: Record<string, number> = {};
  for (const k of arr) m[k] = (m[k] ?? 0) + 1;
  return m;
}

const dateArg = process.argv[2]; // e.g. 2026-07-31
if (!dateArg) {
  console.error('Usage: tsx scripts/fetch-epic-snapshot.ts <YYYY-MM-DD>');
  process.exit(1);
}
const [y, mo, day] = dateArg.split('-');
const generatedAt = `${mo}/${day}/${y}`;

const issues = await fetchAll();
console.log(`Fetched ${issues.length} epic issues`);

const statusCounts = count(issues.map((i) => i.status));
const typeCounts = count(issues.map((i) => i.type));

const bugs = issues.filter((i) => i.type === 'Bug');
const bugByStatus = count(bugs.map((i) => i.status));
const bugClosed = bugByStatus['Closed'] ?? 0;
const bugTotal = bugs.length;
const bugPipeline = bugTotal - bugClosed;
const bugActive = (bugByStatus['Open'] ?? 0) + (bugByStatus['In Progress'] ?? 0);

const allActive = (statusCounts['Open'] ?? 0) + (statusCounts['In Progress'] ?? 0);

// Per-ticket blocker list (auto-named in the report's section 4) = the bugs that
// genuinely block forward progress: status Open or In Progress ("confirmed active
// defects"). Sorted by priority so P1/P2 lead.
function priorityRank(p: string): number {
  const m = /^P(\d)/.exec(p);
  return m ? Number(m[1]) : 9;
}
const bugBlockers = bugs
  .filter((i) => i.status === 'Open' || i.status === 'In Progress')
  .map((i) => ({ key: i.key, priority: i.priority, status: i.status, summary: i.summary }))
  .sort((a, b) => priorityRank(a.priority) - priorityRank(b.priority) || a.key.localeCompare(b.key));

const snapshot = {
  generatedAt,
  total: issues.length,
  statusCounts,
  typeCounts,
  bugCounts: {
    total: bugTotal,
    byStatus: bugByStatus,
    closed: bugClosed,
    pipeline: bugPipeline,
    activeOpenInProgress: bugActive,
  },
  bugBlockers,
  activeAllIssues: allActive,
  jql: JQL,
};

const out = `scripts/epic-live-snapshot-${dateArg}.json`;
fs.writeFileSync(out, JSON.stringify(snapshot, null, 2));
console.log('Saved:', out);
console.log(JSON.stringify(snapshot, null, 2));
