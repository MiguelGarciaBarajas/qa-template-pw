/**
 * Network Monitor
 * Intercepts HTTP requests during a Playwright session.
 * Captures errors (4xx/5xx), saves them as JSON for Jira attachments.
 */

import { type Page, type Request, type Response } from 'playwright';
import fs from 'fs';
import path from 'path';

export interface NetworkEntry {
  timestamp: string;
  method: string;
  url: string;
  status: number;
  statusText: string;
  requestHeaders: Record<string, string>;
  responseBody: string;
}

const ARTIFACTS_DIR = 'artifacts';

export class NetworkMonitor {
  private entries: NetworkEntry[] = [];
  private requestMap = new Map<string, { method: string; url: string; headers: Record<string, string> }>();

  /** Attach network monitoring to a Playwright page */
  attach(page: Page): void {
    page.on('request', (req: Request) => {
      this.requestMap.set(req.url(), {
        method: req.method(),
        url: req.url(),
        headers: req.headers(),
      });
    });

    page.on('response', (res: Response) => {
      const status = res.status();
      if (status >= 400) {
        const req = this.requestMap.get(res.url());
        // Read body with a short timeout to avoid holding up the event loop.
        // Fire-and-forget pattern: we don't await so this never blocks the LLM call.
        const entry: NetworkEntry = {
          timestamp: new Date().toISOString(),
          method: req?.method ?? 'GET',
          url: res.url(),
          status,
          statusText: res.statusText(),
          requestHeaders: sanitizeHeaders(req?.headers ?? {}),
          responseBody: '',
        };
        this.entries.push(entry);
        // Attempt body read with 1-second guard; don't block the caller.
        const bodyTimeout = new Promise<string>(r => setTimeout(() => r(''), 1_000));
        Promise.race([res.text().catch(() => ''), bodyTimeout])
          .then(body => { entry.responseBody = body.slice(0, 2_000); })
          .catch(() => {});
      }
    });
  }

  /** Get all captured error entries */
  getErrors(): NetworkEntry[] {
    return [...this.entries];
  }

  /** Check if any errors were captured */
  hasErrors(): boolean {
    return this.entries.length > 0;
  }

  /** Save errors to a JSON file and return the path */
  save(name: string, subdir = ''): string | null {
    if (this.entries.length === 0) return null;

    const dir = subdir ? path.join(ARTIFACTS_DIR, subdir) : ARTIFACTS_DIR;
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    const filePath = path.join(dir, `network-errors-${name}-${Date.now()}.json`);
    fs.writeFileSync(filePath, JSON.stringify(this.entries, null, 2), 'utf-8');
    console.log(`[Network] Saved ${this.entries.length} error(s) to ${filePath}`);
    return filePath;
  }

  /** Clear captured entries */
  reset(): void {
    this.entries = [];
    this.requestMap.clear();
  }
}

/** Remove sensitive headers from network logs before saving */
function sanitizeHeaders(headers: Record<string, string>): Record<string, string> {
  const SENSITIVE = new Set(['authorization', 'cookie', 'x-auth-token', 'x-api-key']);
  return Object.fromEntries(
    Object.entries(headers).map(([k, v]) =>
      SENSITIVE.has(k.toLowerCase()) ? [k, '[REDACTED]'] : [k, v]
    )
  );
}
