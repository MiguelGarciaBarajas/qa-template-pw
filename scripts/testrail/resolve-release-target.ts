/**
 * Resolve which TestRail project + Functional suite a Jira Fix Version targets.
 *
 * Rule (confirmed with the user): the Fix Version's title contains the product
 * name somewhere (not always as a strict prefix), so we scan the full title for a known
 * product token. Products, project-name matching and per-product "Functional" suite rules
 * come from scripts/testrail/products.config.json (override path: TESTRAIL_PRODUCTS_CONFIG).
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { getProjects, getSuites, type TestRailProject, type TestRailSuite } from './testrail-client.js';

export interface ReleaseTarget {
  productCode: string;
  project: TestRailProject;
  suite: TestRailSuite;
  smokeSuite: TestRailSuite;
}

interface ProductEntry {
  code: string;
  tokenPatterns: string[];
  projectLastSegment?: string;
  functionalSuitePattern?: string;
}

interface ProductsConfig {
  projectNameContains?: string;
  allProductsPattern?: string;
  smokeSuitePattern?: string;
  defaultFunctionalSuitePattern?: string;
  products: ProductEntry[];
}

let cachedConfig: ProductsConfig | null = null;

function loadConfig(): ProductsConfig {
  if (cachedConfig) return cachedConfig;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const file = process.env.TESTRAIL_PRODUCTS_CONFIG?.trim() || path.join(here, 'products.config.json');
  if (!fs.existsSync(file)) {
    throw new Error(`TestRail products config not found: ${file}. Create it from scripts/testrail/products.config.json.`);
  }
  cachedConfig = JSON.parse(fs.readFileSync(file, 'utf-8')) as ProductsConfig;
  return cachedConfig;
}

/** Product tokens to look for in a Fix Version title, in config order (put longer/more-specific names first). */
function productTokens(): Array<{ code: string; patterns: RegExp[] }> {
  return loadConfig().products.map((p) => ({ code: p.code, patterns: p.tokenPatterns.map((s) => new RegExp(s, 'i')) }));
}

/** Given a Fix Version title, return the configured product code. */
export function detectProductFromFixVersion(fixVersionName: string): string {
  const code = detectProductToken(fixVersionName);
  if (!code) {
    const known = loadConfig().products.map((p) => p.code).join('/');
    throw new Error(
      `Could not detect a known product (${known}) in Fix Version title: "${fixVersionName}"`,
    );
  }
  return code;
}

/** Same token scan as detectProductFromFixVersion, but returns null instead of throwing — used for
 * multi-product releases where the title itself doesn't map to a
 * single product and each ticket's own text must be scanned instead. */
export function detectProductToken(text: string): string | null {
  for (const { code, patterns } of productTokens()) {
    if (patterns.some((re) => re.test(text))) return code;
  }
  return null;
}

/** Matches tickets like "All Products - <summary>" that apply to every
 * product in a multi-product release and must be replicated into each one's suite. */
export function isAllProductsTicket(text: string): boolean {
  return new RegExp(loadConfig().allProductsPattern ?? '\\ball\\s+products?\\b', 'i').test(text);
}

/** Per-product "Functional" suite name-matching rule, taken from the products config. */
function pickFunctionalSuite(productCode: string, suites: TestRailSuite[]): TestRailSuite {
  const cfg = loadConfig();
  const entry = cfg.products.find((p) => p.code === productCode);
  const pattern = new RegExp(entry?.functionalSuitePattern ?? cfg.defaultFunctionalSuitePattern ?? 'functional', 'i');
  const match = suites.find((s) => pattern.test(s.name));
  if (!match) {
    throw new Error(
      `No matching Functional suite found for product ${productCode}. Available suites: ${suites.map((s) => s.name).join(', ')}`,
    );
  }
  return match;
}

/** Find the TestRail project for a product code. Optionally scope to projects whose name contains
 * `projectNameContains`, then match the exact last path segment of the project name
 * (avoids false substring hits like "ga" matching inside "Legacy Regression Tests"). */
