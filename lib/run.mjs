// `flow-review run`, `merge`, `times` and `judge --merge`.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { loadFlows, prepare, configFor, policyOf } from './load.mjs';
import { unitsOf, shardUnits, readTimes, parseShard, exactlyOnce, DEFAULT_TIMES, cellsOf, unitKey, sideOf, notRunByEngine, engineOfCell } from './matrix.mjs';
import { parseEngines, launchOptionsFor, browserTypeOf, speaksCdp, DEFAULT_ENGINE } from './engines.mjs';
import { startApp, stopApps, stopFlowApp, stopStuckApp, withStart } from './app.mjs';
import { runAgentFlow } from './agent.mjs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { runWebUnit, stepId } from './web.mjs';
import { constrainedFromEnv, bannerLine, assertSandboxedHost } from './constrain-profile.mjs';
import { closeEncoder } from './evidence.mjs';
import { keepEvidence, parseBytes, DEFAULT_EVIDENCE_MAX } from './budget.mjs';
import { assertHeadless, launchBrowser } from './browser.mjs';
import { buildReport, judgePackets, writeReport, readFindings, clearOut, markdown, exitCodeFor } from './report.mjs';
import { validate } from './schema.mjs';

const enabledAgent = (flow, only) => (k) => k === 'step' || ((!only || only.includes(k)) && (!flow.checks?.only || flow.checks.only.includes(k)) && !(flow.checks?.skip ?? []).includes(k));

async function runAgentUnit(unit, cwd, emit, only, slack, signal) {
  const t0 = performance.now();
  for (const f of await runAgentFlow(unit.flow, cwd, { slack, enabled: enabledAgent(unit.flow, only), signal, onStep: (step, target) => { unit.at = { step, target }; } })) emit(f);
  if (!signal.aborted) unit.ms = Math.round(performance.now() - t0);
}

/** How long a stopped cell's work may take to wind down (its page closing, its command dying) before the run moves on. */
export const STOP_GRACE_MS = 10_000;

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

