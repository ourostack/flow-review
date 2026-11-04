// Constrained computer: the profile, the slow-network proxy, the slow-disk preload, the DevTools throttling of pages,
// and the CLI end to end on this platform: the CPU slowdown it measures, a grandchild slowed as much, the memory cap
// enforced or detected, a run's report marked as constrained, and nothing left running after a run ends or times out.
// These tests measure speed, so they run on their own (npm run test:constrain), never alongside the other test files,
// and only where flow-review constrain may run: on a CI runner or a declared sandbox. Anywhere else they are skipped.
import nodeTest from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { resolveSettings, constrainedFromEnv, bannerLine, PROFILES, CONSTRAINED_ENV } from '../../lib/constrain-profile.mjs';
import { pickMechanisms, jobCpuRate, windowsCommandLine, constrainedEnv, sandboxedHost, launchConstrained } from '../../lib/constrain.mjs';
import { startDelayProxy } from '../../lib/constrain-proxy.mjs';
import { constrainPage, constrainCdp } from '../../lib/constrain-cdp.mjs';
import { baseline, within } from '../../lib/constrain-calibrate.mjs';
import { launchPersistentBrowser } from '../../lib/browser.mjs';
import { validate } from '../../lib/schema.mjs';
import { launch, close } from '../helpers.mjs';

const notSandboxed = !sandboxedHost() && 'flow-review constrain runs only on a CI runner or a declared sandbox (FLOW_REVIEW_CONSTRAIN_SANDBOX=1)';
const test = (name, options, fn) => (typeof options === 'function' ? nodeTest(name, { skip: notSandboxed }, options) : nodeTest(name, { ...options, skip: options.skip || notSandboxed }, fn));
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const scratch = path.join(root, '.scratch', 'constrain');
const fixture = (f) => path.join(root, 'test', 'fixtures', 'constrain', f);
const run = (args, env = {}) => new Promise((resolve) => {
  const p = spawn(process.execPath, ['bin/flow-review.mjs', ...args], { cwd: root, env: { ...process.env, [CONSTRAINED_ENV]: '', ...env } });
  let stdout = '';
  let stderr = '';
  p.stdout.on('data', (d) => { stdout += d; });
  p.stderr.on('data', (d) => { stderr += d; });
  p.on('close', (status) => resolve({ status, stdout, stderr }));
});
// One run, never retried: a calibration measured in adjacent pairs (the constraint lifted, then on) holds on a busy or
// drifting runner, so a refusal here (exit 4) is a failure to look at, not noise to try again.
const runConstrain = run;
const serve = (body) => new Promise((resolve) => {
  const server = http.createServer((req, res) => { res.setHeader('cache-control', 'no-store'); res.setHeader('access-control-allow-origin', '*'); res.end(body); }).listen(0, '127.0.0.1', () => resolve(server));
});
const viaProxy = (proxy, url) => new Promise((resolve, reject) => {
  const t = performance.now();
  http.get({ host: '127.0.0.1', port: proxy.port, path: url }, (res) => {
    let n = 0;
    res.on('data', (d) => { n += d.length; });
    res.on('end', () => resolve({ ms: performance.now() - t, bytes: n, status: res.statusCode }));
  }).on('error', reject);
});
fs.mkdirSync(scratch, { recursive: true });
const describe = (summary) => { const c = summary.cpu; return `${c.mechanism} measured ${c.achieved}× (${c.baselineMs} ms -> ${c.constrainedMs} ms${c.corrections ? `, ${c.corrections} corrections` : ''}${c.dutyRatio ? `, ratio ${c.dutyRatio}` : ''}${c.rate ? `, rate ${c.rate}` : ''}${c.quota ? `, quota ${c.quota}` : ''}); 10 ms tasks ${c.burst?.achieved}× (${c.burst?.baselineMs} ms -> ${c.burst?.constrainedMs} ms)`; };