function pickProject(productCode: string, projects: TestRailProject[]): TestRailProject {
  const cfg = loadConfig();
  const entry = cfg.products.find((p) => p.code === productCode);
  const label = (entry?.projectLastSegment ?? productCode).toLowerCase().trim();
  const umbrella = (cfg.projectNameContains ?? '').toLowerCase();
  const scoped = umbrella ? projects.filter((p) => p.name.toLowerCase().includes(umbrella)) : projects;
  const match = scoped.find((p) => {
    const lastSegment = p.name.split('/').pop()!.toLowerCase().trim();
    return lastSegment === label;
  });
  if (!match) {
    throw new Error(
      `No TestRail project found matching product ${productCode}${umbrella ? ` under "${cfg.projectNameContains}"` : ''}. Available: ${scoped.map((p) => p.name).join(', ')}`,
    );
  }
  return match;
}

/** Find the "Smoke" suite in a project — used for the Test Plan's "Manual Regression" entry. */
export function pickSmokeSuite(suites: TestRailSuite[]): TestRailSuite {
  const re = new RegExp(loadConfig().smokeSuitePattern ?? 'smoke', 'i');
  const match = suites.find((s) => re.test(s.name));
  if (!match) throw new Error(`No Smoke suite found. Available suites: ${suites.map((s) => s.name).join(', ')}`);
  return match;
}

export async function resolveReleaseTarget(fixVersionName: string, opts: { suiteOverride?: RegExp } = {}): Promise<ReleaseTarget> {
  const productCode = detectProductFromFixVersion(fixVersionName);
  return resolveTargetForProduct(productCode, opts);
}

/** Resolve a ReleaseTarget directly from a known product code (no Fix Version title parsing) —
 * used by the multi-product flow where each ticket determines its own product. */
export async function resolveTargetForProduct(productCode: string, opts: { suiteOverride?: RegExp } = {}): Promise<ReleaseTarget> {
  const projects = await getProjects();
  const project = pickProject(productCode, projects);
  const suites = await getSuites(project.id);
  const suite = opts.suiteOverride ? suites.find((s) => opts.suiteOverride!.test(s.name)) : pickFunctionalSuite(productCode, suites);
  if (!suite) {
    throw new Error(`Suite override matched nothing for product ${productCode}. Available: ${suites.map((s) => s.name).join(', ')}`);
  }
  const smokeSuite = pickSmokeSuite(suites);
  return { productCode, project, suite, smokeSuite };
}

/**
 * Multi-product release support (a Fix Version spanning several products):
 * each ticket's OWN summary is scanned for a product token; tickets that say "All Products"
 * are replicated into every concrete product detected across the release's other tickets.
 * Falls back to the Fix Version title's product (if it has one) only when a ticket has neither
 * its own token nor is an "All Products" ticket.
 */
export async function resolveMultiProductAssignments(
  fixVersionName: string,
  tickets: Array<{ key: string; summary: string }>,
): Promise<Map<string, string[]>> {
  let fallbackProduct: string | null = null;
  try {
    fallbackProduct = detectProductFromFixVersion(fixVersionName);
  } catch {
    fallbackProduct = null;
  }

  const perTicketProduct = new Map<string, string | 'ALL'>();
  const concreteProducts = new Set<string>();
  for (const t of tickets) {
    if (isAllProductsTicket(t.summary)) {
      perTicketProduct.set(t.key, 'ALL');
      continue;
    }
    const code = detectProductToken(t.summary) ?? fallbackProduct;
    if (!code) {
      throw new Error(`Ticket ${t.key} ("${t.summary}") has no detectable product and the Fix Version title has none either — resolve manually.`);
    }
    perTicketProduct.set(t.key, code);
    concreteProducts.add(code);
  }
  if (concreteProducts.size === 0 && [...perTicketProduct.values()].some((v) => v === 'ALL')) {
    throw new Error('Found "All Products" ticket(s) but no ticket in this release has a specific, concrete product — cannot expand "All Products".');
  }

  // productCode -> [ticketKey, ...]
  const assignments = new Map<string, string[]>();
  for (const t of tickets) {
    const p = perTicketProduct.get(t.key)!;
    const codes = p === 'ALL' ? [...concreteProducts] : [p];
    for (const code of codes) {
      if (!assignments.has(code)) assignments.set(code, []);
      assignments.get(code)!.push(t.key);
    }
  }
  return assignments;
}