export async function run({ globs = [], out = 'report', config, shard: shardText, failOn = 'any', only, times: timesFile, workers, cells, engines: engineList = process.env.FLOW_REVIEW_ENGINE || DEFAULT_ENGINE, target = process.env.FLOW_REVIEW_TARGET || undefined, targetVersion = process.env.FLOW_REVIEW_TARGET_VERSION || undefined, slack = 1, headed = false, evidenceMax = process.env.FLOW_REVIEW_EVIDENCE_MAX || DEFAULT_EVIDENCE_MAX, cwd = process.cwd(), log = console.error, constrained = constrainedFromEnv() }) {
  const maxBytes = parseBytes(evidenceMax);
  const engines = parseEngines(engineList);
  // WebKit has no DevTools protocol to throttle its pages: a constrained run on it is slowed only by flow-review
  // constrain's process tree, and is refused without one rather than run at full speed under a constrained banner.
  if (constrained && engines.some((e) => !speaksCdp(e)) && !constrained.tree?.cpu) throw new Error(`a constrained run on ${engines.filter((e) => !speaksCdp(e)).join(', ')} needs flow-review constrain around it: that engine has no DevTools protocol to throttle its pages, so only the process tree can slow it`);
  // Checked before anything runs: DevTools CPU throttling holds a core busy per page, so only on a CI runner or a sandbox.
  if (constrained && constrained.cpu > 1 && !constrained.tree?.cpu) assertSandboxedHost(process.env, { what: 'page-cpu' });
  if (constrained) log(`flow-review: ${bannerLine(constrained, { cpu: constrained.tree?.achieved ? { achieved: constrained.tree.achieved, mechanism: constrained.tree.cpu } : null })}; pages are constrained through DevTools${constrained.tree ? ', and the process tree by flow-review constrain' : ''}`);
  // Checked before anything runs: outside CI, a headful run is refused rather than shown.
  const launchOptions = assertHeadless({ headless: !headed });
  const startedAt = new Date().toISOString();
  const targets = new Map();
  const outDir = path.resolve(cwd, out);
  const workdir = path.join(outDir, 'work');
  const loaded = (await loadFlows(globs, cwd)).map((l) => {
    const t = prepare(l.flow, { target, workdir, config: configFor(l.file, cwd, config) });
    if (t.target !== undefined) targets.set(l.flow.name, t.target);
    return { ...l, flow: t.flow };
  });
  const all = unitsOf(loaded, engines).filter((u) => !cells?.length || cells.some((c) => u.key.split('#')[1].includes(c)));
  const shard = parseShard(shardText);
  const tf = timesFile ?? (fs.existsSync(path.join(cwd, DEFAULT_TIMES)) ? path.join(cwd, DEFAULT_TIMES) : null);
  const { units } = shardUnits(all, shard, readTimes(tf));
  clearOut(outDir);
  fs.mkdirSync(workdir, { recursive: true });
  const jsonl = fs.openSync(path.join(outDir, 'findings.jsonl'), 'w');
  const findings = [];
  const captures = [];
  const states = new Map();
  log(`flow-review: ${units.length} of ${all.length} units in shard ${shard.index}/${shard.total}${engines.length > 1 || engines[0] !== DEFAULT_ENGINE ? ` on ${engines.join(', ')}` : ''}${tf ? ` (times: ${path.relative(cwd, tf)})` : ''}`);
  const notRun = notRunByEngine(loaded, engines);
  for (const [e, list] of Object.entries(notRun)) log(`flow-review: ${list.length} flows don't run on ${e}: ${list.map((n) => `${n.flow} (${n.why})`).slice(0, 5).join('; ')}${list.length > 5 ? '; ...' : ''}`);

  // One browser per engine the shard's web units use, launched before any runs. An engine that can't launch (Edge not
  // installed, say) fails each of its units with the reason; the other engines' units still run.
  const browsers = new Map();
  const launchErrors = new Map();
  const versions = {};
  let playwright = null;
  if (units.some((u) => u.flow.surface === 'web' || u.flow.surface === 'cdp')) playwright = await import('playwright');
  for (const engine of new Set(units.filter((u) => u.flow.surface === 'web').map((u) => u.cell.engine))) {
    try {
      const b = await launchBrowser(playwright[browserTypeOf(engine)], launchOptionsFor(engine, launchOptions));
      browsers.set(engine, b);
      versions[engine] = b.version();
    } catch (e) {
      launchErrors.set(engine, `${engine} did not launch: ${String(e.message).split('\n')[0]}`);
      log(`flow-review: ${launchErrors.get(engine)}`);
    }
  }

  const emitter = (unit) => (f) => {
    // A stopped cell's work may still be winding down after the run has moved on, or finished.
    if (unit.closed) return;
    const full = { flow: unit.flow.name, step: f.step, surface: unit.flow.surface, cell: unit.cell, ...f };
    if (!full.pass && !full.advisory) unit.failures = (unit.failures ?? 0) + (full.more ?? 1);
    findings.push(full);
    fs.writeSync(jsonl, `${JSON.stringify(full)}\n`);
  };

  // Each unit runs under its flow's timeouts.cellMs, counted once its app is up (app.readyTimeoutMs bounds that). Past it,
  // the unit is stopped (its page closed, its command killed, its app stopped when the app is the unit's own or no
  // longer answers), a timeout finding names the step it was on, and the run goes on with the next unit, so a shard
  // always finishes and writes its report.
  const runUnit = async (unit) => {
    const t0 = performance.now();
    // As the flow gave it, before ${start.*} is filled: the key its app runs under.
    const app = unit.flow.app;
    const emit = emitter(unit);
    const stopper = new AbortController();
    const cellMs = unit.flow.timeouts?.cellMs ?? 120_000;
    unit.at = { step: 'setup' };
    let timer;
    let clock;
    let late;
    const timedOut = new Promise((r) => { late = r; });
    const work = (async () => {
      try {
        const vars = await startApp(app, cwd, unit.key);
        if (Object.keys(vars).length) unit.flow = withStart(unit.flow, vars);
        clock = performance.now();
        timer = setTimeout(() => late('late'), cellMs);
        if (unit.flow.surface === 'agent-cli' || unit.flow.surface === 'agent-http') await runAgentUnit(unit, cwd, emit, only, slack, stopper.signal);
        else {
          const engine = engineOfCell(unit.cell);
          if (launchErrors.has(engine)) throw new Error(launchErrors.get(engine));
          await runWebUnit({ unit, engine, browser: browsers.get(engine) ?? null, chromium: playwright.chromium, constrained, onBrowser: (v) => { versions[engine] ??= v; }, cwd, outDir, only, emit, signal: stopper.signal, addMoment: (m) => captures.push({ flow: unit.flow.name, cell: unit.cell, ...m }), addState: (m) => { const k = JSON.stringify([unit.key, m.step, m.kind, m.selector]); if (!states.has(k)) states.set(k, { flow: unit.flow.name, step: m.step, cell: unit.cell, kind: m.kind, selector: m.selector, label: m.label, how: m.how, hasMoment: m.hasMoment }); } });
        }
      } catch (e) {
        if (stopper.signal.aborted) return;
        unit.error = String(e.message).split('\n').slice(0, 3).join(' ');
        emit({ step: 'setup', check: 'step', pass: false, measured: unit.error.slice(0, 300), threshold: 'unit runs', ms: Math.round(performance.now() - t0) });
      }
    })();
    const outcome = await Promise.race([work.then(() => 'done'), timedOut]);
    clearTimeout(timer);
    if (outcome === 'late') {
      const at = unit.at;
      const ms = Math.round(performance.now() - clock);
      const total = Math.round(performance.now() - t0);
      stopper.abort();
      await stopStuckApp(app, cwd, unit.key);
      let grace;
      await Promise.race([work, new Promise((r) => { grace = setTimeout(r, STOP_GRACE_MS); })]);
      clearTimeout(grace);
      unit.timedOut = true;
      unit.error = `timed out after ${(ms / 1000).toFixed(1)} s at step ${at.step}`;
      unit.ms = total;
      emit({ step: at.step, check: 'timeout', pass: false, measured: `stopped after ${(ms / 1000).toFixed(1)} s, at step "${at.step}"${at.target ? ` (${at.target})` : ''}`, threshold: `${cellMs} ms per cell (timeouts.cellMs)`, ...(at.target && sideOf(unit.flow.surface) === 'human' ? { selector: at.target } : {}), fix: `The cell ran past timeouts.cellMs. Find what hangs at step "${at.step}", or raise timeouts.cellMs for this flow if it is only long.`, ms });
      unit.closed = true;
    }
    await stopFlowApp(app, cwd, unit.key);
    unit.ms ??= Math.round(performance.now() - t0);
    log(`  ${unit.key}: ${(unit.ms / 1000).toFixed(1)} s, ${unit.failures ?? 0} failing${unit.timedOut ? `, timed out at step ${unit.at?.step}` : ''}`);
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
    for (const u of units) u.closed = true;
    fs.closeSync(jsonl);
    await closeEncoder();
    for (const b of browsers.values()) await b.close().catch(() => {});
    await stopApps();
    fs.rmSync(workdir, { recursive: true, force: true });
  }

  const attachments = loaded.flatMap(({ flow }) => (flow.attachments ?? []).map((a) => ({ flow: flow.name, ...a })));
  const plain = units.map((u) => ({ key: u.key, flow: u.flow.name, file: u.file, surface: u.flow.surface, cell: u.cell, ms: u.ms, failures: u.failures ?? 0, error: u.error, timedOut: u.timedOut }));
  const failOnByFlow = new Map(loaded.filter((l) => l.flow.failOn !== undefined).map((l) => [l.flow.name, l.flow.failOn]));
  const flowsByName = new Map(loaded.map((l) => [l.flow.name, l.flow]));
  // The pictures the report keeps: failing findings' crops, then the key moments a judge packet asks for, under the cap.
  const judged = new Set(judgePackets({ captures }, findings, flowsByName).flatMap((p) => p.packet.moments.map((m) => m.crop)));
  const kept = keepEvidence({ outDir, findings, captures, judged, maxBytes });
  if (kept.findingsChanged) fs.writeFileSync(path.join(outDir, 'findings.jsonl'), findings.map((f) => `${JSON.stringify(f)}\n`).join(''));
  const report = buildReport({ units: plain, findings, moments: [...states.values()], captures, attachments, startedAt, finishedAt: new Date().toISOString(), shard: shardText ?? null, failOn, failOnByFlow, engines, notRun, args: { globs, only: only ?? null, engines } });
  report.evidence = kept.evidence;
  if (kept.evidence.dropped.evidence + kept.evidence.dropped.moments) log(`flow-review: the evidence cap (${maxBytes} bytes) dropped ${kept.evidence.dropped.evidence} evidence crops and ${kept.evidence.dropped.moments} key moments`);
  report.provenance = {
    engine: report.tool,
    node: process.version,
    platform: `${process.platform}-${process.arch}`,
    browsers: versions,
    repo: repoOf(cwd),
    target: describeTarget(target ?? [...new Set(targets.values())][0], cwd, targetVersion),
    flowTargets: Object.fromEntries(targets),
    failOn,
    slack,
    retries: 0,
    shard: shardText ?? '1/1',
    constrained: constrained ? describeConstrained(constrained) : null,
  };
  writeReport(outDir, report, judgePackets(report, findings, flowsByName));
  fs.writeFileSync(path.join(outDir, 'summary.md'), markdown(report, findings));
  return report;
}