test('the old-windows-laptop profile, overrides and the environment switch', () => {
  const s = resolveSettings('old-windows-laptop');
  assert.deepEqual({ cpu: s.cpu, memoryMB: s.memoryMB, disk: s.disk, network: s.network }, { ...PROFILES['old-windows-laptop'] });
  assert.equal(s.cpu, 4);
  const o = resolveSettings('old-windows-laptop', { cpu: '6', network: { latencyMs: 0 } });
  assert.equal(o.cpu, 6);
  assert.equal(o.network.latencyMs, 0);
  assert.equal(o.network.downKbps, 5000);
  assert.deepEqual(o.overridden, ['cpu', 'network.latencyMs']);
  assert.throws(() => resolveSettings('fast-desktop'), /unknown constrained profile "fast-desktop"; profiles are old-windows-laptop/);
  assert.throws(() => resolveSettings('old-windows-laptop', { cpu: 0.5 }), /cpu must be a number of at least 1/);
  assert.equal(constrainedFromEnv({}), null);
  assert.equal(constrainedFromEnv({ [CONSTRAINED_ENV]: 'off' }), null);
  assert.equal(constrainedFromEnv({ [CONSTRAINED_ENV]: 'old-windows-laptop' }).cpu, 4);
  assert.equal(constrainedFromEnv({ [CONSTRAINED_ENV]: '1' }).profile, 'old-windows-laptop');
  const inTree = constrainedFromEnv({ [CONSTRAINED_ENV]: JSON.stringify({ ...s, tree: { cpu: 'duty-cycle', memory: 'rss-watch', achieved: 3.9 } }) });
  assert.equal(inTree.tree.achieved, 3.9);
  assert.match(bannerLine(s), /^CONSTRAINED COMPUTER \(old-windows-laptop\): CPU 4× slower · memory 2048 MB · disk \+4 ms\/op, 60 MB\/s \(Node fs\) · network \+150 ms, 5 Mbps down \/ 1 Mbps up$/);
});

test('each platform picks what it can enforce, and says so', () => {
  const s = resolveSettings();
  assert.deepEqual(pickMechanisms(s, { platform: 'win32' }), { cpu: 'job-duty-cycle', memory: 'job-memory' });
  assert.deepEqual(pickMechanisms(s, { platform: 'win32', cpuMechanism: 'hard-cap' }), { cpu: 'job-cpu-rate', memory: 'job-memory' });
  assert.deepEqual(pickMechanisms(s, { platform: 'darwin' }), { cpu: 'duty-cycle', memory: 'rss-watch' });
  assert.deepEqual(pickMechanisms(s, { platform: 'linux', env: { CI: 'true' }, cgroup: () => true }), { cpu: 'cgroup-cpu-max', memory: 'cgroup-memory-max' });
  assert.deepEqual(pickMechanisms(s, { platform: 'linux', env: { CI: 'true' }, cgroup: () => true, cpuMechanism: 'duty-cycle' }), { cpu: 'duty-cycle', memory: 'cgroup-memory-max' });
  assert.deepEqual(pickMechanisms(s, { platform: 'linux', env: {}, cgroup: () => true }), { cpu: 'duty-cycle', memory: 'rss-watch' }, 'outside CI, no sudo');
  assert.deepEqual(pickMechanisms(s, { platform: 'linux', env: { CI: 'true' }, cgroup: () => false }), { cpu: 'duty-cycle', memory: 'rss-watch' });
  assert.deepEqual(pickMechanisms(resolveSettings(undefined, { cpu: 1, memoryMB: 0 }), { platform: 'win32' }), { cpu: null, memory: null });
  assert.throws(() => pickMechanisms(s, { platform: 'linux', cpuMechanism: 'hard-cap', cgroup: () => false }), /sudo without a password/);
  assert.throws(() => pickMechanisms(s, { platform: 'darwin', cpuMechanism: 'hard-cap' }), /no hard CPU cap/);
  assert.throws(() => pickMechanisms(s, { platform: 'win32', cpuMechanism: 'job' }), /unknown CPU mechanism job/);
  assert.equal(jobCpuRate(4, 4), 625, 'one core of four, at a quarter');
  assert.equal(jobCpuRate(4, 1), 2500);
  // Quoted for the program, then every cmd.exe metacharacter escaped with ^ (twice for a .cmd or .bat, which reads %* again).
  assert.equal(windowsCommandLine('npm', ['run', 'say "hi"', 'C:\\a b\\']), 'npm ^"run^" ^"say^ \\^"hi\\^"^" ^"C:\\a^ b\\\\^"');
  assert.equal(windowsCommandLine('npm', ['run', 'a&b'], { batch: true }), 'npm ^^^"run^^^" ^^^"a^^^&b^^^"');
  const env = constrainedEnv({ NODE_OPTIONS: '--max-old-space-size=512', NO_PROXY: 'corp' }, s, 'http://127.0.0.1:1');
  assert.match(env.NODE_OPTIONS, /^--max-old-space-size=512 --import=file:.*constrain-fs\.mjs --disable-warning=UNDICI-EHPA$/);
  assert.equal(env.HTTPS_PROXY, 'http://127.0.0.1:1');
  assert.equal(env.NO_PROXY, 'corp,localhost,127.0.0.1,::1');
  assert.equal(JSON.parse(env[CONSTRAINED_ENV]).profile, 'old-windows-laptop');
});

