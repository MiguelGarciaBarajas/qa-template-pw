/**
 * Release Documentation flow — step 2: create one TestRail section per Jira
 * ticket (Story/Bug/Defect) in the target product's Functional suite.
 *
 * Supports MULTI-PRODUCT releases (a Fix Version spanning several products,
 * e.g. PRODUCT_A + PRODUCT_B): each ticket's own summary is scanned for a product token
 * (configured in products.config.json); tickets that say "All Products" are
 * replicated into every concrete product detected in the release — see
 * resolveMultiProductAssignments() in resolve-release-target.ts.
 *
 * This is meant to be called by the (user-scope) `release-documentation` skill
 * AFTER it has asked the user whether bugs/defects get a shared parent section
 * or individual top-level sections like stories — see --bugs-mode below.
 *
 * Usage:
 *   npx tsx scripts/testrail/create-release-sections.ts \
 *     --fix-version "<Release Name>" \
 *     --project-key PROJ \
 *     --bugs-mode shared|individual \
 *     [--dry-run]
 *
 * Output: artifacts/release-<slug>/testrail-sections.json
 *   { fixVersion, projectKey, bugsMode, products: { PRODUCT_A: { testrail: {...}, tickets: [...] }, PRODUCT_B: {...} } }
 *
 * Idempotent: re-running skips tickets that already have a matching section
 * (matched by the ticket key appearing at the start of the section name).
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { getIssuesByFixVersion, type JiraIssue } from '../jira-client.js';
import { getSections, addSection } from './testrail-client.js';
import { resolveTargetForProduct, resolveMultiProductAssignments } from './resolve-release-target.js';

interface Args {
  fixVersion: string;
  projectKey: string;
  bugsMode: 'shared' | 'individual';
  dryRun: boolean;
}

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const fixVersion = get('--fix-version') ?? process.env.JIRA_FIX_VERSION;
  const projectKey = get('--project-key') ?? process.env.JIRA_PROJECT ?? 'PROJ';
  const bugsModeRaw = get('--bugs-mode');
  const dryRun = argv.includes('--dry-run');

  if (!fixVersion) throw new Error('Missing --fix-version (or JIRA_FIX_VERSION env var)');
  if (bugsModeRaw !== 'shared' && bugsModeRaw !== 'individual') {
    throw new Error(
      '--bugs-mode is required and must be "shared" or "individual". The calling skill/agent must ask the user this question EVERY run before invoking this script.',
    );
  }
  return { fixVersion, projectKey, bugsMode: bugsModeRaw, dryRun };
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

function sectionNameFor(issue: JiraIssue): string {
  const summary = issue.summary.length > 80 ? `${issue.summary.slice(0, 77)}...` : issue.summary;
  return `${issue.key} — ${summary}`;
}

interface TicketResult { key: string; type: string; summary: string; sectionId: number | null; sectionName: string; created: boolean; }

async function createSectionsForProduct(
  productCode: string,
  issuesByKey: Map<string, JiraIssue>,
  ticketKeys: string[],
  fixVersion: string,
  bugsMode: 'shared' | 'individual',
  dryRun: boolean,
) {
  const target = await resolveTargetForProduct(productCode);
  console.log(`[Release] [${productCode}] TestRail target -> project "${target.project.name}" (#${target.project.id}), suite "${target.suite.name}" (#${target.suite.id})`);

  const existingSections = await getSections(target.project.id, target.suite.id);

  const bugSharedSectionName = `Bugs & Defects — ${fixVersion}`;
  let bugParentId: number | undefined;
  if (bugsMode === 'shared') {
    const existingParent = existingSections.find((s) => s.name === bugSharedSectionName);
    if (existingParent) {
      bugParentId = existingParent.id;
      console.log(`[Release] [${productCode}] Reusing existing shared bugs section "${bugSharedSectionName}" (#${bugParentId})`);
    } else if (!dryRun) {
      const created = await addSection(target.project.id, { suite_id: target.suite.id, name: bugSharedSectionName });
      bugParentId = created.id;
      console.log(`[Release] [${productCode}] Created shared bugs section "${bugSharedSectionName}" (#${bugParentId})`);
    } else {
      console.log(`[Release] [${productCode}] [dry-run] Would create shared bugs section "${bugSharedSectionName}"`);
    }
  }

  const results: TicketResult[] = [];
  for (const key of ticketKeys) {
    const issue = issuesByKey.get(key)!;
    const isBug = issue.issuetype === 'Bug' || issue.issuetype === 'Defect';
    const name = sectionNameFor(issue);
    const existing = existingSections.find((s) => s.name.startsWith(issue.key));
    if (existing) {
      console.log(`[Release] [${productCode}] Section already exists for ${issue.key}: "${existing.name}" (#${existing.id}) — skipping`);
      results.push({ key: issue.key, type: issue.issuetype, summary: issue.summary, sectionId: existing.id, sectionName: existing.name, created: false });
      continue;
    }
    if (dryRun) {
      console.log(`[Release] [${productCode}] [dry-run] Would create section "${name}"${isBug && bugsMode === 'shared' ? ` (nested under "${bugSharedSectionName}")` : ''}`);
      results.push({ key: issue.key, type: issue.issuetype, summary: issue.summary, sectionId: null, sectionName: name, created: false });
      continue;
    }
    const parentId = isBug && bugsMode === 'shared' ? bugParentId : undefined;
    const created = await addSection(target.project.id, { suite_id: target.suite.id, name, parent_id: parentId });
    console.log(`[Release] [${productCode}] Created section "${name}" (#${created.id})${parentId ? ` under #${parentId}` : ''}`);
    results.push({ key: issue.key, type: issue.issuetype, summary: issue.summary, sectionId: created.id, sectionName: name, created: true });
  }

  return {
    testrail: { projectId: target.project.id, projectName: target.project.name, suiteId: target.suite.id, suiteName: target.suite.name },
    tickets: results,
  };
}

async function main() {
  const args = parseArgs();
  console.log(`[Release] Fix Version: "${args.fixVersion}" | Jira project: ${args.projectKey} | bugs-mode: ${args.bugsMode}${args.dryRun ? ' (dry-run)' : ''}`);

  const issues = await getIssuesByFixVersion(args.projectKey, args.fixVersion);
  if (issues.length === 0) {
    console.log('[Release] No Story/Bug/Defect issues found for this Fix Version. Nothing to do.');
    return;
  }
  console.log(`[Release] Found ${issues.length} issues: ${issues.map((i) => `${i.key}(${i.issuetype})`).join(', ')}`);

  const issuesByKey = new Map(issues.map((i) => [i.key, i]));
  const assignments = await resolveMultiProductAssignments(
    args.fixVersion,
    issues.map((i) => ({ key: i.key, summary: i.summary })),
  );
  console.log(`[Release] Product assignment: ${[...assignments.entries()].map(([p, keys]) => `${p}=[${keys.join(', ')}]`).join(' | ')}`);

  const products: Record<string, Awaited<ReturnType<typeof createSectionsForProduct>>> = {};
  for (const [productCode, ticketKeys] of assignments) {
    products[productCode] = await createSectionsForProduct(productCode, issuesByKey, ticketKeys, args.fixVersion, args.bugsMode, args.dryRun);
  }

  const outDir = path.join('artifacts', `release-${slug(args.fixVersion)}`);
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, 'testrail-sections.json');
  fs.writeFileSync(
    outFile,
    JSON.stringify({ fixVersion: args.fixVersion, projectKey: args.projectKey, bugsMode: args.bugsMode, products }, null, 2),
  );
  console.log(`[Release] Wrote mapping: ${outFile}`);
  console.log('[Release] Next: for each ticket above, run the smartlearn-product-config skill flow to generate + upload test cases into its sectionId.');
}

main().catch((err) => {
  console.error('[Release] FAILED:', err.message ?? err);
  process.exit(1);
});
