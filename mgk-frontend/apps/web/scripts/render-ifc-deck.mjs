import { chromium } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = resolve(process.cwd(), '../../..');
const source = resolve(root, 'docs/ifc-pitch/deck.html');
const output = resolve(root, 'docs/ifc-pitch/artifacts');
await mkdir(output, { recursive: true });

const browser = await chromium.launch({ headless: true });
const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 1 });
await page.goto(pathToFileURL(source).href, { waitUntil: 'load' });
await page.emulateMedia({ media: 'screen' });

const slides = page.locator('.slide');
if (await slides.count() !== 2) throw new Error('Deck must contain exactly two slides.');
for (let index = 0; index < 2; index += 1) {
  await slides.nth(index).screenshot({ path: resolve(output, `mgk-ifc-pitch-page-${index + 1}.png`) });
}

await page.emulateMedia({ media: 'print' });
await page.pdf({ path: resolve(output, 'mgk-ifc-pitch.pdf'), preferCSSPageSize: true, printBackground: true, tagged: true });
await browser.close();
console.log(`Rendered 2 slides to ${output}`);
