// Unattended daily status-report runner (for cron / Task Scheduler / CI).
//
//   node scripts/run-daily-report.mjs [YYYY-MM-DD]
//
// Steps (nothing is hand-edited):
//   1. Resolve TODAY (arg or local today) and the previous BUSINESS day.
//   2. Fetch the previous-business-day snapshot if it's missing.
//   3. (Re)fetch today's snapshot — live from Jira.
//   4. Generate the report (.txt + .docx) into artifacts/.
//
// Jira creds come from the environment / .env (fetch-epic-snapshot.ts loads
// dotenv). Exit non-zero on any failure so schedulers/CI surface it.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const python = process.platform === 'win32' ? 'python' : 'python3';

// Corporate TLS-inspecting proxies present a self-signed root CA that Node
// doesn't trust by default (external hosts like *.powerplatform.com). If a CA
// bundle exists next to the scripts, point Node at it so the Teams POST works.
const caBundle = path.join(ROOT, 'scripts', 'corp-ca-bundle.pem');
if (existsSync(caBundle) && !process.env.NODE_EXTRA_CA_CERTS) {
  process.env.NODE_EXTRA_CA_CERTS = caBundle;
}

function iso(d) {
  return d.toISOString().slice(0, 10);
}

function prevBusinessDay(d) {
  const x = new Date(d);
  do {
    x.setUTCDate(x.getUTCDate() - 1);
  } while (x.getUTCDay() === 0 || x.getUTCDay() === 6); // 0 Sun, 6 Sat
  return x;
}

function run(cmd, args) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  // On Windows, spawning .cmd/.bat shims (npx.cmd) requires a shell; Node >=20
  // rejects them with EINVAL otherwise. But a shell mangles paths with spaces
  // (e.g. process.execPath = "C:\Program Files\nodejs\node.exe"), so only use a
  // shell for the .cmd/.bat shims that actually need it.
  const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd);
  execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: needsShell });
}

const arg = process.argv[2];
const today = arg ? new Date(`${arg}T00:00:00Z`) : new Date();
const todayStr = iso(today);
const prevStr = iso(prevBusinessDay(today));

console.log(`Daily report -> today=${todayStr}, prevBusinessDay=${prevStr}`);

const prevSnap = path.join(ROOT, 'scripts', `epic-live-snapshot-${prevStr}.json`);
if (!existsSync(prevSnap)) {
  console.log(`Previous-day snapshot missing, fetching ${prevStr}...`);
  run(npx, ['tsx', 'scripts/fetch-epic-snapshot.ts', prevStr]);
}

run(npx, ['tsx', 'scripts/fetch-epic-snapshot.ts', todayStr]);
run(python, ['scripts/generate-status-report.py', todayStr]);

// Deliver to Teams (best-effort: a delivery failure must not discard the report).
try {
  run(process.execPath, ['scripts/send-teams-report.mjs', todayStr]);
} catch (err) {
  console.error(`WARNING: Teams delivery failed: ${err.message}`);
}

console.log('\nDone. Report written to artifacts/QA_Status_Report_' + todayStr + '.{txt,docx}');
