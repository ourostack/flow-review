// Capability parity: detectors over records, data and hook floors, the read-only guard, a report with counts and hashes
// only, issue intents with stable keys, and baselines.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { meets, detect, pickSamples, hashKey, runParity, parityIssues, parityTable, parityBaseline, parityCompare, validateParitySpec, launchGuarded, fill, expectHook } from '../lib/parity.mjs';
import { validate } from '../lib/schema.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Made-up records: rooms with a layout field, notes that may quote another, and people who may lack a name.
const rooms = [
  { id: 'room-a', kind: 'room', layout: 'stream' },
  { id: 'room-b', kind: 'room', layout: 'board' },
  { id: 'room-c', kind: 'room', layout: 'stream' },
  { id: 'dm-1', kind: 'direct' },
];
const notes = [
  { id: 'n1', room: 'room-a', body: { blocks: [{ type: 'p' }, { type: 'quote', of: 'n0' }] }, author: { name: 'Avery Example' } },
  { id: 'n2', room: 'room-a', body: { blocks: [{ type: 'p' }] }, author: { name: 'Unknown' } },
  { id: 'n3', room: 'room-c', body: { blocks: [{ type: 'p', inner: [{ type: 'quote', of: 'n1' }] }] }, author: { name: 'Blake Sample' } },
];

const spec = {
  version: 1,
  name: 'fixture-floor',
  surfaces: [
    {
      id: 'rooms', title: 'Rooms', owner: 'team:rooms',
      capabilities: [
        {
          id: 'stream-layout', title: 'Stream rooms read as a stream',
          intent: 'A stream room shows its messages as a conversation, with replies in a side rail.',
          detect: { records: 'rooms', scope: [{ path: 'kind', eq: 'room' }], requires: ['layout'], where: [{ path: 'layout', eq: 'stream' }] },
          open: { with: 'room', args: { room: 'id' } },
          floor: [{ id: 'layout-hook', expect: { selector: '[data-room="${room}"][data-layout="stream"]' } }],
        },
        {
          id: 'pinned-tabs', title: 'Pinned tabs show',
          detect: { records: 'rooms', scope: [{ path: 'kind', eq: 'room' }], requires: ['tabs'], where: [{ path: 'tabs', minItems: 1 }] },
          floor: [{ id: 'tabs', expect: { selector: '[data-tabs]' } }],
        },
        {
          id: 'polls', title: 'Polls',
          detect: { records: 'rooms', where: [{ path: 'poll', exists: true }] },
          floor: [{ id: 'poll', expect: { selector: '[data-poll]' } }],
        },
      ],
    },
    {
      id: 'notes', title: 'Notes', owner: 'team:notes',
      capabilities: [
        {
          id: 'quotes', title: 'A quoted note shows its quote',
          detect: { records: 'notes', where: [{ path: 'body.blocks', deep: [{ path: 'type', eq: 'quote' }] }] },
          open: { with: 'note', args: { room: 'room', note: 'id' } },
          floor: [{ id: 'quote-hook', act: [{ click: '[data-note="${note}"] [data-expand]', optional: true }], expect: { selector: '[data-note="${note}"] [data-quote]' } }],
        },
        {
          id: 'names', title: 'Authors have names',
          detect: { records: 'notes', where: [{ path: 'author', exists: true }] },
          floor: [
            { id: 'named', data: { where: [{ path: 'author.name', notIn: ['Unknown', ''] }], min: 0.99 } },
            { id: 'shown', expect: { selector: '[data-note="${note}"] [data-author]', textNot: ['Unknown'] } },
          ],
          open: { with: 'note', args: { room: 'room', note: 'id' } },
        },
      ],
    },
  ],
};

