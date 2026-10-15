import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';

/**
 * Create a TestRail Test Run from local ticket validations (artifacts/<KEY>/result.json).
 *
 * Because our PROJ Jira tickets do NOT map 1:1 to existing TestRail cases, this tool
 * creates one case per ticket in a section of the target suite, creates a run over those
 * cases, and posts a result per case mirroring the validation verdict.
 *
 * Usage:
 *   npx tsx scripts/testrail/create-run-from-validations.ts PROJ-1234 PROJ-1234 ... [flags]
 *   npx tsx scripts/testrail/create-run-from-validations.ts --keys-file keys.txt [flags]
 * Flags:
 *   --project <id>        TestRail project id (default: env TESTRAIL_PROJECT_ID)
 *   --suite <id>          TestRail suite id  (default: env TESTRAIL_SUITE_ID)
 *   --section <id>        Reuse an existing section instead of creating one
 *   --section-name <str>  Name for a new section
 *   --run-name <str>      Name for the run
 *   --dry-run             Print the plan, do not mutate TestRail
 *
 * TestRail facts (verify for your project): cases use template_id=2 and the field
 * custom_automation_status may be REQUIRED (1=Pending Review). Status ids: 1 Passed, 2 Blocked,
 * 4 Retest, 5 Failed. Verdict map: PASS->1, FAIL->5, INCONCLUSIVE->4, NO-RESULT->4 (Retest).
 */

const TR = (process.env.TESTRAIL_BASE_URL ?? '').replace(/\/$/, '');
const auth = Buffer.from(`${process.env.TESTRAIL_USERNAME ?? ''}:${process.env.TESTRAIL_API_KEY ?? ''}`).toString('base64');
const tr = axios.create({ baseURL: `${TR}/index.php?/api/v2`, headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' } });
const JIRA = (process.env.JIRA_BASE_URL ?? '').replace(/\/$/, '');
const JTOKEN = process.env.JIRA_TOKEN ?? '';

const AI_FOOTER = '\n\n_🤖 Validated by the QA AI Agent (GitHub Copilot). Reviewed by: the QA owner._';
const STATUS: Record<string, number> = { PASS: 1, FAIL: 5, INCONCLUSIVE: 4, 'NO-RESULT': 4 };

function flag(name: string, fallback = ''): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}
const hasFlag = (name: string) => process.argv.includes(`--${name}`);

const PROJECT = Number(flag('project', process.env.TESTRAIL_PROJECT_ID ?? ''));
const SUITE = Number(flag('suite', process.env.TESTRAIL_SUITE_ID ?? ''));
if (!PROJECT || !SUITE) {
  console.error('Missing TestRail project/suite. Pass --project <id> --suite <id> or set TESTRAIL_PROJECT_ID / TESTRAIL_SUITE_ID.');
  process.exit(1);
}
const stamp = new Date().toISOString().slice(0, 10);
const RUN_PREFIX = process.env.TESTRAIL_RUN_NAME_PREFIX?.trim() || 'QA AI Agent';
const SECTION_NAME = flag('section-name', `${RUN_PREFIX} — Validations (${stamp})`);
const RUN_NAME = flag('run-name', `${RUN_PREFIX} — Manual Validations ${stamp}`);

interface Row { key: string; jiraStatus: string; title: string; verdict: string; summary: string; res: any | null; }

function loadResult(key: string): any | null {
  const p = path.resolve('artifacts', key, 'result.json');
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, 'utf-8')); } catch { return null; }
}
function verdictOf(res: any | null): string {
  if (!res) return 'NO-RESULT';
  return res.inconclusive ? 'INCONCLUSIVE' : (res.passed ? 'PASS' : 'FAIL');
}
const browse = (key: string) => `${JIRA}/jira/browse/${key}`;

function resolveKeys(): string[] {
  const kf = flag('keys-file');
  if (kf) return fs.readFileSync(kf, 'utf-8').split(/\s+/).map(s => s.trim()).filter(Boolean).map(s => s.toUpperCase());
  const positional = process.argv.slice(2).filter(a => /^PROJ-\d+$/i.test(a)).map(a => a.toUpperCase());
  return [...new Set(positional)];
}

async function fetchJira(keys: string[]): Promise<Record<string, any>> {
  const out: Record<string, any> = {};
  if (!keys.length) return out;
  const res = await axios.get(`${JIRA}/jira/rest/api/2/search`, {
    headers: { Authorization: `Bearer ${JTOKEN}` },
    params: { jql: `key in (${keys.join(',')})`, fields: 'summary,status', maxResults: 200 },
  });
  for (const issue of res.data.issues) out[issue.key] = issue.fields;
  return out;
}

