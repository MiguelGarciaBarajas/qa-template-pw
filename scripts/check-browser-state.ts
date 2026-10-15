import 'dotenv/config';
import { chromium } from 'playwright';

const CDP = process.env.CDP_ENDPOINT ?? 'http://localhost:9222';
const APP_HOSTNAME = 'your-app-qa.example.com';

const browser = await chromium.connectOverCDP(CDP);
const ctx = browser.contexts()[0];
const pages = ctx.pages();
console.log(`Total tabs: ${pages.length}`);

let hasAppTab = false;
for (const p of pages) {
  const url = p.url();
  let bodyLen = 0;
  try { bodyLen = (await p.locator('body').innerText({ timeout: 3000 })).trim().length; } catch {}
  const isApp = (() => { try { return new URL(url).hostname === APP_HOSTNAME; } catch { return false; } })();
  const marker = isApp ? '✅ APP' : '  ';
  console.log(`${marker} [${bodyLen} chars] ${url.slice(0, 120)}`);
  if (isApp && bodyLen > 50) hasAppTab = true;
}

console.log(hasAppTab ? '\n✅ Authenticated app tab found — batch should proceed.' : '\n❌ No authenticated app tab — login required before batch run.');
await browser.close();