// The fixture product: room-a renders its stream layout and its quote; room-c renders the board layout (a gap) and
// hides its quote until expanded; note n2's author shows as Unknown.
const page = (room) => {
  const layout = room === 'room-a' ? 'stream' : 'board';
  const body = notes.filter((n) => n.room === room).map((n) => `<article data-note="${n.id}"><span data-author>${n.author.name}</span>${n.id === 'n1' ? '<blockquote data-quote>q</blockquote>' : ''}${n.id === 'n3' ? '<button data-expand onclick="this.insertAdjacentHTML(\'afterend\', \'<blockquote data-quote>q</blockquote>\')">more</button>' : ''}</article>`).join('');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Fixture</title></head><body><main data-room="${room}" data-layout="${layout}">${body}</main>
<script>
  fetch('/api/write', { method: 'POST', body: '{}' }).catch(() => {});
  fetch('http://remote.invalid/track').catch(() => {});
  fetch('/api/read').then(() => document.body.dataset.read = 'ok').catch(() => {});
</script></body></html>`;
};

async function serve() {
  const hits = { post: 0, get: 0 };
  const server = http.createServer((req, res) => {
    if (req.method === 'POST') hits.post++; else hits.get++;
    const u = new URL(req.url, 'http://x');
    if (u.pathname === '/api/read') { res.end('{}'); return; }
    res.setHeader('content-type', 'text/html');
    res.end(page(u.searchParams.get('room') ?? 'room-a'));
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}`, hits, close: () => new Promise((r) => server.close(r)) };
}

test('conditions: paths, equality, membership, patterns, some, deep, anyOf and not', () => {
  const r = { a: { b: 'x' }, list: [{ t: 1 }, { t: 2 }], tree: { k: [{ k: [{ type: 'quote' }] }] }, empty: '', none: [] };
  assert.equal(meets(r, { path: 'a.b', eq: 'x' }), true);
  assert.equal(meets(r, { path: 'a.b', ne: 'x' }), false);
  assert.equal(meets(r, { path: 'a.b', in: ['y', 'x'] }), true);
  assert.equal(meets(r, { path: 'a.b', notIn: ['x'] }), false);
  assert.equal(meets(r, { path: 'a.b', match: '^X$', flags: 'i' }), true);
  assert.equal(meets(r, { path: 'empty', exists: false }), true);
  assert.equal(meets(r, { path: 'none', exists: false }), true);
  assert.equal(meets(r, { path: 'list.1.t', eq: 2 }), true);
  assert.equal(meets(r, { path: 'list.1.t', gte: 2, lte: 2 }), true);
  assert.equal(meets(r, { path: 'list.0.t', gte: 2 }), false);
  assert.equal(meets(r, { path: 'a.b', gte: 0 }), false);
  assert.equal(meets(r, { path: 'list', some: [{ path: 't', eq: 2 }] }), true);
  assert.equal(meets(r, { path: 'list', some: [{ path: 't', eq: 3 }] }), false);
  assert.equal(meets(r, { path: 'tree', deep: [{ path: 'type', eq: 'quote' }] }), true);
  assert.equal(meets(r, { path: 'tree', deep: [{ path: 'type', eq: 'card' }] }), false);
  assert.equal(meets(r, { anyOf: [{ path: 'a.b', eq: 'z' }, [{ path: 'list', minItems: 2 }]] }), true);
  assert.equal(meets(r, { not: { path: 'a.b', eq: 'x' } }), false);
});

test('a detector finds its records, and says when the records lack a field it needs', () => {
  const stream = spec.surfaces[0].capabilities[0].detect;
  const d = detect(stream, rooms);
  assert.equal(d.scoped, 3);
  assert.deepEqual(d.found.map((r) => r.id), ['room-a', 'room-c']);
  assert.deepEqual(d.unread, []);
  const tabs = detect(spec.surfaces[0].capabilities[1].detect, rooms);
  assert.deepEqual(tabs.unread, ['tabs']);
  assert.equal(tabs.found.length, 0);
  // Nothing in scope is no evidence that a field goes unread.
  assert.deepEqual(detect(spec.surfaces[0].capabilities[1].detect, []), { scoped: 0, found: [], unread: [] });
});

