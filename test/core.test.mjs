// Schema validation, sharding, agent expectations and route matching: no browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { validate } from '../lib/schema.mjs';
import { partition, exactlyOnce, unitsOf, parseShard, DEFAULT_MS } from '../lib/matrix.mjs';
import { expectFindings, runCommand, sendRequest, fieldOk } from '../lib/agent.mjs';
import { routeMatches, resolveUrl } from '../lib/web.mjs';
import { exitCodeFor } from '../lib/report.mjs';

const web = { name: 'web', surface: 'web', app: { url: 'http://127.0.0.1:1/' }, matrix: { viewports: ['390x844', '1440x900'], themes: ['light', 'dark'], reducedMotion: [true] }, steps: [{ goto: '/' }, { act: { role: 'button', name: 'Open', verb: 'click' } }, { capture: { moment: 'open' } }, { tabTraverse: true }], checks: { thresholds: { deadSpace: 0.3 }, designSystem: { marker: '[data-ouro]' } }, rubric: ['craft'] };

test('schema: a valid flow passes; mistakes name their field', () => {
  assert.deepEqual(validate('flow', web), []);
  assert.deepEqual(validate('flow', { name: 'cli', surface: 'agent-cli', steps: [{ run: ['node', '-v'], expect: { exit: 0, jsonShape: { type: 'object' }, stderrRules: { mustNotMatch: ['Error'] }, maxMs: 500 } }] }), []);
  assert.match(validate('flow', { ...web, surface: 'tv' }).join(), /surface/);
  assert.match(validate('flow', { ...web, steps: [{ act: { role: 'button' } }] }).join(), /verb/);
  assert.match(validate('flow', { ...web, matrix: { viewports: ['wide'] } }).join(), /viewports\/0/);
  assert.match(validate('flow', { ...web, checks: { thresholds: { deadSpace: 2 } } }).join(), /deadSpace/);
  assert.match(validate('flow', { ...web, bogus: 1 }).join(), /bogus/);
  assert.ok(validate('flow', { ...web, steps: [{ goto: '/', capture: { moment: 'x' } }] }).length > 0, 'one verb per step');
});

test('schema: rubric answers', () => {
  assert.deepEqual(validate('rubric', { judge: 'ive', verdict: 'not yet', moments: [{ step: 'open', cell: { viewport: '390x844', theme: 'dark', reducedMotion: true }, crop: 'moments/a.webp', observation: 'The title wraps under the badge.', fix: 'Let the badge sit on its own line.' }] }), []);
  assert.ok(validate('rubric', { judge: 'ive', verdict: 'maybe', moments: [] }).length > 0);
  assert.ok(validate('rubric', { judge: 'ive', verdict: 'approve', moments: [{ step: 'x' }] }).length > 0);
});

test('matrix: units are flow x viewport x theme x reduced motion; agent flows are one unit', () => {
  const units = unitsOf([{ file: 'flows/a.flow.ts', flow: web }, { file: 'flows/b.flow.json', flow: { name: 'b', surface: 'agent-cli', steps: [{ run: ['x'] }] } }]);
  assert.equal(units.length, 5);
  assert.deepEqual(units.map((u) => u.key), ['flows/a.flow.ts#390x844-light-rm', 'flows/a.flow.ts#390x844-dark-rm', 'flows/a.flow.ts#1440x900-light-rm', 'flows/a.flow.ts#1440x900-dark-rm', 'flows/b.flow.json#agent']);
  assert.equal(units[4].cell, null);
});

test('sharding: every unit in exactly one shard, balanced by recorded time, by count with none recorded', () => {
  const keys = Array.from({ length: 27 }, (_, i) => `f#${i}`);
  for (const total of [1, 2, 3, 4, 6, 8, 27, 30]) {
    const parts = partition(keys, {}, total);
    const g = exactlyOnce(keys, parts.map((p) => p.keys));
    assert.deepEqual(g, { missing: [], duplicated: [], unexpected: [] }, `${total} shards`);
    const sizes = parts.map((p) => p.keys.length);
    assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `even counts with no times (${sizes})`);
    assert.equal(parts.reduce((s, p) => s + p.ms, 0), keys.length * DEFAULT_MS);
  }
  const times = Object.fromEntries(keys.map((k, i) => [k, i < 3 ? 60_000 : 5_000]));
  const parts = partition(keys, times, 4);
  const spread = Math.max(...parts.map((p) => p.ms)) - Math.min(...parts.map((p) => p.ms));
  assert.ok(spread <= 5_000, `balanced by time (spread ${spread})`);
  assert.deepEqual(partition(keys, times, 4), parts, 'deterministic');
  // A recorded time for a unit that is gone is ignored; a new unit counts as the median.
  const p2 = partition([...keys, 'f#new'], { ...times, 'f#gone': 1e9 }, 4);
  assert.deepEqual(exactlyOnce([...keys, 'f#new'], p2.map((p) => p.keys)).missing, []);
  assert.deepEqual(exactlyOnce(['a', 'b', 'c'], [['a', 'b'], ['b', 'z']]), { missing: ['c'], duplicated: ['b'], unexpected: ['z'] });
  assert.deepEqual(parseShard('2/5'), { index: 2, total: 5 });
  assert.throws(() => parseShard('6/5'));
  assert.throws(() => parseShard('x'));
});

