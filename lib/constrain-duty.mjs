// The duty cycle: on macOS, and on Linux without a cgroup, a constrained tree is stopped (SIGSTOP) and continued
// (SIGCONT) in turn so it runs 1/factor of the time. A worker thread keeps the beat with Atomics.wait, which sleeps far
// more precisely than a timer on a busy event loop, and corrects each pause for how long the last run actually was.
import { workerData, parentPort } from 'node:worker_threads';

const { shared, factor, periodMs } = workerData;
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

let ran = 0;
let paused = 0;
let cycles = 0;
const runMs = periodMs / factor;
while (Atomics.load(s, 0) === 0) {
  const t0 = performance.now();
  signal('SIGCONT');
  sleep(runMs);
  signal('SIGSTOP');
  const t1 = performance.now();
  ran += t1 - t0;
  if (Atomics.load(s, 0) !== 0) break;
  sleep(ran * (factor - 1) - paused);
  paused += performance.now() - t1;
  cycles++;
}
signal('SIGCONT');
parentPort.postMessage({ ranMs: Math.round(ran), pausedMs: Math.round(paused), cycles });
