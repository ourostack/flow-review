// The CLI end to end on the fixture app: a web flow (served by app.start) and an agent-cli flow, then shards, merge and
// judge answers.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validate } from '../lib/schema.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = path.join(root, '.scratch', 'test-run');
const FLOWS = 'test/fixtures/flows/*.flow.{ts,json}';
const cli = (...args) => spawnSync(process.execPath, ['bin/flow-review.mjs', ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, FLOW_REVIEW_WORKERS: '2' } });
const read = (dir) => ({ report: JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8')), findings: fs.readFileSync(path.join(dir, 'findings.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l)) });

test('run, shard, merge and judge', { timeout: 240_000 }, async (t) => {
  fs.rmSync(scratch, { recursive: true, force: true });
  const full = path.join(scratch, 'full');

  await t.test('run writes a valid report, findings, evidence, moments and judge packets', () => {
    const r = cli('run', FLOWS, '--out', full);
    assert.equal(r.status, 1, `fails on planted defects:\n${r.stderr}`);
    const { report, findings } = read(full);
    assert.deepEqual(validate('report', report), []);
    for (const f of findings) assert.deepEqual(validate('finding', f), [], JSON.stringify(f));
    assert.equal(report.summary.units, 5);
    assert.equal(report.summary.agent.units, 1);
    assert.deepEqual(report.table.map((x) => x.side).sort(), ['agent', 'human']);
    const fail = (check, pred = () => true) => findings.filter((f) => !f.pass && f.check === check && pred(f));
    assert.equal(fail('targetSize', (f) => /"y"/.test(f.label) && f.step === 'list').length, 4, 'the tiny button, in every cell');
    assert.equal(fail('designSystem', (f) => /"y"/.test(f.label) && f.step === 'list').length, 4, 'the button without the marker');
    assert.equal(fail('fields').length, 1, 'the agent field');
    assert.equal(fail('states', (f) => f.step === 'raw-error').length, 4, 'a raw stack is not a human error state');
    assert.equal(fail('states', (f) => f.step === 'empty' || f.step === 'error').length, 0, 'the human states pass');
    assert.equal(fail('step').length, 0, 'every step runs');
    assert.equal(fail('errors').length, 0, 'routed 500s are expected, not errors');
    assert.ok(findings.some((f) => f.check === 'keyboard' && f.pass && f.step === '6-tabTraverse'), 'tab traversal inside the dialog');
    for (const f of findings.filter((x) => x.evidence)) {
      const size = fs.statSync(path.join(full, f.evidence)).size;
      assert.ok(size > 0 && size < 300 * 1024, `${f.evidence} is ${size} bytes`);
    }
    assert.ok(findings.filter((f) => !f.pass && f.evidence).length >= 8, 'failures carry crops');
    assert.equal(report.captures.length, 8, 'two captures in four cells');
    const packet = JSON.parse(fs.readFileSync(path.join(full, 'judge-packet-craft.json'), 'utf8'));
    assert.equal(packet.rubric, 'craft');
    assert.ok(packet.moments.length > 0 && packet.failing.length > 0);
    assert.match(fs.readFileSync(path.join(full, 'summary.md'), 'utf8'), /\| Fixture: open details \| human \| 4 \|/);
    assert.ok(report.moments.some((m) => m.kind === 'empty' && m.step === 'empty' && !m.hasMoment), 'the empty state, without its Moment');
    assert.ok(report.moments.some((m) => m.kind === 'error' && m.step === 'error' && m.hasMoment), 'the error state, with its Moment');
    const missing = JSON.parse(cli('moments', full, '--missing', '--json').stdout);
    assert.ok(missing.length > 0 && missing.every((m) => !m.hasMoment));
    assert.ok(missing.some((m) => /^fixture-open-details\/empty\/[0-9a-f]{10}$/.test(m.key)), JSON.stringify(missing.map((m) => m.key)));
    assert.ok(!missing.some((m) => m.kind === 'error' && m.how !== 'declared'));
    assert.equal(cli('run', FLOWS, '--out', path.join(scratch, 'none'), '--fail-on', 'none', '--only', 'states').status, 0);
  });

  await t.test('shards cover every unit exactly once, and merge checks it', () => {
    const a = path.join(scratch, 's1');
    const b = path.join(scratch, 's2');
    cli('run', FLOWS, '--out', a, '--shard', '1/2', '--only', 'overflow');
    cli('run', FLOWS, '--out', b, '--shard', '2/2', '--only', 'overflow');
    const ka = read(a).report.units.map((u) => u.key);
    const kb = read(b).report.units.map((u) => u.key);
    assert.equal(ka.length + kb.length, 5);
    assert.deepEqual(ka.filter((k) => kb.includes(k)), []);
    const m = cli('merge', a, b, '--out', path.join(scratch, 'merged'), '--flows', FLOWS, '--fail-on', 'none');
    assert.equal(m.status, 0, m.stderr);
    const merged = read(path.join(scratch, 'merged')).report;
    assert.deepEqual(merged.coverage, { missing: [], duplicated: [], unexpected: [], timedOut: [], missingReports: [], mode: 'gated', failing: [], advisory: [] });
    assert.equal(merged.summary.units, 5);
    // Failing on nothing, every flow is advisory: shard 1 counted twice and shard 2 missing are coverage findings.
    const dup = cli('merge', a, a, '--out', path.join(scratch, 'dup'), '--flows', FLOWS, '--fail-on', 'none');
    assert.equal(dup.status, 0, dup.stderr);
    assert.equal(read(path.join(scratch, 'dup')).findings.filter((f) => f.check === 'coverage').length, 5);
    const strict = cli('merge', a, a, '--out', path.join(scratch, 'dup'), '--flows', FLOWS, '--fail-on', 'none', '--coverage', 'strict');
    assert.equal(strict.status, 3, 'strict: a shard counted twice and one missing fail the guard');
    assert.match(strict.stderr, /duplicated [1-9]/);
    assert.equal(cli('merge', a, a, '--out', path.join(scratch, 'dup'), '--flows', FLOWS, '--fail-on', 'overflow').status, 3, 'gated: so do they');
    const times = path.join(scratch, 'times.json');
    cli('times', a, b, '--out', times);
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(times, 'utf8')).units).length, 5);
    const listed = cli('list', FLOWS, '--shard', '1/3', '--times', times);
    assert.equal(listed.status, 0, listed.stderr);
    assert.match(listed.stdout, /shard 3\/3/);
  });

  await t.test('judge --merge validates answers against the report and folds them in', () => {
    const { report } = read(full);
    const m = report.captures[0];
    const good = path.join(scratch, 'ive.json');
    fs.writeFileSync(good, JSON.stringify({ judge: 'ive', rubric: 'craft', verdict: 'not yet', moments: [{ flow: m.flow, step: m.step, cell: m.cell, crop: m.crop, observation: 'The two small buttons crowd each other.', fix: 'Give each 24 px and space them.' }] }));
    const bad = path.join(scratch, 'bad.json');
    fs.writeFileSync(bad, JSON.stringify({ judge: 'x', verdict: 'approve', moments: [{ step: 'nowhere', cell: null, crop: 'moments/none.webp', observation: 'o', fix: '' }] }));
    const no = cli('judge', '--merge', bad, '--report', full);
    assert.equal(no.status, 2);
    assert.match(no.stderr, /nowhere/);
    assert.equal(cli('judge', '--merge', good, '--report', full).status, 0);
    const after = read(full).report;
    assert.equal(after.judges.length, 1);
    assert.equal(after.judges[0].verdict, 'not yet');
    assert.deepEqual(validate('report', after), []);
  });

  fs.rmSync(scratch, { recursive: true, force: true });
});

