// Post the daily QA status report to Microsoft Teams as a PLAIN TEXT message
// (not a card, not a file attachment) via Workflows webhooks.
//
//   node scripts/send-teams-report.mjs [YYYY-MM-DD]
//
// Reads artifacts/QA_Status_Report_<date>.txt and POSTs it as { "text": "<html>" }
// to each configured Teams webhook. Newlines become <br> so the message keeps the
// same line layout as the .txt (Teams "Post message" renders HTML).
//
//   TEAMS_WEBHOOK_PRIMARY     -> primary chat/channel (display name: TEAMS_CHANNEL_PRIMARY_NAME)
//   TEAMS_WEBHOOK_SECONDARY   -> optional second chat/channel (display name: TEAMS_CHANNEL_SECONDARY_NAME)
//
// Flow to build (Teams > Apps > Workflows): trigger "When a Teams webhook request
// is received" -> action "Post message in a chat or channel", Message =
// expression triggerBody()?['text']. Missing URLs are skipped with a warning, and
// a delivery failure never discards the generated report.
import 'dotenv/config';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

// Corporate TLS-inspecting proxies present a self-signed root CA on external
// hosts (*.powerplatform.com). NODE_EXTRA_CA_CERTS must be set BEFORE Node
// starts for global fetch to honor it, so if a CA bundle exists and the env
// var isn't set, re-exec this script once with it configured.
const caBundle = path.join(ROOT, 'scripts', 'corp-ca-bundle.pem');
if (existsSync(caBundle) && !process.env.NODE_EXTRA_CA_CERTS) {
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), ...process.argv.slice(2)], {
    stdio: 'inherit',
    env: { ...process.env, NODE_EXTRA_CA_CERTS: caBundle },
  });
  process.exit(r.status ?? 1);
}

const targets = [
  { name: process.env.TEAMS_CHANNEL_PRIMARY_NAME || 'Primary channel', url: process.env.TEAMS_WEBHOOK_PRIMARY },
  { name: process.env.TEAMS_CHANNEL_SECONDARY_NAME || 'Secondary channel', url: process.env.TEAMS_WEBHOOK_SECONDARY },
];

const args = process.argv.slice(2);
const isDateArg = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s);
const dateArg = args.find((a) => isDateArg(a));
const dateStr = dateArg || new Date().toISOString().slice(0, 10);
const allowBackfill = args.includes('--allow-backfill');
const forceSend = args.includes('--force-send');
const todayStr = new Date().toISOString().slice(0, 10);

if (dateStr !== todayStr && !allowBackfill) {
  console.warn(
    `Skipping Teams delivery for ${dateStr}: backfill sends are disabled by default. ` +
    'Use --allow-backfill to send a non-today report.'
  );
  process.exit(0);
}

const txtPath = path.join(ROOT, 'artifacts', `QA_Status_Report_${dateStr}.txt`);
const statePath = path.join(ROOT, 'artifacts', 'teams-delivery-state.json');

if (!existsSync(txtPath)) {
  console.error(`ERROR: report not found: ${txtPath}\nGenerate it first (run-daily-report.mjs).`);
  process.exit(1);
}

const report = readFileSync(txtPath, 'utf8').replace(/\s+$/, '');

// Escape HTML, then keep line breaks as <br> so Teams shows the same layout as
// the .txt — a plain text message, not a card and not a file.
const html = report
  .replace(/&/g, '&amp;')
  .replace(/</g, '&lt;')
  .replace(/>/g, '&gt;')
  .replace(/\r?\n/g, '<br>');

async function post(target) {
  const res = await fetch(target.url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: html }),
  });
  const bodyText = await res.text().catch(() => '');
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText} ${bodyText}`.trim());
  }
  return bodyText;
}

function readState() {
  if (!existsSync(statePath)) return { dates: {} };
  const raw = readFileSync(statePath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || typeof parsed !== 'object' || !parsed.dates || typeof parsed.dates !== 'object') {
    throw new Error(`Invalid state file schema: ${statePath}`);
  }
  return parsed;
}

function persistState(state) {
  writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n', 'utf8');
}

const configured = targets.filter((t) => t.url && t.url.trim());
if (configured.length === 0) {
  console.warn(
    'WARNING: no Teams webhooks configured (TEAMS_WEBHOOK_PRIMARY / TEAMS_WEBHOOK_SECONDARY). ' +
    'Skipping Teams delivery. Add the URLs to .env to enable it.'
  );
  process.exit(0);
}

const state = readState();
state.dates[dateStr] ??= { targets: {} };

let failed = 0;
let posted = 0;
let skipped = 0;
for (const t of configured) {
  const alreadySent = Boolean(state.dates[dateStr].targets?.[t.name]);
  if (alreadySent && !forceSend) {
    skipped += 1;
    console.log(`Skipped (already delivered today): ${t.name} for report ${dateStr}`);
    continue;
  }
  try {
    await post(t);
    state.dates[dateStr].targets[t.name] = new Date().toISOString();
    persistState(state);
    posted += 1;
    console.log(`Posted to Teams: ${t.name}`);
  } catch (err) {
    failed += 1;
    console.error(`FAILED to post to "${t.name}": ${err.message}`);
  }
}

if (failed > 0) {
  console.error(`${failed}/${configured.length} Teams post(s) failed.`);
  process.exit(1);
}
if (posted === 0 && skipped > 0) {
  console.log(`No new Teams posts sent (${skipped} target(s) were already delivered for ${dateStr}).`);
  process.exit(0);
}
console.log(`Delivered report to ${posted} Teams target(s).`);
