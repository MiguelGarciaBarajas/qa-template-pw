import fs from 'node:fs';
import path from 'node:path';
import type { JiraIssue } from './jira-client.js';

export interface TestrailLegacyCase {
  caseId: string;
  title: string;
  legacyUrl?: string;
  steps?: string[];
  expected?: string[];
  keywords?: string[];
}

export interface TestrailMatch {
  score: number;
  matched: TestrailLegacyCase;
}

interface CaseFile {
  cases: TestrailLegacyCase[];
}

const DEFAULT_CASES_FILE = path.resolve(process.cwd(), 'wiki', 'docs', 'testrail-legacy-cases.json');
const MIN_SCORE = Number(process.env.TESTRAIL_MATCH_MIN_SCORE ?? '3') || 3;

export function findSimilarTestrailCase(issue: JiraIssue): TestrailMatch | null {
  const filePath = process.env.TESTRAIL_CASES_FILE?.trim() || DEFAULT_CASES_FILE;
  if (!fs.existsSync(filePath)) return null;

  let parsed: CaseFile;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8')) as CaseFile;
  } catch {
    return null;
  }

  const cases = parsed.cases ?? [];
  if (!cases.length) return null;

  const query = `${issue.summary}\n${issue.acceptanceCriteria}\n${issue.description}`;
  const qTokens = new Set(tokens(query));

  let best: TestrailMatch | null = null;
  const queryDomain = classifyDomain(query);
  for (const c of cases) {
    const haystack = `${c.title}\n${(c.steps ?? []).join('\n')}\n${(c.expected ?? []).join('\n')}\n${(c.keywords ?? []).join(' ')}`;
    const candidateDomain = classifyDomain(haystack);
    if (!isDomainCompatible(queryDomain, candidateDomain)) continue;
    const hTokens = new Set(tokens(haystack));
    let score = overlapScore(qTokens, hTokens);

    const titleLower = c.title.toLowerCase();
    const issueLower = issue.summary.toLowerCase();
    if (issueLower.includes(titleLower) || titleLower.includes(issueLower)) score += 2;

    if (!best || score > best.score) {
      best = { score, matched: c };
    }
  }

  if (!best || best.score < MIN_SCORE) return null;
  return best;
}

export function renderTestrailMatch(match: TestrailMatch): string {
  const c = match.matched;
  const lines: string[] = [];
  lines.push(`Matched TestRail legacy case: ${c.caseId} — ${c.title} (score=${match.score})`);
  if (c.legacyUrl) lines.push(`Legacy URL: ${c.legacyUrl}`);
  if (c.steps?.length) {
    lines.push('Legacy reference steps:');
    lines.push(...c.steps.map((s, i) => `${i + 1}. ${s}`));
  }
  if (c.expected?.length) {
    lines.push('Expected behavior baseline:');
    lines.push(...c.expected.map((s, i) => `${i + 1}. ${s}`));
  }
  lines.push('Use this legacy case as parity oracle unless ticket evidence clearly overrides it.');
  return lines.join('\n');
}

function tokens(input: string): string[] {
  return (input.toLowerCase().match(/[a-z0-9-]{4,}/g) ?? [])
    .filter(t => !STOPWORDS.has(t));
}

function overlapScore(a: Set<string>, b: Set<string>): number {
  let score = 0;
  for (const token of a) {
    if (b.has(token)) score += 1;
  }
  return score;
}

type CaseDomain = 'customer-owner' | 'dms' | 'other';

function classifyDomain(text: string): CaseDomain {
  const lower = text.toLowerCase();
  const ownerSignals = countSignals(lower, ['owner', 'customer', 'business', 'individual', 'address', 'feid', 'registration owner']);
  const dmsSignals = countSignals(lower, ['dms', 'reynolds', 'cdk', 'dms import', 'load dms', 'integration']);
  if (ownerSignals >= 2 && ownerSignals > dmsSignals) return 'customer-owner';
  if (dmsSignals >= 2 && dmsSignals > ownerSignals) return 'dms';
  return 'other';
}

function isDomainMismatch(query: CaseDomain, candidate: CaseDomain): boolean {
  return (query === 'customer-owner' && candidate === 'dms') ||
    (query === 'dms' && candidate === 'customer-owner');
}

function isDomainCompatible(query: CaseDomain, candidate: CaseDomain): boolean {
  if (isDomainMismatch(query, candidate)) return false;
  if (query === 'customer-owner') return candidate === 'customer-owner';
  if (query === 'dms') return candidate === 'dms';
  return true;
}

function countSignals(text: string, signals: string[]): number {
  return signals.reduce((count, signal) => count + (text.includes(signal) ? 1 : 0), 0);
}

const STOPWORDS = new Set([
  'with', 'from', 'that', 'this', 'there', 'where', 'when', 'then', 'into', 'only', 'should',
  'have', 'has', 'been', 'were', 'will', 'would', 'could', 'about', 'your', 'them', 'they',
  'what', 'which', 'while', 'after', 'before', 'under', 'over', 'very', 'more', 'some',
  'acceptance', 'criteria', 'ticket', 'jira', 'testing', 'tested',
]);