test('a data-only capability counts the records that meet its floors; samples must be at least one', async () => {
  const dataOnly = { version: 0, name: 'd', surfaces: [{ id: 's', title: 'S', capabilities: [{ id: 'c', title: 'C', detect: { records: 'r' }, floor: [{ id: 'f', data: { where: [{ path: 'ok', eq: true }] } }] }] }] };
  const report = await runParity({ spec: dataOnly, records: () => [{ id: 1, ok: true }, { id: 2, ok: false }] });
  assert.deepEqual([report.results[0].status, report.results[0].detected, report.results[0].passed], ['gap', 2, 1]);
  for (const samples of [0, NaN, 1.5]) await assert.rejects(runParity({ spec: dataOnly, records: () => [], samples }), /samples must be/);
  // Records without their key still sample the same whatever their order.
  const keyless = [{ a: 1 }, { a: 2 }, { a: 3 }];
  assert.deepEqual(pickSamples(keyless, { n: 2 }).map((x) => x.h), pickSamples([...keyless].reverse(), { n: 2 }).map((x) => x.h));
});

test('samples are the same whatever order the records come in, and hashes are salted and never the key', () => {
  const a = pickSamples(rooms, { n: 2, salt: 's' }).map((x) => x.h);
  const b = pickSamples([...rooms].reverse(), { n: 2, salt: 's' }).map((x) => x.h);
  assert.deepEqual(a, b);
  assert.match(a[0], /^h:[0-9a-f]{12}$/);
  assert.notEqual(hashKey('room-a', 's'), hashKey('room-a', 't'));
  assert.ok(!a.some((h) => rooms.some((r) => h.includes(r.id))));
});

test('fill quotes sample values for CSS strings', () => {
  assert.equal(fill('[data-x="${v}"]', { v: 'a"b\\c' }), '[data-x="a\\"b\\\\c"]');
  assert.equal(fill('[data-x="${missing}"]', {}), '[data-x=""]');
});

test('the spec schema accepts the fixture and rejects a floor that mixes data and hooks, or a duplicate id', () => {
  assert.deepEqual(validateParitySpec(spec), []);
  const mixed = structuredClone(spec);
  mixed.surfaces[1].capabilities[1].floor[0].expect = { selector: 'x' };
  assert.ok(validateParitySpec(mixed).length);
  const dup = structuredClone(spec);
  dup.surfaces[0].capabilities.push(structuredClone(dup.surfaces[0].capabilities[0]));
  assert.ok(validateParitySpec(dup).some((e) => /duplicate capability rooms\/stream-layout/.test(e)));
});

