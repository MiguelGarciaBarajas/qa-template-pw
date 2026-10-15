/**
 * Release Documentation flow — step 3 (runs AFTER SmartLearn has generated test
 * cases into the per-ticket sections created by create-release-sections.ts):
 * create the TestRail Milestone + Test Plan for the release.
 *
 * Supports MULTI-PRODUCT releases (a Fix Version spanning several products)
 * — reads the per-product breakdown written by
 * create-release-sections.ts and creates ONE Milestone + Test Plan PER PRODUCT
 * (each product has its own TestRail project, so a single cross-product
 * plan/milestone isn't possible in TestRail).
 *
 * Confirmed with the user:
 *   1. Milestone name = Fix Version name (name only, no due date — dates change later).
 *   2. Test Plan name = Fix Version name, linked to that Milestone.
 *   3. Add 3 suite entries to the plan:
 *      - The product's Functional suite, scoped to just this release's ticket
 *        sections (whole folders, all their cases) -> named "Functional Test".
 *      - The SAME Functional suite + same sections again -> named "Rollback Test".
 *      - The product's Smoke suite, complete (include_all, no filtering) -> named
 *        "Manual Regression".
 *
 * Usage:
 *   npx tsx scripts/testrail/create-release-milestone-plan.ts \
 *     --fix-version "<Release Name>" \
 *     [--dry-run]
 *
 * Reads: artifacts/release-<slug>/testrail-sections.json (written by
 * create-release-sections.ts) to know which sections belong to this release,
 * per product.
 * Writes: artifacts/release-<slug>/testrail-milestone-plan.json
 */
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { resolveTargetForProduct } from './resolve-release-target.js';
import { getMilestones, addMilestone, getPlans, addPlan, addPlanEntry, getCases } from './testrail-client.js';

interface Args { fixVersion: string; dryRun: boolean; }

function parseArgs(): Args {
  const argv = process.argv.slice(2);
  const get = (flag: string) => {
    const i = argv.indexOf(flag);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const fixVersion = get('--fix-version') ?? process.env.JIRA_FIX_VERSION;
  if (!fixVersion) throw new Error('Missing --fix-version (or JIRA_FIX_VERSION env var)');
  return { fixVersion, dryRun: argv.includes('--dry-run') };
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '');
}

interface SectionsFile {
  fixVersion: string;
  products: Record<string, {
    testrail: { projectId: number; projectName: string; suiteId: number; suiteName: string };
    tickets: Array<{ key: string; sectionId: number | null; sectionName: string }>;
  }>;
}

