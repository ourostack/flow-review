// The calibration loop: a fixed amount of CPU-bound work, timed. The same work before and after a constraint gives the
// slowdown it achieved, so a run proves its "4×" instead of assuming it.

/** A fixed amount of integer work that the JIT can't skip. */
export function spin(iterations) {
  let x = 1;
  for (let i = 0; i < iterations; i++) x = (Math.imul(x, 1103515245) + 12345 + i) | 0;
  return x;
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/** Milliseconds `spin(iterations)` takes, the median of `samples` runs. */
export function timeSpin(iterations, samples = 3) {
  const ms = [];
  for (let k = 0; k < samples; k++) {
    const t = performance.now();
    spin(iterations);
    ms.push(performance.now() - t);
  }
  return median(ms);
}

/** Warms the loop up and sizes it to take about `targetMs` here, now; returns `{ iterations, ms }` (the baseline). */
export function baseline(targetMs = 150, samples = 3) {
  let n = 1 << 16;
  spin(n);
  while (timeSpin(n, 1) < targetMs / 8 && n < 2 ** 34) n *= 2;
  n = Math.max(1, Math.round((n * targetMs) / timeSpin(n, 3)));
  return { iterations: n, ms: timeSpin(n, samples) };
}

/** The slowdown factor of `ms` against a baseline of `baseMs`, to two decimals. */
export const factorOf = (ms, baseMs) => Math.round((ms / baseMs) * 100) / 100;

/** Whether an achieved factor is within `tolerance` (a fraction, 0.25 for ±25%) of the target. */
export const within = (achieved, target, tolerance) => Math.abs(achieved - target) <= target * tolerance;
