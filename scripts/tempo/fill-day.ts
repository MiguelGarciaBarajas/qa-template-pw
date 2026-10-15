/**
 * Tempo day filler — completes ONE day to 8h (28800s) following the QA owner's real pattern.
 *
 * Pattern (mirrors historical worklogs on 2026-07-07 / 07-08):
 *   08:00–09:00  morning ticket  "Working on issue <KEY>"   (1h / 3600s)
 *   09:00–10:00  morning ticket  "Daily meeting"            (1h / 3600s)
 *   10:00→16:00  day tickets     "QA validation and bug triage" (30m / 1800s each)
 *   Total = 28800s (8h). Activity = Development on every worklog.
 *
 * Safe by default: refuses to write if the target day already has worklogs (use --force).
 *
 * Usage:
 *   npx tsx scripts/tempo/fill-day.ts --date 2026-07-14 --morning PROJ-1234 \
 *     --tickets PROJ-1234,PROJ-1234,... [--dry-run] [--force]
 *
 * Auth: JIRA_TOKEN (Bearer) — works for both Jira API and tempo-timesheets endpoints.
 * Worker: TEMPO_WORKER from the environment.
 */
import axios from 'axios';
import 'dotenv/config';

const BASE = process.env.JIRA_BASE_URL ?? '';
const TOKEN = process.env.JIRA_TOKEN ?? '';
const WORKER = process.env.TEMPO_WORKER ?? '';
const ACTIVITY_ATTR_ID = 32; // _Activity_ workAttributeId (STATIC_LIST) -> "Development"

interface Block {
  key: string;
  originTaskId: number;
  started: string;      // "YYYY-MM-DD HH:mm:ss.SSS"
  seconds: number;
  comment: string;
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

function jira() {
  if (!BASE || !TOKEN) throw new Error('Missing JIRA_BASE_URL / JIRA_TOKEN in .env');
  return axios.create({
    baseURL: `${BASE}/jira/rest/api/2`,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    maxRedirects: 0,
  });
}

async function resolveId(key: string): Promise<number> {
  const res = await jira().get(`/issue/${key}`, { params: { fields: 'id' } });
  return Number(res.data.id);
}

async function existingWorklogs(date: string): Promise<any[]> {
  const res = await axios.post(
    `${BASE}/jira/rest/tempo-timesheets/4/worklogs/search`,
    { from: date, to: date, worker: [WORKER] },
    { headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' }, maxRedirects: 0 },
  );
  return res.data as any[];
}

function fmt(date: string, h: number, m: number): string {
  const hh = String(h).padStart(2, '0');
  const mm = String(m).padStart(2, '0');
  return `${date} ${hh}:${mm}:00.000`;
}

async function createWorklog(b: Block): Promise<void> {
  const payload = {
    worker: WORKER,
    originTaskId: b.originTaskId,
    started: b.started,
    timeSpentSeconds: b.seconds,
    billableSeconds: b.seconds,
    comment: b.comment,
    attributes: {
      _Activity_: { workAttributeId: ACTIVITY_ATTR_ID, value: 'Development' },
    },
  };
  await axios.post(`${BASE}/jira/rest/tempo-timesheets/4/worklogs/`, payload, {
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    maxRedirects: 0,
  });
}

(async () => {
  if (!WORKER) {
    throw new Error('Missing TEMPO_WORKER in .env');
  }

  const date = arg('date');
  const morning = arg('morning');
  const ticketsCsv = arg('tickets');
  const afternoonComment = arg('comment') ?? 'QA validation and bug triage';
  const dryRun = hasFlag('dry-run');
  const force = hasFlag('force');

  if (!date || !morning || !ticketsCsv) {
    console.error('Required: --date YYYY-MM-DD --morning PROJ-#### --tickets PROJ-#,PROJ-#,...');
    process.exit(1);
  }
  const tickets = ticketsCsv.split(/[\s,]+/).map(t => t.trim()).filter(Boolean);

  console.log(`\n=== Tempo fill: ${date} (worker ${WORKER}) ===`);

  const existing = await existingWorklogs(date);
  const existingSecs = existing.reduce((s, l) => s + (l.timeSpentSeconds ?? 0), 0);
  console.log(`Existing worklogs: ${existing.length} (${(existingSecs / 3600).toFixed(2)}h)`);
  if (existing.length > 0 && !force) {
    console.error('Day is not empty. Aborting (use --force to add anyway).');
    process.exit(2);
  }

  // Resolve ids
  const morningId = await resolveId(morning);
  const ids: Record<string, number> = {};
  for (const k of tickets) {
    try { ids[k] = await resolveId(k); }
    catch { console.warn(`  WARN: could not resolve ${k}, skipping`); }
  }
  const resolved = tickets.filter(k => ids[k]);

  // Build blocks
  const blocks: Block[] = [];
  blocks.push({ key: morning, originTaskId: morningId, started: fmt(date, 8, 0), seconds: 3600, comment: `Working on issue ${morning}` });
  blocks.push({ key: morning, originTaskId: morningId, started: fmt(date, 9, 0), seconds: 3600, comment: 'Daily meeting' });

  const TOTAL = 28800;
  let filled = 7200;
  let h = 10, m = 0;
  let i = 0;
  while (filled < TOTAL && resolved.length) {
    const k = resolved[i % resolved.length];
    blocks.push({ key: k, originTaskId: ids[k], started: fmt(date, h, m), seconds: 1800, comment: afternoonComment });
    filled += 1800;
    i++;
    m += 30; if (m >= 60) { m = 0; h += 1; }
  }

  console.log(`\nPlan (${blocks.length} worklogs, ${(filled / 3600).toFixed(2)}h):`);
  for (const b of blocks) {
    console.log(`  ${b.started.slice(11, 16)}  ${String(b.seconds / 60).padStart(2)}m  ${b.key.padEnd(9)} #${b.originTaskId}  "${b.comment}"`);
  }

  if (dryRun) { console.log('\n[dry-run] no worklogs created.'); return; }

  console.log('\nCreating worklogs...');
  let ok = 0;
  for (const b of blocks) {
    try { await createWorklog(b); ok++; process.stdout.write('.'); }
    catch (e: any) { console.error(`\n  FAIL ${b.started} ${b.key}: ${e.response?.status} ${JSON.stringify(e.response?.data)?.slice(0, 200)}`); }
  }
  console.log(`\nCreated ${ok}/${blocks.length}.`);

  const after = await existingWorklogs(date);
  const afterSecs = after.reduce((s, l) => s + (l.timeSpentSeconds ?? 0), 0);
  console.log(`Day total now: ${afterSecs}s (${(afterSecs / 3600).toFixed(2)}h) ${afterSecs === TOTAL ? '✓' : '⚠️ expected 28800'}`);
})();
