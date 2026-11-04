// The same measurements on Chromium and WebKit. A message list that stalls each wheel only on WebKit (the browser
// Safari and WKWebView run) fails the jank check there and passes it on Chromium; layout shifts and long tasks, which
// WebKit has no performance entries for, are measured another way and agree with Chromium's; and an in-page meter on
// rAF and event timeStamps (as the basics gate's) reads the same on both. Needs both browsers: CI's webkit job runs it
// (FLOW_REVIEW_PARITY=1 with `npx playwright install chromium-headless-shell webkit`). On macOS runners, whose headless
// Chromium has no GPU and drops frames of its own, FLOW_REVIEW_PARITY=webkit holds the WebKit side of the wheel tests
// only; Linux holds Chromium's smooth baseline.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import * as playwright from 'playwright';
import { checks, PAGE_SCRIPT } from '../lib/checks.mjs';
import { launchBrowser } from '../lib/browser.mjs';
import { browserTypeOf, launchOptionsFor } from '../lib/engines.mjs';
import { validate } from '../lib/schema.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const skip = process.env.FLOW_REVIEW_PARITY ? false : 'needs Chromium and WebKit: CI runs it with FLOW_REVIEW_PARITY=1';
const ENGINES = ['chromium', 'webkit'];
const WHEEL_ENGINES = process.env.FLOW_REVIEW_PARITY === 'webkit' ? ['webkit'] : ENGINES;
const browsers = new Map();
const browserFor = async (engine) => {
  if (!browsers.has(engine)) browsers.set(engine, await launchBrowser(playwright[browserTypeOf(engine)], launchOptionsFor(engine)));
  return browsers.get(engine);
};
after(async () => { for (const b of browsers.values()) await b.close().catch(() => {}); });

const FIXTURE = 'http://fixture.test/';
/** A page on `engine` holding `html` at a stable URL, with the engine's page script and any init scripts. */
async function pageOn(engine, html, { init = [], width = 800, height = 600 } = {}) {
  const ctx = await (await browserFor(engine)).newContext({ viewport: { width, height }, deviceScaleFactor: 1 });
  await ctx.addInitScript(PAGE_SCRIPT);
  for (const s of init) await ctx.addInitScript(s);
  await ctx.route(`${FIXTURE}**`, (r) => r.fulfill({ contentType: 'text/html; charset=utf-8', body: html }));
  const page = await ctx.newPage();
  await page.goto(FIXTURE, { waitUntil: 'load' });
  return page;
}
const wheelHtml = fs.readFileSync(path.join(root, 'test/fixtures/wheel/index.html'), 'utf8');
const meterJs = fs.readFileSync(path.join(root, 'test/fixtures/wheel/meter.js'), 'utf8');

const out = path.join(root, '.scratch', 'engine-parity');
after(() => fs.rmSync(out, { recursive: true, force: true }));

