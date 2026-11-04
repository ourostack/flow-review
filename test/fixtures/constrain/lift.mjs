// A constrained tree for the lift test: times the calibration loop (iterations given) `count` times, a pause between,
// and appends each time to a file as a JSON line, so the harness can tell lifted timings from constrained ones.
import fs from 'node:fs';
import { timeSpin } from '../../../lib/constrain-calibrate.mjs';

const [iterations, file, count] = process.argv.slice(2);
for (let k = 0; k < Number(count); k++) {
  const ms = timeSpin(Number(iterations), 1);
  fs.appendFileSync(file, `${JSON.stringify({ k, ms })}\n`);
  await new Promise((r) => setTimeout(r, 100));
}
