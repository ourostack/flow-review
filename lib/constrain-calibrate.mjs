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

/** Runs the loop enough for the JIT to settle on its fastest code, so later timings compare like with like. */
export function warmUp() {
  for (let i = 0; i < 200; i++) spin(1 << 14);
}

/** Warms the loop up and sizes it to take about `targetMs` here, now; returns `{ iterations, ms }` (the baseline). */
export function baseline(targetMs = 150, samples = 3) {
  warmUp();
  let n = 1 << 16;
  while (timeSpin(n, 1) < targetMs / 8 && n < 2 ** 34) n *= 2;
  n = Math.max(1, Math.round((n * targetMs) / timeSpin(n, 3)));
  return { iterations: n, ms: timeSpin(n, samples) };
}

/** The slowdown factor of `ms` against a baseline of `baseMs`, to two decimals. */
export const factorOf = (ms, baseMs) => Math.round((ms / baseMs) * 100) / 100;

/** Whether an achieved factor is within `tolerance` (a fraction, 0.25 for ±25%) of the target. */
export const within = (achieved, target, tolerance) => Math.abs(achieved - target) <= target * tolerance;

/**
 * The slowdown of adjacent pairs: each constrained time over the unconstrained one timed just before it, on the same
 * computer a moment apart, so a computer that changes speed between them (a virtual machine whose host gets busier, a
 * core that changes clock) moves both. Returns the median of the pairs' factors (`achieved`), each pair's (`factors`),
 * and the median times. Pairs with a time that isn't a positive number are left out; none left gives `achieved: null`.
 */
export function pairedFactor(baseMs, constrainedMs) {
  const pairs = baseMs.map((b, k) => [b, constrainedMs[k]]).filter(([b, c]) => b > 0 && c > 0 && Number.isFinite(b) && Number.isFinite(c));
  if (!pairs.length) return { achieved: null, factors: [], baselineMs: null, constrainedMs: null };
  const factors = pairs.map(([b, c]) => factorOf(c, b));
  return { achieved: median(factors), factors, baselineMs: median(pairs.map((p) => p[0])), constrainedMs: median(pairs.map((p) => p[1])) };
}

/**
 * The next correction to a constraint that measured `history.at(-1).achieved` against a `target` factor: how many times
 * stronger (over 1) or weaker (under 1) to make it. `history` is each measurement so far with the constraint's strength
 * when it was taken (`{ strength, achieved }`, strength relative to where it started). One measurement gives the plain
 * ratio, target over achieved. From two at different strengths it learns how far the factor moves for a change in
 * strength (its elasticity, from 0.5 to 3; a factor that moved the wrong way, or not at all, counts as 1) and corrects
 * by that: a duty cycle on a computer that resumes a process late slows more than its ratio says, and more so the shorter
 * its runs, so its factor moves further than its ratio. One correction is at most 2× either way.
 */
export function nextCorrection(target, history) {
  const last = history.at(-1);
  const ratio = target / last.achieved;
  let elasticity = 1;
  const prev = history.at(-2);
  if (prev && prev.strength !== last.strength) {
    const e = Math.log(last.achieved / prev.achieved) / Math.log(last.strength / prev.strength);
    if (Number.isFinite(e) && e > 0) elasticity = Math.min(3, Math.max(0.5, e));
  }
  return Math.min(2, Math.max(0.5, ratio ** (1 / elasticity)));
}
