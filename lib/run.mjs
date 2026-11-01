// `flow-review run`, `merge`, `times` and `judge --merge`.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadFlows, prepare, configFor } from './load.mjs';
import { unitsOf, shardUnits, readTimes, parseShard, exactlyOnce, DEFAULT_TIMES, cellsOf, unitKey } from './matrix.mjs';
import { startApp, stopApps, stopFlowApp, withStart } from './app.mjs';
import { runAgentFlow } from './agent.mjs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { runWebUnit, stepId } from './web.mjs';
import { closeEncoder } from './evidence.mjs';
import { buildReport, judgePackets, writeReport, readFindings, clearOut, markdown, exitCodeFor } from './report.mjs';
import { validate } from './schema.mjs';

const enabledAgent = (flow, only) => (k) => k === 'step' || ((!only || only.includes(k)) && (!flow.checks?.only || flow.checks.only.includes(k)) && !(flow.checks?.skip ?? []).includes(k));

async function runAgentUnit(unit, cwd, emit, only, slack) {
  const t0 = performance.now();
  for (const f of await runAgentFlow(unit.flow, cwd, { slack, enabled: enabledAgent(unit.flow, only) })) emit(f);
  unit.ms = Math.round(performance.now() - t0);
}

/** Where the run's target came from and what it is: a file's sha256, a folder's package version, or a URL. */
export function describeTarget(target, cwd, version) {
  if (target === undefined) return null;
  const out = { value: target, version: version ?? null };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(target)) return { ...out, kind: 'url' };
  const abs = path.resolve(cwd, target);
  out.kind = 'path';
  out.path = abs;
  try {
    const st = fs.statSync(abs);
    if (st.isFile()) { out.sha256 = createHash('sha256').update(fs.readFileSync(abs)).digest('hex'); out.bytes = st.size; }
    else if (st.isDirectory() && fs.existsSync(path.join(abs, 'package.json'))) out.version ??= JSON.parse(fs.readFileSync(path.join(abs, 'package.json'), 'utf8')).version ?? null;
  } catch { out.missing = true; }
  return out;
}

function repoOf(cwd) {
  const git = (...a) => { const r = spawnSync('git', a, { cwd, encoding: 'utf8' }); return r.status === 0 ? r.stdout.trim() : null; };
  const sha = git('rev-parse', 'HEAD');
  return sha ? { sha, dirty: !!git('status', '--porcelain', '--untracked-files=no') } : null;
}

