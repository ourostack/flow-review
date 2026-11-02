// Route scope: a goto's routes last until the next goto or the end of the flow, so they answer what the page asks for
// just after it loads; any other step's last that step only. A step's route no request used is an advisory finding.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { exitCodeFor, markdown } from '../lib/report.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, '.scratch', 'routes');

test('a goto\'s routes outlive its step, another step\'s end with it, and unused routes are advisory', { timeout: 120_000 }, () => {
  fs.rmSync(out, { recursive: true, force: true });
  const r = spawnSync(process.execPath, ['bin/flow-review.mjs', 'run', 'test/fixtures/routes/flows/*.flow.json', '--out', out, '--fail-on', 'any'], { cwd: root, encoding: 'utf8', env: { ...process.env, FLOW_REVIEW_WORKERS: '1' } });
  const findings = fs.readFileSync(path.join(out, 'findings.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const of = (flow) => findings.filter((f) => f.flow === `Routes fixture: ${flow}`);
  const steps = (flow) => Object.fromEntries(of(flow).filter((f) => f.check === 'step').map((f) => [f.step, f.pass ? 'pass' : f.measured]));

  // The page asks 300 ms after its load: the goto's route answers it, and the next goto's lack of one lets it through.
  assert.deepEqual(steps("a goto's route answers after the load"), { open: 'pass', routed: 'pass', reopen: 'pass', unrouted: 'pass' });
  assert.deepEqual(of("a goto's route answers after the load").filter((f) => f.check === 'unusedRoute'), []);

  // A click's route answers that click only: the next click reaches the server.
  assert.deepEqual(steps("another step's route lasts that step"), { open: 'pass', routed: 'pass', unrouted: 'pass' });
  assert.deepEqual(of("another step's route lasts that step").filter((f) => f.check === 'unusedRoute'), []);

  // A route no request matched names its step and pattern, and fails nothing.
  assert.deepEqual(steps('unused routes'), { open: 'pass', routed: 'pass', press: 'pass', pressed: 'pass' });
  const unused = of('unused routes').filter((f) => f.check === 'unusedRoute').map(({ step, pass, advisory, measured }) => ({ step, pass, advisory, measured }));
  assert.deepEqual(unused.sort((a, b) => (a.step < b.step ? -1 : 1)), [
    { step: 'open', pass: false, advisory: true, measured: 'no request matched **/api/never.json' },
    { step: 'press', pass: false, advisory: true, measured: 'no request matched **/api/other.json' },
  ]);

  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
  assert.equal(report.summary.failures, 0);
  assert.equal(report.summary.advisories, 2);
  assert.deepEqual(report.summary.byCheck.unusedRoute, { pass: 0, fail: 0, advisory: 2, ms: 0 });
  assert.ok(report.units.every((u) => u.failures === 0));
  const md = markdown(report, findings);
  assert.match(md, /✅ \*\*0 failing\*\*, 2 advisory of/);
  assert.match(md, /⚠️ unusedRoute 2/);
  assert.match(md, /2 advisory findings \(never fail the run\)/);
  fs.rmSync(out, { recursive: true, force: true });
});

test('an advisory finding fails no --fail-on, even one naming its check', () => {
  const f = { flow: 'x', check: 'unusedRoute', pass: false, advisory: true };
  for (const failOn of ['any', 'unusedRoute', 'step,unusedRoute']) assert.equal(exitCodeFor([f], failOn), 0, failOn);
  assert.equal(exitCodeFor([{ ...f, advisory: undefined }], 'any'), 1);
});