test('the proxy adds round-trip latency, limits throughput and tunnels HTTPS', async () => {
  const small = await serve('ok');
  const big = await serve('x'.repeat(25_000));
  const url = (s) => `http://127.0.0.1:${s.address().port}/`;
  try {
    const slow = await startDelayProxy({ latencyMs: 300 });
    const r = await viaProxy(slow, url(small));
    assert.equal(r.status, 200);
    assert.ok(r.ms >= 290 && r.ms < 1500, `a request through a 300 ms proxy took ${r.ms.toFixed(0)} ms`);

    // CONNECT: a round trip to connect, then one for the request.
    const t = performance.now();
    const answer = await new Promise((resolve, reject) => {
      const sock = net.connect(slow.port, '127.0.0.1', () => sock.write(`CONNECT 127.0.0.1:${small.address().port} HTTP/1.1\r\nHost: x\r\n\r\n`));
      let got = '';
      sock.on('data', (d) => {
        got += d;
        if (got.includes('Connection Established\r\n\r\n') && !got.includes('GET-SENT')) { got += 'GET-SENT'; sock.write('GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'); }
      });
      sock.on('end', () => resolve(got));
      sock.on('error', reject);
    });
    const tunnelMs = performance.now() - t;
    assert.match(answer, /200 Connection Established[\s\S]*HTTP\/1\.1 200 OK[\s\S]*ok$/);
    assert.ok(tunnelMs >= 590, `a tunnelled request took ${tunnelMs.toFixed(0)} ms, under two round trips`);
    assert.equal(slow.stats().tunnels, 1);
    await slow.close();

    const narrow = await startDelayProxy({ downKbps: 100 });
    const b = await viaProxy(narrow, url(big));
    assert.equal(b.bytes, 25_000);
    assert.ok(b.ms >= 1900 && b.ms < 5000, `25 KB at 100 kbps took ${b.ms.toFixed(0)} ms, not about 2 s`);
    assert.ok(narrow.stats().bytesDown >= 25_000);
    await narrow.close();
  } finally {
    small.close();
    big.close();
  }
});