test('a run on a guarded page: pass, gap, unread and not present, counts only, and nothing written gets through', async () => {
  const srv = await serve();
  let g;
  try {
    g = await launchGuarded({ url: `${srv.url}/?room=room-a` });
    const open = async (p, opener, args) => {
      assert.ok(opener === 'room' || opener === 'note');
      await p.goto(`${srv.url}/?room=${encodeURIComponent(args.room)}`, { waitUntil: 'load' });
    };
    const report = await runParity({ spec, records: (name) => (name === 'rooms' ? rooms : notes), page: g.page, open, guard: g.guard, waitMs: 1500, salt: 'fixture' });
    assert.deepEqual(validate('parity-report', report), []);
    const by = Object.fromEntries(report.results.map((r) => [`${r.surface}/${r.capability}`, r]));
    // room-c renders the board layout: one of two samples fails the hook.
    assert.equal(by['rooms/stream-layout'].status, 'gap');
    assert.equal(by['rooms/stream-layout'].detected, 2);
    assert.equal(by['rooms/stream-layout'].checked, 2);
    assert.equal(by['rooms/stream-layout'].passed, 1);
    assert.deepEqual(by['rooms/stream-layout'].floors[0].reasons, { missing: 1 });
    assert.equal(by['rooms/pinned-tabs'].status, 'unread');
    assert.deepEqual(by['rooms/pinned-tabs'].unread, ['tabs']);
    assert.equal(by['rooms/polls'].status, 'not-present');
    // The quote behind "more" shows once the floor's act expands it.
    assert.equal(by['notes/quotes'].status, 'pass');
    assert.equal(by['notes/quotes'].passed, 2);
    // Names: the data floor (2 of 3 named) and the hook floor (n2 shows Unknown) both fail.
    assert.equal(by['notes/names'].status, 'gap');
    const named = by['notes/names'].floors.find((f) => f.id === 'named');
    assert.equal(named.pass, 2);
    assert.equal(named.fail, 1);
    assert.deepEqual(by['notes/names'].floors.find((f) => f.id === 'shown').reasons, { text: 1 });
    assert.deepEqual(report.summary, { pass: 1, gap: 2, unread: 1, 'not-present': 1 });
    // The guard: the page's POST and its remote fetch were blocked, its reads of this computer allowed.
    assert.equal(srv.hits.post, 0);
    assert.ok(report.guard.blocked >= 2, JSON.stringify(report.guard));
    assert.ok(report.guard.blockedByMethod.POST >= 1);
    assert.ok(report.guard.blockedRemote >= 1);
    assert.ok(report.guard.allowed >= 2);
    assert.equal(await g.page.evaluate(() => document.body.dataset.read), 'ok');
    // Nothing from the records leaves: no id, name or text in the report.
    const text = JSON.stringify(report);
    for (const v of ['room-a', 'room-c', '"n1"', '"n2"', '"n3"', 'Avery', 'Blake', 'Unknown']) assert.ok(!text.includes(v), v);

    // Issue intents: gaps and unread ones, each with a stable key, its owner and a counts-only body.
    const issues = parityIssues(report, spec);
    assert.deepEqual(issues.map((i) => i.key), ['parity:fixture-floor:rooms/stream-layout', 'parity:fixture-floor:rooms/pinned-tabs', 'parity:fixture-floor:notes/names']);
    assert.deepEqual(issues.map((i) => i.owner), ['team:rooms', 'team:rooms', 'team:notes']);
    assert.match(issues[0].body, /A stream room shows its messages/);
    assert.match(issues[0].body, /parity-key: parity:fixture-floor:rooms\/stream-layout$/);
    assert.match(issues[2].body, /`named`: 2 of 3 records \(needs 99%\)/);
    assert.ok(!issues.some((i) => /Avery|Blake|room-a|Unknown/.test(i.body)));
    assert.match(parityTable(report), /\| rooms \| stream-layout \| gap \| 2 \| 1\/2 \|/);

    // Baselines: a capability that passed and no longer does is a regression.
    const base = parityBaseline(report);
    assert.deepEqual(parityCompare(report, base), { regressions: [], improvements: [] });
    const worse = structuredClone(report);
    worse.results.find((r) => r.capability === 'quotes').status = 'gap';
    assert.deepEqual(parityCompare(worse, base).regressions, [{ id: 'notes/quotes', was: 'pass', now: 'gap' }]);
    const better = parityCompare(report, { ...base, 'notes/quotes': 'gap' });
    assert.deepEqual(better.improvements, [{ id: 'notes/quotes', was: 'gap', now: 'pass' }]);
    assert.deepEqual(parityCompare(report, { ...base, 'notes/gone': 'pass' }).regressions, [{ id: 'notes/gone', was: 'pass', now: 'missing' }]);
    // A run limited with only compares only what it ran.
    assert.deepEqual(parityCompare({ ...report, only: ['notes'] }, { ...base, 'other/x': 'pass' }).regressions, []);
  } finally {
    await g?.close();
    await srv.close();
  }
});

test('hook expectations: counts, attributes, text ruled out, and visible meaning enough of them on screen', async () => {
  let g;
  try {
    g = await launchGuarded({ url: `data:text/html,${encodeURIComponent('<div data-x="a">One</div><div data-x="b" hidden>Two</div><span data-y="z">Unknown</span>')}` });
    assert.equal(await expectHook(g.page, { selector: '[data-x]', min: 2 }), null);
    assert.equal(await expectHook(g.page, { selector: '[data-x]', min: 3 }, {}, 200), 'missing');
    assert.equal(await expectHook(g.page, { selector: '[data-x]', max: 1 }), 'extra');
    assert.equal(await expectHook(g.page, { selector: '[data-x]', visible: true }), null);
    assert.equal(await expectHook(g.page, { selector: '[data-x]', min: 2, visible: true }), 'hidden');
    assert.equal(await expectHook(g.page, { selector: '[data-x]', attr: { 'data-x': 'a' } }), 'attr');
    assert.equal(await expectHook(g.page, { selector: '[data-y]', attr: { 'data-y': true, 'data-w': null } }), null);
    assert.equal(await expectHook(g.page, { selector: '[data-y]', textNot: ['Unknown'] }), 'text');
    assert.equal(await expectHook(g.page, { selector: '[data-none]', min: 0, max: 0 }), null);
  } finally {
    await g?.close();
  }
});

