// report.json, findings.jsonl, judge packets, shard merging, recorded times and the markdown summary.
import fs from 'node:fs';
import path from 'node:path';
import { sideOf } from './matrix.mjs';
import { validate } from './schema.mjs';
import { createHash } from 'node:crypto';

export const TOOL = { name: 'flow-review', version: JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version };
const MOMENTS_PER_PACKET = 24;
const FAILURES_PER_PACKET = 40;

/** The exit code for these findings under --fail-on: none, any, or a comma list of checks. Known defects never count. */
export function exitCodeFor(findings, failOn = 'any') {
  if (failOn === 'none') return 0;
  const list = failOn === 'any' ? null : failOn.split(',').map((s) => s.trim()).filter(Boolean);
  // A step that couldn't run measured nothing, so it fails whatever checks are named.
  return findings.some((f) => !f.pass && !f.known && (!list || list.includes(f.check) || f.check === 'step')) ? 1 : 0;
}

// A capped finding ("and 12 more") stands for that many failures.
const count = (into, key, pass, ms = 0, weight = 1) => {
  into[key] ??= { pass: 0, fail: 0, ms: 0 };
  into[key][pass ? 'pass' : 'fail'] += weight;
  into[key].ms += ms;
};
const weight = (f) => (f.pass ? 1 : f.more ?? 1);

/** Builds report.json's object from what a run (or a merge of shard runs) produced. */
export function buildReport({ units, findings, moments = [], captures = [], attachments = [], judges = [], startedAt, finishedAt, shard = null, failOn = 'any', args = {} }) {
  const byCheck = {};
  for (const f of findings) count(byCheck, f.check, f.pass, f.ms ?? 0, weight(f));
  const flows = new Map();
  for (const u of units) {
    const row = flows.get(u.flow) ?? { flow: u.flow, file: u.file, side: sideOf(u.surface), surface: u.surface, units: 0, ms: 0, checks: {} };
    row.units++;
    row.ms += u.ms ?? 0;
    flows.set(u.flow, row);
  }
  for (const f of findings) {
    const row = flows.get(f.flow);
    if (row) count(row.checks, f.check, f.pass, 0, weight(f));
  }
  for (const row of flows.values()) for (const c of Object.values(row.checks)) delete c.ms;
  const failures = findings.filter((f) => !f.pass).reduce((n, f) => n + weight(f), 0);
  const known = findings.filter((f) => !f.pass && f.known).reduce((n, f) => n + weight(f), 0);
  const exitCode = exitCodeFor(findings, failOn);
  return {
    schema: 'flow-review-report/0',
    tool: TOOL,
    startedAt,
    finishedAt,
    ms: Date.parse(finishedAt) - Date.parse(startedAt),
    shard,
    failOn,
    exitCode,
    args,
    summary: {
      flows: flows.size,
      units: units.length,
      findings: findings.reduce((n, f) => n + weight(f), 0),
      failures,
      known,
      human: { units: units.filter((u) => sideOf(u.surface) === 'human').length, failures: findings.filter((f) => !f.pass && sideOf(f.surface) === 'human').reduce((n, f) => n + weight(f), 0) },
      agent: { units: units.filter((u) => sideOf(u.surface) === 'agent').length, failures: findings.filter((f) => !f.pass && sideOf(f.surface) === 'agent').reduce((n, f) => n + weight(f), 0) },
      byCheck,
    },
    table: [...flows.values()].sort((a, b) => (a.side + a.flow < b.side + b.flow ? -1 : 1)),
    units: units.map(({ key, flow, file, surface, cell, ms, failures: uf, error }) => ({ key, flow, file, surface, cell, ms: ms ?? 0, failures: uf ?? 0, ...(error ? { error } : {}) })),
    moments,
    captures,
    attachments,
    judges,
    timing: {
      byUnit: Object.fromEntries(units.map((u) => [u.key, u.ms ?? 0])),
      byCheck: Object.fromEntries(Object.entries(byCheck).map(([k, v]) => [k, Math.round(v.ms)])),
    },
  };
}

/** Judge packets: per rubric, the measurements, failing checks with crops and key-moment crops, capped. */
export function judgePackets(report, findings, flowsByName) {
  const rubrics = new Map();
  for (const [name, flow] of flowsByName) for (const r of flow.rubric ?? []) rubrics.set(r, [...(rubrics.get(r) ?? []), name]);
  const out = [];
  for (const [rubric, names] of rubrics) {
    const mine = new Set(names);
    const failing = findings.filter((f) => !f.pass && mine.has(f.flow)).sort((a, b) => Number(!!b.evidence) - Number(!!a.evidence)).slice(0, FAILURES_PER_PACKET);
    const ms = (report.captures ?? []).filter((m) => mine.has(m.flow));
    const step = Math.max(1, ms.length / MOMENTS_PER_PACKET);
    const moments = [];
    for (let i = 0; i < ms.length && moments.length < MOMENTS_PER_PACKET; i += step) moments.push(ms[Math.floor(i)]);
    const byCheck = {};
    for (const f of findings.filter((x) => mine.has(x.flow))) count(byCheck, f.check, f.pass);
    for (const c of Object.values(byCheck)) delete c.ms;
    out.push({
      name: `judge-packet-${rubric}.json`,
      packet: {
        schema: 'flow-review-judge-packet/0',
        rubric,
        flows: names,
        rules: 'Judge only from these measurements and crops; do not browse. Answer with JSON matching `flow-review schema rubric` ({ judge, verdict: "approve" | "not yet", moments: [{ step, cell, crop, observation, fix }] }), naming a step, cell and crop from this packet for every moment.',
        measurements: byCheck,
        failing: failing.map(({ flow, step, cell, check, measured, threshold, selector, evidence, fix }) => ({ flow, step, cell, check, measured, threshold, selector, evidence, fix })),
        moments,
      },
    });
  }
  return out;
}