test("the slow-disk preload slows every style of Node's fs calls", () => {
  const file = path.join(scratch, 'disk.bin');
  fs.writeFileSync(file, Buffer.alloc(512 * 1024, 7));
  const preload = pathToFileURL(path.join(root, 'lib', 'constrain-fs.mjs')).href;
  const env = { ...process.env, NODE_OPTIONS: `--import=${preload}`, [CONSTRAINED_ENV]: JSON.stringify({ ...resolveSettings(), disk: { latencyMs: 20, mbPerSec: 1 } }) };
  const r = spawnSync(process.execPath, [fixture('disk.mjs'), file], { encoding: 'utf8', env });
  assert.equal(r.status, 0, r.stderr);
  const ms = JSON.parse(r.stdout);
  for (const k of ['sync', 'named', 'promises', 'callback']) assert.ok(ms[k] >= 95, `5 ${k} stats took ${ms[k].toFixed(0)} ms, under 5 × 20 ms`);
  assert.ok(ms.promisified >= 38, `open and read took ${ms.promisified.toFixed(0)} ms`);
  assert.ok(ms.readFile >= 500, `512 KB at 1 MB/s took ${ms.readFile.toFixed(0)} ms`);
  assert.ok(ms.stream >= 500, `a 512 KB stream at 1 MB/s took ${ms.stream.toFixed(0)} ms`);
  const plain = spawnSync(process.execPath, [fixture('disk.mjs'), file], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
  assert.ok(JSON.parse(plain.stdout).sync < 50, 'without the preload the disk is fast');
});

test('pages: DevTools throttles CPU about 4× and slows the network', async (t) => {
  const site = await serve('x'.repeat(20_000));
  const url = `http://127.0.0.1:${site.address().port}/`;
  const settings = resolveSettings('old-windows-laptop', { network: { latencyMs: 300, downKbps: 0, upKbps: 0 } });
  const fetchMs = (page) => page.evaluate(async (u) => { const t0 = performance.now(); await (await fetch(u, { cache: 'no-store' })).text(); return performance.now() - t0; }, url);
  try {
    // Each part closes its browser before the next starts. Chromium slows a page by holding its main thread in a busy
    // wait for the slowed share of every moment, so a throttled page left open keeps a core busy, idle or not: on a
    // three-core runner it starves the next page's throttling and halves the slowdown measured there.
    await t.test('a Playwright page', async () => {
      try {
        const b = await launch();
        const page = await b.newPage();
        await page.goto(url);
        const r = await constrainPage(page, settings, { calibrate: true });
        console.log(`a Playwright page: ${r.cpu.achieved}× (${r.cpu.baselineMs} ms -> ${r.cpu.constrainedMs} ms; pairs ${r.cpu.factors.join(', ')})`);
        assert.equal(r.cpu.rate, 4);
        assert.ok(within(r.cpu.achieved, 4, 0.25), `the page measured ${r.cpu.achieved}×`);
        const ms = await fetchMs(page);
        assert.ok(ms >= 290, `a fetch took ${ms.toFixed(0)} ms under 300 ms of latency`);
        const inTree = await constrainPage(await b.newPage(), { ...settings, tree: { cpu: 'duty-cycle' } });
        assert.equal(inTree.cpu.rate, null, 'a page in a throttled tree is not slowed twice');
        assert.match(inTree.cpu.skipped, /constrained process tree/);
        assert.equal(await constrainPage(page, null), null, 'off when constrained mode is off');
      } finally { await close(); }
    });
    await t.test('any Chromium on its remote-debugging port, as WebView2 is reached', async () => {
      const dir = path.join(scratch, 'profile');
      fs.rmSync(dir, { recursive: true, force: true });
      const ctx = await launchPersistentBrowser(chromium, dir, { executablePath: process.env.FLOW_REVIEW_CHROMIUM || undefined, args: ['--remote-debugging-port=0'] });
      try {
        const page = ctx.pages()[0] ?? (await ctx.newPage());
        await page.goto(url);
        let port = null;
        for (let i = 0; i < 50 && !port; i++) {
          try { port = Number(fs.readFileSync(path.join(dir, 'DevToolsActivePort'), 'utf8').split('\n')[0]); } catch { await new Promise((r) => setTimeout(r, 100)); }
        }
        assert.ok(port, 'Chromium wrote its DevTools port');
        const handle = await constrainCdp(`http://127.0.0.1:${port}`, settings, { calibrate: true });
        try {
          assert.ok(handle.applied.length >= 1);
          const r = handle.applied.find((a) => a.url.startsWith(url));
          assert.ok(r, `the page at ${url} was constrained: ${JSON.stringify(handle.applied.map((a) => a.url))}`);
          console.log(`a page on its debugging port: ${r.cpu.achieved}× (${r.cpu.baselineMs} ms -> ${r.cpu.constrainedMs} ms; pairs ${r.cpu.factors.join(', ')})`);
          assert.ok(within(r.cpu.achieved, 4, 0.25), `the page measured ${r.cpu.achieved}×`);
          const ms = await fetchMs(page);
          assert.ok(ms >= 290, `a fetch took ${ms.toFixed(0)} ms under 300 ms of latency`);
        } finally { await handle.close(); }
        // Closing lifts the throttling: the same loop runs at full speed again.
        const lifted = handle.applied.find((a) => a.url.startsWith(url)).cpu;
        const after = await page.evaluate((n) => { const ms = [0, 1, 2].map(() => { const t = performance.now(); globalThis.__flowReviewSpin(n); return performance.now() - t; }); return ms.sort((a, b) => a - b)[1]; }, lifted.iterations);
        assert.ok(after < lifted.constrainedMs / 2, `after close the loop took ${after.toFixed(0)} ms, ${lifted.constrainedMs} ms throttled and ${lifted.baselineMs} ms before`);
      } finally { await ctx.close(); }
    });
  } finally {
    site.close();
    await close();
  }
});

test('flow-review constrain: the whole tree runs about 4× slower, proven by measurement', { timeout: 180_000 }, async () => {
  const site = await serve('ok');
  const summaryFile = path.join(scratch, 'tree.json');
  try {
    const { iterations } = baseline(150);
    // The grandchild's unconstrained time: the median of three plain runs, one before the constrained run and two after,
    // so a moment when this computer runs fast or slow (a virtual Apple silicon runner's cores change speed under it)
    // isn't taken for the baseline.
    const plainGrandchildMs = () => JSON.parse(spawnSync(process.execPath, [fixture('tree.mjs'), String(iterations)], { encoding: 'utf8', env: { ...process.env, [CONSTRAINED_ENV]: '' } }).stdout.split('TREE ')[1].split('\n')[0]).grandchildMs;
    const plain = [plainGrandchildMs()];
    const r = await runConstrain(['constrain', '--summary', summaryFile, '--', 'node', fixture('tree.mjs'), String(iterations), `http://127.0.0.1:${site.address().port}/`]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /CONSTRAINED COMPUTER \(old-windows-laptop\): CPU 4× slower \(measured [\d.]+×, 10 ms tasks [\d.]+×, (job-duty-cycle|cgroup-cpu-max|duty-cycle)\)/, 'a banner before');
    assert.match(r.stderr, /CONSTRAINED COMPUTER [^\n]*: exit 0; no caps hit/, 'and after');
    const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
    assert.deepEqual(validate('constrained', summary), []);
    const expected = { win32: 'job-duty-cycle', darwin: 'duty-cycle' }[process.platform] ?? (process.env.CI === 'true' && summary.cpu.mechanism === 'cgroup-cpu-max' ? 'cgroup-cpu-max' : 'duty-cycle');
    assert.equal(summary.cpu.mechanism, expected);
    console.log(`constrain on ${summary.platform} (${summary.cpu.cpus} CPUs): ${describe(summary)}; memory ${summary.memory.mechanism} (${summary.memory.enforcement}), peak ${summary.memory.peakMB} MB`);
    assert.equal(summary.cpu.within, true);
    assert.ok(summary.cpu.achieved >= 3.6 && summary.cpu.achieved <= 4.4, `measured ${summary.cpu.achieved}×, not within 4× ±10%`);
    assert.equal(summary.cpu.calibration.length, summary.cpu.corrections + 1, 'every measurement is in the summary');
    assert.equal(summary.cpu.calibration.at(-1).achieved, summary.cpu.achieved, 'and the last is the factor reported');
    assert.ok(summary.cpu.factors.length >= 3 && summary.cpu.factors.length <= 9, `three to nine pairs a measurement: ${summary.cpu.factors.length}`);
    assert.equal(summary.cpu.burst.within, true);
    assert.ok(summary.cpu.burst.achieved >= 3 && summary.cpu.burst.achieved <= 5, `10 ms tasks measured ${summary.cpu.burst.achieved}×`);
    assert.equal(summary.cpu.dutyCycle, true, 'every CPU mechanism has a duty cycle, so short tasks are slowed from their start');
    assert.equal(summary.ok, true);
    assert.deepEqual(summary.capsHit, []);
    const tree = JSON.parse(r.stdout.split('TREE ')[1].split('\n')[0]);
    plain.push(plainGrandchildMs(), plainGrandchildMs());
    const baseMs = [...plain].sort((a, b) => a - b)[1];
    const ratio = tree.grandchildMs / baseMs;
    console.log(`a grandchild ran the loop in ${tree.grandchildMs.toFixed(0)} ms, ${baseMs.toFixed(0)} ms unconstrained (${plain.map((ms) => ms.toFixed(0)).join(', ')}): ${ratio.toFixed(2)}×`);
    assert.ok(ratio >= 2.8 && ratio <= 5.5, `a grandchild ran ${ratio.toFixed(2)}× slower, not about 4×`);
    assert.equal(tree.env.profile, 'old-windows-laptop');
    assert.equal(tree.env.tree.achieved, summary.cpu.achieved, 'the harness learns the measured factor');
    assert.equal(tree.env.tree.burst, summary.cpu.burst.achieved, 'and the short tasks\' factor');
    assert.equal(tree.proxy, summary.network.proxy);
    assert.ok(tree.requestMs >= 145, `a request through the run's proxy took ${tree.requestMs.toFixed(0)} ms, under 150 ms`);
    assert.ok(tree.statMs >= 19, `5 stats took ${tree.statMs.toFixed(0)} ms, under 5 × 4 ms`);
    assert.equal(summary.network.requests, 1);
  } finally {
    site.close();
  }
});

test("flow-review constrain: the platform's other CPU mechanism", { skip: process.platform === 'darwin' && 'macOS has only the duty cycle', timeout: 150_000 }, async () => {
  const other = process.platform === 'win32' ? ['hard-cap', 'job-cpu-rate'] : ['duty-cycle', 'duty-cycle'];
  const summaryFile = path.join(scratch, 'other.json');
  const r = await runConstrain(['constrain', '--cpu-mechanism', other[0], '--summary', summaryFile, '--', 'node', '-e', '0']);
  const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
  console.log(`${other[0]} on ${summary.platform}: ${describe(summary)}`);
  assert.equal(summary.cpu.mechanism, other[1]);
  if (process.platform === 'linux') assert.equal(summary.cpu.quota ?? null, null, 'under the duty cycle a cgroup holds memory only, never a CPU cap as well');
  assert.equal(r.status, 0, r.stderr);
  assert.equal(summary.cpu.within, true);
  assert.equal(summary.cpu.burst.within, true, `10 ms tasks measured ${summary.cpu.burst.achieved}×`);
  assert.equal(summary.cpu.dutyCycle, true);
});

// The defect this gate exists for, planted: a hard cap alone, over a window long enough (Windows' own, or a Linux cgroup
// period of 100 ms) that a 10 ms task after idle runs at full speed. Long work measures about 4×; the short tasks
// don't, so the command doesn't run.
test('a constraint that lets short tasks run at full speed is refused, and the command never runs', { skip: (process.platform === 'darwin' && 'macOS has no hard cap to plant it in') || (process.platform === 'linux' && process.env.CI !== 'true' && 'the cgroup needs CI'), timeout: 150_000 }, async () => {
  const marker = path.join(scratch, 'escaped-ran');
  fs.rmSync(marker, { force: true });
  const summary = await launchConstrained(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`], {
    cpuMechanism: 'hard-cap', capDuty: false, cgroupPeriodUs: 100_000, overrides: { memoryMB: 0, network: { latencyMs: 0, downKbps: 0, upKbps: 0 } }, log: null,
  }).done;
  console.log(`a hard cap alone on ${summary.platform}: ${describe(summary)}`);
  assert.equal(summary.cpu.dutyCycle, false);
  assert.ok(summary.cpu.burst.achieved < 3, `10 ms tasks measured ${summary.cpu.burst.achieved}×, not let through`);
  assert.equal(summary.cpu.burst.within, false);
  assert.equal(summary.cpu.within, false);
  assert.match(summary.error, /on 10 ms tasks \(±25% allowed\)[^\n]*against 4×: the command didn't run/);
  assert.equal(summary.ok, false);
  assert.equal(summary.exitCode, null);
  assert.equal(fs.existsSync(marker), false, 'the command never ran');
});

test("a constraint the calibration can't bring to its factor is refused after its corrections, and the command never runs", { timeout: 120_000 }, async () => {
  // The defect planted: a duty cycle with a 4 s period. Each timing starts as the cycle starts again, so the loop's
  // ~150 ms runs inside one long run at full speed, whatever the ratio (at most 12, a run of 333 ms): long work measures
  // about 1×, and no correction can bring it to 4×.
  const marker = path.join(scratch, 'unconverged-ran');
  fs.rmSync(marker, { force: true });
  const summary = await launchConstrained(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`], {
    cpuMechanism: 'duty-cycle', periodMs: 4000, overrides: { memoryMB: 0, network: { latencyMs: 0, downKbps: 0, upKbps: 0 } }, log: null,
  }).done;
  console.log(`a duty cycle with a 4 s period on ${summary.platform}: ${describe(summary)}; measurements ${summary.cpu.calibration.map((c) => c.achieved).join(', ')}`);
  assert.equal(summary.cpu.corrections, 6, 'it tried every correction');
  assert.equal(summary.cpu.calibration.length, 7);
  assert.ok(summary.cpu.achieved < 3.6, `long work measured ${summary.cpu.achieved}×`);
  assert.equal(summary.cpu.within, false);
  assert.match(summary.error, /measured [\d.]+× on long work \(±10% allowed\) after 6 corrections[^\n]*against 4×: the command didn't run/);
  assert.equal(summary.ok, false);
  assert.equal(summary.exitCode, null);
  assert.equal(fs.existsSync(marker), false, 'the command never ran');
});

test('a harness lifts the constraint for its own unconstrained timings and puts it back as calibrated', { timeout: 120_000 }, async () => {
  const file = path.join(scratch, 'lift.jsonl');
  fs.rmSync(file, { force: true });
  const { iterations } = baseline(100);
  const run = launchConstrained(process.execPath, [fixture('lift.mjs'), String(iterations), file, '16'], { overrides: { memoryMB: 0, network: { latencyMs: 0, downKbps: 0, upKbps: 0 } }, log: null });
  await assert.rejects(run.lift(), /only while the command runs/, 'not before ready');
  await run.ready;
  const lines = () => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const after = async (n) => { while (lines().length < n) await new Promise((r) => setTimeout(r, 50)); return lines().length; };
  // Each switch's first timing may straddle it, so it is left out.
  const c1 = await after(4);
  assert.deepEqual(await run.lift(), { lifted: true });
  assert.deepEqual(await run.lift(), { lifted: true }, 'lifting a lifted run changes nothing');
  const l0 = lines().length + 1;
  const l1 = await after(l0 + 4);
  assert.deepEqual(await run.restore(), { lifted: false });
  assert.deepEqual(await run.restore(), { lifted: false }, 'restoring a constrained run changes nothing');
  const r0 = lines().length + 1;
  const summary = await run.done;
  const all = lines();
  const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
  const constrained = median([...all.slice(1, c1), ...all.slice(r0)].map((x) => x.ms));
  const free = median(all.slice(l0, l1).map((x) => x.ms));
  console.log(`lifted ${free.toFixed(0)} ms, constrained ${constrained.toFixed(0)} ms (${(constrained / free).toFixed(2)}×); ${describe(summary)}`);
  assert.ok(constrained / free > 3 && constrained / free < 5.5, `the constraint lifted and put back: ${(constrained / free).toFixed(2)}×`);
  assert.equal(summary.cpu.lifted.length, 1, 'one lifted interval, though lift was called twice');
  assert.ok(summary.cpu.lifted[0].from < summary.cpu.lifted[0].to);
  assert.deepEqual(validate('constrained', summary), []);
  await assert.rejects(run.restore(), /only while the command runs/, 'not after done');
});

test('flow-review constrain: the memory cap is enforced, or detected where it can only be', { timeout: 120_000 }, async () => {
  const summaryFile = path.join(scratch, 'memory.json');
  const r = await run(['constrain', '--cpu', '1', '--memory-mb', '192', '--summary', summaryFile, '--', 'node', fixture('memory.mjs')]);
  const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
  console.log(`memory cap on ${summary.platform}: ${summary.memory.mechanism} (${summary.memory.enforcement}), peak ${summary.memory.peakMB} MB, exit ${summary.exitCode ?? summary.signal}`);
  assert.deepEqual(validate('constrained', summary), []);
  assert.equal(r.status, 3, `over the cap exits 3:\n${r.stderr}`);
  assert.doesNotMatch(r.stdout, /held 640 MB/, 'the command never got all it asked for');
  assert.equal(summary.memory.hit, true);
  assert.deepEqual(summary.capsHit, ['memory']);
  assert.equal(summary.memory.enforcement, summary.memory.mechanism === 'rss-watch' ? 'detected' : 'enforced');
  if (process.platform === 'win32') assert.equal(summary.memory.mechanism, 'job-memory');
  if (process.platform === 'darwin') assert.equal(summary.memory.mechanism, 'rss-watch');
  assert.match(r.stderr, /caps hit: memory/);
});

test('flow-review constrain refuses without a command and prints what it would use', async () => {
  const none = await run(['constrain']);
  assert.equal(none.status, 2);
  assert.match(none.stderr, /put the command to run after --/);
  const bad = await run(['constrain', '--profile', 'nope', '--', 'node', '-e', '0']);
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /unknown constrained profile/);
  const p = await run(['constrain', '--print', '--cpu', '3']);
  assert.equal(p.status, 0);
  const printed = JSON.parse(p.stdout);
  assert.equal(printed.cpu, 3);
  assert.ok(printed.mechanisms.cpu);
});