test('agent-cli: exit, jsonShape, fields, stderr and stdout rules, maxMs', async () => {
  const ok = await runCommand([process.execPath, '-e', 'console.log(JSON.stringify({ today: { items: [1, 2] }, user: "Ada" })); console.error("note: mock data")']);
  const expect = { exit: 0, jsonShape: { type: 'object', required: ['today'], properties: { today: { type: 'object', required: ['items'], properties: { items: { type: 'array', minItems: 1 } } } } }, fields: { user: 'Ada', 'today.items.0': 1, 'today.items': { type: 'array' }, 'user ': { exists: false } }, stderrRules: { mustMatch: ['^note:'], mustNotMatch: ['Error|at \\w+ \\('] }, stdoutRules: { mustNotMatch: ['undefined'] }, maxMs: 30_000 };
  const good = expectFindings(ok, expect);
  assert.deepEqual(good.filter((f) => !f.pass), []);
  assert.deepEqual([...new Set(good.map((f) => f.check))].sort(), ['exit', 'fields', 'jsonShape', 'maxMs', 'stderrRules', 'stdoutRules']);
  const bad = await runCommand([process.execPath, '-e', 'console.log("not json"); console.error("TypeError: boom\\n    at main (x.js:1:1)"); process.exit(3)']);
  const f = expectFindings(bad, { ...expect, maxMs: 0 });
  const failed = new Set(f.filter((x) => !x.pass).map((x) => x.check));
  for (const c of ['exit', 'jsonShape', 'fields', 'stderrRules', 'maxMs']) assert.ok(failed.has(c), `${c} fails`);
  assert.match(f.find((x) => x.check === 'exit').fix, /exited 3/);
  const missing = await runCommand(['definitely-not-a-command-xyz']);
  assert.equal(expectFindings(missing, {}).find((x) => x.check === 'exit').pass, false);
  assert.ok(fieldOk(5, { gte: 1, lte: 9 }) && !fieldOk('a', { matches: '^b' }) && fieldOk({ a: 1 }, { a: 1 }));
});

