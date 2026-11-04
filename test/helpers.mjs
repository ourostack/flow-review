import * as playwright from 'playwright';
import { PAGE_SCRIPT } from '../lib/checks.mjs';
import { launchBrowser } from '../lib/browser.mjs';
import { parseEngines, browserTypeOf, launchOptionsFor } from '../lib/engines.mjs';

/** The engine these tests' pages run on: FLOW_REVIEW_ENGINE's first (CI runs the suite on chromium and on webkit). */
export const ENGINE = parseEngines(process.env.FLOW_REVIEW_ENGINE)[0];

let browser;
export async function launch() {
  browser ??= await launchBrowser(playwright[browserTypeOf(ENGINE)], launchOptionsFor(ENGINE));
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
