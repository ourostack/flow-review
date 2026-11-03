// The duty cycle: on macOS, and on Linux without a cgroup, a constrained tree is stopped (SIGSTOP) and continued
// (SIGCONT) in turn so it runs 1/factor of the time. A worker thread keeps the beat with Atomics.wait, which sleeps far
// more precisely than a timer on a busy event loop, and corrects each pause for how long the last run actually was.
import { workerData, parentPort } from 'node:worker_threads';

const { shared, periodMs } = workerData;
// How many times longer a whole cycle is than its run: the profile's factor, or the correction the calibration made.
const ratio = new Float64Array(workerData.ratio);
// [0] stop flag, [1] process group, [2] how many more pids, [3...] the pids (tree members outside the group).
const s = new Int32Array(shared);
const sleep = (ms) => { if (ms > 0) Atomics.wait(s, 0, 0, ms); };
const signal = (name) => {
  const group = Atomics.load(s, 1);
  if (group > 0) { try { process.kill(-group, name); } catch { /* the group is gone */ } }
  const n = Atomics.load(s, 2);
  for (let i = 0; i < n; i++) {
    const pid = Atomics.load(s, 3 + i);
    if (pid > 0) { try { process.kill(pid, name); } catch { /* gone */ } }
  }
};

// The account runs from when a continue has been delivered to when a stop has, and pauses the other way round, so the
// time a signal takes to land (long where security software inspects each one) is counted on the side it belongs to.
let ran = 0;
let paused = 0;
let cycles = 0;
let factor = ratio[0];
signal('SIGCONT');
let on = performance.now();
while (Atomics.load(s, 0) === 0) {
  sleep(periodMs / factor);
  signal('SIGSTOP');
  const off = performance.now();
  ran += off - on;
  if (Atomics.load(s, 0) !== 0) break;
  if (ratio[0] !== factor) {
    // A new ratio starts its own account, so the old one's debt isn't paid at the new rate.
    factor = ratio[0];
    ran = off - on;
    paused = 0;
  }
  sleep(ran * (factor - 1) - paused);
  signal('SIGCONT');
  on = performance.now();
  paused += on - off;
  cycles++;
}
signal('SIGCONT');
parentPort.postMessage({ ranMs: Math.round(ran), pausedMs: Math.round(paused), cycles, ratio: Math.round(factor * 100) / 100 });
