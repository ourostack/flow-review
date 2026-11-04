// Busy loop that records every gap in its own running longer than 300 µs (a stop, or a preemption), on the shared
// monotonic clock, and reports them when told to finish.
const gaps = [];
let last = process.hrtime.bigint();
let iters = 0;
const endAt = last + BigInt(Number(process.argv[2] ?? 8000)) * 1_000_000n;
while (true) {
  const now = process.hrtime.bigint();
  iters++;
  if (now - last > 300_000n && gaps.length < 100000) gaps.push([Number(last), Number(now)]);
  last = now;
  if (now > endAt) break;
}
process.stdout.write(JSON.stringify({ gaps, iters }));