test('flow-review run --constrained slows its pages and marks the report', { timeout: 120_000 }, async (t) => {
  const out = path.join(scratch, 'run');
  // The site is served here, not by the flow's app.start, so the test is about constrained mode alone.
  const site = spawn(process.execPath, ['test/fixtures/serve.mjs', '5311', 'test/fixtures/site'], { cwd: root, stdio: 'ignore' });
  t.after(() => site.kill());
  for (let i = 0; i < 50; i++) {
    if (await fetch('http://127.0.0.1:5311/').then((r) => r.ok, () => false)) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  const r = await run(['run', 'test/fixtures/constrain/flows/*.flow.json', '--constrained', 'old-windows-laptop', '--fail-on', 'none', '--out', out]);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stderr, /flow-review: CONSTRAINED COMPUTER \(old-windows-laptop\)/);
  const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
  assert.deepEqual(validate('report', report), []);
  assert.equal(report.provenance.constrained.profile, 'old-windows-laptop');
  assert.equal(report.provenance.constrained.scope, 'pages');
  assert.match(fs.readFileSync(path.join(out, 'summary.md'), 'utf8'), /Constrained computer: `old-windows-laptop`.*Not a normal run\./);
  const normal = await run(['run', 'test/fixtures/constrain/flows/*.flow.json', '--fail-on', 'none', '--out', `${out}-normal`]);
  assert.equal(JSON.parse(fs.readFileSync(path.join(`${out}-normal`, 'report.json'), 'utf8')).provenance.constrained, null);
  assert.equal(normal.status, 0);
});

