/**
 * Screenshot Utility
 * Captures screenshots via Playwright and adds basic annotations (red boxes/arrows).
 */

import { type Page } from 'playwright';
import fs from 'fs';
import path from 'path';
import { Jimp } from 'jimp';

const ARTIFACTS_DIR = 'artifacts';

export interface AnnotationBox {
  x: number;
  y: number;
  width: number;
  height: number;
  color?: number; // hex, default red
}

/** Ensure artifacts directory exists */
function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

/**
 * Capture a screenshot and return the file path (or '' if the capture failed).
 *
 * Evidence capture is best-effort: a screenshot that hangs or fails must NEVER
 * abort the functional assertion around it (a flaky `page.screenshot` timeout was
 * wrongly failing whole validator variants). We use a shorter explicit timeout and
 * swallow errors, returning '' so callers can filter it out.
 */
export async function capture(page: Page, name: string, subdir = ''): Promise<string> {
  const dir = subdir ? path.join(ARTIFACTS_DIR, subdir) : ARTIFACTS_DIR;
  ensureDir(dir);
  const filename = `${name}-${Date.now()}.png`;
  const filePath = path.join(dir, filename);
  try {
    await page.screenshot({ path: filePath, fullPage: false, timeout: 15_000 });
    console.log(`[Screenshot] Saved: ${filePath}`);
    return filePath;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[Screenshot] Failed to capture "${name}": ${msg}`);
    return '';
  }
}

/** Capture and annotate a screenshot with red boxes marking areas of interest */
export async function captureAnnotated(
  page: Page,
  name: string,
  annotations: AnnotationBox[],
  subdir = ''
): Promise<string> {
  const rawPath = await capture(page, `${name}-raw`, subdir);

  if (annotations.length === 0) return rawPath;

  const img = await Jimp.read(rawPath);
  const RED = 0xff0000ff;

  for (const box of annotations) {
    const color = box.color ?? RED;
    const thickness = 3;

    // Draw rectangle border
    for (let i = 0; i < thickness; i++) {
      // Top edge
      for (let x = box.x; x < box.x + box.width; x++) img.setPixelColor(color, x, box.y + i);
      // Bottom edge
      for (let x = box.x; x < box.x + box.width; x++) img.setPixelColor(color, x, box.y + box.height - i);
      // Left edge
      for (let y = box.y; y < box.y + box.height; y++) img.setPixelColor(color, box.x + i, y);
      // Right edge
      for (let y = box.y; y < box.y + box.height; y++) img.setPixelColor(color, box.x + box.width - i, y);
    }
  }

  const dir = subdir ? path.join(ARTIFACTS_DIR, subdir) : ARTIFACTS_DIR;
  const annotatedPath = path.join(dir, `${name}-annotated-${Date.now()}.png`);
  await img.write(annotatedPath as `${string}.png`);
  console.log(`[Screenshot] Annotated: ${annotatedPath}`);

  // Clean up raw file
  fs.unlinkSync(rawPath);
  return annotatedPath;
}

/** Capture the element bounding box and annotate it automatically */
export async function captureElement(
  page: Page,
  selector: string,
  name: string,
  subdir = ''
): Promise<string> {
  const element = page.locator(selector).first();
  const box = await element.boundingBox();

  if (!box) {
    console.warn(`[Screenshot] Element not found: ${selector}`);
    return capture(page, name, subdir);
  }

  return captureAnnotated(page, name, [{ x: box.x, y: box.y, width: box.width, height: box.height }], subdir);
}
