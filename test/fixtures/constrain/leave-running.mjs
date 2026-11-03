// Runs under flow-review constrain and leaves processes behind: one in its process group and one that leaves it
// (detached). Both only sleep. Writes their pids to the file named first, then exits after a second ("exit") or stays
// until killed ("stay").
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const [pidsFile, mode] = process.argv.slice(2);
const sleeper = (detached) => {
  const p = spawn(process.execPath, ['-e', 'setInterval(() => {}, 60000)'], { stdio: 'ignore', detached, windowsHide: true });
  p.unref();
  return p.pid;
};
fs.writeFileSync(pidsFile, JSON.stringify({ command: process.pid, inGroup: sleeper(false), detached: sleeper(true) }));
// A second, so the tree's watch has seen the detached one before its parent goes.
if (mode === 'exit') setTimeout(() => process.exit(0), 1000);
else setInterval(() => {}, 60000);
