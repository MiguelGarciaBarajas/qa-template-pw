/**
 * run-state.ts — Persists live run status to artifacts/run-state.json
 * so the dashboard can read it in real-time.
 *
 * Usage: import { startRun, startTicket, finishTicket, finishRun } from './run-state.js';
 */

import fs from 'fs';
import path from 'path';

const STATE_FILE = path.join(process.cwd(), 'artifacts', 'run-state.json');

export type RunStateValue = 'IDLE' | 'RUNNING' | 'FINISHED' | 'ERROR';
export type Verdict = 'pass' | 'fail' | 'error' | 'skipped' | 'blocked';

export interface ProcessedTicket {
  key: string;
  summary: string;
  verdict: Verdict;
  duration_ms: number;
  timestamp: string;
  /** Validation route used for this run (codified/agent/mcp). */
  route: string;
  /** Jira transition applied, e.g. "Performance Test" or "In Progress" */
  transition: string;
  /** External blocker class when verdict=blocked (jira-transition/cdp/auth/outage/unknown). */
  blocker: string | null;
  error: string | null;
}

export interface RunStatus {
  state: RunStateValue;
  mode: 'single' | 'batch';
  started_at: string | null;
  updated_at: string | null;
  finished_at: string | null;
  current: { key: string; summary: string; started_at: string } | null;
  /** Keys still waiting to be processed */
  queue: string[];
  /** Newest first */
  processed: ProcessedTicket[];
  counts: { pass: number; fail: number; error: number; skipped: number; blocked: number };
  total: number;
  done: number;
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function blank(): RunStatus {
  return {
    state: 'IDLE',
    mode: 'single',
    started_at: null,
    updated_at: null,
    finished_at: null,
    current: null,
    queue: [],
    processed: [],
    counts: { pass: 0, fail: 0, error: 0, skipped: 0, blocked: 0 },
    total: 0,
    done: 0,
  };
}

function read(): RunStatus {
  try {
    const parsed = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')) as RunStatus;
    parsed.counts = {
      pass: parsed.counts?.pass ?? 0,
      fail: parsed.counts?.fail ?? 0,
      error: parsed.counts?.error ?? 0,
      skipped: parsed.counts?.skipped ?? 0,
      blocked: parsed.counts?.blocked ?? 0,
    };
    return parsed;
  } catch {
    return blank();
  }
}

function write(s: RunStatus): void {
  const dir = path.dirname(STATE_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  s.updated_at = new Date().toISOString();
  fs.writeFileSync(STATE_FILE, JSON.stringify(s, null, 2), 'utf-8');
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Call once at the start of a run, before any ticket processing. */
export function startRun(mode: 'single' | 'batch', queue: string[]): void {
  write({
    ...blank(),
    state: 'RUNNING',
    mode,
    started_at: new Date().toISOString(),
    queue,
    total: queue.length,
  });
  console.log(`[RunState] Run started — mode=${mode}, tickets=${queue.length}`);
}

/** Call after fetching a ticket, just before validation starts. */
export function startTicket(key: string, summary: string): void {
  const s = read();
  s.state = 'RUNNING';
  s.current = { key, summary, started_at: new Date().toISOString() };
  s.queue = s.queue.filter(k => k !== key);
  write(s);
}

/** Call after a ticket finishes (pass, fail, error, or skipped). */
export function finishTicket(
  key: string,
  summary: string,
  verdict: Verdict,
  route: string,
  transition: string,
  blocker: string | null = null,
  error: string | null = null,
): void {
  const s = read();
  const startedAt = s.current?.started_at ?? new Date().toISOString();
  const duration_ms = Date.now() - new Date(startedAt).getTime();

  s.processed.unshift({
    key,
    summary,
    verdict,
    duration_ms,
    timestamp: new Date().toISOString(),
    route,
    transition,
    blocker,
    error,
  });
  s.current = null;
  s.counts[verdict]++;
  s.done++;
  s.total = Math.max(s.total, s.done + s.queue.length);
  write(s);
}

/** Call once when the entire run is complete. */
export function finishRun(): void {
  const s = read();
  s.state = 'FINISHED';
  s.current = null;
  s.finished_at = new Date().toISOString();
  write(s);
  console.log(
    `[RunState] Run finished — pass=${s.counts.pass} fail=${s.counts.fail} blocked=${s.counts.blocked} error=${s.counts.error}`,
  );
}

/** Call when a fatal error aborts the run. */
export function setError(_message?: string): void {
  const s = read();
  s.state = 'ERROR';
  write(s);
}
