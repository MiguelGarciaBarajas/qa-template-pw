/**
 * rft-dashboard.ts — Live terminal dashboard for all tickets under an epic
 * (default PROJ-1).
 *
 * Polls Jira every N seconds and redraws an auto-refreshing table so you can
 * watch ticket status in real time, right in the terminal (no browser needed —
 * unlike `python dashboard.py`).
 *
 * Difficulty column reuses the agent/skill classification for PROJ-1.
 *
 * Usage:
 *   npx tsx scripts/rft-dashboard.ts
 *   npx tsx scripts/rft-dashboard.ts --epic PROJ-1 --interval 30
 *   npx tsx scripts/rft-dashboard.ts --bugs         # only issuetype = Bug
  *   npx tsx scripts/rft-dashboard.ts --active        # only Ready for Testing + In Testing
  *   npx tsx scripts/rft-dashboard.ts --once         # render one frame and exit
 *   npx tsx scripts/rft-dashboard.ts --no-color
 */

import axios, { type AxiosInstance } from 'axios';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import 'dotenv/config';

// ─── Config ──────────────────────────────────────────────────────────────
const BASE_URL = (process.env.JIRA_BASE_URL ?? 'https://jira.example.com').replace(/\/+$/, '');
const TOKEN = process.env.JIRA_TOKEN ?? '';

function argVal(flag: string, def: string): string {
  const i = process.argv.indexOf(flag);
  const v = i >= 0 ? process.argv[i + 1] : undefined;
  return v && !v.startsWith('--') ? v : def;
}

const EPIC = argVal('--epic', process.env.JIRA_EPIC ?? '');
const INTERVAL = Math.max(5, Number.parseInt(argVal('--interval', '30'), 10) || 30);
const ONCE = process.argv.includes('--once');
const BUGS_ONLY = process.argv.includes('--bugs');
// --active / --queue: only show tickets that are actionable right now
// (Ready for Testing + In Testing).
const ACTIVE_ONLY = process.argv.includes('--active') || process.argv.includes('--queue');
const NO_COLOR = process.argv.includes('--no-color') || !!process.env.NO_COLOR || !process.stdout.isTTY;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const STATE_FILE = path.join(ROOT, 'artifacts', 'run-state.json');

// ─── Difficulty classification (PROJ-1 Ready-for-Testing analysis) ───────
type Tier = 'EASY' | 'MED' | 'MHARD' | 'NOAP';
const DIFFICULTY: Record<string, Tier> = {
  // 'PROJ-1234': 'EASY', // curated per-ticket tier (optional)
};
const TIER_ORDER: Record<string, number> = { EASY: 0, MED: 1, MHARD: 2, NOAP: 3, '?': 4 };

// Re-reviewed against live Jira details for the Ready for Testing + In Testing
// queue on 2026-10-01. Explicit entries are the exceptions to the conservative
// default that operational Tasks/Stories are not agent-testable without their
// owner, environment, or fixture prerequisites.
const ACTIVE_QUEUE_OVERRIDES: Record<string, Tier> = {
  // 'PROJ-1234': 'EASY',
};

const ACTIVE_QUEUE_NOAP = new Set<string>([
  // keys with no safe agent-run path until prerequisites are met
]);

// ─── Auto-classification fallback ───────────────────────────────────────────
// Any ticket NOT in the curated DIFFICULTY map above is auto-classified from its
// type/summary/status so the dashboard never shows an unrated "?" — new arrivals
// get a best-effort tier immediately. Auto-inferred rows are flagged (rendered
// with a trailing "*") so they stay visually distinct from the curated ones.
function inferTier(summary: string, type: string, status: string): Tier {
  const s = (summary || '').toLowerCase();
  const t = (type || '').trim().toLowerCase();
  const st = (status || '').trim().toLowerCase();

  // 🔴 infra / secrets / DB-grant / observability / CI / decision / env-outage
  const noapRe = /(secret|kubeconfig|namespace|traefik|grant execute|credential|client_credentials|\brotate\b|provision|deployment|\bdeploy\b|\bworker\b|backplane|websocket|ingress|egress|network\s?policy|graylog|observab|monitoring|smoke gate|\bci\b|pipeline|sql instance|sql plan|sql server|database migration|unreachable|is down|outage|\bdecision\b|testrail|worklog|tempo|policy compliance|soft launch|cutover|performance environment|50-user|antivirus|production-only|\bprod\b|\bprd\b)/;
  // 🟠 timing / intermittent / load — hard to reproduce reliably in one run
  const mhardRe = /(intermittent|inconsistent|under load|load test|\btiming\b|race condition|\bflaky\b|60 seconds|\blatency\b|reconciliation|operation matrix|multiple (?:screens|surfaces|flows)|cross[- ]module|legacy parity|parity gaps|certification|multi[- ]form|multi[- ]step)/;
  // 🟢 pure snapshot / absence / styling / redirect — single-check
  const easyRe = /(styling|mandatory|remove |should not (see|show|appear)|absence|redirect|snapshot|\bhide\b|collapsed|tooltip|placeholder)/;

  if (st === 'ready for testing' || st === 'in testing') {
    if (t === 'task' || t === 'story' || t === 'sub-task' || t === 'subtask') return 'NOAP';
  }
  // Operational/permission gates take precedence over reproduction difficulty.
  if (noapRe.test(s)) return 'NOAP';
  if (mhardRe.test(s)) return 'MHARD';
  if (easyRe.test(s)) return 'EASY';
  return 'MED'; // default: a UI-reachable bug is Medium
}