// Nothing a constrained run starts outlives it: a process left in the command's group and one that left the group are
// both gone once the run has ended, whether the command exited or the run timed out.
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };
const gone = async (pid, ms = 10_000) => {
  for (const end = Date.now() + ms; Date.now() < end;) {
    if (!alive(pid)) return true;
    await new Promise((r) => setTimeout(r, 100));
  }
  return !alive(pid);
};
const leftRunning = async (pidsFile) => {
  const pids = JSON.parse(fs.readFileSync(pidsFile, 'utf8'));
  const left = [];
  for (const [name, pid] of Object.entries(pids)) if (!(await gone(pid))) left.push(`${name} ${pid}`);
  for (const pid of Object.values(pids)) { try { process.kill(pid, 'SIGKILL'); } catch { /* gone, as it should be */ } }
  return left;
};

test('flow-review constrain kills what the command left running when it exits', { timeout: 120_000 }, async () => {
  const pidsFile = path.join(scratch, 'left-exit.json');
  const summaryFile = path.join(scratch, 'left-exit-summary.json');
  fs.rmSync(pidsFile, { force: true });
  // About what is killed, not the factor: a wide tolerance, so a noisy host's measurement doesn't stop the command running.
  const r = await runConstrain(['constrain', '--tolerance', '0.99', '--burst-tolerance', '0.99', '--summary', summaryFile, '--', 'node', fixture('leave-running.mjs'), pidsFile, 'exit']);
  assert.equal(r.status, 0, r.stderr);
  const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
  assert.deepEqual(validate('constrained', summary), []);
  assert.equal(summary.timedOut, false);
  assert.match(summary.sandbox, /^(GITHUB_ACTIONS=true|CI=true|FLOW_REVIEW_CONSTRAIN_SANDBOX=1)$/);
  assert.deepEqual(await leftRunning(pidsFile), [], 'nothing the command started is still running');
});