export async function run({ globs = [], out = 'report', config, shard: shardText, failOn = 'any', only, times: timesFile, workers, cells, target = process.env.FLOW_REVIEW_TARGET || undefined, targetVersion = process.env.FLOW_REVIEW_TARGET_VERSION || undefined, slack = 1, cwd = process.cwd(), log = console.error }) {
  const startedAt = new Date().toISOString();
  const targets = new Map();
  const outDir = path.resolve(cwd, out);
  const workdir = path.join(outDir, 'work');
  const loaded = (await loadFlows(globs, cwd)).map((l) => {
    const t = prepare(l.flow, { target, workdir, config: configFor(l.file, cwd, config) });
    if (t.target !== undefined) targets.set(l.flow.name, t.target);
    return { ...l, flow: t.flow };
  });
  const all = unitsOf(loaded).filter((u) => !cells?.length || cells.some((c) => u.key.split('#')[1].includes(c)));
  const shard = parseShard(shardText);
  const tf = timesFile ?? (fs.existsSync(path.join(cwd, DEFAULT_TIMES)) ? path.join(cwd, DEFAULT_TIMES) : null);
  const { units } = shardUnits(all, shard, readTimes(tf));
  clearOut(outDir);
  fs.mkdirSync(workdir, { recursive: true });
  const jsonl = fs.openSync(path.join(outDir, 'findings.jsonl'), 'w');
  const findings = [];
  const captures = [];
  const states = new Map();
  log(`flow-review: ${units.length} of ${all.length} units in shard ${shard.index}/${shard.total}${tf ? ` (times: ${path.relative(cwd, tf)})` : ''}`);

  let browser = null;
  let chromium = null;
  const needsBrowser = units.some((u) => u.flow.surface === 'web' || u.flow.surface === 'cdp');
  if (needsBrowser) {
    ({ chromium } = await import('playwright'));
    if (units.some((u) => u.flow.surface === 'web')) {
      browser = await chromium.launch({ headless: true, executablePath: process.env.FLOW_REVIEW_CHROMIUM || undefined, channel: process.env.FLOW_REVIEW_CHANNEL || undefined });
    }
  }

  const emitter = (unit) => (f) => {
    const full = { flow: unit.flow.name, step: f.step, surface: unit.flow.surface, cell: unit.cell, ...f };
    if (!full.pass) unit.failures = (unit.failures ?? 0) + (full.more ?? 1);
    findings.push(full);
    fs.writeSync(jsonl, `${JSON.stringify(full)}\n`);
  };

  const runUnit = async (unit) => {
    const t0 = performance.now();
    // As the flow gave it, before ${start.*} is filled: the key its app runs under.
    const app = unit.flow.app;
    const emit = emitter(unit);
    try {
      const vars = await startApp(app, cwd, unit.key);
      if (Object.keys(vars).length) unit.flow = withStart(unit.flow, vars);
      if (unit.flow.surface === 'agent-cli' || unit.flow.surface === 'agent-http') await runAgentUnit(unit, cwd, emit, only, slack);
      else await runWebUnit({ unit, browser, chromium, cwd, outDir, only, emit, addMoment: (m) => captures.push({ flow: unit.flow.name, cell: unit.cell, ...m }), addState: (m) => { const k = JSON.stringify([unit.key, m.step, m.kind, m.selector]); if (!states.has(k)) states.set(k, { flow: unit.flow.name, step: m.step, cell: unit.cell, kind: m.kind, selector: m.selector, label: m.label, how: m.how, hasMoment: m.hasMoment }); } });
    } catch (e) {
      unit.error = String(e.message).split('\n').slice(0, 3).join(' ');
      emit({ step: 'setup', check: 'step', pass: false, measured: unit.error.slice(0, 300), threshold: 'unit runs', ms: Math.round(performance.now() - t0) });
    }
    await stopFlowApp(app, cwd, unit.key);
    unit.ms ??= Math.round(performance.now() - t0);
    log(`  ${unit.key}: ${(unit.ms / 1000).toFixed(1)} s, ${unit.failures ?? 0} failing`);
  };

  try {
    // cdp units share one browser window, and agent units may share one app whose state they change, so each of those
    // runs one at a time, in file order; web units run `workers` at a time.
    const serial = units.filter((u) => u.flow.surface !== 'web');
    const pool = units.filter((u) => u.flow.surface === 'web');
    const n = Number(workers ?? (process.env.FLOW_REVIEW_WORKERS || undefined) ?? Math.min(4, Math.max(1, Math.floor(os.availableParallelism() / 2))));
    if (!Number.isInteger(n) || n < 1) throw new Error(`workers ${workers ?? process.env.FLOW_REVIEW_WORKERS} is not a positive whole number`);
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(n, pool.length) }, async () => {
      while (next < pool.length) await runUnit(pool[next++]);
    }));
    for (const u of serial) await runUnit(u);
    for (const u of units) if (u.ms === undefined) { u.error = 'never ran'; emitter(u)({ step: 'setup', check: 'step', pass: false, measured: 'never ran', threshold: 'unit runs', ms: 0 }); }
  } finally {
    fs.closeSync(jsonl);
    await closeEncoder();
    await browser?.close().catch(() => {});
    await stopApps();
    fs.rmSync(workdir, { recursive: true, force: true });
  }

  const attachments = loaded.flatMap(({ flow }) => (flow.attachments ?? []).map((a) => ({ flow: flow.name, ...a })));
  const plain = units.map((u) => ({ key: u.key, flow: u.flow.name, file: u.file, surface: u.flow.surface, cell: u.cell, ms: u.ms, failures: u.failures ?? 0, error: u.error }));
  const report = buildReport({ units: plain, findings, moments: [...states.values()], captures, attachments, startedAt, finishedAt: new Date().toISOString(), shard: shardText ?? null, failOn, args: { globs, only: only ?? null } });
  const flowsByName = new Map(loaded.map((l) => [l.flow.name, l.flow]));
  report.provenance = {
    engine: report.tool,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    repo: repoOf(cwd),
    target: describeTarget(target ?? [...new Set(targets.values())][0], cwd, targetVersion),
    flowTargets: Object.fromEntries(targets),
    failOn,
    slack,
    retries: 0,
    shard: shardText ?? '1/1',
  };
  writeReport(outDir, report, judgePackets(report, findings, flowsByName));
  fs.writeFileSync(path.join(outDir, 'summary.md'), markdown(report, findings));
  return report;
}