// Resolve a ticket's tier: curated map wins; otherwise auto-infer.
// Returns the tier plus whether it was auto-inferred.
function resolveTier(
  key: string, summary: string, type: string, status: string,
): { tier: Tier; inferred: boolean } {
  const active = /^(ready for testing|in testing)$/i.test(status.trim());
  if (active) {
    const reviewed = ACTIVE_QUEUE_OVERRIDES[key];
    if (reviewed) return { tier: reviewed, inferred: false };
    if (ACTIVE_QUEUE_NOAP.has(key)) return { tier: 'NOAP', inferred: false };
    return { tier: inferTier(summary, type, status), inferred: true };
  }
  const curated = DIFFICULTY[key];
  if (curated) return { tier: curated, inferred: false };
  return { tier: inferTier(summary, type, status), inferred: true };
}

// ─── ANSI colors ───────────────────────────────────────────────────────────
const wrap = (code: string) => (s: string): string => (NO_COLOR ? s : `\x1b[${code}m${s}\x1b[0m`);
const dim = wrap('2');
const bold = wrap('1');
const red = wrap('31');
const green = wrap('32');
const yellow = wrap('33');
const magenta = wrap('35');
const cyan = wrap('36');
const gray = wrap('90');
const boldYellow = wrap('1;33');
const invCyan = wrap('7;36');

// ─── Status buckets ──────────────────────────────────────────────────────
type Bucket = 'pending' | 'testing' | 'passed' | 'failed' | 'other';
function bucketOf(status: string): Bucket {
  const s = status.trim().toLowerCase();
  if (s === 'ready for testing') return 'pending';
  if (s === 'in testing') return 'testing';
  if (s === 'in progress') return 'failed';
  if (s === 'performance test' || s.includes('acceptance') || s === 'closed' || s === 'done' || s === 'resolved') {
    return 'passed';
  }
  return 'other';
}

function colorTier(t: string, text: string): string {
  switch (t) {
    case 'EASY': return green(text);
    case 'MED': return yellow(text);
    case 'MHARD': return magenta(text);
    case 'NOAP': return red(text);
    default: return gray(text);
  }
}

// Short 4-char code + color per Jira issue type
function shortType(name: string): string {
  const s = name.trim().toLowerCase();
  if (s === 'bug') return 'BUG';
  if (s === 'story') return 'STRY';
  if (s === 'task' || s === 'sub-task' || s === 'subtask') return 'TASK';
  if (s === 'epic') return 'EPIC';
  return (name || '?').slice(0, 4).toUpperCase();
}

function colorType(name: string, text: string): string {
  switch (name.trim().toLowerCase()) {
    case 'bug': return red(text);
    case 'story': return green(text);
    case 'task': case 'sub-task': case 'subtask': return cyan(text);
    case 'epic': return magenta(text);
    default: return gray(text);
  }
}

function colorStatus(b: Bucket, text: string): string {
  switch (b) {
    case 'pending': return cyan(text);
    case 'testing': return boldYellow(text);
    case 'passed': return green(text);
    case 'failed': return red(text);
    default: return gray(text);
  }
}

// ─── Jira ──────────────────────────────────────────────────────────────────
interface JiraSearchIssue {
  key: string;
  fields: {
    summary?: string;
    status?: { name?: string };
    priority?: { name?: string };
    issuetype?: { name?: string };
  };
}
interface Row { key: string; summary: string; status: string; prio: string; tier: string; type: string; inferred: boolean; }

