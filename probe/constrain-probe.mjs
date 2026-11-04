// Diagnoses the macOS duty cycle: when do SIGSTOP and SIGCONT actually take effect, against when they were sent, and
// what slowdown a busy child really gets, against what the duty cycle's own account says. Then runs flow-review
// constrain's calibration repeatedly and prints what it reports. Temporary, for the fr-constrain investigation.
import { spawn } from 'node:child_process';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { launchConstrained } from '../lib/constrain.mjs';
import { baseline, timeSpin } from '../lib/constrain-calibrate.mjs';

const here = (f) => fileURLToPath(new URL(f, import.meta.url));
const ns = () => Number(process.hrtime.bigint());
const sleep = (ms) => (ms > 0 ? new Promise((r) => setTimeout(r, ms)) : Promise.resolve());
const q = (xs, p) => { const s = [...xs].sort((a, b) => a - b); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : NaN; };
const f1 = (x) => (Number.isFinite(x) ? x.toFixed(2) : String(x));
const stats = (xs) => `p10 ${f1(q(xs, 0.1))} p50 ${f1(q(xs, 0.5))} p90 ${f1(q(xs, 0.9))} max ${f1(Math.max(...xs))} (n ${xs.length})`;

console.log(`platform ${process.platform}-${process.arch}, ${os.availableParallelism()} CPUs, ${os.cpus()[0]?.model}, node ${process.version}`);

// 1. Timer lateness: setTimeout(x) actual duration.
for (const want of [1, 2.5, 7.5]) {
  const late = [];
  for (let i = 0; i < 200; i++) { const t = ns(); await sleep(want); late.push((ns() - t) / 1e6 - want); }
  console.log(`setTimeout(${want}) late by ms: ${stats(late)}`);
}

// 2. The VM's own speed drift: a ~100 ms loop timed 40 times over ~6 s.
{
  const b = baseline(100);
  const ms = [];
  for (let i = 0; i < 40; i++) { ms.push(timeSpin(b.iterations, 1)); await sleep(50); }
  const med = q(ms, 0.5);
  console.log(`unconstrained 100 ms loop, ratio to its median: ${stats(ms.map((m) => m / med))}`);
}

// 3. Stop/continue latency against a busy child, at several periods and ratios.
async function dutyProbe(periodMs, factor, seconds = 6) {
  const child = spawn(process.execPath, [here('./latency-child.mjs'), String(seconds * 1000)], { stdio: ['ignore', 'pipe', 'inherit'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  const closed = new Promise((r) => child.on('close', r));
  await sleep(300);
  const sent = [];
  let ran = 0;
  let paused = 0;
  let on = ns();
  const t0 = on;
  while (child.exitCode === null && ns() - t0 < (seconds - 1) * 1e9) {
    await sleep(periodMs / factor);
    const s0 = ns(); try { process.kill(child.pid, 'SIGSTOP'); } catch { break; } const s1 = ns();
    ran += (s1 - on) / 1e6;
    await sleep(ran * (factor - 1) - paused);
    const c0 = ns(); try { process.kill(child.pid, 'SIGCONT'); } catch { break; } const c1 = ns();
    on = c1;
    paused += (c1 - s1) / 1e6;
    sent.push({ s0, s1, c0, c1 });
  }
  const tEnd = ns();
  try { process.kill(child.pid, 'SIGCONT'); } catch {}
  await closed;
  const { gaps } = JSON.parse(out);
  // Match each stop/continue pair to the child's gap that contains it.
  const stopLat = [];
  const contLat = [];
  const other = [];
  let gi = 0;
  const used = new Set();
  for (const p of sent) {
    while (gi < gaps.length && gaps[gi][1] < p.s0) gi++;
    const g = gaps[gi];
    if (!g || g[0] > p.c1) { stopLat.push(NaN); continue; }
    used.add(gi);
    stopLat.push((g[0] - p.s1) / 1e6);
    contLat.push((g[1] - p.c1) / 1e6);
  }
  gaps.forEach((g, i) => { if (!used.has(i) && g[0] >= t0 && g[1] <= tEnd) other.push((g[1] - g[0]) / 1e6); });
  // The child's real running time over the duty window: wall minus every gap inside it.
  const wall = (tEnd - t0) / 1e6;
  const stoppedMs = gaps.filter((g) => g[0] >= t0 && g[1] <= tEnd).reduce((a, g) => a + (g[1] - g[0]) / 1e6, 0);
  const real = wall / (wall - stoppedMs);
  const sigSendMs = sent.map((p) => (p.s1 - p.s0) / 1e6).concat(sent.map((p) => (p.c1 - p.c0) / 1e6));
  console.log(`duty period ${periodMs} ms ratio ${factor}: ${sent.length} cycles; account says ${f1((ran + paused) / ran)}x; child really got ${f1(real)}x`);
  console.log(`   stop took effect after (ms, + = child kept running): ${stats(stopLat.filter(Number.isFinite))}; unmatched ${stopLat.filter((x) => !Number.isFinite(x)).length}`);
  console.log(`   resumed after continue (ms): ${stats(contLat)}`);
  console.log(`   kill() call itself (ms): ${stats(sigSendMs)}`);
  if (other.length) console.log(`   other gaps (preemption) ms: ${stats(other)}; total ${f1(other.reduce((a, b) => a + b, 0))} ms`);
}
for (const [p, f] of [[10, 4], [10, 4], [20, 4], [40, 4], [10, 2]]) await dutyProbe(p, f);

// 4. flow-review constrain's own calibration, as shipped, a few times.
for (const mech of process.platform === 'linux' ? ['duty-cycle', 'auto'] : ['duty-cycle']) for (let i = 0; i < Number(process.env.PROBE_RUNS ?? 6); i++) {
  const r = launchConstrained(process.execPath, ['-e', '0'], { cpuMechanism: mech, tolerance: 0.99, overrides: { memoryMB: 0, disk: { latencyMs: 0, mbPerSec: 0 }, network: { latencyMs: 0, downKbps: 0, upKbps: 0 } }, log: null });
  const s = await r.done;
  const c = s.cpu;
  console.log(`constrain ${c.mechanism} run ${i + 1}: achieved ${c.achieved}x after ${c.corrections} corrections (ratio ${c.dutyRatio ?? '-'}, period ${c.dutyPeriodMs ?? 10}); base ${c.baselineMs} -> ${c.constrainedMs} ms; bursts ${c.burst?.achieved}x (${c.burst?.baselineMs} -> ${c.burst?.constrainedMs}); duty ${JSON.stringify(c.duty)}; ${s.error ?? 'ok'}`);
}
