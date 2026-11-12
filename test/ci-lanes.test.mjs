// Pull-request macOS jobs wait in a shared lane: the Ouro Labs enterprise's 50 macOS slots are shared by every org in it
// (ourostack/gatefold#286). A lane is a job-level concurrency group with `queue: max`; it never cancels a job, and
// runs other than pull requests get a group of their own.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, '.github', 'workflows');

// [{file, name, block}] for each job under `jobs:`.
function jobs(file, text) {
  const out = [];
  let inside = false;
  let cur = null;
  for (const line of text.split('\n')) {
    if (/^jobs:\s*$/.test(line)) { inside = true; continue; }
    if (inside && /^\S/.test(line)) inside = false;
    if (!inside) continue;
    const m = line.match(/^ {2}([A-Za-z0-9_-]+):\s*$/);
    if (m) { cur = { file, name: m[1], block: '' }; out.push(cur); } else if (cur) cur.block += line + '\n';
  }
  return out;
}

const all = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f))
  .flatMap((f) => jobs(f, fs.readFileSync(path.join(dir, f), 'utf8')));
const onMac = (j) => /^ {4}runs-on:.*macos/m.test(j.block) || (/^ {4}runs-on:.*matrix\./m.test(j.block) && /macos-/.test(j.block));

test('the workflows have macOS jobs to check', () => {
  assert.ok(all.filter(onMac).length >= 2, 'expected webkit-mac and constrain');
});

for (const j of all.filter(onMac)) {
  test(`${j.file}: ${j.name} waits in a pull-request macOS lane`, () => {
    const conc = j.block.match(/^ {4}concurrency:\n((?: {6}.*\n| *\n)*)/m);
    assert.ok(conc, 'a macOS job needs a lane (a job-level concurrency group)');
    const body = conc[1];
    assert.match(body, /^ +queue: max\s*$/m, 'a lane queues with `queue: max`');
    assert.doesNotMatch(body, /cancel-in-progress/, 'a lane never cancels a job');
    assert.match(body, /github\.event_name == 'pull_request'/, 'only pull requests share the lane');
    assert.match(body, /'flow-review-macos-pr-lane-[a-z-]+'/, 'the lane is named flow-review-macos-pr-lane-<job>');
    assert.match(body, /github\.run_id/, 'other runs get a group of their own');
  });
}
