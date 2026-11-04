// Engines as a matrix dimension: which cells a run has, their keys, what doesn't run where and why, and the keys an
// engine presses. No browser.
import test from 'node:test';
import assert from 'node:assert/strict';
import { ENGINES, GAPS, parseEngines, keyFor, tabKeyOf, launchOptionsFor, browserTypeOf } from '../lib/engines.mjs';
import { cellsOf, unitsOf, cellKey, notRunByEngine, engineOfCell } from '../lib/matrix.mjs';
import { validate } from '../lib/schema.mjs';
import { buildReport, markdown } from '../lib/report.mjs';

const web = (extra = {}) => ({ schema: 'flow-review/0', name: 'w', surface: 'web', app: { url: 'http://127.0.0.1:1/' }, matrix: { viewports: ['390x844'], themes: ['light', 'dark'], reducedMotion: [true], ...extra }, steps: [{ goto: '/' }] });

test('engine lists parse, keep their order and refuse an unknown engine', () => {
  assert.deepEqual(ENGINES, ['chromium', 'webkit', 'msedge']);
  assert.deepEqual(parseEngines(undefined), ['chromium']);
  assert.deepEqual(parseEngines(''), ['chromium']);
  assert.deepEqual(parseEngines('webkit, chromium,webkit'), ['webkit', 'chromium']);
  assert.deepEqual(parseEngines(['msedge']), ['msedge']);
  assert.throws(() => parseEngines('chromium,safari'), /unknown engine safari/);
});

test('each engine is one more matrix dimension; Chromium keeps its keys from before engines', () => {
  const loaded = [{ file: 'flows/w.flow.ts', flow: web() }, { file: 'flows/a.flow.json', flow: { name: 'a', surface: 'agent-cli', steps: [] } }];
  assert.deepEqual(unitsOf(loaded).map((u) => u.key), ['flows/w.flow.ts#390x844-light-rm', 'flows/w.flow.ts#390x844-dark-rm', 'flows/a.flow.json#agent']);
  const keys = unitsOf(loaded, ['chromium', 'webkit', 'msedge']).map((u) => u.key);
  assert.deepEqual(keys, ['flows/w.flow.ts#390x844-light-rm', 'flows/w.flow.ts#390x844-dark-rm', 'flows/w.flow.ts#390x844-light-rm@webkit', 'flows/w.flow.ts#390x844-dark-rm@webkit', 'flows/w.flow.ts#390x844-light-rm@msedge', 'flows/w.flow.ts#390x844-dark-rm@msedge', 'flows/a.flow.json#agent']);
  assert.equal(new Set(keys).size, keys.length, 'every key is its own');
  assert.deepEqual(unitsOf(loaded, ['webkit']).map((u) => u.cell?.engine ?? null), ['webkit', 'webkit', null], 'an agent unit has no engine');
  // A cell from a report before engines ran on Chromium.
  assert.equal(engineOfCell({ viewport: '1x1', theme: 'light', reducedMotion: false }), 'chromium');
  assert.equal(cellKey({ viewport: '1x1', theme: 'light', reducedMotion: false }), '1x1-light');
});

test('a flow\'s matrix.engines and a cdp flow leave engines out, and say so', () => {
  const pinned = web({ engines: ['chromium'] });
  assert.deepEqual(cellsOf(pinned, ['chromium', 'webkit']).map((c) => c.engine), ['chromium', 'chromium']);
  const cdp = { ...web(), name: 'c', surface: 'cdp', app: { cdpUrl: 'http://127.0.0.1:9222' } };
  assert.deepEqual(cellsOf(cdp, ['webkit', 'msedge']).map((c) => c.engine), ['msedge', 'msedge']);
  const notRun = notRunByEngine([{ file: 'p.flow.ts', flow: { ...pinned, name: 'p' } }, { file: 'c.flow.ts', flow: cdp }], ['chromium', 'webkit', 'msedge']);
  assert.deepEqual(Object.keys(notRun).sort(), ['msedge', 'webkit']);
  assert.deepEqual(notRun.webkit.map((n) => n.flow), ['p', 'c']);
  assert.match(notRun.webkit[1].why, /DevTools protocol/);
  assert.match(notRun.msedge[0].why, /matrix\.engines is chromium/);
});

test('flows validate engines and wheel steps', () => {
  assert.deepEqual(validate('flow', web({ engines: ['webkit', 'msedge'] })), []);
  assert.ok(validate('flow', web({ engines: ['safari'] })).length > 0, 'an unknown engine');
  assert.ok(validate('flow', web({ engines: [] })).length > 0, 'no engines');
  const wheel = (scroll) => ({ ...web(), steps: [{ goto: '/' }, { scroll }] });
  assert.deepEqual(validate('flow', wheel({ wheel: 120, times: 5, intervalMs: 30, target: { selector: '[data-list]' } })), []);
  assert.deepEqual(validate('flow', wheel({ wheel: -240 })), []);
  assert.ok(validate('flow', wheel({ wheel: 120, times: 0 })).length > 0, 'at least one notch');
});

