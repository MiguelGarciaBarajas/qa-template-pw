import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { connectBrowser, disconnectBrowser } from './cdp-browser.js';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const durationSec = Number(args[0] ?? '900') || 900;
  const outDir = path.join('artifacts', 'manual-recordings');
  fs.mkdirSync(outDir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tracePath = path.join(outDir, `manual-flow-${stamp}.zip`);

  const session = await connectBrowser();
  const { context, page } = session;

  try {
    await context.tracing.start({ screenshots: true, snapshots: true });
    console.log(`[Recorder] Recording started for ${durationSec}s`);
    console.log('[Recorder] Use the newly opened Edge tab and perform your flow.');
    console.log(`[Recorder] Trace output will be saved at: ${tracePath}`);
    console.log(`[Recorder] Active tab URL: ${page.url()}`);

    await new Promise(resolve => setTimeout(resolve, durationSec * 1000));

    await context.tracing.stop({ path: tracePath });
    console.log(`[Recorder] Recording finished. Trace saved: ${tracePath}`);
  } finally {
    await disconnectBrowser(session);
  }
}

main().catch(err => {
  console.error('[Recorder] Fatal error:', err);
  process.exit(1);
});