export function writeReport(outDir, report, packets = []) {
  const errors = validate('report', report);
  if (errors.length) throw new Error(`internal: report.json does not match flow-review-report/0: ${errors.join('; ')}`);
  fs.writeFileSync(path.join(outDir, 'report.json'), `${JSON.stringify(report, null, 1)}\n`);
  for (const p of packets) fs.writeFileSync(path.join(outDir, p.name), `${JSON.stringify(p.packet, null, 1)}\n`);
}

export function readFindings(dir) {
  const file = path.join(dir, 'findings.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

/** Clears what a previous run left in the output folder (only flow-review's own files). */
export function clearOut(outDir) {
  fs.mkdirSync(outDir, { recursive: true });
  for (const name of fs.readdirSync(outDir)) {
    if (['report.json', 'findings.jsonl', 'summary.md', 'evidence', 'moments', 'work'].includes(name) || /^judge-packet-.*\.json$/.test(name)) fs.rmSync(path.join(outDir, name), { recursive: true, force: true });
  }
}

const fmtCell = (c) => (c ? `${c.viewport} ${c.theme}${c.reducedMotion ? ' reduced-motion' : ''}` : 'agent');

/** A short markdown summary for $GITHUB_STEP_SUMMARY. */
export function markdown(report, findings, { title = 'Flow review', top = 15 } = {}) {
  const s = report.summary;
  const min = (ms) => `${(ms / 60000).toFixed(1)} min`;
  const lines = [`## ${title}${report.shard ? ` (shard ${report.shard})` : ''}`, ''];
  lines.push(`${s.failures ? '❌' : '✅'} **${s.failures} failing**${s.known ? ` (${s.known} known)` : ''} of ${s.findings} findings across ${s.units} units (${s.human.units} human, ${s.agent.units} agent) in ${min(report.ms)}. Fail on: \`${report.failOn}\`.`, '');
  const t = report.provenance?.target;
  if (t) lines.push(`Target: \`${t.value}\`${t.version ? ` ${t.version}` : ''}${t.sha256 ? ` (sha256 ${t.sha256.slice(0, 12)})` : ''}; engine ${report.tool.version}; no retries.`, '');
  lines.push('| Flow | Side | Units | Min | Failing checks |', '| --- | --- | ---: | ---: | --- |');
  for (const r of report.table) {
    const bad = Object.entries(r.checks).filter(([, c]) => c.fail).map(([k, c]) => `${k} ${c.fail}`).join(' · ') || '—';
    lines.push(`| ${r.flow} | ${r.side} | ${r.units} | ${(r.ms / 60000).toFixed(1)} | ${bad} |`);
  }
  lines.push('', '| Check | Pass | Fail |', '| --- | ---: | ---: |');
  for (const [k, c] of Object.entries(s.byCheck).sort()) lines.push(`| ${k} | ${c.pass} | ${c.fail} |`);
  const failing = findings.filter((f) => !f.pass);
  if (failing.length) {
    lines.push('', `<details><summary>First ${Math.min(top, failing.length)} failing findings</summary>`, '');
    for (const f of failing.slice(0, top)) lines.push(`- **${f.check}** · ${f.flow} · ${f.step} · ${fmtCell(f.cell)}: ${String(f.label ?? f.measured).replace(/\|/g, '\\|')}${f.selector ? ` \`${f.selector}\`` : ''}${f.fix ? ` — ${f.fix}` : ''}`);
    lines.push('', '</details>');
  }
  const inv = momentInventory(report);
  if (inv.length) lines.push('', `Moments: ${inv.length} states (empty, loading, error, first-run, success); ${inv.filter((m) => !m.hasMoment).length} without their Moment (\`flow-review moments --missing\`).`);
  if (report.judges?.length) {
    lines.push('', '| Judge | Verdict | Moments |', '| --- | --- | ---: |');
    for (const j of report.judges) lines.push(`| ${j.judge} | ${j.verdict} | ${j.moments.length} |`);
  }
  return `${lines.join('\n')}\n`;
}

const slug = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

/**
 * The report's states, one entry per flow, kind and element (across steps and cells), with a stable key
 * (`<flow>/<kind>/<selector-hash>`) a tracker can deduplicate on. `hasMoment` is false when any sighting lacked it.
 */
export function momentInventory(report) {
  const out = new Map();
  for (const m of report.moments ?? []) {
    if (!m.kind) continue;
    const key = `${slug(m.flow)}/${m.kind}/${createHash('sha1').update(m.selector ?? '').digest('hex').slice(0, 10)}`;
    const e = out.get(key) ?? { key, flow: m.flow, kind: m.kind, selector: m.selector, label: m.label, how: m.how, hasMoment: true, steps: [], cells: [] };
    e.hasMoment &&= !!m.hasMoment;
    if (!e.steps.includes(m.step)) e.steps.push(m.step);
    const cell = m.cell ? `${m.cell.viewport} ${m.cell.theme}${m.cell.reducedMotion ? ' reduced-motion' : ''}` : 'agent';
    if (!e.cells.includes(cell)) e.cells.push(cell);
    out.set(key, e);
  }
  return [...out.values()].sort((a, b) => (a.key < b.key ? -1 : 1));
}