test('WebKit presses Option-Tab where Chromium presses Tab; other keys are as given', () => {
  assert.equal(tabKeyOf('chromium'), 'Tab');
  assert.equal(tabKeyOf('msedge'), 'Tab');
  assert.equal(tabKeyOf('webkit'), 'Alt+Tab');
  assert.equal(keyFor('webkit', 'Tab'), 'Alt+Tab');
  assert.equal(keyFor('webkit', 'Shift+Tab'), 'Alt+Shift+Tab');
  assert.equal(keyFor('webkit', 'Alt+Tab'), 'Alt+Tab');
  assert.equal(keyFor('webkit', 'Enter'), 'Enter');
  assert.equal(keyFor('chromium', 'Tab'), 'Tab');
});

test('launch options per engine', () => {
  assert.equal(browserTypeOf('msedge'), 'chromium');
  assert.equal(browserTypeOf('webkit'), 'webkit');
  assert.deepEqual(launchOptionsFor('msedge', { headless: true }, {}), { headless: true, channel: 'msedge' });
  assert.deepEqual(launchOptionsFor('webkit', { headless: true }, { FLOW_REVIEW_CHROMIUM: '/x' }), { headless: true });
  assert.deepEqual(launchOptionsFor('webkit', {}, { FLOW_REVIEW_WEBKIT: '/w' }), { executablePath: '/w' });
  assert.deepEqual(launchOptionsFor('chromium', {}, { FLOW_REVIEW_CHROMIUM: '/c', FLOW_REVIEW_CHANNEL: 'chrome' }), { executablePath: '/c', channel: 'chrome' });
});

test('every WebKit gap names its check, what is missing and what flow-review does instead', () => {
  assert.deepEqual(GAPS.chromium, []);
  assert.deepEqual(GAPS.msedge, []);
  for (const g of GAPS.webkit) for (const k of ['check', 'what', 'instead']) assert.ok(g[k]?.length > 10 || (k === 'check' && g[k]), JSON.stringify(g));
  assert.deepEqual([...new Set(GAPS.webkit.map((g) => g.check))].sort(), ['cdp', 'cls', 'constrained', 'jank', 'keyboard']);
});

test('a report keys results by engine and shows engines side by side', () => {
  const cell = (engine) => ({ viewport: '390x844', theme: 'light', reducedMotion: true, engine });
  const units = [
    { key: 'w#390x844-light-rm', flow: 'w', file: 'w.flow.ts', surface: 'web', cell: cell('chromium'), ms: 1000 },
    { key: 'w#390x844-light-rm@webkit', flow: 'w', file: 'w.flow.ts', surface: 'web', cell: cell('webkit'), ms: 1000 },
  ];
  const findings = [
    { flow: 'w', step: 's', surface: 'web', cell: cell('chromium'), check: 'jank', pass: true, ms: 1, method: 'longtask' },
    { flow: 'w', step: 's', surface: 'web', cell: cell('webkit'), check: 'jank', pass: false, measured: 0.4, threshold: 0.1, ms: 1, method: 'timer, no raster split' },
  ];
  for (const f of findings) assert.deepEqual(validate('finding', f), []);
  const report = buildReport({ units, findings, startedAt: new Date(0).toISOString(), finishedAt: new Date(1000).toISOString(), engines: ['chromium', 'webkit'], notRun: { webkit: [{ flow: 'c', file: 'c.flow.ts', why: 'a cdp flow' }] } });
  report.provenance = { browsers: { chromium: '156.0', webkit: '27.2' } };
  assert.deepEqual(validate('report', report), []);
  assert.equal(report.engines.chromium.failures, 0);
  assert.equal(report.engines.webkit.failures, 1);
  assert.deepEqual(report.engines.webkit.byCheck.jank, { pass: 0, fail: 1 });
  assert.equal(report.engines.webkit.gaps, GAPS.webkit);
  assert.equal(report.engines.webkit.notRun[0].flow, 'c');
  assert.deepEqual(report.table[0].byEngine, { chromium: { units: 1, failures: 0, checks: {} }, webkit: { units: 1, failures: 1, checks: { jank: 1 } } });
  const md = markdown(report, findings);
  assert.match(md, /### By engine/);
  assert.match(md, /\| Flow \| chromium 156\.0 \| webkit 27\.2 \|/);
  assert.match(md, /\| w \| ✅ 1 units \| ❌ jank 1 \|/);
  assert.match(md, /webkit measures differently/);
  assert.match(md, /didn't run on webkit: c \(a cdp flow\)/);
  // A Chromium-only report's summary is as it was.
  assert.doesNotMatch(markdown(buildReport({ units: units.slice(0, 1), findings: findings.slice(0, 1), startedAt: new Date(0).toISOString(), finishedAt: new Date(1).toISOString(), engines: ['chromium'] }), findings.slice(0, 1)), /By engine/);
});