/** Combines shard reports, checking every expected unit ran exactly once. */
export async function merge({ dirs, out = 'report', failOn = 'any', globs, cwd = process.cwd() }) {
  const outDir = path.resolve(cwd, out);
  const reports = dirs.map((d) => ({ dir: path.resolve(cwd, d), report: JSON.parse(fs.readFileSync(path.resolve(cwd, d, 'report.json'), 'utf8')) }));
  const shardKeys = reports.map((r) => r.report.units.map((u) => u.key));
  let expected = [...new Set(shardKeys.flat())];
  let flowsByName = new Map();
  if (globs) {
    const loaded = await loadFlows(globs, cwd);
    expected = unitsOf(loaded).map((u) => u.key);
    flowsByName = new Map(loaded.map((l) => [l.flow.name, l.flow]));
  }
  const guard = exactlyOnce(expected, shardKeys);
  const findings = [];
  const moments = [];
  const captures = [];
  const attachments = [];
  const units = [];
  const sameDir = (d) => path.resolve(d) === outDir;
  const staged = [];
  for (const { dir, report } of reports) {
    findings.push(...readFindings(dir));
    moments.push(...report.moments.filter((m) => m.kind));
    captures.push(...(report.captures ?? report.moments.filter((m) => m.crop)));
    for (const a of report.attachments) if (!attachments.some((b) => JSON.stringify(b) === JSON.stringify(a))) attachments.push(a);
    units.push(...report.units);
    for (const sub of ['evidence', 'moments']) {
      const src = path.join(dir, sub);
      if (fs.existsSync(src) && !sameDir(dir)) for (const f of fs.readdirSync(src)) staged.push([path.join(src, f), path.join(sub, f)]);
    }
  }
  const starts = reports.map((r) => Date.parse(r.report.startedAt));
  const ends = reports.map((r) => Date.parse(r.report.finishedAt));
  if (!reports.some((r) => sameDir(r.dir))) clearOut(outDir);
  for (const [src, rel] of staged) {
    fs.mkdirSync(path.join(outDir, path.dirname(rel)), { recursive: true });
    fs.copyFileSync(src, path.join(outDir, rel));
  }
  fs.writeFileSync(path.join(outDir, 'findings.jsonl'), findings.map((f) => JSON.stringify(f)).join('\n') + (findings.length ? '\n' : ''));
  const report = buildReport({ units, findings, moments, captures, attachments, judges: reports.flatMap((r) => r.report.judges), startedAt: new Date(Math.min(...starts)).toISOString(), finishedAt: new Date(Math.max(...ends)).toISOString(), shard: null, failOn, args: { merged: dirs.length } });
  report.shards = reports.map((r) => ({ shard: r.report.shard, units: r.report.units.length, ms: r.report.ms, failures: r.report.summary.failures }));
  const provs = reports.map((r) => r.report.provenance).filter(Boolean);
  if (provs.length) {
    const same = (k) => new Set(provs.map((p) => JSON.stringify(p[k] ?? null))).size === 1;
    report.provenance = { ...provs[0], shard: null, merged: provs.length, consistent: same('target') && same('repo') && same('engine') };
  }
  report.coverage = guard;
  const bad = guard.missing.length + guard.duplicated.length + guard.unexpected.length;
  if (bad) report.exitCode = 3;
  if (!flowsByName.size) for (const u of units) flowsByName.set(u.flow, { rubric: [] });
  writeReport(outDir, report, judgePackets(report, findings, flowsByName));
  fs.writeFileSync(path.join(outDir, 'summary.md'), markdown(report, findings) + (bad ? `\n❌ Shards did not cover every unit exactly once: missing ${guard.missing.length}, duplicated ${guard.duplicated.length}, unexpected ${guard.unexpected.length}.\n` : ''));
  return report;
}

