// A run keeps failing findings' crops, then the key moments its judge packets name, up to the evidence cap; it deletes
// the rest and records what the cap dropped in report.json's evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { keepEvidence, parseBytes, DEFAULT_EVIDENCE_MAX } from '../lib/budget.mjs';
import { validate } from '../lib/schema.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scratch = path.join(root, '.scratch', 'evidence-cap');

test('sizes read as bytes, KB, MB or none', () => {
  assert.equal(DEFAULT_EVIDENCE_MAX, 1024 * 1024);
  assert.equal(parseBytes('2048'), 2048);
  assert.equal(parseBytes('512KB'), 512 * 1024);
  assert.equal(parseBytes('1.5 mb'), 1.5 * 1024 * 1024);
  assert.equal(parseBytes('none'), Infinity);
  for (const bad of ['', 'lots', '-1', '5GB']) assert.throws(() => parseBytes(bad), /is not a size/, bad);
});

test('keepEvidence keeps failing crops first, then judged moments, under the cap, and deletes the rest', () => {
  const dir = path.join(scratch, 'unit');
  fs.rmSync(dir, { recursive: true, force: true });
  const file = (rel, n) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), Buffer.alloc(n)); };
  file('evidence/a.png', 400); file('evidence/b.png', 400); file('evidence/c.png', 400); file('evidence/pass.png', 100);
  file('moments/judged.webp', 300); file('moments/judged2.webp', 300); file('moments/unjudged.webp', 300);
  const findings = [
    { check: 'x', pass: false, evidence: 'evidence/a.png' },
    { check: 'x', pass: false, evidence: 'evidence/a.png' },
    { check: 'x', pass: true, evidence: 'evidence/pass.png' },
    { check: 'x', pass: false, evidence: 'evidence/b.png' },
    { check: 'x', pass: false, evidence: 'evidence/c.png' },
  ];
  const captures = [{ flow: 'f', step: 's1', crop: 'moments/judged.webp' }, { flow: 'f', step: 's2', crop: 'moments/judged2.webp' }, { flow: 'f', step: 's3', crop: 'moments/unjudged.webp' }];
  const r = keepEvidence({ outDir: dir, findings, captures, judged: new Set(['moments/judged.webp', 'moments/judged2.webp']), maxBytes: 1100 });
  assert.equal(r.findingsChanged, true);
  assert.deepEqual(findings.map((f) => f.evidence), ['evidence/a.png', 'evidence/a.png', undefined, 'evidence/b.png', undefined]);
  assert.deepEqual(captures.map((c) => c.crop), ['moments/judged.webp', undefined, undefined], 'one judged moment fits; the unjudged one keeps none anyway');
  assert.deepEqual(r.evidence, { maxBytes: 1100, bytes: 1100, files: 3, dropped: { evidence: 1, moments: 1, bytes: 700 }, unjudgedMoments: 1 });
  assert.deepEqual(fs.readdirSync(path.join(dir, 'evidence')).sort(), ['a.png', 'b.png']);
  assert.deepEqual(fs.readdirSync(path.join(dir, 'moments')), ['judged.webp']);
  fs.rmSync(path.join(dir, 'moments'), { recursive: true, force: true });

  const roomy = { findings: [{ check: 'x', pass: false, evidence: 'evidence/a.png' }], captures: [{ flow: 'f', step: 's', crop: 'moments/m.webp' }, { flow: 'f', step: 't', crop: 'moments/n.webp' }] };
  file('moments/m.webp', 10); file('moments/n.webp', 10);
  const r2 = keepEvidence({ outDir: dir, ...roomy, judged: new Set(['moments/m.webp']), maxBytes: Infinity });
  assert.equal(r2.evidence.maxBytes, null);
  assert.deepEqual(roomy.captures.map((c) => c.crop), ['moments/m.webp', undefined]);
  assert.deepEqual(r2.evidence.dropped, { evidence: 0, moments: 0, bytes: 0 });
  fs.rmSync(dir, { recursive: true, force: true });
});

test('a run under a small cap keeps what fits, records the rest, and still gives judges only pictures it has', { timeout: 180_000 }, () => {
  const out = path.join(scratch, 'run');
  fs.rmSync(out, { recursive: true, force: true });
  const r = spawnSync(process.execPath, ['bin/flow-review.mjs', 'run', 'test/fixtures/flows/web.flow.ts', '--out', out, '--fail-on', 'none', '--cells', '390x844-light', '--evidence-max', '20KB'], { cwd: root, encoding: 'utf8', env: { ...process.env, FLOW_REVIEW_WORKERS: '1' } });
  assert.equal(r.status, 0, r.stderr);
  const report = JSON.parse(fs.readFileSync(path.join(out, 'report.json'), 'utf8'));
  assert.deepEqual(validate('report', report), []);
  const findings = fs.readFileSync(path.join(out, 'findings.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const ev = report.evidence;
  assert.equal(ev.maxBytes, 20 * 1024);
  assert.ok(ev.bytes <= 20 * 1024, `${ev.bytes} bytes kept`);
  assert.ok(ev.dropped.evidence + ev.dropped.moments > 0, 'the cap dropped something');
  const onDisk = ['evidence', 'moments'].flatMap((d) => fs.existsSync(path.join(out, d)) ? fs.readdirSync(path.join(out, d)).map((n) => fs.statSync(path.join(out, d, n)).size) : []);
  assert.equal(onDisk.reduce((a, b) => a + b, 0), ev.bytes);
  for (const f of findings.filter((x) => x.evidence)) assert.ok(fs.existsSync(path.join(out, f.evidence)), f.evidence);
  const packet = JSON.parse(fs.readFileSync(path.join(out, 'judge-packet-craft.json'), 'utf8'));
  for (const m of packet.moments) assert.ok(m.crop && fs.existsSync(path.join(out, m.crop)), `packet moment ${m.step}`);
  assert.match(fs.readFileSync(path.join(out, 'summary.md'), 'utf8'), /The evidence cap \(20 KB per run\) dropped/);
  assert.match(r.stderr, /the evidence cap \(20480 bytes\) dropped/);
  fs.rmSync(out, { recursive: true, force: true });
});

test('a cap that is not a size is refused before anything runs', () => {
  const r = spawnSync(process.execPath, ['bin/flow-review.mjs', 'run', 'test/fixtures/flows/web.flow.ts', '--out', path.join(scratch, 'bad'), '--evidence-max', 'lots'], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /evidence cap lots is not a size/);
  assert.equal(fs.existsSync(path.join(scratch, 'bad')), false);
});
