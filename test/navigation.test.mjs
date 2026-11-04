// What a goto waits for: the load event by default, so a page that holds an event stream open (live updates) costs no
// extra time per goto; networkidle, which such a page never reaches, only when a flow asks for it; or a target.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validate } from '../lib/schema.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, '.scratch', 'navigation');

test('a page holding an event stream open adds no wait to a goto, unless the flow asks for networkidle', { timeout: 120_000 }, () => {
  fs.rmSync(out, { recursive: true, force: true });
  const r = spawnSync(process.execPath, ['bin/flow-review.mjs', 'run', 'test/fixtures/stream/flows/*.flow.json', '--out', out, '--fail-on', 'any'], { cwd: root, encoding: 'utf8', env: { ...process.env, FLOW_REVIEW_WORKERS: '1' } });
  const findings = fs.readFileSync(path.join(out, 'findings.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(r.status, 0, `${r.stderr}\n${JSON.stringify(findings.filter((f) => !f.pass).map((f) => [f.check, f.step, f.measured]))}`);
  const gotos = (flow) => findings.filter((f) => f.flow === `Stream fixture: ${flow}` && f.check === 'step' && f.measured === 'goto');
  for (const flow of ['load', 'a target']) {
    assert.equal(gotos(flow).length, 3);
    for (const f of gotos(flow)) assert.ok(f.pass && f.ms < 1500, `${flow}: ${f.step} took ${f.ms} ms`);
  }
  // The stream holds the network busy: opted in, networkidle waits out its 3 s on every goto.
  for (const f of gotos('networkidle')) assert.ok(f.pass && f.ms >= 2900, `networkidle: ${f.step} took ${f.ms} ms`);
  const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
  assert.equal(report.captures.length, 3, 'every flow reached its capture');
  fs.rmSync(out, { recursive: true, force: true });
});

test('readyAfterGoto takes load, domcontentloaded, networkidle or a target, in a flow\'s app and a config\'s', () => {
  const flow = (readyAfterGoto) => ({ name: 'x', surface: 'web', app: { url: 'http://127.0.0.1:1/', readyAfterGoto }, steps: [{ goto: '/' }] });
  for (const v of ['load', 'domcontentloaded', 'networkidle', { selector: '#ready' }, { role: 'heading', name: { regex: 'Plan' }, ms: 5000 }]) assert.deepEqual(validate('flow', flow(v)), [], JSON.stringify(v));
  assert.ok(validate('flow', flow('idle')).length > 0);
  for (const v of [{}, { ms: 5000 }, { name: 'Plan' }, { exact: true }]) assert.ok(validate('flow', flow(v)).length > 0, `a target names a role, text or selector: ${JSON.stringify(v)}`);
  assert.deepEqual(validate('config', { schema: 'flow-review-config/0', surfaces: { web: { app: { start: 'x', readyAfterGoto: 'networkidle' } } } }), []);
});
