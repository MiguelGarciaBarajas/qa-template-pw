import fs from 'node:fs';
import path from 'node:path';
import type { JiraIssue } from './jira-client.js';

export interface SectionFlowGuide {
  id: string;
  ticketKeys?: string[];
  sectionId?: string;
  title: string;
  intent: string;
  matchKeywords: string[];
  minKeywordHits?: number;
  preferredStartPath?: string;
  flow: string[];
  requiredChecks?: string[];
  guardrails?: string[];
}

interface SectionFlowMapFile {
  entries: SectionFlowGuide[];
}

export interface SectionFlowMatch {
  guide: SectionFlowGuide;
  matchedKeywords: string[];
}

const DEFAULT_MAP_PATH = path.resolve(process.cwd(), 'wiki', 'docs', 'section-flow-map.json');

export function matchSectionFlowGuides(issue: JiraIssue, maxMatches = 2): SectionFlowMatch[] {
  const mapPath = process.env.SECTION_FLOW_MAP_FILE?.trim() || DEFAULT_MAP_PATH;
  if (!fs.existsSync(mapPath)) return [];

  let parsed: SectionFlowMapFile;
  try {
    parsed = JSON.parse(fs.readFileSync(mapPath, 'utf-8')) as SectionFlowMapFile;
  } catch {
    return [];
  }

  const corpus = normalizeText([
    issue.key,
    issue.summary,
    issue.description,
    issue.acceptanceCriteria,
    issue.issuetype,
    ...(issue.labels ?? []),
  ].join('\n'));

  const matches = (parsed.entries ?? [])
    .map((guide) => {
      const ticketMatched = (guide.ticketKeys ?? [])
        .map(key => key.trim().toUpperCase())
        .includes(issue.key.trim().toUpperCase());
      const matchedKeywords = (guide.matchKeywords ?? [])
        .map(v => v.trim())
        .filter(Boolean)
        .filter(keyword => hasKeyword(corpus, keyword));
      const minHits = Math.max(1, guide.minKeywordHits ?? Math.min(2, Math.max(1, guide.matchKeywords?.length ?? 0)));
      return { guide, matchedKeywords, minHits, ticketMatched };
    })
    .filter(match => match.ticketMatched || match.matchedKeywords.length >= match.minHits)
    .sort((a, b) => {
      if (a.ticketMatched !== b.ticketMatched) return a.ticketMatched ? -1 : 1;
      return b.matchedKeywords.length - a.matchedKeywords.length;
    })
    .slice(0, Math.max(1, maxMatches))
    .map(({ guide, matchedKeywords }) => ({ guide, matchedKeywords }));

  return matches;
}

export function renderSectionFlowGuides(matches: SectionFlowMatch[]): string {
  if (!matches.length) return '';
  const lines: string[] = ['Section-aware execution guides (mandatory when matched):'];

  for (const [idx, match] of matches.entries()) {
    const { guide, matchedKeywords } = match;
    lines.push(`${idx + 1}. [${guide.id}] ${guide.title}`);
    lines.push(`   Intent: ${guide.intent}`);
    lines.push(`   Matched by keywords: ${matchedKeywords.join(', ')}`);
    if (guide.preferredStartPath) lines.push(`   Preferred start path: ${guide.preferredStartPath}`);
    lines.push('   Required flow:');
    lines.push(...guide.flow.map((step, i) => `   ${i + 1}) ${step}`));
    if (guide.requiredChecks?.length) {
      lines.push('   AC checks (mandatory):');
      lines.push(...guide.requiredChecks.map((check, i) => `   ${i + 1}) ${check}`));
    }
    if (guide.guardrails?.length) {
      lines.push('   Guardrails:');
      lines.push(...guide.guardrails.map((rule, i) => `   ${i + 1}) ${rule}`));
    }
  }

  lines.push('If multiple guides match, prioritize the one that best matches the ticket summary/AC scope and keep out-of-scope areas under "Not Validated".');
  return lines.join('\n');
}

export function resolveSectionGuideStartUrl(matches: SectionFlowMatch[], appUrl: string): string | null {
  for (const match of matches) {
    const startPath = match.guide.preferredStartPath?.trim();
    if (!startPath) continue;
    try {
      return new URL(startPath, appUrl).toString();
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Extract the section identifier from a URL path.
 * Examples: /app/orders → orders (with APP_SECTION_PATH_PREFIX=app), /reports/summary → summary, / → (home)
 */
export function extractSectionFromUrl(url: string, appHost?: string): string {
  try {
    const parsedUrl = new URL(url);

    // If an appHost is given, only extract section from app URLs
    if (appHost && parsedUrl.hostname !== new URL(appHost).hostname) {
      return 'external';
    }

    const pathname = parsedUrl.pathname;

    // Extract the last meaningful path segment
    // APP_SECTION_PATH_PREFIX (optional): a leading path segment that is not part of the section id (e.g. "app")
    const ignoredSegment = (process.env.APP_SECTION_PATH_PREFIX ?? '').trim().replace(/^\/|\/$/g, '');
    const segments = pathname.split('/').filter(s => s.length > 0 && (!ignoredSegment || s !== ignoredSegment));
    if (segments.length === 0) return 'home';

    // Return the last segment as the section ID
    return segments[segments.length - 1];
  } catch {
    return 'unknown';
  }
}

/**
 * Determine if a navigation URL represents a different section than the current one.
 */
export function isSectionChange(fromUrl: string, toUrl: string): boolean {
  const currentSection = extractSectionFromUrl(fromUrl);
  const nextSection = extractSectionFromUrl(toUrl);
  return currentSection !== nextSection;
}

function hasKeyword(corpus: string, keyword: string): boolean {
  const normalizedKeyword = normalizeText(keyword);
  if (!normalizedKeyword) return false;
  return corpus.includes(normalizedKeyword);
}

function normalizeText(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
}