test('agent-http: status, shape and fields', async () => {
  const server = http.createServer((req, res) => {
    if (req.url === '/today') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ items: [{ id: 1 }] })); }
    else { res.statusCode = 404; res.end('no'); }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}/`;
  const good = expectFindings(await sendRequest(base, { path: '/today' }), { status: 200, jsonShape: { type: 'object', required: ['items'] }, fields: { 'items.0.id': 1 } }, 'http');
  assert.deepEqual(good.filter((f) => !f.pass), []);
  const bad = expectFindings(await sendRequest(base, { path: '/nope' }), { jsonShape: { type: 'object' } }, 'http');
  assert.deepEqual(bad.filter((f) => !f.pass).map((f) => f.check).sort(), ['jsonShape', 'status']);
  server.close();
});

test('routes and URLs', () => {
  assert.ok(routeMatches('**/plan.json', 'http://127.0.0.1:5/plan.json?t=1'));
  assert.ok(routeMatches('**/plan.json', 'http://127.0.0.1:5/a/b/plan.json'));
  assert.ok(!routeMatches('**/plan.json', 'http://127.0.0.1:5/plan.json.map'));
  assert.ok(routeMatches('/api/*', 'http://h/api/status'));
  assert.ok(!routeMatches('/api/*', 'http://h/api/a/b'));
  assert.equal(resolveUrl('http://h:1/base/', '/?fixture=empty'), 'http://h:1/base/?fixture=empty');
  assert.equal(resolveUrl('http://h:1/', '/x'), 'http://h:1/x');
  assert.equal(resolveUrl('http://h:1/app', 'x'), 'http://h:1/app/x');
});

test('--fail-on', () => {
  const f = [{ check: 'axe', pass: false }, { check: 'cls', pass: true }];
  assert.equal(exitCodeFor(f, 'any'), 1);
  assert.equal(exitCodeFor(f, 'none'), 0);
  assert.equal(exitCodeFor(f, 'cls,jank'), 0);
  assert.equal(exitCodeFor(f, 'axe'), 1);
  assert.equal(exitCodeFor([{ check: 'step', pass: false }], 'axe'), 1, 'a step that could not run fails any list');
  assert.equal(exitCodeFor([{ check: 'axe', pass: false, known: '#1' }], 'any'), 0, 'known defects never count');
  assert.equal(exitCodeFor([{ check: 'timeout', pass: false }], 'axe'), 1, 'a cell stopped at its time limit fails any list');
  assert.equal(exitCodeFor([{ check: 'timeout', pass: false }], 'none'), 0);
  assert.equal(exitCodeFor([{ check: 'coverage', pass: false }], 'any'), 0, 'coverage findings never count: merge decides');
  const byFlow = new Map([['site', 'axe'], ['app', 'none']]);
  assert.equal(exitCodeFor([{ flow: 'app', check: 'axe', pass: false }], 'any', byFlow), 0, "a flow's own failOn wins");
  assert.equal(exitCodeFor([{ flow: 'site', check: 'cls', pass: false }], 'any', byFlow), 0);
  assert.equal(exitCodeFor([{ flow: 'site', check: 'axe', pass: false }], 'none', byFlow), 1);
  assert.equal(exitCodeFor([{ flow: 'other', check: 'cls', pass: false }], 'any', byFlow), 1, 'other flows follow --fail-on');
});

test('timeouts and failOn: the flow\'s own, over its surface\'s in the config, over the config\'s, over the defaults', async () => {
  const { policyOf, DEFAULT_TIMEOUTS } = await import('../lib/load.mjs');
  assert.deepEqual(DEFAULT_TIMEOUTS, { cellMs: 120_000, stepMs: 60_000 });
  assert.deepEqual(policyOf(web, null), { timeouts: DEFAULT_TIMEOUTS, failOn: undefined });
  const config = { schema: 'flow-review-config/0', timeouts: { cellMs: 1000, stepMs: 500 }, failOn: 'any', surfaces: { web: { timeouts: { cellMs: 2000 }, failOn: 'none' } } };
  assert.deepEqual(validate('config', config), []);
  assert.deepEqual(policyOf(web, config), { timeouts: { cellMs: 2000, stepMs: 500 }, failOn: 'none' });
  assert.deepEqual(policyOf({ ...web, timeouts: { stepMs: 50 }, failOn: 'axe,overflow' }, config), { timeouts: { cellMs: 2000, stepMs: 50 }, failOn: 'axe,overflow' });
  assert.deepEqual(policyOf({ ...web, surface: 'cdp' }, config).failOn, 'any');
  assert.deepEqual(validate('flow', { ...web, timeouts: { cellMs: 1000, stepMs: 100 }, failOn: 'axe,overflow' }), []);
  assert.match(validate('flow', { ...web, timeouts: { cellMs: 0 } }).join(), /cellMs/);
  assert.match(validate('flow', { ...web, timeouts: { hours: 1 } }).join(), /hours/);
  assert.throws(() => policyOf({ ...web, failOn: 'axe,contrst' }, null), /unknown check contrst/);
});

test('a failing harness call during a step is a step failure, not a crash', async () => {
  const { runAgentFlow } = await import('../lib/agent.mjs');
  const flow = { name: 'h', surface: 'agent-cli', app: { controlUrl: 'http://127.0.0.1:9/' }, steps: [{ id: 'wait', run: [process.execPath, '-e', 'setTimeout(() => {}, 400)'], during: { afterMs: 10, harness: { path: '/inject' } } }] };
  const out = await runAgentFlow(flow, process.cwd());
  assert.equal(out.length, 1);
  assert.equal(out[0].check, 'step');
  assert.equal(out[0].pass, false);
});

test('agent paths and the path style of expectations', async () => {
  const { at } = await import('../lib/agent.mjs');
  const doc = { a: { b: [{ id: 1, subject: 'Weekly sync' }, { id: 2, subject: 'Lunch' }] } };
  assert.deepEqual(at(doc, 'a.b[0].id').values, [1]);
  assert.deepEqual(at(doc, 'a.b[-1].id').values, [2]);
  assert.deepEqual(at(doc, 'a.b[].id'), { values: [1, 2], fan: true });
  assert.deepEqual(at(doc, 'a.b[subject~^weekly].id').values, [1]);
  assert.deepEqual(at(doc, 'a.b.length').values, [2]);
  assert.deepEqual(at(doc, 'a.c[].id').values, []);
  const res = { code: 2, stdout: JSON.stringify(doc), stderr: 'no such meeting. Fix: tool today\n', ms: 5 };
  const f = expectFindings(res, { exit: [1, 2], jsonShape: ['a.b[].id', 'a.missing'], fields: { 'a.b[].subject': { re: '^Lunch' }, 'a.b[0].id': { oneOf: [1, 3] } }, stderrRules: ['oneLine', 'namesFix', 'noStack', 'empty'], text: { has: ['Fix:'], not: ['Error'] }, maxBytes: 10 }, { cliNames: ['tool'] });
  const failed = f.filter((x) => !x.pass).map((x) => `${x.check} ${x.selector ?? ''}`.trim());
  assert.deepEqual(failed.sort(), ['jsonShape a.missing', 'maxBytes', 'stderrRules empty']);
  const stack = expectFindings({ code: 1, stdout: '', stderr: 'boom\n    at main (/x/cli.mjs:3:9)\n', ms: 1 }, { stderrRules: ['noStack', 'namesFix'] }, { cliNames: ['tool'] });
  assert.deepEqual(stack.filter((x) => !x.pass && x.check === 'stderrRules').map((x) => x.selector).sort(), ['namesFix', 'noStack']);
});

test('an HTTP step takes exit as its status, one or several', () => {
  assert.equal(expectFindings({ status: 422, stdout: '{}', stderr: '', ms: 1 }, { exit: [400, 422] }, 'http')[0].pass, true);
  assert.equal(expectFindings({ status: 200, stdout: '{}', stderr: '', ms: 1 }, { exit: 422 }, 'http')[0].pass, false);
});

test('a config gives a flow without an app its surface app; placeholders fill values and keys', async () => {
  const { prepare } = await import('../lib/load.mjs');
  const config = { surfaces: { 'agent-cli': { app: { start: 'mock ${workdir}/home', cli: ['node', '${target}'], env: { AGENT: '${flow.agent:-flow-review}', URL: '${start.agent}' }, files: { '${workdir}/a.png': { text: 'x' } }, target: 'bin/cli.mjs' }, vars: { home: '${workdir}/home' } } } };
  const { flow, target } = prepare({ name: 'f', surface: 'agent-cli', agent: 'helper', steps: [{ run: ['look', '{home}'] }] }, { workdir: '/w', config });
  assert.equal(target, 'bin/cli.mjs');
  assert.deepEqual(flow.app.cli, ['node', 'bin/cli.mjs']);
  assert.equal(flow.app.start, 'mock /w/home');
  assert.deepEqual(flow.app.env, { AGENT: 'helper', URL: '${start.agent}' });
  assert.deepEqual(Object.keys(flow.app.files), ['/w/a.png']);
  assert.deepEqual(flow.vars, { home: '/w/home' });
  const own = prepare({ name: 'g', surface: 'agent-cli', app: { start: 'mine' }, steps: [{ run: ['x'] }] }, { config });
  assert.equal(own.flow.app.start, 'mine', "a flow's own app wins whole");
  const { withStart } = await import('../lib/app.mjs');
  assert.deepEqual(withStart(flow.app.env, { agent: 'http://127.0.0.1:9' }), { AGENT: 'helper', URL: 'http://127.0.0.1:9' });
});

test('a flow-scoped app stops after its flow, even when its env names ${start.*}', async () => {
  const { startApp, stopFlowApp, stopApps, withStart } = await import('../lib/app.mjs');
  const app = { start: `${JSON.stringify(process.execPath)} test/fixtures/ax/mock.mjs`, ready: 'stdout-json', scope: 'flow', env: { URL: '${start.agent}' } };
  const vars = await startApp(app, process.cwd(), 'u1');
  assert.match(vars.agent, /^http:\/\/127\.0\.0\.1:\d+$/);
  assert.equal(withStart(app.env, vars).URL, vars.agent);
  await stopFlowApp(app, process.cwd(), 'u1');
  await assert.rejects(fetch(`${vars.agent}/log`), 'the mock is down');
  await stopApps();
});