test('flow-review constrain kills the whole tree when the run times out', { timeout: 120_000 }, async () => {
  const pidsFile = path.join(scratch, 'left-timeout.json');
  const summaryFile = path.join(scratch, 'left-timeout-summary.json');
  fs.rmSync(pidsFile, { force: true });
  const t0 = performance.now();
  const r = await run(['constrain', '--cpu', '1', '--timeout-minutes', '0.2', '--summary', summaryFile, '--', 'node', fixture('leave-running.mjs'), pidsFile, 'stay']);
  const s = (performance.now() - t0) / 1000;
  assert.equal(r.status, 5, `a run past its limit exits 5:\n${r.stderr}`);
  assert.ok(s < 60, `the run ended ${s.toFixed(0)} s after it started, with a 12 s limit`);
  assert.match(r.stderr, /went past its 0\.2-minute limit \(--timeout-minutes\): its whole process tree was killed/);
  const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
  assert.deepEqual(validate('constrained', summary), []);
  assert.equal(summary.timedOut, true);
  assert.equal(summary.timeoutMinutes, 0.2);
  assert.equal(summary.ok, false);
  assert.ok(fs.existsSync(pidsFile), 'the command had started');
  assert.deepEqual(await leftRunning(pidsFile), [], 'the command and everything it started are gone');
});

