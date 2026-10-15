// Auto-detect the Tempo inputs for a day WITHOUT any hand-editing:
//   - morning : the current weekly admin ticket (TEMPO_MORNING_TICKET / TEMPO_MORNING_SUMMARY),
//               resolved live from Jira as the most recently created one. This is
//               the fixed 08:00-10:00 block and rotates each week, so we never
//               hard-code it — we read whichever one exists now.
//   - tickets : the issues the QA owner actually worked on that day = issues assigned to
//               him that were updated within the target day. These become the
//               afternoon 30m validation blocks (fill-day cycles them to reach 8h).
//
//   node scripts/tempo/detect-day-tickets.mjs [YYYY-MM-DD] [--json]
//
// Auth = JIRA_TOKEN (Bearer). Override the morning ticket with TEMPO_MORNING_TICKET
// in .env if you ever need to pin a specific one.
import axios from 'axios';
import 'dotenv/config';

const BASE = process.env.JIRA_BASE_URL ?? '';
const TOKEN = process.env.JIRA_TOKEN ?? '';

function jira() {
  if (!BASE || !TOKEN) throw new Error('Missing JIRA_BASE_URL / JIRA_TOKEN in .env');
  return axios.create({
    baseURL: `${BASE}/jira/rest/api/2`,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
    maxRedirects: 0,
  });
}

function nextDay(iso) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

// The weekly admin morning ticket. Pinned via env, else the newest issue assigned
// to the current user whose summary matches TEMPO_MORNING_SUMMARY (auto-rotates weekly).
async function resolveMorning() {
  const pinned = (process.env.TEMPO_MORNING_TICKET ?? '').trim();
  if (pinned) return pinned;
  const summaryMatch = (process.env.TEMPO_MORNING_SUMMARY ?? '').trim().replace(/"/g, '');
  if (!summaryMatch) throw new Error('Set TEMPO_MORNING_TICKET (or TEMPO_MORNING_SUMMARY) in .env.');
  const jql = `assignee = currentUser() AND summary ~ "${summaryMatch}" ORDER BY created DESC`;
  const r = await jira().get('/search', { params: { jql, fields: 'key', maxResults: 1 } });
  const key = r.data.issues?.[0]?.key;
  if (!key) throw new Error(`Could not resolve the weekly morning ticket (no "${summaryMatch}" issue found). Set TEMPO_MORNING_TICKET in .env.`);
  return key;
}

// Issues the QA owner worked on that day = assigned to him and updated within the day.
async function resolveDayTickets(date, exclude) {
  const from = date;
  const to = nextDay(date);
  const jql = `assignee = currentUser() AND updated >= "${from}" AND updated < "${to}" ORDER BY updated DESC`;
  const r = await jira().get('/search', { params: { jql, fields: 'key', maxResults: 50 } });
  const keys = (r.data.issues ?? []).map((i) => i.key).filter((k) => k && k !== exclude);
  return [...new Set(keys)];
}

const date = (process.argv[2] && /^\d{4}-\d{2}-\d{2}$/.test(process.argv[2]))
  ? process.argv[2]
  : new Date().toISOString().slice(0, 10);
const asJson = process.argv.includes('--json');

const morning = await resolveMorning();
const tickets = await resolveDayTickets(date, morning);

if (asJson) {
  process.stdout.write(JSON.stringify({ date, morning, tickets }) + '\n');
} else {
  console.log(`Date         : ${date}`);
  console.log(`Morning      : ${morning}`);
  console.log(`Day tickets  : ${tickets.length ? tickets.join(', ') : '(none touched — fill-day will need a fallback)'}`);
}

export { resolveMorning, resolveDayTickets };
