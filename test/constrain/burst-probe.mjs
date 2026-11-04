// Temporary: sweeps the CPU mechanisms and their periods on this platform and prints the long and burst factors.
import { Worker } from 'node:worker_threads';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const [mode = 'sweep', arg] = process.argv.slice(2);
const tag = process.env.PROBE_TAG ?? '';
const off = { memoryMB: 0, disk: { latencyMs: 0, mbPerSec: 0 }, network: { latencyMs: 0, downKbps: 0, upKbps: 0 } };
const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) * p)];

if (mode === 'sleep') {
  // How long Atomics.wait in a worker really sleeps, as the duty cycle's beat does.
  const code = `const { parentPort } = require('node:worker_threads'); const s = new Int32Array(new SharedArrayBuffer(4)); const out = {};
for (const ms of [0.5, 1, 2.5, 7.5]) { const xs = []; for (let i = 0; i < 300; i++) { const t = performance.now(); Atomics.wait(s, 0, 0, ms); xs.push(performance.now() - t - ms); } out[ms] = xs; }
parentPort.postMessage(out);`;
  const out = await new Promise((r) => new Worker(code, { eval: true }).once('message', r));
  for (const [ms, xs] of Object.entries(out)) console.log(`SLEEP ${tag} ${process.platform} wait ${ms} ms: oversleep p50 ${pct(xs, 0.5).toFixed(2)} p90 ${pct(xs, 0.9).toFixed(2)} p99 ${pct(xs, 0.99).toFixed(2)} max ${Math.max(...xs).toFixed(2)}`);
  process.exit(0);
}

const lib = mode === 'before' ? pathToFileURL(path.resolve(arg)).href : '../../lib/constrain.mjs';
const { launchConstrained } = await import(lib);
const configs = mode === 'before'
  ? (process.platform === 'darwin' ? [{ cpuMechanism: 'auto' }] : [{ cpuMechanism: 'auto' }, { cpuMechanism: process.platform === 'win32' ? 'hard-cap' : 'duty-cycle' }])
  : {
    linux: [{ cpuMechanism: 'hard-cap', cgroupPeriodUs: 10000 }, { cpuMechanism: 'hard-cap', cgroupPeriodUs: 4000 }, { cpuMechanism: 'duty-cycle', periodMs: 10 }, { cpuMechanism: 'duty-cycle', periodMs: 4 }, { cpuMechanism: 'duty-cycle', periodMs: 2 }],
    darwin: [{ cpuMechanism: 'duty-cycle', periodMs: 10 }, { cpuMechanism: 'duty-cycle', periodMs: 4 }, { cpuMechanism: 'duty-cycle', periodMs: 2 }, { cpuMechanism: 'duty-cycle', periodMs: 1 }],
    win32: [{ cpuMechanism: 'duty-cycle', periodMs: 10 }, { cpuMechanism: 'duty-cycle', periodMs: 4 }, { cpuMechanism: 'hard-cap', capDuty: true, periodMs: 4 }],
  }[process.platform];
for (const c of configs) {
  for (let k = 0; k < 3; k++) {
    const s = await launchConstrained(process.execPath, ['-e', '0'], { ...c, overrides: off, log: null, burstSamples: true }).done;
    const u = s.cpu;
    const d = u.duty?.cycles ? { onMs: +(u.duty.ranMs / u.duty.cycles).toFixed(2), offMs: +(u.duty.pausedMs / u.duty.cycles).toFixed(2), timer: u.duty.timer } : null;
    const spread = u.burst?.constrainedSamples ? `; constrained p10/p90 ${pct(u.burst.constrainedSamples, 0.1)}/${pct(u.burst.constrainedSamples, 0.9)}` : '';
    console.log(`PROBE ${mode}${tag} ${process.platform} ${u.mechanism} ${JSON.stringify(c)} long ${u.achieved} (${u.baselineMs}->${u.constrainedMs}, corr ${u.corrections}, ratio ${u.dutyRatio ?? '-'}, rate ${u.rate ?? '-'}, quota ${u.quota ?? '-'}) burst ${u.burst?.achieved} (${u.burst?.baselineMs}->${u.burst?.constrainedMs}${spread}) duty ${JSON.stringify(d)} throttled ${u.throttledPeriods ?? '-'} err ${s.error ?? '-'}`);
    if (u.burst?.constrainedSamples) console.log(`SAMPLES ${JSON.stringify(u.burst.constrainedSamples)}`);
  }
}
