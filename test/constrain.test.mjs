// Constrained computer: the profile, the slow-network proxy, the slow-disk preload, the DevTools throttling of pages,
// and the CLI end to end on this platform: the CPU slowdown it measures, a grandchild slowed as much, the memory cap
// enforced or detected, and a run's report marked as constrained.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { chromium } from 'playwright';
import { resolveSettings, constrainedFromEnv, bannerLine, PROFILES, CONSTRAINED_ENV } from '../lib/constrain-profile.mjs';
import { pickMechanisms, jobCpuRate, windowsCommandLine, constrainedEnv } from '../lib/constrain.mjs';
import { startDelayProxy } from '../lib/constrain-proxy.mjs';
import { constrainPage, constrainCdp } from '../lib/constrain-cdp.mjs';
import { baseline, within } from '../lib/constrain-calibrate.mjs';
import { assertHeadless } from '../lib/browser.mjs';
import { validate } from '../lib/schema.mjs';
import { launch, close } from './helpers.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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
  assert.deepEqual(pickMechanisms(s, { platform: 'win32' }), { cpu: 'job-cpu-rate', memory: 'job-memory' });
  assert.deepEqual(pickMechanisms(s, { platform: 'darwin' }), { cpu: 'duty-cycle', memory: 'rss-watch' });
  assert.deepEqual(pickMechanisms(s, { platform: 'linux', env: { CI: 'true' }, cgroup: () => true }), { cpu: 'cgroup-cpu-max', memory: 'cgroup-memory-max' });
  assert.deepEqual(pickMechanisms(s, { platform: 'linux', env: {}, cgroup: () => true }), { cpu: 'duty-cycle', memory: 'rss-watch' }, 'outside CI, no sudo');
  assert.deepEqual(pickMechanisms(s, { platform: 'linux', env: { CI: 'true' }, cgroup: () => false }), { cpu: 'duty-cycle', memory: 'rss-watch' });
  assert.deepEqual(pickMechanisms(resolveSettings(undefined, { cpu: 1, memoryMB: 0 }), { platform: 'win32' }), { cpu: null, memory: null });
  assert.throws(() => pickMechanisms(s, { platform: 'linux', cpuMechanism: 'cgroup', cgroup: () => false }), /sudo without a password/);
  assert.throws(() => pickMechanisms(s, { platform: 'win32', cpuMechanism: 'duty-cycle' }), /isn't available on Windows/);
  assert.equal(jobCpuRate(4, 4), 625, 'one core of four, at a quarter');
  assert.equal(jobCpuRate(4, 1), 2500);
  assert.equal(windowsCommandLine('npm', ['run', 'say "hi"', 'C:\\a b\\']), 'npm run "say \\"hi\\"" "C:\\a b\\\\"');
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
    await t.test('a Playwright page', async () => {
      const b = await launch();
      const page = await b.newPage();
      await page.goto(url);
      const r = await constrainPage(page, settings, { calibrate: true });
      assert.equal(r.cpu.rate, 4);
      assert.ok(within(r.cpu.achieved, 4, 0.25), `the page measured ${r.cpu.achieved}×`);
      const ms = await fetchMs(page);
      assert.ok(ms >= 290, `a fetch took ${ms.toFixed(0)} ms under 300 ms of latency`);
      const inTree = await constrainPage(await b.newPage(), { ...settings, tree: { cpu: 'duty-cycle' } });
      assert.equal(inTree.cpu.rate, null, 'a page in a throttled tree is not slowed twice');
      assert.match(inTree.cpu.skipped, /constrained process tree/);
      assert.equal(await constrainPage(page, null), null, 'off when constrained mode is off');
    });
    await t.test('any Chromium on its remote-debugging port, as WebView2 is reached', async () => {
      const dir = path.join(scratch, 'profile');
      fs.rmSync(dir, { recursive: true, force: true });
      const ctx = await chromium.launchPersistentContext(dir, assertHeadless({ executablePath: process.env.FLOW_REVIEW_CHROMIUM || undefined, args: ['--remote-debugging-port=0'] }));
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
          assert.ok(within(r.cpu.achieved, 4, 0.25), `the page measured ${r.cpu.achieved}×`);
          const ms = await fetchMs(page);
          assert.ok(ms >= 290, `a fetch took ${ms.toFixed(0)} ms under 300 ms of latency`);
        } finally { handle.close(); }
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
    const plain = spawnSync(process.execPath, [fixture('tree.mjs'), String(iterations)], { encoding: 'utf8', env: { ...process.env, [CONSTRAINED_ENV]: '' } });
    const base = JSON.parse(plain.stdout.split('TREE ')[1]);
    const r = await run(['constrain', '--summary', summaryFile, '--', 'node', fixture('tree.mjs'), String(iterations), `http://127.0.0.1:${site.address().port}/`]);
    assert.equal(r.status, 0, r.stderr);
    assert.match(r.stderr, /CONSTRAINED COMPUTER \(old-windows-laptop\): CPU 4× slower \(measured [\d.]+×, (job-cpu-rate|cgroup-cpu-max|duty-cycle)\)/, 'a banner before');
    assert.match(r.stderr, /CONSTRAINED COMPUTER [^\n]*: exit 0; no caps hit/, 'and after');
    const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
    assert.deepEqual(validate('constrained', summary), []);
    const expected = { win32: 'job-cpu-rate', darwin: 'duty-cycle' }[process.platform] ?? (process.env.CI === 'true' && summary.cpu.mechanism === 'cgroup-cpu-max' ? 'cgroup-cpu-max' : 'duty-cycle');
    assert.equal(summary.cpu.mechanism, expected);
    console.log(`constrain on ${summary.platform} (${summary.cpu.cpus} CPUs): ${summary.cpu.mechanism} measured ${summary.cpu.achieved}× (${summary.cpu.baselineMs} ms -> ${summary.cpu.constrainedMs} ms); memory ${summary.memory.mechanism} (${summary.memory.enforcement}), peak ${summary.memory.peakMB} MB`);
    assert.equal(summary.cpu.within, true);
    assert.ok(summary.cpu.achieved >= 3 && summary.cpu.achieved <= 5, `measured ${summary.cpu.achieved}×`);
    assert.equal(summary.ok, true);
    assert.deepEqual(summary.capsHit, []);
    const tree = JSON.parse(r.stdout.split('TREE ')[1]);
    const ratio = tree.grandchildMs / base.grandchildMs;
    console.log(`a grandchild ran the loop in ${tree.grandchildMs.toFixed(0)} ms, ${base.grandchildMs.toFixed(0)} ms unconstrained: ${ratio.toFixed(2)}×`);
    assert.ok(ratio >= 2.8 && ratio <= 5.5, `a grandchild ran ${ratio.toFixed(2)}× slower, not about 4×`);
    assert.equal(tree.env.profile, 'old-windows-laptop');
    assert.equal(tree.env.tree.achieved, summary.cpu.achieved, 'the harness learns the measured factor');
    assert.equal(tree.proxy, summary.network.proxy);
    assert.ok(tree.requestMs >= 145, `a request through the run's proxy took ${tree.requestMs.toFixed(0)} ms, under 150 ms`);
    assert.ok(tree.statMs >= 19, `5 stats took ${tree.statMs.toFixed(0)} ms, under 5 × 4 ms`);
    assert.equal(summary.network.requests, 1);
  } finally {
    site.close();
  }
});

test('flow-review constrain: the duty cycle, where a cgroup is used by default', { skip: process.platform !== 'linux', timeout: 60_000 }, async () => {
  const summaryFile = path.join(scratch, 'duty.json');
  const r = await run(['constrain', '--cpu-mechanism', 'duty-cycle', '--summary', summaryFile, '--', 'node', '-e', '0']);
  const summary = JSON.parse(fs.readFileSync(summaryFile, 'utf8'));
  console.log(`duty cycle on ${summary.platform}: measured ${summary.cpu.achieved}×`);
  assert.equal(r.status, 0, r.stderr);
  assert.equal(summary.cpu.mechanism, 'duty-cycle');
  assert.equal(summary.memory.mechanism, 'rss-watch');
  assert.equal(summary.cpu.within, true);
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

test('flow-review run --constrained slows its pages and marks the report', { timeout: 120_000 }, async () => {
  const out = path.join(scratch, 'run');
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
