// The duty cycle: on macOS, and on Linux, a constrained tree is stopped (SIGSTOP) and continued (SIGCONT) in turn so it
// runs 1/factor of the time. A worker thread keeps the beat, sleeping on its own event loop's timers, and corrects each
// pause for how long the last run actually was. Not Atomics.wait: on macOS it wakes up to four times late (a 2.5 ms wait
// took about 12 ms on GitHub's runners, where a timer took 2.5 to 3.5), and a beat that late lets a short task run
// through a whole slice at full speed, then holds the next one through a pause as long.
import { workerData, parentPort } from 'node:worker_threads';

const { shared, periodMs } = workerData;
// How many times longer a whole cycle is than its run: the profile's factor, or the correction the calibration made.
const ratio = new Float64Array(workerData.ratio);
// [0] stop flag, [1] process group, [2] how many more pids, [3...] the pids (tree members outside the group).
const s = new Int32Array(shared);
const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
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
  await sleep(periodMs / factor);
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
  await sleep(ran * (factor - 1) - paused);
  signal('SIGCONT');
  on = performance.now();
  paused += on - off;
  cycles++;
}
signal('SIGCONT');
parentPort.postMessage({ ranMs: Math.round(ran), pausedMs: Math.round(paused), cycles, ratio: Math.round(factor * 100) / 100 });
