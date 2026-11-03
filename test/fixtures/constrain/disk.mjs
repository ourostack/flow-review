// Times file-system calls in each style the slow-disk preload covers.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { statSync } from 'node:fs';
import { promisify } from 'node:util';

const [file] = process.argv.slice(2);
const time = async (fn) => { const t = performance.now(); await fn(); return performance.now() - t; };
const out = {
  sync: await time(() => { for (let i = 0; i < 5; i++) fs.statSync(file); }),
  named: await time(() => { for (let i = 0; i < 5; i++) statSync(file); }),
  promises: await time(async () => { for (let i = 0; i < 5; i++) await fsp.stat(file); }),
  callback: await time(async () => { for (let i = 0; i < 5; i++) await new Promise((r) => fs.stat(file, r)); }),
  promisified: await time(async () => { const fd = fs.openSync(file, 'r'); const r = await promisify(fs.read)(fd, Buffer.alloc(16), 0, 16, 0); fs.closeSync(fd); if (r.bytesRead !== 16) throw new Error('promisify(fs.read) lost its shape'); }),
  readFile: await time(() => fs.readFileSync(file)),
  stream: await time(() => new Promise((r) => fs.createReadStream(file).on('data', () => {}).on('end', r))),
};
console.log(JSON.stringify(out));
