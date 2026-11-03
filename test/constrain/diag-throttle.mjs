// TEMPORARY diagnostic for PR #9, removed before merge: measures DevTools CPU throttling on a page reached on its
// debugging port with and without another throttled page left open, and how busy an idle throttled renderer is.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { chromium } from 'playwright';
import { launchBrowser, launchPersistentBrowser } from '../../lib/browser.mjs';
import { constrainPage, constrainCdp } from '../../lib/constrain-cdp.mjs';
import { resolveSettings } from '../../lib/constrain-profile.mjs';

const settings = resolveSettings('old-windows-laptop', { network: { latencyMs: 0, downKbps: 0, upKbps: 0 } });
const executablePath = process.env.FLOW_REVIEW_CHROMIUM || undefined;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function viaPort(label, rounds = 4) {
  const dir = path.resolve('.scratch', 'diag-profile');
  fs.rmSync(dir, { recursive: true, force: true });
  const ctx = await launchPersistentBrowser(chromium, dir, { executablePath, args: ['--remote-debugging-port=0'] });
  try {
    const page = ctx.pages()[0] ?? (await ctx.newPage());
    await page.setContent('<p>diag</p>');
    let port = null;
    for (let i = 0; i < 50 && !port; i++) { try { port = Number(fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await wait(100); } }
    const out = [];
    for (let i = 0; i < rounds; i++) {
      const h = await constrainCdp(`http://127.0.0.1:${port}`, settings, { calibrate: true });
      const c = h.applied[0].cpu;
      out.push(`${c.achieved}× (${c.baselineMs}->${c.constrainedMs} ms)`);
      await h.close();
    }
    console.log(`DIAG ${process.platform} ${label}: ${out.join(', ')}`);
  } finally { await ctx.close(); }
}

const cpuOf = () => {
  if (process.platform === 'win32') return '(no ps on Windows)';
  return execFileSync('ps', ['-A', '-o', 'pid=,%cpu=,command='], { encoding: 'utf8' }).split('\n').filter((l) => /renderer/.test(l)).map((l) => l.trim().split(/\s+/).slice(0, 2).join(' ')).join('; ');
};

await viaPort('alone');
const b = await launchBrowser(chromium, { executablePath });
const left = await b.newPage();
await left.setContent('<p>left open</p>');
await constrainPage(left, settings);
await wait(3000);
console.log(`DIAG ${process.platform} renderer CPU with an idle page throttled 4x: ${cpuOf()}`);
await viaPort('with an idle throttled page left open in another browser');
await b.close();
await wait(1000);
console.log(`DIAG ${process.platform} renderer CPU after it closed: ${cpuOf()}`);
await viaPort('alone again');