async function createMilestonePlanForProduct(productCode: string, fixVersion: string, sectionIds: number[], dryRun: boolean) {
  const target = await resolveTargetForProduct(productCode);
  console.log(`[Release] [${productCode}] Project "${target.project.name}" (#${target.project.id}) | Functional suite "${target.suite.name}" (#${target.suite.id}) | Smoke suite "${target.smokeSuite.name}" (#${target.smokeSuite.id})`);

  // Milestone — name only, idempotent.
  const milestones = await getMilestones(target.project.id);
  let milestone = milestones.find((m) => m.name === fixVersion);
  if (milestone) {
    console.log(`[Release] [${productCode}] Reusing existing milestone "${milestone.name}" (#${milestone.id})`);
  } else if (!dryRun) {
    milestone = await addMilestone(target.project.id, { name: fixVersion });
    console.log(`[Release] [${productCode}] Created milestone "${milestone.name}" (#${milestone.id})`);
  } else {
    console.log(`[Release] [${productCode}] [dry-run] Would create milestone "${fixVersion}"`);
  }

  // Test Plan — name = Fix Version, linked to the milestone above.
  const plans = await getPlans(target.project.id);
  let plan = plans.find((p) => p.name === fixVersion);
  if (plan) {
    console.log(`[Release] [${productCode}] Reusing existing test plan "${plan.name}" (#${plan.id}) — entries are NOT re-added if the plan already exists; delete it first to regenerate.`);
  } else if (!dryRun) {
    plan = await addPlan(target.project.id, { name: fixVersion, milestone_id: milestone?.id });
    console.log(`[Release] [${productCode}] Created test plan "${plan.name}" (#${plan.id})`);
  } else {
    console.log(`[Release] [${productCode}] [dry-run] Would create test plan "${fixVersion}" linked to milestone`);
  }

  // Collect all cases across this release's ticket sections (whole folders — all their cases).
  let caseIds: number[] = [];
  if (!dryRun) {
    for (const sectionId of sectionIds) {
      const cases = await getCases(target.project.id, target.suite.id, sectionId);
      caseIds.push(...cases.map((c) => c.id));
    }
    console.log(`[Release] [${productCode}] Collected ${caseIds.length} cases across ${sectionIds.length} release sections`);
  } else {
    console.log(`[Release] [${productCode}] [dry-run] Would collect all cases from ${sectionIds.length} release sections`);
  }

  const entries: Array<{ name: string; suiteId: number; entryId?: string; runId?: number }> = [];
  if (!dryRun && plan) {
    const functionalEntry = await addPlanEntry(plan.id, { suite_id: target.suite.id, name: 'Functional Test', case_ids: caseIds });
    entries.push({ name: 'Functional Test', suiteId: target.suite.id, entryId: functionalEntry.id, runId: functionalEntry.runs[0]?.id });
    console.log(`[Release] [${productCode}] Added plan entry "Functional Test" (${caseIds.length} cases)`);

    const rollbackEntry = await addPlanEntry(plan.id, { suite_id: target.suite.id, name: 'Rollback Test', case_ids: caseIds });
    entries.push({ name: 'Rollback Test', suiteId: target.suite.id, entryId: rollbackEntry.id, runId: rollbackEntry.runs[0]?.id });
    console.log(`[Release] [${productCode}] Added plan entry "Rollback Test" (${caseIds.length} cases)`);

    const smokeEntry = await addPlanEntry(plan.id, { suite_id: target.smokeSuite.id, name: 'Manual Regression', include_all: true });
    entries.push({ name: 'Manual Regression', suiteId: target.smokeSuite.id, entryId: smokeEntry.id, runId: smokeEntry.runs[0]?.id });
    console.log(`[Release] [${productCode}] Added plan entry "Manual Regression" (entire Smoke suite)`);
  } else {
    console.log(`[Release] [${productCode}] [dry-run] Would add plan entries: "Functional Test" + "Rollback Test" (this release's cases) + "Manual Regression" (entire Smoke suite)`);
  }

  return {
    milestoneId: milestone?.id ?? null,
    planId: plan?.id ?? null,
    planUrl: plan ? `${(process.env.TESTRAIL_BASE_URL ?? process.env.TESTRAIL_URL ?? '').replace(/\/$/, '')}/index.php?/plans/view/${plan.id}` : null,
    entries,
  };
}

async function main() {
  const args = parseArgs();
  console.log(`[Release] Milestone + Test Plan for Fix Version: "${args.fixVersion}"${args.dryRun ? ' (dry-run)' : ''}`);

  const outDir = path.join('artifacts', `release-${slug(args.fixVersion)}`);
  const sectionsFile = path.join(outDir, 'testrail-sections.json');
  if (!fs.existsSync(sectionsFile)) {
    throw new Error(`Missing ${sectionsFile}. Run create-release-sections.ts (and the SmartLearn generation step) for this release first.`);
  }
  const sectionsData: SectionsFile = JSON.parse(fs.readFileSync(sectionsFile, 'utf-8'));

  const products: Record<string, Awaited<ReturnType<typeof createMilestonePlanForProduct>>> = {};
  for (const [productCode, data] of Object.entries(sectionsData.products)) {
    const sectionIds = data.tickets.map((t) => t.sectionId).filter((id): id is number => id !== null);
    if (sectionIds.length === 0) {
      console.log(`[Release] [${productCode}] No ticket sections with a real sectionId found — skipping (was create-release-sections.ts run without --dry-run?)`);
      continue;
    }
    products[productCode] = await createMilestonePlanForProduct(productCode, args.fixVersion, sectionIds, args.dryRun);
  }

  const outFile = path.join(outDir, 'testrail-milestone-plan.json');
  fs.writeFileSync(outFile, JSON.stringify({ fixVersion: args.fixVersion, products }, null, 2));
  console.log(`[Release] Wrote: ${outFile}`);
}

main().catch((err) => {
  console.error('[Release] FAILED:', err.message ?? err);
  process.exit(1);
});