function buildComment(r: Row): string {
  const res = r.res;
  const L: string[] = [];
  L.push(`**QA AI Agent — Validation**`, `**Verdict:** ${r.verdict}`);
  if (res?.environment) L.push(`**Environment:** ${res.environment}`);
  if (res?.method) L.push(`**Method:** ${res.method}`);
  L.push(`**Jira:** ${browse(r.key)} (status: ${r.jiraStatus})`);
  if (res?.dealUrl) L.push(`**Record URL:** ${res.dealUrl}`);
  L.push('', `**Summary:** ${res?.summary ?? r.summary ?? '(no summary)'}`);
  if (Array.isArray(res?.acChecks) && res.acChecks.length) {
    L.push('', '**Acceptance Criteria:**');
    for (const c of res.acChecks) {
      const sym = (c.status === 'fail' || c.passed === false) ? '❌' : (c.status === 'inconclusive' ? '⚠️' : '✅');
      L.push(`- ${sym} ${c.description} — expected: ${c.expected}; observed: ${c.observed}`);
    }
  }
  if (Array.isArray(res?.reproSteps) && res.reproSteps.length) {
    L.push('', '**Repro Steps:**');
    res.reproSteps.forEach((s: string, i: number) => L.push(`${i + 1}. ${s}`));
  }
  if (Array.isArray(res?.notValidated) && res.notValidated.length) {
    L.push('', '**Not Validated / Out of Scope:**');
    for (const n of res.notValidated) L.push(`- ${n}`);
  }
  if (r.verdict === 'NO-RESULT') L.push('', '_No validation evidence captured this cycle → marked Retest; needs re-validation._');
  return L.join('\n') + AI_FOOTER;
}

function buildCaseBody(r: Row): any {
  const res = r.res;
  const preconds = [
    res?.environment ? `Environment: ${res.environment}` : 'Environment: QA — your-app-qa.example.com',
    res?.method ? `Method: ${res.method}` : null,
    res?.testData ? `Test data: ${Object.entries(res.testData).map(([k, v]) => `${k}=${v}`).join(', ')}` : null,
    res?.dealUrl ? `Record URL: ${res.dealUrl}` : null,
    `Jira: ${browse(r.key)}`,
  ].filter(Boolean).join('\n');

  let steps: Array<{ content: string; expected: string }> = [];
  if (Array.isArray(res?.reproSteps)) steps = res.reproSteps.map((s: string) => ({ content: s, expected: '' }));
  if (Array.isArray(res?.acChecks)) for (const c of res.acChecks) steps.push({ content: `Verify: ${c.description}`, expected: c.expected });
  if (!steps.length) steps = [{ content: `Validate ${r.key} in the app UI per its acceptance criteria.`, expected: 'Behaves per AC.' }];

  return {
    title: `${r.key} — ${r.title}`.slice(0, 250),
    refs: r.key,
    template_id: 2,
    custom_automation_status: 1, // Pending Review (required by the project's case template)
    custom_ai_type: 3,           // LLM (AI attribution)
    custom_preconds: preconds,
    custom_steps_separated: steps,
  };
}

async function main() {
  const keys = resolveKeys();
  if (!keys.length) { console.error('No PROJ keys. Pass PROJ-#### args or --keys-file <file>.'); process.exit(1); }

  const jira = await fetchJira(keys);
  const rows: Row[] = keys.map(key => {
    const res = loadResult(key);
    const f = jira[key] ?? {};
    return { key, jiraStatus: f.status?.name ?? '??', title: (f.summary ?? key).trim(), verdict: verdictOf(res), summary: (res?.summary ?? '').slice(0, 140), res };
  });

  const counts = rows.reduce((a: any, r) => { a[r.verdict] = (a[r.verdict] ?? 0) + 1; return a; }, {});
  console.log(`Project ${PROJECT} / Suite ${SUITE} | ${rows.length} tickets | counts=${JSON.stringify(counts)}`);
  if (hasFlag('dry-run')) { for (const r of rows) console.log(`  ${r.key}  ${r.verdict}->${STATUS[r.verdict]}  "${r.title}"`); return; }

  // Section
  let sectionId = Number(flag('section', '0'));
  if (sectionId > 0) console.log(`Reusing section id=${sectionId}`);
  else {
    const sec = await tr.post(`/add_section/${PROJECT}`, { suite_id: SUITE, name: SECTION_NAME, description: `Ticket validations by the QA AI Agent (GitHub Copilot). One case per PROJ ticket; results mirror the Jira verdicts.` });
    sectionId = sec.data.id; console.log(`Section created id=${sectionId} "${SECTION_NAME}"`);
  }

  // Cases
  const caseMap: Record<string, number> = {};
  for (const r of rows) {
    const c = await tr.post(`/add_case/${sectionId}`, buildCaseBody(r));
    caseMap[r.key] = c.data.id;
    console.log(`  case C${c.data.id}  ${r.key}`);
  }
  const caseIds = rows.map(r => caseMap[r.key]).filter(Boolean);

  // Run
  const run = await tr.post(`/add_run/${PROJECT}`, {
    suite_id: SUITE, name: RUN_NAME, include_all: false, case_ids: caseIds,
    description: `Manual ticket validations by the QA AI Agent (GitHub Copilot) against your-app-qa.example.com. Verdicts mirror the Jira validation results. 🤖 Reviewed by: the QA owner.`,
  });
  const runId = run.data.id;
  const runUrl = `${TR}/index.php?/runs/view/${runId}`;
  console.log(`Run created id=${runId} ${runUrl} (${caseIds.length} cases)`);

  // Results
  const results = rows.map(r => ({ case_id: caseMap[r.key], status_id: STATUS[r.verdict] ?? 4, comment: buildComment(r) })).filter(x => x.case_id);
  await tr.post(`/add_results_for_cases/${runId}`, { results });
  console.log(`Results posted for ${results.length} cases.`);

  fs.writeFileSync('artifacts/_tr-run.json', JSON.stringify({ project: PROJECT, suite: SUITE, sectionId, runId, runUrl, caseMap, counts }, null, 2));
  console.log(`\nDONE — ${runUrl}`);
}
main().catch(e => { console.error('ERR', e?.response?.status, JSON.stringify(e?.response?.data ?? e.message)); process.exit(1); });
