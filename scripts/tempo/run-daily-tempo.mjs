// Unattended daily Tempo filler (for Windows Task Scheduler at 17:00).
//
//   node scripts/tempo/run-daily-tempo.mjs [YYYY-MM-DD] [--write]
//
// Nothing is hand-edited. Steps:
//   1. Resolve TODAY (arg or local today). Skip weekends (no timesheet on Sat/Sun).
//   2. Auto-detect the weekly morning ticket + the tickets worked today (Jira).
//   3. If nothing was touched today, widen the lookback so the day still fills.
//   4. Call scripts/tempo/fill-day.ts to complete the day to 8h.
//
// SAFETY: dry-run by default (prints the plan, writes nothing). A real write only
// happens with --write or TEMPO_AUTOWRITE=1. fill-day itself is safe-by-default too
// (it aborts if the day already has worklogs, so re-runs never duplicate).
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { resolveMorning, resolveDayTickets } from './detect-day-tickets.mjs';

const ROOT = path.dirname(path.dirname(path.dirname(fileURLToPath(import.meta.url))));
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

// Corporate TLS bundle (harmless for internal Jira, needed if any external host is hit).
const caBundle = path.join(ROOT, 'scripts', 'corp-ca-bundle.pem');
if (existsSync(caBundle) && !process.env.NODE_EXTRA_CA_CERTS) {
  process.env.NODE_EXTRA_CA_CERTS = caBundle;
}

function iso(d) {
  return d.toISOString().slice(0, 10);
}
function nextDay(isoStr) {
  const d = new Date(`${isoStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return iso(d);
}

function run(cmd, args) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  // Only .cmd/.bat shims need a shell on Windows; a shell mangles paths with spaces.
  const needsShell = process.platform === 'win32' && /\.(cmd|bat)$/i.test(cmd);
  execFileSync(cmd, args, { cwd: ROOT, stdio: 'inherit', shell: needsShell });
}

// Widen the lookback (business days) until we have some tickets to log against.
const arg = process.argv[2];
const write = process.argv.includes('--write') || process.env.TEMPO_AUTOWRITE === '1';
const today = arg && /^\d{4}-\d{2}-\d{2}$/.test(arg) ? new Date(`${arg}T00:00:00Z`) : new Date();
const dateStr = iso(today);

const dow = today.getUTCDay(); // 0 Sun, 6 Sat
if (dow === 0 || dow === 6) {
  console.log(`Daily Tempo -> ${dateStr} is a weekend. Nothing to log. Exiting.`);
  process.exit(0);
}

console.log(`Daily Tempo -> date=${dateStr}, mode=${write ? 'WRITE' : 'dry-run'}`);

const morning = await resolveMorning();
console.log(`Morning ticket (weekly admin): ${morning}`);

let tickets = await resolveDayTickets(dateStr, morning);
if (!tickets.length) {
  // Widen: scan the trailing week for assigned issues that were updated.
  const start = new Date(`${dateStr}T00:00:00Z`);
  start.setUTCDate(start.getUTCDate() - 6);
  const seen = new Set();
  for (let d = new Date(start); iso(d) <= dateStr; d.setUTCDate(d.getUTCDate() + 1)) {
    const day = iso(d);
    const dd = d.getUTCDay();
    if (dd === 0 || dd === 6) continue;
    for (const k of await resolveDayTickets(day, morning)) seen.add(k);
  }
  tickets = [...seen];
  console.log(`Widened lookback found ${tickets.length} ticket(s).`);
}

if (!tickets.length) {
  console.error('No tickets found to log against (even after widening). Aborting to avoid an empty day.');
  process.exit(3);
}
console.log(`Day tickets: ${tickets.join(', ')}`);

const fillArgs = ['tsx', 'scripts/tempo/fill-day.ts', '--date', dateStr, '--morning', morning, '--tickets', tickets.join(',')];
if (!write) fillArgs.push('--dry-run');

run(npx, fillArgs);

console.log(`\nDone (${write ? 'worklogs written' : 'dry-run only — pass --write or set TEMPO_AUTOWRITE=1 to log for real'}).`);
