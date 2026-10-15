import 'dotenv/config';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import { verifyCDP } from './cdp-browser.js';

const DEFAULT_TIMEOUT_MS = 30_000;

export interface EnsureCDPResult {
  alreadyRunning: boolean;
  started: boolean;
  endpoint: string;
  edgePath: string;
  profileDir: string;
}

function cdpEndpoint(): string {
  return process.env.CDP_ENDPOINT ?? 'http://localhost:9222';
}

function resolveEdgePath(): string {
  const x86 = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
  const x64 = 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe';
  if (existsSync(x86)) return x86;
  if (existsSync(x64)) return x64;
  throw new Error('[CDP] Edge executable not found in Program Files.');
}

function resolveProfileDir(): string {
  const configured = process.env.CDP_USER_DATA_DIR?.trim();
  if (configured) return configured;
  const localAppData = process.env.LOCALAPPDATA;
  if (!localAppData) throw new Error('[CDP] LOCALAPPDATA is missing.');
  return join(localAppData, 'Microsoft', 'Edge', 'User Data QA-Brain-CDP');
}

async function waitUntilReady(timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await verifyCDP()) return true;
    await new Promise(resolve => setTimeout(resolve, 1_000));
  }
  return false;
}

function parsePort(endpoint: string): string {
  const value = endpoint.trim();
  const match = value.match(/:(\d+)(?:\/|$)/);
  return match?.[1] ?? '9222';
}

export async function ensureCDPRunning(timeoutMs = DEFAULT_TIMEOUT_MS): Promise<EnsureCDPResult> {
  const endpoint = cdpEndpoint();
  const edgePath = resolveEdgePath();
  const profileDir = resolveProfileDir();

  if (await verifyCDP()) {
    return { alreadyRunning: true, started: false, endpoint, edgePath, profileDir };
  }

  const port = parsePort(endpoint);
  const args = [
    `--remote-debugging-port=${port}`,
    `--user-data-dir=${profileDir}`,
    'about:blank',
  ];

  const child = spawn(edgePath, args, {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();

  const up = await waitUntilReady(timeoutMs);
  if (!up) {
    throw new Error(
      `[CDP] Failed to start CDP at ${endpoint} within ${Math.round(timeoutMs / 1000)}s. ` +
      `Launched Edge with dedicated profile: ${profileDir}`,
    );
  }

  return { alreadyRunning: false, started: true, endpoint, edgePath, profileDir };
}

async function main(): Promise<void> {
  const result = await ensureCDPRunning();
  const state = result.alreadyRunning ? 'already running' : 'started';
  console.log(`[CDP] ${state} at ${result.endpoint}`);
  console.log(`[CDP] Edge: ${result.edgePath}`);
  console.log(`[CDP] Profile: ${result.profileDir}`);
}

const invokedPath = process.argv[1] ?? '';
if (/(^|[\\/])cdp-start\.(ts|js)$/i.test(invokedPath)) {
  main().catch(err => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
