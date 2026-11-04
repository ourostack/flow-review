// The calibration's arithmetic (paired factors, corrections) and the duty cycle's hold, without loading the computer:
// the factors are made-up timings, and the duty cycle stops and continues an idle child.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { pairedFactor, nextCorrection } from '../lib/constrain-calibrate.mjs';

test('a paired factor is the median of each pair, so a slow moment slows both halves and cancels', () => {
  // The runner ran at half speed for the second pair: a single baseline (100 ms) would read 8× there.
  const m = pairedFactor([100, 200, 100], [400, 800, 410]);
  assert.deepEqual(m.factors, [4, 4, 4.1]);
  assert.equal(m.achieved, 4);
  assert.equal(m.baselineMs, 100);
  assert.equal(m.constrainedMs, 410);
});

test('a pair without a timing is left out, and none left gives no factor', () => {
  assert.deepEqual(pairedFactor([100, 0, NaN], [400, 300, 500]).factors, [4]);
  assert.equal(pairedFactor([0], [400]).achieved, null);
});

test('a correction is the plain ratio first, bounded to 2× either way', () => {
  assert.equal(nextCorrection(4, [{ strength: 1, achieved: 5 }]), 0.8);
  assert.equal(nextCorrection(4, [{ strength: 1, achieved: 16 }]), 0.5, 'one wild reading moves the ratio at most 2×');
  assert.equal(nextCorrection(4, [{ strength: 1, achieved: 1 }]), 2);
});

test('a correction learns how far the factor moved for the last change, and corrects by that', () => {
  // The ratio went down 0.8×; the factor went from 5 to 3.2, (0.64 = 0.8^2): elasticity 2, so the next step is the
  // square root of the plain ratio.
  const next = nextCorrection(4, [{ strength: 1, achieved: 5 }, { strength: 0.8, achieved: 3.2 }]);
  assert.ok(Math.abs(next - Math.sqrt(4 / 3.2)) < 1e-9, `${next}`);
  // A factor that moved the wrong way counts as elasticity 1: the plain ratio.
  assert.equal(nextCorrection(4, [{ strength: 1, achieved: 5 }, { strength: 0.8, achieved: 5 }]), 0.8);
});

const duty = fileURLToPath(new URL('../lib/constrain-duty.mjs', import.meta.url));
const stateOf = (pid) => spawnSync('ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
// Whether `fn` held at any check within `ms`: the state a stopped-and-continued process is in changes between checks.
const until = async (fn, ms = 3000) => {
  const end = Date.now() + ms;
  do { if (fn()) return true; await new Promise((r) => setTimeout(r, 2)); } while (Date.now() < end);
  return false;
};

test('the duty cycle holds with the tree running, says so, and cycles again after', { skip: process.platform === 'win32' && 'POSIX signals' }, async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });
  const shared = new SharedArrayBuffer(4 * 1027);
  const s = new Int32Array(shared);
  s[1] = child.pid;
  const ratio = new Float64Array(new SharedArrayBuffer(24));
  ratio[0] = 4;
  ratio[1] = 10;
  const worker = new Worker(duty, { workerData: { shared, ratio: ratio.buffer }, execArgv: [] });
  const done = new Promise((resolve) => worker.once('message', resolve));
  try {
    assert.ok(await until(() => stateOf(child.pid).startsWith('T')), 'the cycle stops the tree');
    ratio[0] = 1;
    assert.ok(await until(() => ratio[2] === 1), 'the hold is answered');
    for (let i = 0; i < 20; i++) {
      assert.ok(!stateOf(child.pid).startsWith('T'), 'and the tree runs while it lasts');
      await new Promise((r) => setTimeout(r, 5));
    }
    ratio[0] = 4;
    assert.ok(await until(() => ratio[2] === 0), 'the end of the hold is answered');
    assert.ok(await until(() => stateOf(child.pid).startsWith('T')), 'and the cycle stops the tree again');
  } finally {
    Atomics.store(s, 0, 1);
    await done;
    await worker.terminate();
    child.kill('SIGKILL');
  }
  assert.ok(!stateOf(child.pid).startsWith('T'));
});

test("an older caller's 16-byte buffer (ratio and period only) keeps cycling", { skip: process.platform === 'win32' && 'POSIX signals' }, async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore', detached: true });
  const shared = new SharedArrayBuffer(4 * 1027);
  const s = new Int32Array(shared);
  s[1] = child.pid;
  const ratio = new Float64Array(new SharedArrayBuffer(16));
  ratio[0] = 4;
  ratio[1] = 10;
  const worker = new Worker(duty, { workerData: { shared, ratio: ratio.buffer }, execArgv: [] });
  const done = new Promise((resolve) => worker.once('message', resolve));
  try {
    assert.ok(await until(() => stateOf(child.pid).startsWith('T')), 'the cycle stops the tree');
  } finally {
    Atomics.store(s, 0, 1);
    const account = await done;
    await worker.terminate();
    child.kill('SIGKILL');
    assert.ok(account.cycles > 0, JSON.stringify(account));
    assert.equal(account.ratio, 4);
  }
});
