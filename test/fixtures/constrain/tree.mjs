// Runs under flow-review constrain: times the calibration loop in a grandchild (so the whole tree is shown slowed, not
// just the first process), times file-system calls, and makes one request through the proxy it was given.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';

const [iterations, url] = process.argv.slice(2);
const grandchild = spawnSync(process.execPath, ['--input-type=module', '-e', `import { timeSpin } from ${JSON.stringify(new URL('../../../lib/constrain-calibrate.mjs', import.meta.url).href)}; console.log(timeSpin(${Number(iterations)}, 3));`], { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } });
const out = { grandchildMs: Number(grandchild.stdout.trim()), env: process.env.FLOW_REVIEW_CONSTRAINED ? JSON.parse(process.env.FLOW_REVIEW_CONSTRAINED) : null, proxy: process.env.HTTP_PROXY ?? null };
let t = performance.now();
for (let i = 0; i < 5; i++) fs.statSync(process.execPath);
out.statMs = performance.now() - t;
if (url && out.proxy) {
  const proxy = new URL(out.proxy);
  t = performance.now();
  await new Promise((resolve, reject) => http.get({ host: proxy.hostname, port: proxy.port, path: url }, (res) => { res.resume(); res.on('end', resolve); }).on('error', reject));
  out.requestMs = performance.now() - t;
}
console.log(`TREE ${JSON.stringify(out)}`);
