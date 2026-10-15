import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import axios from 'axios';

interface TestrailSuite {
  id: number;
  name: string;
  project_id: number;
}

interface TestrailCase {
  id: number;
  title: string;
  custom_steps_separated?: Array<{ content?: string; expected?: string }>;
}

interface OutputCase {
  caseId: string;
  title: string;
  legacyUrl?: string;
  steps?: string[];
  expected?: string[];
  keywords?: string[];
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const targetId = Number(argValue(args, '--suite', process.env.TESTRAIL_SUITE_ID ?? ''));
  if (!Number.isFinite(targetId) || targetId <= 0) {
    throw new Error('Invalid id. Use --suite <id> or set TESTRAIL_SUITE_ID.');
  }

  const outPath = path.resolve(process.cwd(), 'wiki', 'docs', 'testrail-legacy-cases.json');
  const baseUrl = required('TESTRAIL_BASE_URL/TESTRAIL_URL', firstEnv('TESTRAIL_BASE_URL', 'TESTRAIL_URL'));
  const username = required('TESTRAIL_USERNAME/TESTRAIL_USER', firstEnv('TESTRAIL_USERNAME', 'TESTRAIL_USER'));
  const apiKey = required('TESTRAIL_API_KEY', process.env.TESTRAIL_API_KEY ?? '');
  const legacyUrl = process.env.APP_URL_LEGACY ?? 'https://legacy-app-qa.example.com/';

  const auth = Buffer.from(`${username}:${apiKey}`).toString('base64');
  const client = axios.create({
    baseURL: `${baseUrl.replace(/\/$/, '')}/index.php?/api/v2`,
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
  });

  try {
    const resolution = await resolveSuites(client, targetId);
    const cases: TestrailCase[] = [];
    for (const suite of resolution.suites) {
      cases.push(...await getCases(client, resolution.projectId, suite.id));
    }

    const output: { cases: OutputCase[] } = {
      cases: cases.map(c => toOutputCase(c, legacyUrl)),
    };

    fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf-8');
    const suiteLabel = resolution.suites.map((s: TestrailSuite) => `${s.id}:${s.name}`).join(', ');
    console.log(`[TestRail Import] Project ${resolution.projectId}; suites [${suiteLabel}] -> ${output.cases.length} case(s) written to ${outPath}`);
  } catch (err) {
    const status = (err as any)?.response?.status;
    if (status === 401) {
      throw new Error(
        'Unauthorized (401) from TestRail API. Check TESTRAIL_USERNAME/TESTRAIL_USER and TESTRAIL_API_KEY in .env. ' +
        'Use API Key (not password), remove extra spaces/quotes, and confirm the account has API access.',
      );
    }
    throw err;
  }
}

async function getSuite(client: ReturnType<typeof axios.create>, suiteId: number): Promise<TestrailSuite> {
  const res = await client.get(`/get_suite/${suiteId}`);
  return res.data as TestrailSuite;
}

async function getSuites(client: ReturnType<typeof axios.create>, projectId: number): Promise<TestrailSuite[]> {
  const res = await client.get(`/get_suites/${projectId}`);
  return (res.data ?? []) as TestrailSuite[];
}

async function getCases(client: ReturnType<typeof axios.create>, projectId: number, suiteId: number): Promise<TestrailCase[]> {
  const out: TestrailCase[] = [];
  let offset = 0;
  const limit = 250;
  while (true) {
    const res = await client.get(`/get_cases/${projectId}&suite_id=${suiteId}&limit=${limit}&offset=${offset}`);
    const data = res.data;
    const page = Array.isArray(data) ? data : (data.cases ?? []);
    if (!page.length) break;
    out.push(...page as TestrailCase[]);
    if (page.length < limit) break;
    offset += limit;
  }
  return out;
}

async function resolveSuites(
  client: ReturnType<typeof axios.create>,
  targetId: number,
): Promise<{ projectId: number; suites: TestrailSuite[] }> {
  const explicitProject = Number(process.env.TESTRAIL_PROJECT_ID ?? '0');
  if (explicitProject > 0) {
    return { projectId: explicitProject, suites: [{ id: targetId, name: `suite-${targetId}`, project_id: explicitProject }] };
  }

  try {
    const suite = await getSuite(client, targetId);
    return { projectId: suite.project_id, suites: [suite] };
  } catch {
    // If targetId is not a suite id, treat it as a project id (UI /suites/overview/<project_id>).
    const suites = await getSuites(client, targetId);
    if (!suites.length) {
      throw new Error(`No suites found for project ${targetId}. Set TESTRAIL_PROJECT_ID/TESTRAIL_SUITE_ID explicitly.`);
    }
    return { projectId: targetId, suites };
  }
}

function toOutputCase(input: TestrailCase, legacyUrl: string): OutputCase {
  const separated = input.custom_steps_separated ?? [];
  const steps = separated.map(s => (s.content ?? '').trim()).filter(Boolean);
  const expected = separated.map(s => (s.expected ?? '').trim()).filter(Boolean);
  const title = (input.title ?? '').trim();
  return {
    caseId: `C${input.id}`,
    title,
    legacyUrl,
    steps: steps.length ? steps : undefined,
    expected: expected.length ? expected : undefined,
    keywords: keywordsFrom(title, steps, expected),
  };
}

function keywordsFrom(title: string, steps: string[], expected: string[]): string[] | undefined {
  const text = `${title}\n${steps.join('\n')}\n${expected.join('\n')}`.toLowerCase();
  const words = (text.match(/[a-z0-9-]{4,}/g) ?? []).filter(w => !STOPWORDS.has(w));
  const unique = [...new Set(words)].slice(0, 14);
  return unique.length ? unique : undefined;
}

function argValue(args: string[], flag: string, fallback: string): string {
  const idx = args.indexOf(flag);
  if (idx >= 0) return args[idx + 1] ?? fallback;
  return fallback;
}

function required(name: string, value: string): string {
  if (!value?.trim()) {
    throw new Error(`Missing ${name}. Set it in .env before importing TestRail cases.`);
  }
  return value.trim();
}

function firstEnv(...keys: string[]): string {
  for (const key of keys) {
    const value = process.env[key];
    if (value?.trim()) return value.trim();
  }
  return '';
}

const STOPWORDS = new Set([
  'with', 'from', 'that', 'this', 'there', 'where', 'when', 'then', 'into', 'only', 'should',
  'have', 'has', 'been', 'were', 'will', 'would', 'could', 'about', 'your', 'them', 'they',
  'what', 'which', 'while', 'after', 'before', 'under', 'over', 'very', 'more', 'some',
  'acceptance', 'criteria', 'ticket', 'jira', 'testing', 'tested',
]);

main().catch(err => {
  console.error('[TestRail Import] Fatal error:', err instanceof Error ? err.message : err);
  process.exit(1);
});
