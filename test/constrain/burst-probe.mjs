// Temporary: sweeps the CPU mechanisms and their periods on this platform and prints the long and burst factors.
import { launchConstrained } from '../../lib/constrain.mjs';

const off = { memoryMB: 0, disk: { latencyMs: 0, mbPerSec: 0 }, network: { latencyMs: 0, downKbps: 0, upKbps: 0 } };
const configs = {
  linux: [
    { cpuMechanism: 'hard-cap', cgroupPeriodUs: 10000 }, { cpuMechanism: 'hard-cap', cgroupPeriodUs: 4000 },
    { cpuMechanism: 'duty-cycle', periodMs: 10 }, { cpuMechanism: 'duty-cycle', periodMs: 4 }, { cpuMechanism: 'duty-cycle', periodMs: 2 },
  ],
  darwin: [{ cpuMechanism: 'duty-cycle', periodMs: 10 }, { cpuMechanism: 'duty-cycle', periodMs: 4 }, { cpuMechanism: 'duty-cycle', periodMs: 2 }],
  win32: [
    { cpuMechanism: 'duty-cycle', periodMs: 10 }, { cpuMechanism: 'duty-cycle', periodMs: 4 }, { cpuMechanism: 'duty-cycle', periodMs: 2 },
    { cpuMechanism: 'hard-cap' }, { cpuMechanism: 'hard-cap', capDuty: true, periodMs: 4 },
  ],
}[process.platform];
const pct = (xs, p) => [...xs].sort((a, b) => a - b)[Math.floor((xs.length - 1) * p)];
for (const c of configs) {
  for (let k = 0; k < 3; k++) {
    const s = await launchConstrained(process.execPath, ['-e', '0'], { ...c, overrides: off, log: null, burstSamples: true }).done;
    const u = s.cpu;
    const d = u.duty?.cycles ? { onMs: +(u.duty.ranMs / u.duty.cycles).toFixed(2), offMs: +(u.duty.pausedMs / u.duty.cycles).toFixed(2), timer: u.duty.timer } : null;
    console.log(`PROBE ${process.platform} ${JSON.stringify(c)} long ${u.achieved} (${u.baselineMs}->${u.constrainedMs}, corr ${u.corrections}, ratio ${u.dutyRatio ?? '-'}, rate ${u.rate ?? '-'}, quota ${u.quota ?? '-'}) burst ${u.burst?.achieved} (${u.burst?.baselineMs}->${u.burst?.constrainedMs}; base p10/p90 ${pct(u.burst.baselineSamples, 0.1)}/${pct(u.burst.baselineSamples, 0.9)}; constrained p10/p90 ${pct(u.burst.constrainedSamples, 0.1)}/${pct(u.burst.constrainedSamples, 0.9)}) duty ${JSON.stringify(d)} throttled ${u.throttledPeriods ?? '-'} err ${s.error ?? '-'}`);
    console.log(`SAMPLES ${JSON.stringify(u.burst.constrainedSamples)}`);
  }
}
