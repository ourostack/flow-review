// The calibration's arithmetic (paired factors, corrections) and the duty cycle's hold, without loading the computer:
// the factors are made-up timings, and the duty cycle stops and continues an idle child.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import { fileURLToPath } from 'node:url';
import { pairedFactor, nextCorrection, converge, within, medianError, enoughPairs } from '../lib/constrain-calibrate.mjs';

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

test('a factor that barely moved for a change is noise, and never makes a correction larger than the plain ratio', () => {
  // 5 → 4.8 for a 0.8× change is an elasticity of 0.18: taken at its word, the next step would be (4 / 4.8)^(1 / 0.18).
  assert.equal(nextCorrection(4, [{ strength: 1, achieved: 5 }, { strength: 0.8, achieved: 4.8 }]), 4 / 4.8);
});

test("a median's error grows with the pairs' scatter and shrinks with their number", () => {
  assert.equal(medianError([4]), Infinity);
  assert.equal(medianError([4, 4, 4]), 0);
  const tight = medianError([3.9, 4, 4.1]);
  const loose = medianError([3, 4, 5]);
  assert.ok(Math.abs(tight - (1.2533 * 1.4826 * 0.1) / Math.sqrt(3) / 4) < 1e-12, `${tight}`);
  assert.ok(loose > tight * 9.9 && loose < tight * 10.1, `${loose} against ${tight}`);
  assert.ok(medianError([3, 4, 5, 3, 4, 5, 3, 4, 5]) < loose, 'more pairs, a more precise median');
});

test('a measurement takes three pairs, more while they scatter, and at most nine', () => {
  const precision = 0.025;
  assert.equal(enoughPairs([4, 4.02], { precision }), false, 'never fewer than three');
  assert.equal(enoughPairs([4, 4.02, 3.98], { precision }), true, 'three that agree are enough');
  assert.equal(enoughPairs([3, 4, 5.5], { precision }), false, 'three that scatter are not');
  assert.equal(enoughPairs([3, 4, 4.05], { precision }), false, 'nor three of which two agree and one is far off');
  assert.equal(enoughPairs([3, 4, 5.5, 3.1, 6, 2.8, 4.4, 5, 3.3], { precision }), true, 'nine is the most');
});

test('4× ±10% is 3.6× to 4.4×, both ends included', () => {
  assert.equal(within(3.6, 4, 0.1), true);
  assert.equal(within(4.4, 4, 0.1), true);
  assert.equal(within(3.59, 4, 0.1), false);
  assert.equal(within(4.41, 4, 0.1), false);
});

// A made-up duty cycle on a computer that resumes a process 1 ms late: each 10 ms cycle's run loses that 1 ms, so a
// ratio of 4 measures 6.67×, as GitHub's busy macOS runners did. `strength` scales the ratio.
const lateResume = (lossMs = 1, periodMs = 10) => {
  let ratio = 4;
  return {
    measure: async () => ({ achieved: Math.round((periodMs / (periodMs / ratio - lossMs)) * 100) / 100, factors: [] }),
    correct: async (k) => { const before = ratio; ratio = Math.min(12, Math.max(2, ratio * k)); return { strength: ratio / before, reset: false }; },
    ratio: () => ratio,
  };
};

test('the calibration corrects a constraint that slows far more than its setting says until it is on target', async () => {
  const c = lateResume();
  const m = await converge({ target: 4, tolerance: 0.1, ...c });
  assert.equal(m.calibration[0].achieved, 6.67, 'it started at 6.67×');
  assert.equal(m.within, true);
  assert.ok(within(m.achieved, 4, 0.05), `ended within ±5%: ${m.achieved}× after ${m.corrections} corrections`);
  assert.ok(m.corrections <= 6);
  assert.equal(m.calibration.length, m.corrections + 1);
  assert.equal(m.calibration.at(-1).achieved, m.achieved);
});

test('a constraint that stays on target is measured once and not corrected', async () => {
  let corrected = 0;
  const m = await converge({ target: 4, tolerance: 0.1, measure: async () => ({ achieved: 4.08, factors: [4.1, 4.08, 4.0] }), correct: async () => { corrected++; return { strength: 1, reset: false }; } });
  assert.deepEqual([m.corrections, corrected, m.within, m.achieved], [0, 0, true, 4.08]);
});

test("a constraint that can't reach the target says so after six corrections, so the run is refused", async () => {
  // Whatever the correction, the computer gives 8×: a mechanism stuck at its bound, or a host that starves the tree.
  const calls = [];
  const m = await converge({ target: 4, tolerance: 0.1, measure: async () => ({ achieved: 8, factors: [8, 8, 8] }), correct: async (k) => { calls.push(k); return { strength: k, reset: false }; } });
  assert.equal(m.within, false);
  assert.equal(m.corrections, 6);
  assert.equal(m.calibration.length, 7);
  assert.ok(calls.every((k) => k >= 0.5 && k <= 2), `every correction bounded to 2× either way: ${calls}`);
});

test('a reset (the duty cycle\'s period doubled) starts the learning again', async () => {
  const seen = [];
  let n = 0;
  const readings = [9, 6, 4.02];
  await converge({ target: 4, tolerance: 0.1, measure: async () => ({ achieved: readings[n++], factors: [] }), correct: async (k) => { seen.push(k); return { strength: 1, reset: true }; } });
  // After a reset the history holds one measurement, so the next correction is the plain ratio again.
  assert.deepEqual(seen.map((k) => Math.round(k * 1000) / 1000), [0.5, Math.round((4 / 6) * 1000) / 1000]);
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
