import fs from 'node:fs';
import path from 'node:path';
import type { JiraIssue } from './jira-client.js';

export interface OracleContext {
  summary: string;
  sources: string[];
}

const MAX_SOURCES = Number(process.env.ORACLE_MAX_SOURCES ?? '3') || 3;
const MAX_SUMMARY_CHARS = Number(process.env.ORACLE_MAX_CHARS ?? '1600') || 1600;

interface CandidateDoc {
  filePath: string;
  sourceLabel: string;
  score: number;
  excerpt: string;
}

export function loadOracleContext(issue: JiraIssue): OracleContext {
  const docsDirs = resolveDocsDirs();
  if (!docsDirs.length) {
    return { summary: '', sources: [] };
  }

  const keywords = extractKeywords(`${issue.summary}\n${issue.acceptanceCriteria}\n${issue.description}`);
  const candidates: CandidateDoc[] = [];

  for (const docsDir of docsDirs) {
    const files = listMarkdownFiles(docsDir.path).slice(0, 200);
    for (const filePath of files) {
      const text = readSafe(filePath);
      if (!text) continue;
      const score = scoreDoc(text, keywords);
      if (score <= 0) continue;
      const excerpt = buildExcerpt(text, keywords);
      candidates.push({
        filePath,
        sourceLabel: `${docsDir.label}\\${path.relative(docsDir.path, filePath)}`,
        score,
        excerpt,
      });
    }
  }

  if (!candidates.length) {
    return { summary: '', sources: [] };
  }

  candidates.sort((a, b) => b.score - a.score);
  const selected = candidates.slice(0, MAX_SOURCES);
  const summary = selected
    .map((doc, idx) => `Source ${idx + 1}: ${doc.sourceLabel}\n${doc.excerpt}`)
    .join('\n\n')
    .slice(0, MAX_SUMMARY_CHARS);

  return {
    summary,
    sources: selected.map(s => s.filePath),
  };
}

function resolveDocsDirs(): Array<{ path: string; label: string }> {
  const dirs: Array<{ path: string; label: string }> = [];
  const local = path.resolve(process.cwd(), 'wiki', 'docs');
  if (fs.existsSync(local)) dirs.push({ path: local, label: 'wiki/docs' });
  const skills = path.resolve(process.cwd(), 'skills');
  if (fs.existsSync(skills)) dirs.push({ path: skills, label: 'skills' });

  const custom = process.env.ORACLE_DOCS_DIR?.trim();
  if (custom && fs.existsSync(custom)) dirs.push({ path: custom, label: 'oracle' });

  const research = process.env.RESEARCH_WIKI_DOCS_DIR?.trim();
  if (research && fs.existsSync(research)) dirs.push({ path: research, label: 'research' });

  return dirs.filter((entry, index, all) => all.findIndex(other => other.path === entry.path) === index);
}

function listMarkdownFiles(dir: string): string[] {
  const out: string[] = [];
  walk(dir, out);
  return out;
}

function walk(current: string, out: string[]): void {
  const entries = fs.readdirSync(current, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(current, entry.name);
    if (entry.isDirectory()) {
      walk(full, out);
      continue;
    }
    if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) {
      out.push(full);
    }
  }
}

function readSafe(filePath: string): string {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return '';
  }
}

function extractKeywords(text: string): string[] {
  const words = (text.toLowerCase().match(/[a-z0-9-]{4,}/g) ?? [])
    .filter(w => !STOPWORDS.has(w));
  const freq = new Map<string, number>();
  for (const word of words) freq.set(word, (freq.get(word) ?? 0) + 1);
  return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 14)
    .map(([w]) => w);
}

function scoreDoc(text: string, keywords: string[]): number {
  const lower = text.toLowerCase();
  let score = 0;
  for (const k of keywords) {
    if (lower.includes(k)) score += 1;
  }
  return score;
}

function buildExcerpt(text: string, keywords: string[]): string {
  const lines = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean);
  const matched = lines.filter(l => {
    const lower = l.toLowerCase();
    return keywords.some(k => lower.includes(k));
  });
  const raw = (matched.length ? matched : lines).slice(0, 8).join('\n');
  return raw.slice(0, 520);
}

function unique(values: string[]): string[] {
  const out: string[] = [];
  for (const value of values) if (!out.includes(value)) out.push(value);
  return out;
}

const STOPWORDS = new Set([
  'with', 'from', 'that', 'this', 'there', 'where', 'when', 'then', 'into', 'only', 'should',
  'have', 'has', 'been', 'were', 'will', 'would', 'could', 'about', 'your', 'them', 'they',
  'what', 'which', 'while', 'after', 'before', 'under', 'over', 'very', 'more', 'some',
  'acceptance', 'criteria', 'ticket', 'jira', 'testing', 'tested',
]);