test('flow-review constrain passes a .cmd file its arguments as they were given, through cmd.exe', { skip: process.platform !== 'win32' && 'cmd.exe is Windows only', timeout: 60_000 }, async () => {
  const args = ['{"q":"a&b"}', '100%', '%PATH%', 'x y', 'a^b', 'p|q', '"quoted"', 'C:\\a b\\', '(paren)', 'bang!'];
  const off = ['--cpu', '1', '--memory-mb', '0', '--disk-latency-ms', '0', '--disk-mb-per-sec', '0', '--net-latency-ms', '0', '--net-down-kbps', '0', '--net-up-kbps', '0'];
  const argsOf = (r) => JSON.parse(r.stdout.split('ARGS ')[1].split('\n')[0]);
  // A .cmd that passes them all on through %*, which cmd reads again.
  const all = await run(['constrain', ...off, '--', fixture('args.cmd'), ...args]);
  assert.equal(all.status, 0, all.stderr);
  assert.deepEqual(argsOf(all), args);
  // A .cmd that reads its first as "%~1": its quotes come off, and nothing else is left on it.
  for (const first of ['release', 'x y', 'a&b']) {
    const one = await run(['constrain', ...off, '--', fixture('first.cmd'), first]);
    assert.equal(one.status, 0, one.stderr);
    assert.deepEqual(argsOf(one), [first]);
  }
});

test('a harness killed by a signal while launchConstrained runs leaves nothing running or stopped', { skip: process.platform === 'win32' && 'POSIX signals', timeout: 120_000 }, async () => {
  const pidsFile = path.join(scratch, 'left-signal.json');
  fs.rmSync(pidsFile, { force: true });
  const lib = pathToFileURL(path.join(root, 'lib', 'constrain.mjs')).href;
  // The duty cycle, so the tree is stopped three quarters of the time when the signal lands; a wide tolerance, as the test
  // is about what the signal leaves behind, not the factor.
  const script = `import { launchConstrained } from ${JSON.stringify(lib)};
const run = launchConstrained(process.execPath, [${JSON.stringify(fixture('leave-running.mjs'))}, ${JSON.stringify(pidsFile)}, 'stay'], { cpuMechanism: 'duty-cycle', tolerance: 0.99, burstTolerance: 0.99, overrides: { memoryMB: 0, network: { latencyMs: 0, downKbps: 0, upKbps: 0 } }, log: null });
await run.ready;
console.log('READY');
await run.done;`;
  const harness = spawn(process.execPath, ['--input-type=module', '-e', script], { cwd: root, env: { ...process.env, [CONSTRAINED_ENV]: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  harness.stderr.on('data', (d) => { stderr += d; });
  const ended = new Promise((resolve) => harness.on('exit', (code, signal) => resolve({ code, signal })));
  await new Promise((resolve, reject) => {
    harness.stdout.on('data', (d) => { if (String(d).includes('READY')) resolve(); });
    ended.then(() => reject(new Error(`the harness ended before the command started: ${stderr}`)));
  });
  for (let i = 0; i < 50 && !fs.existsSync(pidsFile); i++) await new Promise((r) => setTimeout(r, 100));
  assert.ok(fs.existsSync(pidsFile), 'the command started its processes');
  await new Promise((r) => setTimeout(r, 500));
  harness.kill('SIGTERM');
  assert.deepEqual(await ended, { code: null, signal: 'SIGTERM' }, 'the harness still ends as the signal ends it');
  assert.deepEqual(await leftRunning(pidsFile), [], 'the command and everything it started are gone, none left stopped');
});