/** What report.json's provenance records about constrained mode: the settings, and how much of the computer it covered. */
function describeConstrained(c) {
  return {
    profile: c.profile, cpu: c.cpu, memoryMB: c.memoryMB, disk: c.disk, network: c.network, overridden: c.overridden ?? [],
    scope: c.tree ? 'process-tree' : 'pages',
    tree: c.tree ?? null,
  };
}

/** A shard's report.json, or null when the folder has none or it can't be read (a cancelled or failed shard). */
function readShard(cwd, d) {
  try {
    return JSON.parse(fs.readFileSync(path.resolve(cwd, d, 'report.json'), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Combines shard reports, checking every expected unit ran exactly once. A folder without a report (a cancelled shard)
 * leaves its units missing. With coverage "gated" (the default), a unit missing or run twice fails the merge (exit 3)
 * only when its flow fails on something (its own failOn, its config's, else --fail-on); a unit of an advisory flow
 * (failOn none) that is missing, ran twice or timed out becomes a `coverage` finding instead. With "strict", every
 * missing or duplicated unit fails. A unit no flow expects always fails.
 */
export async function merge({ dirs, out = 'report', failOn = 'any', globs, config, engines: engineList, coverage: mode = 'gated', cwd = process.cwd(), log = console.error }) {
  if (!['gated', 'strict'].includes(mode)) throw new Error(`coverage ${mode} is not gated or strict`);
  const outDir = path.resolve(cwd, out);
  const reports = [];
  const missingReports = [];
  for (const d of dirs) {
    const report = readShard(cwd, d);
    if (report) reports.push({ dir: path.resolve(cwd, d), report });
    else {
      missingReports.push(d);
      log(`flow-review merge: ${d} holds no readable report.json (a cancelled shard?); its units count as missing`);
    }
  }
  if (!reports.length && !globs) throw new Error('no shard report to merge, and no --flows to say which units were expected');
  const shardKeys = reports.map((r) => r.report.units.map((u) => u.key));
  // The engines expected: those given, else every engine a shard report ran (a report from before engines ran Chromium).
  // Pass them: when every shard of an engine was cancelled, no report says that engine was expected.
  const engines = engineList ? parseEngines(engineList) : parseEngines([...new Set(reports.flatMap((r) => r.report.args?.engines ?? [DEFAULT_ENGINE]))]);
  let expected = [...new Set(shardKeys.flat())];
  let flowsByName = new Map();
  // What each expected unit is (its flow, surface and cell), and the failOn of flows that set their own.
  const unitInfo = new Map();
  const failOnByFlow = new Map();
  let expectedNotRun = null;
  for (const r of reports) for (const [name, f] of Object.entries(r.report.flowFailOn ?? {})) failOnByFlow.set(name, f);
  if (globs) {
    const loaded = await loadFlows(globs, cwd);
    const all = unitsOf(loaded, engines);
    expectedNotRun = notRunByEngine(loaded, engines);
    expected = all.map((u) => u.key);
    for (const u of all) unitInfo.set(u.key, { flow: u.flow.name, surface: u.flow.surface, cell: u.cell });
    flowsByName = new Map(loaded.map((l) => [l.flow.name, l.flow]));
    failOnByFlow.clear();
    for (const l of loaded) {
      const own = policyOf(l.flow, configFor(l.file, cwd, config)).failOn;
      if (own !== undefined) failOnByFlow.set(l.flow.name, own);
    }
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
  for (const u of units) if (!unitInfo.has(u.key)) unitInfo.set(u.key, { flow: u.flow, surface: u.surface, cell: u.cell });

  // Coverage: which units fail the merge, and which are only findings.
  const gated = (k) => (failOnByFlow.get(unitInfo.get(k)?.flow) ?? failOn) !== 'none';
  const timedOut = [...new Set(units.filter((u) => u.timedOut).map((u) => u.key))].sort();
  const failing = mode === 'strict' ? [...guard.missing, ...guard.duplicated, ...guard.unexpected] : [...guard.missing.filter(gated), ...guard.duplicated.filter(gated), ...guard.unexpected];
  const runs = (k) => units.filter((u) => u.key === k);
  // Every unit that is missing or ran twice is a failing coverage finding, gated or not, so it shows as a red row and
  // never as a blank; so is an advisory unit that timed out (a gated one fails through its timeout finding).
  const covered = [...new Set([...guard.missing, ...guard.duplicated, ...timedOut.filter((k) => !gated(k))])].sort();
  // The units whose coverage findings don't fail the merge: in strict mode, only advisory units that timed out.
  const advisory = covered.filter((k) => !failing.includes(k));
  for (const k of covered) {
    const info = unitInfo.get(k);
    const why = guard.missing.includes(k)
      ? (missingReports.length ? 'did not run: its shard was cancelled or failed and wrote no report' : 'did not run: no shard report has it')
      : [guard.duplicated.includes(k) && `ran ${runs(k).length} times`, timedOut.includes(k) && (runs(k).find((u) => u.timedOut)?.error ?? 'timed out')].filter(Boolean).join('; ');
    findings.push({ flow: info.flow, step: 'coverage', surface: info.surface, cell: info.cell, check: 'coverage', pass: false, unit: k, gated: failing.includes(k), measured: why, threshold: 'every unit runs exactly once, to the end', fix: guard.missing.includes(k) ? 'Find why its shard wrote no report (cancelled, out of time) and rerun it.' : timedOut.includes(k) ? 'See its timeout finding for the step it was on.' : 'Give each shard a different --shard k/n.', ms: 0 });
  }

  const starts = reports.map((r) => Date.parse(r.report.startedAt));
  const ends = reports.map((r) => Date.parse(r.report.finishedAt));
  const now = Date.now();
  if (!reports.some((r) => sameDir(r.dir))) clearOut(outDir);
  for (const [src, rel] of staged) {
    fs.mkdirSync(path.join(outDir, path.dirname(rel)), { recursive: true });
    fs.copyFileSync(src, path.join(outDir, rel));
  }
  fs.writeFileSync(path.join(outDir, 'findings.jsonl'), findings.map((f) => JSON.stringify(f)).join('\n') + (findings.length ? '\n' : ''));
  const notRun = {};
  for (const r of reports) for (const [e, list] of Object.entries(r.report.engines ?? {}).map(([k, v]) => [k, v.notRun ?? []])) for (const n of list) if (!(notRun[e] ??= []).some((x) => x.flow === n.flow)) notRun[e].push(n);
  const report = buildReport({ units, findings, moments, captures, attachments, judges: reports.flatMap((r) => r.report.judges), startedAt: new Date(starts.length ? Math.min(...starts) : now).toISOString(), finishedAt: new Date(ends.length ? Math.max(...ends) : now).toISOString(), shard: null, failOn, failOnByFlow, engines, notRun: expectedNotRun ?? notRun, args: { merged: dirs.length, engines } });
  report.shards = reports.map((r) => ({ shard: r.report.shard, units: r.report.units.length, ms: r.report.ms, failures: r.report.summary.failures, ...(r.report.evidence ? { evidence: r.report.evidence } : {}) }));
  const ev = reports.map((r) => r.report.evidence).filter(Boolean);
  if (ev.length) {
    const sum = (f) => ev.reduce((n, e) => n + f(e), 0);
    report.evidence = { maxBytes: ev.every((e) => e.maxBytes === ev[0].maxBytes) ? ev[0].maxBytes : null, bytes: sum((e) => e.bytes), files: sum((e) => e.files), dropped: { evidence: sum((e) => e.dropped.evidence), moments: sum((e) => e.dropped.moments), bytes: sum((e) => e.dropped.bytes) }, unjudgedMoments: sum((e) => e.unjudgedMoments) };
  }
  const provs = reports.map((r) => r.report.provenance).filter(Boolean);
  if (provs.length) {
    const same = (k) => new Set(provs.map((p) => JSON.stringify(p[k] ?? null))).size === 1;
    report.provenance = { ...provs[0], shard: null, merged: provs.length, browsers: Object.assign({}, ...provs.map((p) => p.browsers ?? {})), consistent: same('target') && same('repo') && same('engine') };
  }
  report.coverage = { ...guard, timedOut, missingReports, mode, failing: [...new Set(failing)].sort(), advisory };
  if (failing.length) report.exitCode = 3;
  if (!flowsByName.size) for (const u of units) flowsByName.set(u.flow, { rubric: [] });
  writeReport(outDir, report, judgePackets(report, findings, flowsByName));
  fs.writeFileSync(path.join(outDir, 'summary.md'), markdown(report, findings));
  return report;
}

/** Recorded unit times from reports, for balancing the next run's shards. */
export function times({ dirs, out, cwd = process.cwd() }) {
  const units = {};
  const prev = out && fs.existsSync(path.resolve(cwd, out)) ? readTimes(path.resolve(cwd, out)) : {};
  Object.assign(units, prev);
  for (const d of dirs) for (const u of readShard(cwd, d)?.units ?? []) units[u.key] = u.ms;
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