test('schema and validate commands', () => {
  const s = cli('schema', 'flow');
  assert.equal(JSON.parse(s.stdout).title, 'flow-review/0');
  const v = cli('validate', FLOWS);
  assert.equal(v.status, 0, v.stderr);
  assert.match(v.stdout, /ok test\/fixtures\/flows\/web.flow.ts: Fixture: open details \(web, 4 units\)/);
  assert.equal(cli('run', 'nothing/*.flow.ts').status, 2);
  assert.equal(cli('run', FLOWS, '--workers', 'auto').status, 2);
  const typo = cli('run', FLOWS, '--fail-on', 'axe,contrst');
  assert.equal(typo.status, 2);
  assert.match(typo.stderr, /unknown check contrst/);
});

test('the duo in a flow: the working path, celebrations and quiet mode', { timeout: 120_000 }, () => {
  const out = path.join(scratch, 'duo');
  const r = cli('run', 'test/fixtures/duo/flows/*.flow.json', '--out', out, '--fail-on', 'none');
  assert.equal(r.status, 0, r.stderr);
  const { findings } = read(out);
  const bad = findings.filter((f) => f.flow === 'Duo fixture: bad' && !f.pass);
  const clean = findings.filter((f) => f.flow === 'Duo fixture: clean' && !f.pass);
  assert.deepEqual(clean, [], 'the clean page passes every duo check');
  assert.ok(bad.some((f) => f.check === 'duoOverlap' && f.step === 'type' && /appeared in the working path/.test(f.measured)), JSON.stringify(bad));
  assert.ok(bad.some((f) => f.check === 'celebrationCap' && f.measured === 2 && f.threshold === 1));
  assert.ok(bad.some((f) => f.check === 'duoOverlap' && f.step === 'note' && /appeared in the working path/.test(f.measured)), 'art mounted after the act');
  assert.ok(bad.some((f) => f.check === 'quietMode' && /still shown/.test(f.label)));
  assert.ok(bad.some((f) => f.check === 'quietMode' && /fetched duo\.png/.test(f.measured)));
  assert.ok(findings.some((f) => f.flow === 'Duo fixture: clean' && f.check === 'quietMode' && f.pass && /nothing shown, nothing fetched/.test(f.measured)));
  fs.rmSync(out, { recursive: true, force: true });
});

