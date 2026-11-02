import { chromium } from 'playwright';
import { PAGE_SCRIPT } from '../lib/checks.mjs';
import { launchBrowser } from '../lib/browser.mjs';

let browser;
export async function launch() {
  browser ??= await launchBrowser(chromium, { executablePath: process.env.FLOW_REVIEW_CHROMIUM || undefined });
  return browser;
}
export async function close() {
  await browser?.close();
  browser = undefined;
}

/** A page holding `body` (inside a minimal valid document unless it starts with <!doctype). */
export async function pageWith(body, { width = 800, height = 600, reducedMotion = 'reduce' } = {}) {
  const b = await launch();
  const ctx = await b.newContext({ viewport: { width, height }, deviceScaleFactor: 1, reducedMotion });
  await ctx.addInitScript(PAGE_SCRIPT);
  const page = await ctx.newPage();
  const html = body.trimStart().toLowerCase().startsWith('<!doctype') ? body : `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture</title></head><body>${body}</body></html>`;
  await page.setContent(html, { waitUntil: 'load' });
  return page;
}

export const failing = (findings) => findings.filter((f) => !f.pass);
