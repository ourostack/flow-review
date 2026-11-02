// A step that holds a key: down, the steps while it's held (whose captures run the checks then), then up. The fixture
// page shows its held state only while \ is down, with faint words a contrast check finds.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validate } from '../lib/schema.mjs';
import { policyOf } from '../lib/load.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, '.scratch', 'hold');

let ran;
const run = () => (ran ??= (() => {
  fs.rmSync(out, { recursive: true, force: true });
  const r = spawnSync(process.execPath, ['bin/flow-review.mjs', 'run', 'test/fixtures/hold/flows/*.flow.json', '--out', out, '--fail-on', 'none'], { cwd: root, encoding: 'utf8', env: { ...process.env, FLOW_REVIEW_WORKERS: '1' } });
  assert.equal(r.status, 0, r.stderr);
  const findings = fs.readFileSync(path.join(out, 'findings.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
  return { findings, report };
})());
const at = (findings, step, check) => findings.filter((f) => f.step === step && f.check === check);

test.after(() => fs.rmSync(out, { recursive: true, force: true }));

test('a held key\'s state is seen and captured while it is down, and the checks run at that moment', { timeout: 120_000 }, () => {
  const { findings, report } = run();
  for (const step of ['hold', 'held-shown']) {
    const s = at(findings, step, 'step');
    assert.equal(s.length, 1, `${step} ran once`);
    assert.ok(s[0].pass, `${step}: ${s[0].measured}`);
  }
  assert.ok(report.captures.some((c) => c.step === 'held' && c.moment === 'held'), 'the held moment is captured');
  const faint = at(findings, 'held', 'contrast').filter((f) => !f.pass);
  assert.ok(faint.some((f) => /your own style/.test(f.label ?? '')), `the held state's faint words were measured: ${JSON.stringify(at(findings, 'held', 'contrast'))}`);
  assert.equal(at(findings, 'before', 'contrast').filter((f) => !f.pass).length, 0, 'not held yet');
});

test('the key is released after the steps it was held for, and the page goes back', { timeout: 120_000 }, () => {
  const { findings, report } = run();
  // The hold's expect is checked after the key is up, and the next step waits for the held state to go.
  const released = at(findings, 'released', 'step');
  assert.equal(released.length, 1);
  assert.ok(released[0].pass, released[0].measured);
  assert.ok(report.captures.some((c) => c.moment === 'after'));
  assert.equal(at(findings, 'after', 'contrast').filter((f) => !f.pass).length, 0, `the held state is gone: ${JSON.stringify(at(findings, 'after', 'contrast'))}`);
  assert.equal(findings.filter((f) => !f.pass && f.check !== 'contrast').length, 0, JSON.stringify(findings.filter((f) => !f.pass && f.check !== 'contrast')));
});

test('a hold names its key, and only a hold takes ms and during', () => {
  const flow = (act) => ({ name: 'x', surface: 'web', app: { url: 'http://127.0.0.1:1/' }, steps: [{ act }] });
  assert.deepEqual(validate('flow', flow({ verb: 'hold', key: '\\' })), []);
  assert.deepEqual(validate('flow', flow({ verb: 'hold', key: 'Shift', selector: '#grid', ms: 200, during: [{ waitFor: { selector: '[data-held]' } }, { capture: { moment: 'held' } }] })), []);
  assert.ok(validate('flow', flow({ verb: 'hold' })).length > 0, 'a hold without a key');
  assert.ok(validate('flow', flow({ verb: 'hold', key: 'a', during: [{ wait: 1 }] })).length > 0, 'during holds steps');
  assert.ok(validate('flow', flow({ verb: 'click', selector: '#x', during: [] })).length > 0, 'only a hold takes during');
  assert.ok(validate('flow', flow({ verb: 'press', key: 'a', ms: 100 })).length > 0, 'only a hold takes ms');
});

test('a held step\'s waits count towards the cell\'s time limit', () => {
  const flow = { name: 'x', surface: 'web', steps: [{ act: { verb: 'hold', key: 'a', ms: 2000, during: [{ waitFor: { selector: '#slow', ms: 200_000 } }] } }] };
  assert.equal(policyOf(flow).timeouts.cellMs, 232_000);
  assert.equal(policyOf({ ...flow, steps: [{ act: { verb: 'hold', key: 'a', ms: 150_000 } }] }).timeouts.cellMs, 180_000);
});
