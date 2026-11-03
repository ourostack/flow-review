// TEMPORARY diagnostic for PR #9, removed before merge: how Chromium's CPU throttler actually slices a page's main
// thread on this platform (the running stretches between pauses, and the pauses), and the page calibration's factor
// measured the old way (one baseline, then throttled) and the new way (five alternating pairs, median).
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { chromium } from 'playwright';
import { launchBrowser, launchPersistentBrowser } from '../../lib/browser.mjs';
import { applyCdpConstraints } from '../../lib/constrain-cdp.mjs';
import { resolveSettings } from '../../lib/constrain-profile.mjs';

const settings = resolveSettings('old-windows-laptop', { network: { latencyMs: 0, downKbps: 0, upKbps: 0 } });
const executablePath = process.env.FLOW_REVIEW_CHROMIUM || undefined;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const server = await new Promise((resolve) => {
  const s = http.createServer((req, res) => { res.setHeader('cross-origin-opener-policy', 'same-origin'); res.setHeader('cross-origin-embedder-policy', 'require-corp'); res.setHeader('content-type', 'text/html'); res.end('<p>diag</p>'); }).listen(0, '127.0.0.1', () => resolve(s));
});
const url = `http://127.0.0.1:${server.address().port}/`;

// In the page: read the clock in a loop bounded by its count and by 300 ms, and note every jump over 40 µs (a pause).
const SLICES = `(() => {
  const iso = globalThis.crossOriginIsolated; const runs = []; const gaps = []; const t0 = performance.now(); let last = t0; let runStart = t0;
  for (let i = 0; i < 4e8; i++) { const t = performance.now(); if (t - last > 0.04) { runs.push(last - runStart); gaps.push(t - last); runStart = t; } last = t; if (t - t0 > 300) break; }
  const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? Math.round(s[Math.floor(p * (s.length - 1))] * 1000) : null; };
  const sum = (a) => a.reduce((x, y) => x + y, 0);
  const total = last - t0;
  return { iso, n: gaps.length, runUs: [q(runs, 0.1), q(runs, 0.5), q(runs, 0.9), q(runs, 1)], gapUs: [q(gaps, 0.1), q(gaps, 0.5), q(gaps, 0.9), q(gaps, 1)], capped: gaps.filter((g) => g >= 2.9 && g < 3.3).length, runsOver1ms: runs.filter((r) => r > 1).length, factor: Math.round((total / Math.max(1e-9, total - sum(gaps))) * 100) / 100 };
})()`;
const OLD_BASE = `(() => { const s = globalThis.__flowReviewSpin; const time = (n) => { const t = performance.now(); s(n); return performance.now() - t; }; const med = (a) => a.sort((p, q) => p - q)[1]; let n = 1 << 16; s(n); while (time(n) < 12.5 && n < 2 ** 34) n *= 2; n = Math.max(1, Math.round(n * 100 / med([time(n), time(n), time(n)]))); return { n, ms: med([time(n), time(n), time(n)]) }; })()`;
const OLD_MEASURE = (n) => `(() => { const s = globalThis.__flowReviewSpin; const time = () => { const t = performance.now(); s(${n}); return performance.now() - t; }; return [time(), time(), time()].sort((p, q) => p - q)[1]; })()`;

async function diag(label, send) {
  const ev = async (expression) => (await send('Runtime.evaluate', { expression, returnByValue: true })).result.value;
  for (let k = 0; k < 3; k++) {
    await send('Emulation.setCPUThrottlingRate', { rate: 4 });
    await wait(50);
    console.log(`DIAG ${process.platform} ${label} slices ${k}: ${JSON.stringify(await ev(SLICES))}`);
    await send('Emulation.setCPUThrottlingRate', { rate: 1 });
  }
  const olds = [];
  const news = [];
  for (let k = 0; k < 6; k++) {
    const r = await applyCdpConstraints(send, settings, { calibrate: true, network: false });
    news.push(`${r.cpu.achieved} [${r.cpu.factors.join(' ')}]`);
    await send('Emulation.setCPUThrottlingRate', { rate: 1 });
    const b = await ev(OLD_BASE);
    await send('Emulation.setCPUThrottlingRate', { rate: 4 });
    const c = await ev(OLD_MEASURE(b.n));
    olds.push(Math.round((c / b.ms) * 100) / 100);
    await send('Emulation.setCPUThrottlingRate', { rate: 1 });
  }
  const n = (await applyCdpConstraints(send, settings, { calibrate: true, network: false })).cpu.iterations;
  await send('Emulation.setCPUThrottlingRate', { rate: 1 });
  const plain = [];
  for (let k = 0; k < 10; k++) plain.push(Math.round(await ev(`(() => { const t = performance.now(); globalThis.__flowReviewSpin(${n}); return performance.now() - t; })()`)));
  console.log(`DIAG ${process.platform} ${label} unthrottled timings of one loop, ms: ${plain.join(', ')}`);
  console.log(`DIAG ${process.platform} ${label} old way: ${olds.join(', ')}`);
  console.log(`DIAG ${process.platform} ${label} new way: ${news.join(', ')}`);
}

try {
  const b = await launchBrowser(chromium, { executablePath });
  try {
    const page = await b.newPage();
    await page.goto(url);
    const s = await page.context().newCDPSession(page);
    await diag('playwright page', (m, p) => s.send(m, p));
  } finally { await b.close(); }
  const dir = path.resolve('.scratch', 'diag-profile');
  fs.rmSync(dir, { recursive: true, force: true });
  const ctx = await launchPersistentBrowser(chromium, dir, { executablePath, args: ['--remote-debugging-port=0'] });
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.goto(url);
    const s = await ctx.newCDPSession(page);
    await diag('persistent first page', (m, p) => s.send(m, p));
  } finally { await ctx.close(); }
} finally { server.close(); }