test('a strict-CSP page: the engine\'s own styles break no rule, and the page\'s own inline style still fails', { timeout: 120_000 }, () => {
  const out = path.join(scratch, 'csp');
  const r = cli('run', 'test/fixtures/csp/flows/*.flow.json', '--out', out, '--fail-on', 'none');
  assert.equal(r.status, 0, r.stderr);
  const { findings } = read(out);
  const of = (name) => findings.filter((f) => f.flow === `CSP fixture: ${name}`);
  const cleanErrors = of('clean').filter((f) => f.check === 'errors' && !f.pass);
  assert.deepEqual(cleanErrors, [], 'the engine injects nothing a strict CSP blocks');
  // The clean page still exercises the engine's injections: the duo checks hit-test the art and hide the words to sample
  // the pixels behind them, and a crop marks a finding.
  assert.ok(of('clean').some((f) => f.check === 'duoOverlap' && f.pass && /1 text blocks over it read/.test(f.measured)), 'the words over the art were sampled');
  assert.deepEqual(of('clean').filter((f) => f.check === 'duoOverlap' && !f.pass), [], 'with its glyphs hidden, the words read well on the art');
  assert.deepEqual(of('cover').filter((f) => f.check === 'errors' && !f.pass), []);
  assert.ok(of('cover').some((f) => f.check === 'duoOverlap' && !f.pass && /"Words the art covers\." under duo art/.test(f.label)), 'art that takes no pointer is still hit-tested above the words');
  assert.ok(of('clean').some((f) => f.check === 'overflow' && !f.pass && f.evidence), 'a finding was cropped');
  assert.ok(of('bad').some((f) => f.check === 'errors' && !f.pass && /Content Security Policy/.test(f.measured)), JSON.stringify(of('bad').filter((f) => f.check === 'errors')));
  fs.rmSync(out, { recursive: true, force: true });
});
