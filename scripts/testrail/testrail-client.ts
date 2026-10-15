/**
 * TestRail REST API v2 client (shared).
 * Extracted from create-run-from-validations.ts so other scripts (release section
 * creation, etc.) can reuse the same auth/base-URL setup instead of duplicating it.
 */
import 'dotenv/config';
import axios, { type AxiosInstance } from 'axios';

export interface TestRailProject { id: number; name: string; is_completed: boolean; }
export interface TestRailSuite { id: number; project_id: number; name: string; }
export interface TestRailSection { id: number; suite_id: number; parent_id: number | null; name: string; }

function client(): AxiosInstance {
  // Accept either naming convention present in .env: this repo's own scripts use
  // TESTRAIL_BASE_URL/USERNAME/API_KEY, while the user-scope release-documentation
  // skill's PowerShell helper uses TESTRAIL_URL/USER/TOKEN. Support both so a single
  // .env works for either stack.
  const base = (process.env.TESTRAIL_BASE_URL ?? process.env.TESTRAIL_URL ?? '').replace(/\/$/, '');
  const username = process.env.TESTRAIL_USERNAME ?? process.env.TESTRAIL_USER ?? '';
  const apiKey = process.env.TESTRAIL_API_KEY ?? process.env.TESTRAIL_TOKEN ?? '';
  const auth = Buffer.from(`${username}:${apiKey}`).toString('base64');
  if (!base || !username || !apiKey) {
    throw new Error('Missing TestRail config. Set TESTRAIL_BASE_URL/TESTRAIL_USERNAME/TESTRAIL_API_KEY (or TESTRAIL_URL/TESTRAIL_USER/TESTRAIL_TOKEN) in .env');
  }
  return axios.create({
    baseURL: `${base}/index.php?/api/v2`,
    headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json' },
  });
}

/** All TestRail projects visible to this account. */
export async function getProjects(): Promise<TestRailProject[]> {
  const res = await client().get('/get_projects');
  // TestRail wraps in { projects: [...] } on newer instances, or returns a bare array on older ones.
  return Array.isArray(res.data) ? res.data : res.data.projects;
}

/** All suites under a TestRail project. */
export async function getSuites(projectId: number): Promise<TestRailSuite[]> {
  const res = await client().get(`/get_suites/${projectId}`);
  return Array.isArray(res.data) ? res.data : res.data.suites;
}

/** All sections under a suite (flat list; parent_id links children to their parent section). */
export async function getSections(projectId: number, suiteId: number): Promise<TestRailSection[]> {
  const out: TestRailSection[] = [];
  let offset = 0;
  for (;;) {
    const res = await client().get(`/get_sections/${projectId}`, { params: { suite_id: suiteId, offset, limit: 250 } });
    const page = Array.isArray(res.data) ? res.data : res.data.sections;
    out.push(...page);
    if (!Array.isArray(res.data) && res.data._links?.next) offset += 250; else break;
    if (page.length < 250) break;
  }
  return out;
}

/** Create a new section (folder) in a suite; pass parentId to nest under another section. */
export async function addSection(projectId: number, params: { suite_id: number; name: string; description?: string; parent_id?: number }): Promise<TestRailSection> {
  const res = await client().post(`/add_section/${projectId}`, params);
  return res.data;
}

export interface TestRailMilestone { id: number; project_id: number; name: string; }
export interface TestRailPlan { id: number; project_id: number; name: string; milestone_id: number | null; }
export interface TestRailCase { id: number; section_id: number; title: string; }

/** All milestones for a project (used to avoid creating duplicates per release). */
export async function getMilestones(projectId: number): Promise<TestRailMilestone[]> {
  const res = await client().get(`/get_milestones/${projectId}`);
  return Array.isArray(res.data) ? res.data : res.data.milestones;
}

/** Create a milestone (name only — no due date, per team convention: dates change later). */
export async function addMilestone(projectId: number, params: { name: string }): Promise<TestRailMilestone> {
  const res = await client().post(`/add_milestone/${projectId}`, params);
  return res.data;
}

/** All test plans for a project (used to avoid creating duplicates per release). */
export async function getPlans(projectId: number): Promise<TestRailPlan[]> {
  const res = await client().get(`/get_plans/${projectId}`);
  return Array.isArray(res.data) ? res.data : res.data.plans;
}

/** Create a test plan, linked to a milestone. Entries (suites) are added separately via addPlanEntry. */
export async function addPlan(projectId: number, params: { name: string; milestone_id?: number }): Promise<TestRailPlan> {
  const res = await client().post(`/add_plan/${projectId}`, params);
  return res.data;
}

/**
 * Add a suite entry to a test plan. Pass either `case_ids` (specific cases —
 * used for the two "Functional"-suite entries, scoped to this release's ticket
 * sections) or `include_all: true` (used for the Smoke -> "Manual Regression"
 * entry, which takes the whole suite).
 */
export async function addPlanEntry(
  planId: number,
  params: { suite_id: number; name: string; include_all?: boolean; case_ids?: number[] },
): Promise<{ id: string; runs: Array<{ id: number }> }> {
  // TestRail's add_plan_entry defaults include_all to true if it's omitted —
  // passing case_ids alone does NOT scope the run, it silently includes the
  // whole suite. Always send an explicit include_all so callers who pass
  // case_ids (to scope to specific cases) actually get scoped, not the
  // entire suite.
  const body = { ...params, include_all: params.include_all ?? (params.case_ids ? false : true) };
  const res = await client().post(`/add_plan_entry/${planId}`, body);
  return res.data;
}

/** Replace which cases a plan-entry run includes (fixes runs created with the wrong scope). */
export async function updateRunCases(runId: number, caseIds: number[]): Promise<unknown> {
  const res = await client().post(`/update_run/${runId}`, { include_all: false, case_ids: caseIds });
  return res.data;
}

/** All cases in a suite, optionally scoped to a single section (folder). */
export async function getCases(projectId: number, suiteId: number, sectionId?: number): Promise<TestRailCase[]> {
  const out: TestRailCase[] = [];
  let offset = 0;
  for (;;) {
    const res = await client().get(`/get_cases/${projectId}`, {
      params: { suite_id: suiteId, section_id: sectionId, offset, limit: 250 },
    });
    const page = Array.isArray(res.data) ? res.data : res.data.cases;
    out.push(...page);
    if (page.length < 250) break;
    offset += 250;
  }
  return out;
}
