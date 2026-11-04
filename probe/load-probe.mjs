// Root-cause check for fr-constrain: flow-review constrain's calibration, v0.5.3 (4b436bd here: three pairs)
// against #15 (adjacent pairs, damped corrections), on this runner idle, under steady load and under load that comes and
// goes. Load is other busy processes, bounded in time, run only on a CI runner. Temporary; never merged.
import { spawn } from 'node:child_process';
import os from 'node:os';

const versions = { old: '../probe/old/lib/constrain.mjs', new: '../lib/constrain.mjs' };
const RUNS = Number(process.env.PROBE_RUNS ?? 6);
const cpus = os.availableParallelism();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
console.log(`platform ${process.platform}-${process.arch}, ${cpus} CPUs, ${os.cpus()[0]?.model}`);

// `n` busy processes for `ms`, each a bounded loop that ends on its own.
const busy = (n, ms) => Array.from({ length: n }, () => spawn(process.execPath, ['-e', `const end = Date.now() + ${ms}; let x = 0; while (Date.now() < end) x++;`], { stdio: 'ignore' }));
const stopAll = (ps) => { for (const p of ps) { try { p.kill('SIGKILL'); } catch {} } };

// Load that comes and goes: `n` busy processes for `onMs`, then none for `offMs`, until `stop()`.
function intermittent(n, onMs, offMs) {
  let live = [];
  let stopped = false;
  (async () => {
    while (!stopped) {
      live = busy(n, onMs);
      await sleep(onMs + offMs);
    }
  })();
  return () => { stopped = true; stopAll(live); };
}

async function calibrate(version) {
  const { launchConstrained } = await import(new URL(versions[version], import.meta.url));
  const s = await launchConstrained(process.execPath, ['-e', '0'], { cpuMechanism: process.env.PROBE_MECH ?? 'duty-cycle', tolerance: 0.99, burstTolerance: 0.99, overrides: { memoryMB: 0, disk: { latencyMs: 0, mbPerSec: 0 }, network: { latencyMs: 0, downKbps: 0, upKbps: 0 } }, log: null }).done;
  return s.cpu;
}

const scenarios = {
  idle: () => () => {},
  steady: () => { const ps = busy(cpus, 600_000); return () => stopAll(ps); },
  'comes-and-goes': () => intermittent(cpus, 1200, 1800),
};
const summary = [];
for (const [name, start] of Object.entries(scenarios)) {
  for (const version of ['old', 'new']) {
    for (let i = 0; i < RUNS; i++) {
      const stop = start();
      await sleep(300);
      let c;
      try { c = await calibrate(version); } finally { stop(); }
      const steps = c.calibration ? c.calibration.map((x) => x.achieved).join(' > ') : '';
      console.log(`${name} ${version} #${i + 1}: long ${c.achieved}x after ${c.corrections} corrections${steps ? ` (${steps})` : ''}; bursts ${c.burst?.achieved}x; ratio ${c.dutyRatio ?? 4}, period ${c.dutyPeriodMs ?? 10}`);
      summary.push({ name, version, achieved: c.achieved, burst: c.burst?.achieved });
      await sleep(1000);
    }
  }
}
console.log('\nscenario | version | long factors | within 4x +-10% | bursts');
for (const name of Object.keys(scenarios)) for (const version of ['old', 'new']) {
  const rows = summary.filter((r) => r.name === name && r.version === version);
  console.log(`${name} | ${version} | ${rows.map((r) => r.achieved).join(', ')} | ${rows.filter((r) => Math.abs(r.achieved - 4) <= 0.4 + 1e-9).length}/${rows.length} | ${rows.map((r) => r.burst).join(', ')}`);
}
