// Release gating: the same flow against a candidate named by --target (or FLOW_REVIEW_TARGET), with provenance, no
// retries, and known defects reported but not counted.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validate } from '../lib/schema.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = path.join(root, '.scratch', 'release');
const FLOW = 'test/fixtures/release/*.flow.json';
const cli = (args, env = {}) => spawnSync(process.execPath, ['bin/flow-review.mjs', ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, FLOW_REVIEW_TARGET: '', ...env } });
const read = (dir) => ({ report: JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8')), findings: fs.readFileSync(path.join(dir, 'findings.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) });

test('an agent-cli flow gates a release candidate named by --target', () => {
  fs.rmSync(scratch, { recursive: true, force: true });
  const good = 'test/fixtures/candidate/good.mjs';
  const g = cli(['run', FLOW, '--target', good, '--target-version', '1.2.3', '--fail-on', 'any', '--out', path.join(scratch, 'good')]);
  assert.equal(g.status, 0, `the good candidate passes (its known defect doesn't count):\n${g.stderr}`);
  const { report, findings } = read(path.join(scratch, 'good'));
  assert.deepEqual(validate('report', report), []);
  assert.equal(report.summary.units, 1);
  assert.equal(report.table[0].flow, 'R1 Candidate: today, then one item');
  const p = report.provenance;
  assert.equal(p.target.value, good);
  assert.equal(p.target.kind, 'path');
  assert.equal(p.target.version, '1.2.3');
  assert.equal(p.target.sha256, createHash('sha256').update(fs.readFileSync(path.join(root, good))).digest('hex'));
  assert.equal(p.engine.name, 'flow-review');
  assert.equal(p.retries, 0);
  assert.equal(p.failOn, 'any');
  const failing = findings.filter((f) => !f.pass);
  assert.deepEqual(failing.map((f) => [f.step, f.check, f.known]), [['not-built', 'exit', '#999']], 'only the known defect fails');
  for (const c of ['exit', 'text', 'stderrRules', 'maxMs', 'jsonShape', 'fields', 'maxBytes', 'readOnly']) assert.ok(findings.some((f) => f.check === c && f.pass), `${c} passes`);
  assert.ok(findings.some((f) => f.step === 'show' && f.check === 'fields' && f.pass), 'a saved value fills the next step');
  assert.match(fs.readFileSync(path.join(scratch, 'good', 'summary.md'), 'utf8'), /Target: `test\/fixtures\/candidate\/good.mjs` 1.2.3 \(sha256 [0-9a-f]{12}\); engine/);

  const b = cli(['run', FLOW, '--fail-on', 'any', '--out', path.join(scratch, 'broken')], { FLOW_REVIEW_TARGET: 'test/fixtures/candidate/broken.mjs' });
  assert.equal(b.status, 1, 'the broken candidate fails the gate');
  const broken = read(path.join(scratch, 'broken'));
  assert.equal(broken.report.provenance.target.value, 'test/fixtures/candidate/broken.mjs', 'FLOW_REVIEW_TARGET names the target');
  const bad = new Set(broken.findings.filter((f) => !f.pass && !f.known).map((f) => `${f.step} ${f.check}${f.selector ? ` ${f.selector}` : ''}`));
  for (const k of ['today exit', 'today jsonShape items[].id', 'today stderrRules empty', 'today stderrRules noStack', 'refusal stderrRules namesFix']) assert.ok(bad.has(k), `${k} fails: ${[...bad].join(', ')}`);
  assert.ok(broken.findings.some((f) => f.step === 'show' && f.check === 'exit' && !f.pass), 'a value that was never saved leaves its placeholder, and the step using it fails');

  const none = cli(['run', FLOW, '--out', path.join(scratch, 'none')]);
  assert.equal(none.status, 2);
  assert.match(none.stderr, /runs \$\{target\}: pass --target/);
  fs.rmSync(scratch, { recursive: true, force: true });
});

test("a product's own agent-flow types run unchanged: W1 with its own define.ts, a config's app, and --target", () => {
  const out = path.join(scratch, 'ax');
  const r = cli(['run', 'test/fixtures/ax/*.flow.ts', '--target', 'test/fixtures/ax/cli.mjs', '--fail-on', 'any', '--out', out]);
  assert.equal(r.status, 0, `only known defects fail:\n${r.stderr}`);
  const { report, findings } = read(out);
  assert.deepEqual(validate('report', report), []);
  assert.equal(report.table[0].flow, 'W1 Morning triage: what needs you, what happened and every thread, ranked with links');
  const failing = findings.filter((f) => !f.pass);
  assert.deepEqual(failing.map((f) => [f.step, f.check, f.known]).sort(), [['--help', 'listed', 'https://example.com/issues/1'], ['attention', 'fields', 'https://example.com/issues/2']]);
  assert.ok(findings.some((f) => f.step === 'open-first' && f.check === 'jsonShape' && f.pass), 'the saved ref opens the first item');
  assert.ok(findings.some((f) => f.check === 'readOnly' && f.pass));
  assert.equal(report.provenance.target.value, 'test/fixtures/ax/cli.mjs');
  assert.ok(!fs.existsSync(path.join(out, 'work')), 'the scratch folder is gone');
  assert.ok(!fs.existsSync(path.join(root, '${workdir}')), 'placeholders in file names are filled');
  fs.rmSync(scratch, { recursive: true, force: true });
});