/** Recorded unit times from reports, for balancing the next run's shards. */
export function times({ dirs, out, cwd = process.cwd() }) {
  const units = {};
  const prev = out && fs.existsSync(path.resolve(cwd, out)) ? readTimes(path.resolve(cwd, out)) : {};
  Object.assign(units, prev);
  for (const d of dirs) for (const u of JSON.parse(fs.readFileSync(path.resolve(cwd, d, 'report.json'), 'utf8')).units) units[u.key] = u.ms;
  const sorted = Object.fromEntries(Object.entries(units).sort(([a], [b]) => (a < b ? -1 : 1)));
  const text = `${JSON.stringify({ schema: 'flow-review-times/0', units: sorted }, null, 1)}\n`;
  if (out) fs.writeFileSync(path.resolve(cwd, out), text);
  return text;
}

/** Validates judges' rubric answers against the report and folds them in. */
export function judgeMerge({ files, report: dir = 'report', cwd = process.cwd() }) {
  const file = path.resolve(cwd, dir, 'report.json');
  const report = JSON.parse(fs.readFileSync(file, 'utf8'));
  // A 0.1 report listed its capture pictures as moments.
  if (!report.captures) {
    report.captures = (report.moments ?? []).filter((m) => m.crop);
    report.moments = (report.moments ?? []).filter((m) => m.kind);
  }
  const findings = readFindings(path.resolve(cwd, dir));
  const steps = new Set([...findings.map((f) => `${f.flow}\u0000${f.step}`), ...(report.captures ?? report.moments).map((m) => `${m.flow}\u0000${m.step}`)]);
  const stepNames = new Set([...steps].map((s) => s.split('\u0000')[1]));
  const problems = [];
  const added = [];
  for (const f of files) {
    let answer;
    try {
      answer = JSON.parse(fs.readFileSync(path.resolve(cwd, f), 'utf8'));
    } catch (e) {
      problems.push(`${f}: not JSON (${e.message})`);
      continue;
    }
    const errs = validate('rubric', answer);
    if (errs.length) { problems.push(`${f}: ${errs.join('; ')}`); continue; }
    for (const [i, m] of answer.moments.entries()) {
      const known = m.flow ? steps.has(`${m.flow}\u0000${m.step}`) : stepNames.has(m.step);
      if (!known) problems.push(`${f}: moments[${i}] names step "${m.step}", which this report doesn't have`);
      if (m.crop && !fs.existsSync(path.resolve(cwd, dir, m.crop))) problems.push(`${f}: moments[${i}] names crop ${m.crop}, which this report doesn't have`);
    }
    added.push({ ...answer, file: path.basename(f) });
  }
  if (problems.length) return { ok: false, problems };
  report.judges = [...report.judges.filter((j) => !added.some((a) => a.judge === j.judge && (a.rubric ?? null) === (j.rubric ?? null))), ...added];
  report.summary.judges = { approve: report.judges.filter((j) => j.verdict === 'approve').length, notYet: report.judges.filter((j) => j.verdict === 'not yet').length };
  writeReport(path.resolve(cwd, dir), report);
  fs.writeFileSync(path.resolve(cwd, dir, 'summary.md'), markdown(report, findings));
  return { ok: true, judges: report.judges.length };
}

export { exitCodeFor, stepId, cellsOf, unitKey };