test('a list that stalls each wheel only on WebKit fails jank on WebKit and passes it on Chromium', { skip, timeout: 180_000 }, () => {
  fs.rmSync(out, { recursive: true, force: true });
  const r = spawnSync(process.execPath, ['bin/flow-review.mjs', 'run', 'test/fixtures/wheel/flows/wheel.flow.json', '--engine', WHEEL_ENGINES.join(','), '--out', out, '--fail-on', 'jank'], { cwd: root, encoding: 'utf8', env: { ...process.env, FLOW_REVIEW_WORKERS: '1' } });
  assert.equal(r.status, 1, `WebKit's stall fails the run:\n${r.stderr}`);
  const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
  const findings = fs.readFileSync(path.join(out, 'findings.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(validate('report', report), []);
  for (const f of findings) assert.deepEqual(validate('finding', f), [], JSON.stringify(f));
  const key = 'test/fixtures/wheel/flows/wheel.flow.json#800x600-light';
  assert.deepEqual(report.units.map((u) => u.key), WHEEL_ENGINES.map((e) => (e === 'chromium' ? key : `${key}@${e}`)));
  const jank = (engine) => findings.filter((f) => f.check === 'jank' && f.step === 'scrolled' && f.cell.engine === engine);
  assert.ok(jank('webkit').some((f) => !f.pass && f.threshold === 0.1), `slow frames on WebKit: ${JSON.stringify(jank('webkit'))}`);
  assert.ok(jank('webkit').every((f) => f.method === 'timer, no raster split'), 'WebKit says how it measured');
  assert.ok(report.engines.webkit.failures > 0);
  assert.ok(report.engines.webkit.gaps.length > 0);
  assert.equal(findings.filter((f) => f.check === 'step' && !f.pass).length, 0, 'every step ran');
  if (!WHEEL_ENGINES.includes('chromium')) return;
  assert.ok(jank('chromium').every((f) => f.pass), `smooth on Chromium: ${JSON.stringify(jank('chromium'))}`);
  assert.ok(jank('chromium').some((f) => f.measured.frames >= 20), 'enough frames on Chromium to judge');
  assert.ok(jank('chromium').every((f) => f.method === 'longtask'));
  assert.equal(report.engines.chromium.failures, 0);
  assert.ok(report.provenance.browsers.chromium && report.provenance.browsers.webkit, JSON.stringify(report.provenance.browsers));
  const md = fs.readFileSync(path.join(out, 'summary.md'), 'utf8');
  assert.match(md, /### By engine/);
  assert.match(md, /\| Wheel fixture: scroll a message list \| ✅ 1 units \| ❌ jank \d+ \|/);
});

test('an in-page meter on rAF and event timeStamps runs the same on both engines, and sees the WebKit-only dead input', { skip, timeout: 120_000 }, async () => {
  const { analyze } = (new Function(`${meterJs}; return globalThis.testMeter;`))();
  const results = {};
  for (const engine of WHEEL_ENGINES) {
    const page = await pageOn(engine, wheelHtml, { init: [meterJs] });
    await page.evaluate(() => window.__testMeter.start('[data-list]'));
    const box = await page.locator('[data-list]').boundingBox();
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    for (let i = 0; i < 10; i++) {
      await page.mouse.wheel(0, 120);
      await page.waitForTimeout(80);
    }
    await page.waitForTimeout(300);
    const rec = await page.evaluate(() => window.__testMeter.stop());
    // Event timeStamps and frame timestamps are on performance.now()'s clock on both engines.
    assert.ok(rec.inputs.length >= 5, `${engine}: wheels recorded (${rec.inputs.length})`);
    for (const x of rec.inputs) assert.ok(x.ts > 0 && x.ts <= x.seen + 1, `${engine}: a wheel's timeStamp ${x.ts} is on the page clock (seen ${x.seen})`);
    assert.ok(rec.frames.every((f) => f.t > 0 && f.t <= rec.now + 1), `${engine}: frame times are on the page clock`);
    results[engine] = analyze(rec.frames, rec.inputs);
    await page.context().close();
  }
  if (results.chromium) assert.equal(results.chromium.deadInput, 0, `Chromium moves on every wheel: ${JSON.stringify(results.chromium)}`);
  assert.ok(results.webkit.deadInput >= 3, `WebKit's wheels wait on the list: ${JSON.stringify(results.webkit)}`);
  assert.ok(results.webkit.maxMs >= 100, JSON.stringify(results.webkit));
});

// A late banner pushes the page's content down; reserving its space, or sliding a toast in with a transform, or scrolling,
// shifts nothing.
const paragraphs = Array.from({ length: 12 }, (_, i) => `<p style="margin:0 0 12px">Paragraph ${i}: plain words across the page, the kind a person reads.</p>`).join('');
const shiftPage = (reserve) => `<!doctype html><html lang="en"><head><title>Shift</title></head><body style="margin:0;font:16px/1.5 sans-serif"><div id="slot" style="${reserve ? 'height:200px' : ''}"></div><main>${paragraphs}</main><script>setTimeout(() => { const b = document.createElement('div'); b.style.cssText = 'height:200px;background:#eee'; b.textContent = 'Late banner'; const slot = document.getElementById('slot'); slot.style.height = ''; slot.append(b); }, 400);</script></body></html>`;
const transformPage = `<!doctype html><html lang="en"><head><title>Toast</title></head><body style="margin:0;font:16px/1.5 sans-serif"><main>${paragraphs}</main><div id="toast" style="position:fixed;left:20px;bottom:20px;padding:12px;background:#222;color:#fff;transform:translateY(200px);transition:transform 300ms">Saved</div><script>setTimeout(() => { document.getElementById('toast').style.transform = 'translateY(0)'; }, 400);</script></body></html>`;
const scrollPage = `<!doctype html><html lang="en"><head><title>Scroll</title></head><body style="margin:0;font:16px/1.5 sans-serif"><main>${paragraphs.repeat(6)}</main><script>setTimeout(() => scrollTo({ top: 600, behavior: 'instant' }), 400);</script></body></html>`;

test('layout shift: WebKit samples positions and agrees with Chromium\'s layout-shift entries', { skip, timeout: 120_000 }, async () => {
  const measure = async (engine, html) => {
    const page = await pageOn(engine, html);
    await page.waitForTimeout(1200);
    const [f] = await checks.cls(page, { since: 0 });
    await page.context().close();
    return f;
  };
  const shifted = {};
  for (const engine of ENGINES) {
    const method = engine === 'webkit' ? 'sampled' : 'layout-shift';
    const bad = await measure(engine, shiftPage(false));
    assert.equal(bad.method, method);
    assert.equal(bad.pass, false, `${engine}: the late banner shifts the page: ${JSON.stringify(bad)}`);
    shifted[engine] = bad.measured;
    for (const [what, html] of [['reserved space', shiftPage(true)], ['a transform', transformPage], ['a scroll', scrollPage]]) {
      const good = await measure(engine, html);
      assert.equal(good.pass, true, `${engine}: ${what} is no shift: ${JSON.stringify(good)}`);
      assert.ok(good.measured < 0.02, `${engine}: ${what} measured ${good.measured}`);
    }
  }
  const [a, b] = [shifted.chromium, shifted.webkit];
  assert.ok(Math.abs(a - b) <= 0.5 * Math.max(a, b), `the two engines' scores agree within half: chromium ${a}, webkit ${b}`);
});

test('long tasks: WebKit times the main thread with a timer and finds what Chromium\'s longtask entries find', { skip, timeout: 120_000 }, async () => {
  const html = `<!doctype html><html lang="en"><head><title>Long task</title></head><body><main><p>Words.</p></main><script>setTimeout(() => { const until = performance.now() + 320; let n = 0; while (performance.now() < until) n++; window.done = n; }, 300);</script></body></html>`;
  for (const engine of ENGINES) {
    const page = await pageOn(engine, html);
    await page.waitForFunction(() => window.done !== undefined);
    await page.waitForTimeout(200);
    const list = await checks.jank(page, { since: 0 });
    const long = list.filter((f) => !f.pass && /long task/.test(f.label));
    assert.equal(long.length, 1, `${engine}: one long task: ${JSON.stringify(list)}`);
    assert.ok(long[0].measured >= 300 && long[0].measured <= 400, `${engine}: about 320 ms (${long[0].measured})`);
    await page.context().close();
  }
});

test('a known-failing list holds the WebKit-only stall as known, and an entry that passes comes off', { skip: skip || (WHEEL_ENGINES.length < 2 && 'needs both engines'), timeout: 180_000 }, () => {
  const dir = path.join(root, '.scratch', 'engine-known');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const FLOW = 'test/fixtures/wheel/flows/wheel.flow.json';
  const list = (legs) => {
    const file = path.join(dir, `${legs.join('-')}.json`);
    fs.writeFileSync(file, JSON.stringify({ about: 'test', entries: [{ case: FLOW, legs, issue: '#7', owner: 'Wheel stall (test)', why: 'each wheel waits on the list in WebKit' }] }));
    return file;
  };
  const run = (file, out) => spawnSync(process.execPath, ['bin/flow-review.mjs', 'run', FLOW, '--engine', 'chromium,webkit', '--known-failing', file, '--out', path.join(dir, out), '--fail-on', 'jank,known'], { cwd: root, encoding: 'utf8', env: { ...process.env, FLOW_REVIEW_WORKERS: '1' } });
  const read = (out) => ({ report: JSON.parse(fs.readFileSync(path.join(dir, out, 'report.json'), 'utf8')), findings: fs.readFileSync(path.join(dir, out, 'findings.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) });
  const held = run(list(['webkit']), 'held');
  assert.equal(held.status, 0, `the listed WebKit stall doesn't fail the run:\n${held.stderr}`);
  const h = read('held');
  const webkitJank = h.findings.filter((f) => f.check === 'jank' && !f.pass && f.cell.engine === 'webkit');
  assert.ok(webkitJank.length && webkitJank.every((f) => f.known === '#7' && f.knownCase === FLOW), JSON.stringify(webkitJank));
  assert.deepEqual(validate('report', h.report), []);
  assert.deepEqual({ ...h.report.knownFailing, file: null }, { file: null, enforce: true, entries: 1, failing: 1, passes: [], notRun: [], notJudged: [], judged: true });
  const off = run(list(['webkit', 'chromium']), 'off');
  assert.equal(off.status, 1, 'an entry whose cell passes fails the run');
  const o = read('off');
  assert.deepEqual(o.report.knownFailing.passes, [`${FLOW}@chromium`]);
  assert.ok(o.findings.some((f) => f.check === 'known' && !f.pass && /passes now/.test(f.measured)));
  assert.match(fs.readFileSync(path.join(dir, 'off', 'summary.md'), 'utf8'), /passes now, take off/);
  fs.rmSync(dir, { recursive: true, force: true });
});
