// The duty cycle: on macOS, and on Linux, a constrained tree is stopped (SIGSTOP) and continued (SIGCONT) in turn so it
// runs 1/factor of the time. A worker thread keeps the beat, sleeping on its own event loop's timers, and corrects each
// pause for how long the last run actually was. Not Atomics.wait: on macOS it wakes up to four times late (a 2.5 ms wait
// took about 12 ms on GitHub's runners, where a timer took 2.5 to 3.5), and a beat that late lets a short task run
// through a whole slice at full speed, then holds the next one through a pause as long.
import { workerData, parentPort } from 'node:worker_threads';

const { shared } = workerData;
// [0] how many times longer a whole cycle is than its run: the profile's factor, or the correction the calibration made;
// 1 or less holds the cycle, the tree left running, while the calibration times it unconstrained;
// [1] the cycle's period in milliseconds, lengthened by the calibration where resuming the tree takes long;
// [2], where the buffer has it, 1 while the cycle is held with the tree running and 0 while it cycles, so the calibration
// knows when its timing can start. A 16-byte buffer (an older caller's) has no [2], and is never held.
const ratio = new Float64Array(workerData.ratio);
// [0] stop flag, [1] process group, [2] how many more pids, [3...] the pids (tree members outside the group).
const s = new Int32Array(shared);
const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
// A run or a pause, cut short by a hold or the stop flag, so a hold is taken up within 20 ms whatever the period (a
// pause cut short continues the tree at once). What is left under a millisecond after a sleep is left to the account,
// as one sleep would leave it: timers wake on whole milliseconds, and sleeping again for it would add a whole one.
const nap = async (ms) => {
  const end = performance.now() + ms;
  for (let left = ms; left > 0 && ratio[0] > 1 && Atomics.load(s, 0) === 0; left = end - performance.now()) {
    await sleep(Math.min(left, 20));
    if (end - performance.now() < 1) return;
  }
};
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
let periodMs = ratio[1];
signal('SIGCONT');
let on = performance.now();
let held = false;
while (Atomics.load(s, 0) === 0) {
  if (ratio[0] <= 1) {
    // Held: the tree was continued at the end of the last pause, and runs until the hold ends.
    if (!held) { held = true; ratio[2] = 1; }
    await sleep(1);
    continue;
  }
  if (held) {
    // A cycle after a hold starts its own account, from a run that starts now.
    held = false;
    factor = ratio[0];
    periodMs = ratio[1];
    ran = 0;
    paused = 0;
    on = performance.now();
    ratio[2] = 0;
  }
  await nap(periodMs / factor);
  signal('SIGSTOP');
  const off = performance.now();
  ran += off - on;
  if (Atomics.load(s, 0) !== 0) break;
  if (ratio[0] !== factor || ratio[1] !== periodMs) {
    // A new ratio or period starts its own account, so the old one's debt isn't paid at the new rate.
    factor = ratio[0];
    periodMs = ratio[1];
    ran = off - on;
    paused = 0;
  }
  await nap(ran * (factor - 1) - paused);
  signal('SIGCONT');
  on = performance.now();
  paused += on - off;
  cycles++;
}
signal('SIGCONT');
parentPort.postMessage({ ranMs: Math.round(ran), pausedMs: Math.round(paused), cycles, ratio: Math.round(factor * 100) / 100, periodMs });