function client(): AxiosInstance {
  return axios.create({
    baseURL: `${BASE_URL}/jira/rest/api/2`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${TOKEN}` },
    maxRedirects: 0,
    timeout: 20_000,
  });
}

function shortPrio(name: string): string {
  const m = name.match(/P\d/i);
  return m ? m[0].toUpperCase() : '';
}

async function poll(_tracked: Set<string>): Promise<Row[]> {
  const typeClause = BUGS_ONLY ? ' AND issuetype = Bug' : '';
  const jql =
    `("Epic Link" = ${EPIC} OR parent = ${EPIC}) ` +
    `${typeClause} ORDER BY key`;
  const jira = client();
  const issues: JiraSearchIssue[] = [];
  const maxResults = 200;
  let startAt = 0;
  let total = 0;

  do {
    const res = await jira.get('/search', {
      params: {
        jql,
        fields: 'summary,status,priority,issuetype',
        startAt,
        maxResults,
      },
    });
    const data = res.data as { issues?: JiraSearchIssue[]; total?: number };
    const page = data.issues ?? [];
    issues.push(...page);
    total = data.total ?? issues.length;
    startAt += page.length;
    if (!page.length) break;
  } while (startAt < total);

  let visibleIssues = issues;
  if (BUGS_ONLY) {
    visibleIssues = issues.filter((i) => (i.fields.issuetype?.name ?? '').toLowerCase() === 'bug');
  }
  if (ACTIVE_ONLY) {
    visibleIssues = visibleIssues.filter((i) => {
      const s = (i.fields.status?.name ?? '').trim().toLowerCase();
      return s === 'ready for testing' || s === 'in testing';
    });
  }
  return visibleIssues.map((i) => {
    const summary = i.fields.summary ?? '';
    const type = i.fields.issuetype?.name ?? '';
    const status = i.fields.status?.name ?? 'Unknown';
    const { tier, inferred } = resolveTier(i.key, summary, type, status);
    return {
      key: i.key,
      summary,
      status,
      prio: shortPrio(i.fields.priority?.name ?? ''),
      tier,
      type,
      inferred,
    };
  });
}

// ─── run-state.json overlay (agent "testing now" marker) ───────────────────
function currentlyTesting(): string | null {
  try {
    const j = JSON.parse(fs.readFileSync(STATE_FILE, 'utf8')) as { current?: unknown };
    const c = j.current;
    if (typeof c === 'string') return c;
    if (c && typeof c === 'object' && 'key' in c) return String((c as { key: unknown }).key);
    return null;
  } catch {
    return null;
  }
}

// ─── Rendering ──────────────────────────────────────────────────────────────
function fit(s: string, w: number): string {
  if (s.length > w) return `${s.slice(0, Math.max(0, w - 1))}…`;
  return s.padEnd(w);
}

function progressBar(frac: number, width: number): string {
  const filled = Math.max(0, Math.min(width, Math.round(frac * width)));
  return `${'█'.repeat(filled)}${'░'.repeat(width - filled)}`;
}

function render(rows: Row[], frame: number, error: string): void {
  const cols = process.stdout.columns || 120;
  const now = new Date().toLocaleTimeString();

  // sort: difficulty tier, then key
  const sorted = [...rows].sort((a, b) => {
    const t = (TIER_ORDER[a.tier] ?? 9) - (TIER_ORDER[b.tier] ?? 9);
    return t !== 0 ? t : a.key.localeCompare(b.key);
  });

  const counts = { pending: 0, testing: 0, passed: 0, failed: 0, other: 0 };
  for (const r of rows) counts[bucketOf(r.status)]++;
  const total = rows.length;
  const advanced = total - counts.pending;
  const frac = total ? advanced / total : 0;
  const testingNow = currentlyTesting();

  // column widths
  const W = { mark: 2, key: 8, pri: 3, diff: 6, type: 4, status: 18 };
  const fixed = W.mark + W.key + W.pri + W.diff + W.type + W.status + 6; // + single-space separators
  const wSum = Math.max(20, cols - fixed - 1);

  const lines: string[] = [];
  const rule = dim('─'.repeat(Math.min(cols - 1, fixed + wSum)));

  // title
  const titleText = BUGS_ONLY ? 'Bugs — Epic Tickets — LIVE' : 'Epic Tickets — LIVE';
  lines.push(
    `${invCyan(' QA BRAIN ')} ${bold(titleText)}  ${dim('epic')} ${cyan(EPIC)}` +
      `   ${dim(now)}  ${dim(`refresh ${INTERVAL}s · #${frame}`)}`,
  );
  // stats
  lines.push(
    `  ${dim('Tracked')} ${bold(String(total))}   ` +
      `${cyan('Ready ' + counts.pending)}   ` +
      `${boldYellow('In Testing ' + counts.testing)}   ` +
      `${green('Pass ' + counts.passed)}   ` +
      `${red('In Progress ' + counts.failed)}` +
      (counts.other ? `   ${gray('Other ' + counts.other)}` : ''),
  );
  // progress
  lines.push(
    `  ${green(progressBar(frac, 30))} ${bold(`${Math.round(frac * 100)}%`)} ` +
      dim(`(${advanced}/${total} advanced out of Ready)`),
  );
  if (error) lines.push(`  ${red('⚠ ' + error)} ${dim('(showing last data)')}`);
  lines.push('');

  // header
  lines.push(
    bold(
      `${''.padEnd(W.mark)} ${'TYPE'.padEnd(W.type)} ${'KEY'.padEnd(W.key)} ${'PRI'.padEnd(W.pri)} ` +
        `${'DIFF'.padEnd(W.diff)} ${'STATUS'.padEnd(W.status)} SUMMARY`,
    ),
  );
  lines.push(rule);

  if (!sorted.length) {
    lines.push(dim('  (no tickets — connecting to Jira or queue is empty)'));
  }
  for (const r of sorted) {
    const b = bucketOf(r.status);
    const mark = testingNow === r.key ? boldYellow('▶ ') : '  ';
    const key = r.key.padEnd(W.key);
    const pri = r.prio.padEnd(W.pri);
    const diffText = r.inferred ? `${r.tier}*` : r.tier;
    const diff = colorTier(r.tier, diffText.padEnd(W.diff));
    const type = colorType(r.type, shortType(r.type).padEnd(W.type));
    const status = colorStatus(b, fit(r.status, W.status));
    const summary = fit(r.summary, wSum);
    lines.push(`${mark} ${type} ${key} ${pri} ${diff} ${status} ${summary}`);
  }

  lines.push(rule);
  lines.push(
    dim('  DIFF: ') +
      green('EASY') + dim(' · ') + yellow('MED') + dim(' · ') +
      magenta('MHARD') + dim(' · ') + red('NOAP') + dim(' · ') + dim('* = auto') +
      dim('    TYPE: ') + red('BUG') + dim(' · ') + green('STRY') + dim(' · ') +
      cyan('TASK') + dim(' · ') + magenta('EPIC') +
      dim('    STATUS: ') + cyan('Ready') + dim(' · ') + boldYellow('In Testing') +
      dim(' · ') + green('Pass') + dim(' · ') + red('In Progress'),
  );
  lines.push(dim('  NOAP = no safe agent test path until required owner, environment, access, or fixture prerequisites are met.'));
  lines.push(dim(`  ${BASE_URL}/jira/browse/${EPIC}    ·    Ctrl+C to exit`));

  if (!NO_COLOR) process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
  else process.stdout.write('\n');
  process.stdout.write(lines.join('\n') + '\n');
}

// ─── Main loop ──────────────────────────────────────────────────────────────
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main(): Promise<void> {
  if (!TOKEN) {
    console.error('Missing JIRA_TOKEN in .env — cannot query Jira.');
    process.exit(1);
  }
  if (!EPIC) {
    console.error('Missing epic key — pass --epic PROJ-123 or set JIRA_EPIC in .env.');
    process.exit(1);
  }

  const tracked = new Set<string>();
  let frame = 0;
  let rows: Row[] = [];
  let error = '';

  const restore = (): void => {
    if (!NO_COLOR && !ONCE) process.stdout.write('\x1b[?25h');
  };
  process.on('SIGINT', () => { restore(); process.exit(0); });
  process.on('SIGTERM', () => { restore(); process.exit(0); });
  if (!NO_COLOR && !ONCE) process.stdout.write('\x1b[?25l'); // hide cursor

  process.stdout.write(dim(`Connecting to ${BASE_URL} …\n`));

  for (;;) {
    frame++;
    try {
      rows = await poll(tracked);
      for (const r of rows) tracked.add(r.key);
      error = '';
    } catch (e) {
      const err = e as { response?: { status?: number }; message?: string };
      error = `Jira poll failed: ${err.response?.status ?? ''} ${err.message ?? String(e)}`.trim();
    }
    render(rows, frame, error);
    if (ONCE) break;
    await sleep(INTERVAL * 1000);
  }
  restore();
}

main().catch((e) => {
  if (!NO_COLOR) process.stdout.write('\x1b[?25h');
  console.error(e);
  process.exit(1);
});
