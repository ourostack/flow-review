// flow-review constrain refuses to run on a computer it isn't sandboxing: only a CI runner or a host that declares itself
// a disposable sandbox may be constrained, and anywhere else it exits 2 before it starts anything. Every run here asks for
// nothing to be slowed, so even a broken guard would constrain nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { sandboxedHost, assertSandboxedHost, SANDBOX_ENV } from '../lib/constrain.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = path.join(root, '.scratch', 'constrain-sandbox');
const workstation = { GITHUB_ACTIONS: '', CI: '', [SANDBOX_ENV]: '', FLOW_REVIEW_CONSTRAINED: '' };
const nothingSlowed = ['--cpu', '1', '--memory-mb', '0', '--disk-latency-ms', '0', '--disk-mb-per-sec', '0', '--net-latency-ms', '0', '--net-down-kbps', '0', '--net-up-kbps', '0'];
const cli = (args, env = workstation) => spawnSync(process.execPath, ['bin/flow-review.mjs', ...args], { cwd: root, encoding: 'utf8', timeout: 20_000, env: { ...process.env, ...env } });
const PAGE_CPU_REFUSED = /refusing to throttle the CPU of browser pages on this computer: DevTools CPU throttling holds one core busy for every throttled page, so it runs only on a CI runner \(GITHUB_ACTIONS=true or CI=true\) or on a disposable machine that declares itself one with FLOW_REVIEW_CONSTRAIN_SANDBOX=1.*Nothing was throttled\./;
const REFUSED = /refusing to constrain this computer: flow-review constrain runs only on a CI runner \(GITHUB_ACTIONS=true or CI=true\) or on a disposable machine that declares itself one with FLOW_REVIEW_CONSTRAIN_SANDBOX=1.*Nothing was started\./;

test('only a CI runner or a declared sandbox is a host constrain may run on', () => {
  assert.equal(sandboxedHost({}), null);
  assert.equal(sandboxedHost({ GITHUB_ACTIONS: 'true' }), 'GITHUB_ACTIONS=true');
  assert.equal(sandboxedHost({ CI: 'true' }), 'CI=true');
  assert.equal(sandboxedHost({ [SANDBOX_ENV]: '1' }), 'FLOW_REVIEW_CONSTRAIN_SANDBOX=1');
  for (const env of [{ CI: '1' }, { CI: 'false' }, { GITHUB_ACTIONS: 'false' }, { [SANDBOX_ENV]: 'true' }, { [SANDBOX_ENV]: '0' }, workstation]) {
    assert.equal(sandboxedHost(env), null, JSON.stringify(env));
    assert.throws(() => assertSandboxedHost(env), REFUSED, JSON.stringify(env));
  }
  assert.equal(assertSandboxedHost({ CI: 'true' }), 'CI=true');
});

test('flow-review constrain on a workstation refuses before it starts anything', () => {
  fs.rmSync(scratch, { recursive: true, force: true });
  fs.mkdirSync(scratch, { recursive: true });
  const marker = path.join(scratch, 'ran');
  const summary = path.join(scratch, 'summary.json');
  const r = cli(['constrain', ...nothingSlowed, '--summary', summary, '--', process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, '1')`]);
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, REFUSED);
  assert.doesNotMatch(r.stderr, /CONSTRAINED COMPUTER/, 'no banner: nothing was constrained');
  assert.equal(fs.existsSync(marker), false, 'the command never ran');
  assert.equal(fs.existsSync(summary), false, 'no run, so no summary');

  // The proxy alone is refused too, rather than left listening.
  const proxy = cli(['constrain', '--proxy', '--net-latency-ms', '0']);
  assert.equal(proxy.status, 2, proxy.stderr);
  assert.match(proxy.stderr, REFUSED);
  assert.equal(proxy.stdout, '');

  // Printing the settings starts nothing, so it is allowed anywhere.
  const print = cli(['constrain', '--print', ...nothingSlowed]);
  assert.equal(print.status, 0, print.stderr);
  assert.equal(JSON.parse(print.stdout).profile, 'old-windows-laptop');
  fs.rmSync(scratch, { recursive: true, force: true });
});

test('launchConstrained on a workstation throws before it starts anything, whatever env the command is given', () => {
  const lib = pathToFileURL(path.join(root, 'lib', 'constrain.mjs')).href;
  const script = `import { launchConstrained } from ${JSON.stringify(lib)};
try {
  launchConstrained(process.execPath, ['-e', 'console.log("RAN")'], { overrides: { cpu: 1, memoryMB: 0, disk: { latencyMs: 0, mbPerSec: 0 }, network: { latencyMs: 0, downKbps: 0, upKbps: 0 } }, env: { CI: 'true' }, log: null });
  console.log('STARTED');
} catch (e) { console.log('THREW ' + e.message); }`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: root, encoding: 'utf8', timeout: 20_000, env: { ...process.env, ...workstation } });
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.stdout, /^THREW /);
  assert.match(r.stdout, REFUSED);
  assert.doesNotMatch(r.stdout, /STARTED|RAN/);
});

test('throttling the CPU of pages on a workstation is refused before anything is sent; the network alone is not', () => {
  const lib = (f) => JSON.stringify(pathToFileURL(path.join(root, 'lib', f)).href);
  const script = `import { constrainPage, constrainContext, constrainCdp, applyCdpConstraints } from ${lib('constrain-cdp.mjs')};
import { resolveSettings } from ${lib('constrain-profile.mjs')};
import { run } from ${lib('run.mjs')};
const settings = resolveSettings('old-windows-laptop');
const sent = [];
const send = async (method) => { sent.push(method); return {}; };
const page = { context: () => { sent.push('context'); throw new Error('reached the page'); } };
const out = {};
const attempt = async (name, fn) => { try { await fn(); out[name] = 'ran'; } catch (e) { out[name] = e.message; } };
await attempt('page', () => constrainPage(page, settings));
await attempt('context', () => constrainContext({ on: () => sent.push('on'), pages: () => [page] }, settings));
await attempt('cdp', () => constrainCdp('http://127.0.0.1:9', settings));
await attempt('apply', () => applyCdpConstraints(send, settings));
await attempt('run', () => run({ globs: [], constrained: settings, log: () => {} }));
const refusedSent = sent.length;
const net = await applyCdpConstraints(send, settings, { cpu: false });
console.log(JSON.stringify({ out, refusedSent, sent, net }));`;
  const r = spawnSync(process.execPath, ['--input-type=module', '-e', script], { cwd: root, encoding: 'utf8', timeout: 20_000, env: { ...process.env, ...workstation } });
  assert.equal(r.status, 0, r.stderr);
  const { out, refusedSent, sent, net } = JSON.parse(r.stdout);
  for (const [name, message] of Object.entries(out)) assert.match(message, PAGE_CPU_REFUSED, name);
  assert.equal(refusedSent, 0, 'nothing reached a page, a browser or DevTools');
  assert.deepEqual(sent, ['Network.enable', 'Network.emulateNetworkConditions'], 'with cpu: false only the network is slowed');
  assert.equal(net.cpu.rate, null);
  assert.equal(net.network.latencyMs, 150);
});