test('a redirect away from this computer is caught, and the run refuses to report', async () => {
  const srv = await serve();
  const bounce = http.createServer((req, res) => { res.writeHead(302, { location: 'http://remote.invalid/' }); res.end(); });
  await new Promise((r) => bounce.listen(0, '127.0.0.1', r));
  let g;
  try {
    g = await launchGuarded({ url: `${srv.url}/?room=room-a` });
    await g.page.goto(`http://127.0.0.1:${bounce.address().port}/`).catch(() => {});
    await g.page.waitForTimeout(300);
    assert.ok(g.guard.escaped >= 1, JSON.stringify(g.guard));
    await assert.rejects(runParity({ spec, records: (n) => (n === 'rooms' ? rooms : notes), page: g.page, open: async () => {}, guard: g.guard, waitMs: 200, only: ['rooms/polls'] }), /couldn't stop/);
  } finally {
    await g?.close();
    await srv.close();
    await new Promise((r) => bounce.close(r));
  }
});

test('the CLI runs a spec through an adapter, writes parity.json, and fails on a regression from its baseline', async () => {
  const srv = await serve();
  const dir = fs.mkdtempSync(path.join(root, 'test', '.parity-'));
  try {
    fs.writeFileSync(path.join(dir, 'spec.json'), JSON.stringify(spec));
    fs.writeFileSync(path.join(dir, 'records.json'), JSON.stringify({ rooms, notes }));
    fs.writeFileSync(path.join(dir, 'adapter.mjs'), `import fs from 'node:fs';
const data = JSON.parse(fs.readFileSync(new URL('./records.json', import.meta.url), 'utf8'));
export async function setup({ launchGuarded }) {
  const g = await launchGuarded({ url: ${JSON.stringify(srv.url)} });
  return { records: (n) => data[n], page: g.page, guard: g.guard, close: g.close,
    open: (p, opener, a) => p.goto(${JSON.stringify(srv.url)} + '/?room=' + a.room) };
}`);
    fs.writeFileSync(path.join(dir, 'baseline.json'), JSON.stringify({ 'rooms/stream-layout': 'pass' }));
    const cli = (...args) => spawnSync(process.execPath, [path.join(root, 'bin/flow-review.mjs'), 'parity', ...args], { encoding: 'utf8', cwd: dir });
    assert.equal(cli('validate', 'spec.json').status, 0);
    const run = await new Promise((resolve) => {
      // Async: the adapter's page talks to this process's server.
      import('node:child_process').then(({ execFile }) => execFile(process.execPath, [path.join(root, 'bin/flow-review.mjs'), 'parity', 'run', 'spec.json', '--adapter', 'adapter.mjs', '--out', 'out', '--baseline', 'baseline.json', '--only', 'rooms/stream-layout,notes'], { cwd: dir, encoding: 'utf8' }, (err, stdout, stderr) => resolve({ code: err?.code ?? 0, stdout, stderr })));
    });
    assert.equal(run.code, 1, run.stderr);
    assert.match(run.stdout, /regression rooms\/stream-layout: pass -> gap/);
    const report = JSON.parse(fs.readFileSync(path.join(dir, 'out/parity.json'), 'utf8'));
    assert.deepEqual(report.results.map((r) => r.capability), ['stream-layout', 'quotes', 'names']);
    const issues = cli('issues', 'out/parity.json', '--spec', 'spec.json');
    assert.equal(issues.status, 0);
    assert.equal(issues.stdout.trim().split('\n').length, 2);
    assert.match(cli('table', 'out/parity.json').stdout, /1 pass, 2 gap, 0 unread, 0 not present/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    await srv.close();
  }
});
