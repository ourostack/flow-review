// A hung cell or step can't hold a shard, and merge gates coverage only for flows that fail on something: a cell of an
// advisory flow that is missing, ran twice or timed out is a coverage finding, and a cancelled shard's folder (no
// report) leaves its cells missing.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { validate } from '../lib/schema.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = path.join(root, '.scratch', 'timeouts');
const HANG = 'test/fixtures/hang/flows/*.flow.json';
const COVERAGE = 'test/fixtures/coverage/*.flow.json';
const cli = (...args) => spawnSync(process.execPath, ['bin/flow-review.mjs', ...args], { cwd: root, encoding: 'utf8', env: { ...process.env, FLOW_REVIEW_WORKERS: '1' } });
const read = (dir) => ({ report: JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8')), findings: fs.readFileSync(path.join(dir, 'findings.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)), summary: fs.readFileSync(path.join(dir, 'summary.md'), 'utf8') });

test('a hung cell becomes a timeout finding and the shard finishes; a hung step fails that step', { timeout: 120_000 }, async (t) => {
  fs.rmSync(scratch, { recursive: true, force: true });
  const out = path.join(scratch, 'hang');
  const t0 = performance.now();
  const r = cli('run', HANG, '--out', out, '--fail-on', 'none');
  const wall = performance.now() - t0;
  assert.equal(r.status, 0, r.stderr);
  // The hung waitFor asks for 600 s; the cell's limit is 3 s.
  assert.ok(wall < 60_000, `the run finished in ${Math.round(wall)} ms`);
  const { report, findings, summary } = read(out);
  assert.deepEqual(validate('report', report), []);
  for (const f of findings) assert.deepEqual(validate('finding', f), [], JSON.stringify(f));
  assert.equal(report.summary.units, 4, 'every unit is in the report');
  const unit = (name) => report.units.find((u) => u.key.includes(`/${name}.flow.json`));
  const of = (flow) => findings.filter((f) => f.flow === `Hang fixture: ${flow}`);

  await t.test('web: stopped at its cellMs, at the step it was on, with that step\'s target', () => {
    assert.equal(unit('hang').timedOut, true);
    assert.match(unit('hang').error, /^timed out after 3\.\d s at step wait$/);
    assert.ok(unit('hang').ms >= 3000 && unit('hang').ms < 10_000, `${unit('hang').ms} ms`);
    const timeouts = of('waits forever').filter((f) => f.check === 'timeout');
    assert.equal(timeouts.length, 1);
    const [f] = timeouts;
    assert.equal(f.pass, false);
    assert.equal(f.step, 'wait');
    assert.equal(f.selector, 'text="Never shown"');
    assert.match(f.measured, /^stopped after 3\.\d s, at step "wait"/);
    assert.equal(f.threshold, '3000 ms per cell (timeouts.cellMs)');
    assert.ok(f.ms >= 3000);
    assert.deepEqual(of('waits forever').filter((x) => !x.pass && x.check !== 'timeout'), [], 'closing its page under it adds no other failure');
  });

  await t.test('agent: its running command is killed, and the steps before it are kept', () => {
    assert.equal(unit('agent-hang').timedOut, true);
    const f = of('a command that never exits').find((x) => x.check === 'timeout');
    assert.equal(f.step, 'forever');
    assert.match(f.measured, /at step "forever" \(node -e setInterval/);
    assert.ok(of('a command that never exits').some((x) => x.step === 'first' && x.check === 'exit' && x.pass));
  });

  await t.test('the run goes on: the next cells run and pass', () => {
    assert.equal(unit('quick').timedOut, undefined);
    assert.deepEqual(of('quick').filter((x) => !x.pass), []);
    assert.ok(of('quick').some((x) => x.check === 'overflow' && x.pass));
    assert.ok(report.captures.some((c) => c.flow === 'Hang fixture: quick'));
  });

  await t.test('a step past timeouts.stepMs fails, naming its target, with a picture', () => {
    assert.equal(unit('stuck-step').timedOut, undefined, 'the step failed, not the cell');
    const f = of("a step that can't finish").find((x) => x.check === 'step' && !x.pass);
    assert.equal(f.step, 'press');
    assert.equal(f.measured, 'act took over 1500 ms (timeouts.stepMs): role=button name="Never enabled"');
    assert.equal(f.selector, 'role=button name="Never enabled"');
    assert.ok(f.evidence && fs.existsSync(path.join(out, f.evidence)));
  });

  await t.test('the summary notes the stopped cells; a timeout fails a run that fails on any check', () => {
    assert.match(summary, /❌ \*\*2 units\*\* ran past their time limit and were stopped \(failing `timeout` findings\)/);
    assert.match(summary, /Hang fixture: waits forever · 800x600 light reduced-motion: stopped after 3\.\d s, at step "wait"/);
  });

  await t.test('merge: advisory timed-out cells are coverage findings, and the merge passes', () => {
    const m = cli('merge', out, '--out', path.join(scratch, 'hang-merged'), '--flows', HANG, '--fail-on', 'none');
    assert.equal(m.status, 0, m.stderr);
    const merged = read(path.join(scratch, 'hang-merged'));
    assert.deepEqual(merged.report.coverage.timedOut, [unit('agent-hang').key, unit('hang').key]);
    assert.deepEqual(merged.report.coverage.advisory, merged.report.coverage.timedOut);
    assert.deepEqual(merged.report.coverage.failing, []);
    const cov = merged.findings.filter((f) => f.check === 'coverage');
    assert.equal(cov.length, 2);
    assert.match(cov.find((f) => f.unit === unit('hang').key).measured, /^timed out after 3\.\d s at step wait$/);
    assert.match(merged.summary, /❌ \*\*2 advisory units\*\* didn't run exactly once to the end: failing `coverage` findings/);
    // Gated, a timed-out cell fails the merge through its timeout finding.
    const gated = cli('merge', out, '--out', path.join(scratch, 'hang-gated'), '--flows', HANG, '--fail-on', 'overflow');
    assert.equal(gated.status, 1, gated.stderr);
    assert.deepEqual(read(path.join(scratch, 'hang-gated')).report.coverage.advisory, []);
  });
  fs.rmSync(scratch, { recursive: true, force: true });
});

test('merge gates coverage per flow: missing advisory cells are findings, missing gated cells fail, a missing report is missing cells', async (t) => {
  fs.rmSync(path.join(scratch, 'cov'), { recursive: true, force: true });
  const dir = (n) => path.join(scratch, 'cov', n);
  // The config makes agent-cli flows advisory (failOn none); the gated flow fails on exit.
  assert.equal(cli('run', COVERAGE, '--out', dir('s1'), '--shard', '1/2').status, 0);
  assert.equal(cli('run', COVERAGE, '--out', dir('s2'), '--shard', '2/2').status, 0);
  const keyOf = (d) => read(d).report.units.map((u) => u.key);
  const [advisory] = keyOf(dir('s1'));
  const [gated] = keyOf(dir('s2'));
  assert.match(advisory, /advisory\.flow\.json#agent$/);
  assert.match(gated, /gated\.flow\.json#agent$/);
  assert.deepEqual(read(dir('s1')).report.flowFailOn, { 'Coverage fixture: advisory': 'none', 'Coverage fixture: gated': 'exit' });
  const merge = (name, ...args) => {
    const r = cli('merge', ...args, '--out', dir(name), '--flows', COVERAGE);
    return { ...r, ...read(dir(name)) };
  };

  await t.test('both shards: every cell once, no coverage findings', () => {
    const m = merge('all', dir('s1'), dir('s2'));
    assert.equal(m.status, 0, m.stderr);
    assert.deepEqual(m.report.coverage.failing, []);
    assert.deepEqual(m.report.coverage.advisory, []);
    assert.ok(!m.findings.some((f) => f.check === 'coverage'));
  });

  await t.test('a missing advisory cell: a coverage finding, listed in the summary, and the merge passes', () => {
    const m = merge('no-advisory', dir('s2'));
    assert.equal(m.status, 0, m.stderr);
    assert.deepEqual(m.report.coverage.missing, [advisory]);
    assert.deepEqual(m.report.coverage.advisory, [advisory]);
    assert.deepEqual(m.report.coverage.failing, []);
    const [f] = m.findings.filter((x) => x.check === 'coverage');
    assert.deepEqual([f.flow, f.unit, f.pass, f.gated, f.measured, f.cell, f.surface], ['Coverage fixture: advisory', advisory, false, false, 'did not run: no shard report has it', null, 'agent-cli']);
    assert.deepEqual(validate('finding', f), []);
    assert.match(m.summary, /❌ \*\*1 advisory unit\*\* didn't run exactly once to the end: failing `coverage` findings, red in the table below, which don't fail the merge/);
    assert.ok(m.summary.includes('| Coverage fixture: advisory | agent | 0 | 0.0 | ❌ coverage 1 |'), 'a red row, not a blank, though none of its units ran');
    assert.equal(m.report.summary.failures, 1);
    assert.ok(m.summary.includes(`- \`${advisory}\`: did not run: no shard report has it`));
    assert.match(m.stderr, /advisory \(a coverage finding\): .*advisory\.flow\.json#agent/);
  });

  await t.test('a missing gated cell fails the merge', () => {
    const m = merge('no-gated', dir('s1'));
    assert.equal(m.status, 3, m.stderr);
    assert.deepEqual(m.report.coverage.failing, [gated]);
    assert.equal(m.report.exitCode, 3);
    assert.match(m.summary, /❌ Shards did not cover every gated unit exactly once: 1 unit \(missing 1, duplicated 0, unexpected 0\)/);
    assert.match(m.stderr, /fails the merge: .*gated\.flow\.json#agent/);
    const f = m.findings.find((x) => x.check === 'coverage');
    assert.deepEqual([f.flow, f.unit, f.pass, f.gated], ['Coverage fixture: gated', gated, false, true], 'a gated missing cell is a failing finding too');
    assert.ok(m.summary.includes(`- \`${gated}\`: did not run: no shard report has it`));
    assert.ok(m.summary.includes('| Coverage fixture: gated | agent | 0 | 0.0 | ❌ coverage 1 |'));
  });

  await t.test('a shard that wrote no report (cancelled) is its cells missing, not a crash', () => {
    const cancelled = dir('cancelled');
    fs.mkdirSync(cancelled, { recursive: true });
    fs.copyFileSync(path.join(dir('s1'), 'findings.jsonl'), path.join(cancelled, 'findings.jsonl'));
    const m = merge('cancelled-advisory', cancelled, dir('s2'), dir('never-uploaded'));
    assert.equal(m.status, 0, m.stderr);
    assert.deepEqual(m.report.coverage.missingReports, [cancelled, dir('never-uploaded')]);
    assert.deepEqual(m.report.coverage.advisory, [advisory]);
    assert.match(m.stderr, /holds no readable report\.json/);
    assert.match(m.summary, /Shard folders without a report/);
    const gatedGone = merge('cancelled-gated', dir('s1'), cancelled);
    assert.equal(gatedGone.status, 3, 'the gated cell is missing');
    const cancelledCell = gatedGone.findings.find((x) => x.check === 'coverage');
    assert.deepEqual([cancelledCell.unit, cancelledCell.pass, cancelledCell.gated, cancelledCell.measured], [gated, false, true, 'did not run: its shard was cancelled or failed and wrote no report']);
    // Every shard cancelled: still a report, with every cell missing.
    const none = merge('none', cancelled);
    assert.equal(none.status, 3);
    assert.deepEqual(none.report.coverage.missing, [advisory, gated]);
    assert.deepEqual(none.findings.filter((x) => x.check === 'coverage' && !x.pass).map((x) => [x.unit, x.gated]), [[advisory, false], [gated, true]], 'every cell of the cancelled shards is a failure, none a blank');
    assert.deepEqual(none.report.table.map((r) => [r.flow, r.units, r.checks.coverage]), [['Coverage fixture: advisory', 0, { pass: 0, fail: 1 }], ['Coverage fixture: gated', 0, { pass: 0, fail: 1 }]]);
    assert.deepEqual(validate('report', none.report), []);
  });

  await t.test('an advisory cell run twice is a finding; --coverage strict fails it, as before', () => {
    const m = merge('dup', dir('s1'), dir('s1'), dir('s2'));
    assert.equal(m.status, 0, m.stderr);
    assert.deepEqual(m.report.coverage.duplicated, [advisory]);
    assert.equal(m.findings.find((f) => f.check === 'coverage').measured, 'ran 2 times');
    const strict = merge('strict', dir('s2'), '--coverage', 'strict');
    assert.equal(strict.status, 3);
    assert.deepEqual(strict.report.coverage.failing, [advisory]);
    assert.equal(strict.findings.find((x) => x.check === 'coverage').gated, true);
    assert.equal(cli('merge', dir('s1'), '--coverage', 'loose').status, 2);
  });

  await t.test('without a flow\'s own failOn, --fail-on decides: none makes every missing cell advisory', () => {
    const flows = 'test/fixtures/flows/agent.flow.json';
    const a = dir('plain');
    cli('run', flows, '--out', a, '--fail-on', 'none');
    const m = cli('merge', dir('cancelled'), '--out', dir('plain-none'), '--flows', flows, '--fail-on', 'none');
    assert.equal(m.status, 0, m.stderr);
    assert.equal(cli('merge', dir('cancelled'), '--out', dir('plain-any'), '--flows', flows, '--fail-on', 'any').status, 3);
    assert.equal(cli('merge', dir('cancelled'), '--out', dir('plain-axe'), '--flows', flows, '--fail-on', 'axe').status, 3);
  });
  fs.rmSync(path.join(scratch, 'cov'), { recursive: true, force: true });
});
