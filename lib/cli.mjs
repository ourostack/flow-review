import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { run, merge, times, judgeMerge } from './run.mjs';
import { loadFlows } from './load.mjs';
import { unitsOf, partition, readTimes, parseShard, exactlyOnce, DEFAULT_TIMES } from './matrix.mjs';
import { SCHEMAS } from './schema.mjs';
import { CHECKS } from './constants.mjs';
import { markdown, readFindings, TOOL, momentInventory } from './report.mjs';

const USAGE = `flow-review ${TOOL.version}: deterministic flow review

  flow-review run [globs...] [--out report] [--shard k/n] [--fail-on any|none|<checks>] [--only <checks>]
                  [--times flows/flow-review-times.json] [--workers n] [--cells <keys>]
                  [--target <path|url>] [--target-version <v>] [--slack n] [--config <file>]
      Runs flows (default flows/**/*.flow.{ts,json}). Writes report/report.json, findings.jsonl, evidence/,
      moments/, judge-packet-<rubric>.json and summary.md. Exit 1 when a check named by --fail-on fails.
      --target fills \${target} in app.start, app.cdpUrl, app.cli and argv (default FLOW_REVIEW_TARGET, then the
      flow's app.target) and is recorded in report.json's provenance with its sha256 or version. --slack scales every
      maxMs. Known defects (a step's or flow's known) are reported but never fail the run. No retries, ever.
      A flow without its own app takes its surface's app and vars from the nearest flow-review.config.json
      (or --config).
      --cells keeps only cells whose key contains one of the given texts (390x844-light-rm, agent), for a quick local run.
  flow-review list [globs...] [--shard k/n] [--times file]
      Prints the units and how shards split them, without running anything.
  flow-review merge <report dirs...> [--out report] [--flows <glob>...] [--fail-on ...]
      Combines shard reports. Exit 3 unless every unit of --flows ran exactly once.
  flow-review times <report dirs...> [--out flows/flow-review-times.json]
      Records each unit's time from reports, to balance the next run's shards.
  flow-review moments [report dir] [--missing] [--json]
      Lists every empty, loading, error, first-run and success state the flows met, and whether each holds its
      Moment ([data-moment="<kind>"], or checks.moments.marker), with a stable moment-key for trackers.
  flow-review summary [report dir]
      Prints the markdown summary.
  flow-review judge --merge <rubric.json>... [--report report]
      Validates judges' rubric answers and folds them into report.json. Exit 2 when one is invalid.
  flow-review schema [flow|report|finding|rubric]
      Prints a published JSON Schema.
  flow-review validate [globs...]
      Loads and validates flows.

Environment: FLOW_REVIEW_TARGET, FLOW_REVIEW_TARGET_VERSION, FLOW_REVIEW_CHROMIUM (a Chromium executable), FLOW_REVIEW_CHANNEL (e.g. chrome), FLOW_REVIEW_WORKERS.`;

const list = (s) => (s ? s.split(',').map((x) => x.trim()).filter(Boolean) : undefined);

export async function main(argv) {
  const [cmd, ...rest] = argv;
  if (!cmd || cmd === '--help' || cmd === '-h' || cmd === 'help') { console.log(USAGE); return cmd ? 0 : 2; }
  if (cmd === '--version') { console.log(TOOL.version); return 0; }
  const { values: o, positionals: pos } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: {
      out: { type: 'string' }, shard: { type: 'string' }, 'fail-on': { type: 'string' }, only: { type: 'string' }, times: { type: 'string' },
      workers: { type: 'string' }, missing: { type: 'boolean' }, json: { type: 'boolean' }, cells: { type: 'string' }, target: { type: 'string' }, config: { type: 'string' }, 'target-version': { type: 'string' }, slack: { type: 'string' }, flows: { type: 'string', multiple: true }, merge: { type: 'boolean' }, report: { type: 'string' },
    },
  });
  const failOn = o['fail-on'] ?? 'any';
  const known = new Set([...CHECKS.ui, ...CHECKS.agent, 'step']);
  const unknown = [...(failOn === 'any' || failOn === 'none' ? [] : list(failOn) ?? []), ...(list(o.only) ?? [])].filter((c) => !known.has(c));
  if (unknown.length) { console.error(`unknown check ${unknown.join(', ')}; checks are ${[...known].join(', ')}`); return 2; }
  if (cmd === 'run' && !o.workers && process.env.FLOW_REVIEW_WORKERS && !/^[1-9]\d*$/.test(process.env.FLOW_REVIEW_WORKERS)) { console.error(`FLOW_REVIEW_WORKERS=${process.env.FLOW_REVIEW_WORKERS} is not a positive whole number`); return 2; }
  if (o.workers !== undefined && !/^[1-9]\d*$/.test(o.workers)) { console.error(`--workers ${o.workers} is not a positive whole number`); return 2; }
  if (cmd === 'run') {
    const report = await run({ globs: pos, out: o.out ?? 'report', config: o.config, shard: o.shard, failOn, only: list(o.only), times: o.times, workers: o.workers, cells: list(o.cells), target: o.target ?? (process.env.FLOW_REVIEW_TARGET || undefined), targetVersion: o['target-version'] ?? (process.env.FLOW_REVIEW_TARGET_VERSION || undefined), slack: o.slack ? Number(o.slack) : 1 });
    const s = report.summary;
    console.error(`flow-review: ${s.failures} failing of ${s.findings} findings, ${s.units} units, ${(report.ms / 1000).toFixed(1)} s -> ${o.out ?? 'report'}/report.json`);
    return report.exitCode;
  }
  if (cmd === 'list') {
    const units = unitsOf(await loadFlows(pos));
    const tf = o.times ?? (fs.existsSync(DEFAULT_TIMES) ? DEFAULT_TIMES : null);
    const total = parseShard(o.shard ?? '1/1').total;
    const parts = partition(units.map((u) => u.key), readTimes(tf), total);
    const guard = exactlyOnce(units.map((u) => u.key), parts.map((p) => p.keys));
    parts.forEach((p, i) => console.log(`shard ${i + 1}/${total}: ${p.keys.length} units, ~${(p.ms / 1000).toFixed(0)} s\n  ${p.keys.join('\n  ')}`));
    if (guard.missing.length || guard.duplicated.length) { console.error('shards do not cover every unit exactly once', guard); return 3; }
    return 0;
  }
  if (cmd === 'merge') {
    if (!pos.length) { console.error('merge needs report folders'); return 2; }
    const report = await merge({ dirs: pos, out: o.out ?? 'report', failOn, globs: o.flows });
    const c = report.coverage;
    console.error(`flow-review merge: ${report.summary.units} units from ${pos.length} reports, ${report.summary.failures} failing; missing ${c.missing.length}, duplicated ${c.duplicated.length}, unexpected ${c.unexpected.length}`);
    for (const k of [...c.missing, ...c.duplicated, ...c.unexpected]) console.error(`  ${k}`);
    return report.exitCode;
  }
  if (cmd === 'times') {
    process.stdout.write(times({ dirs: pos, out: o.out }));
    return 0;
  }
  if (cmd === 'moments') {
    const dir = pos[0] ?? 'report';
    const list = momentInventory(JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8'))).filter((m) => !o.missing || !m.hasMoment);
    if (o.json) console.log(JSON.stringify(list, null, 1));
    else for (const m of list) console.log(`${m.hasMoment ? 'has    ' : 'MISSING'} ${m.kind.padEnd(9)} ${m.flow} · ${m.selector} · "${m.label}" (${m.steps.join(', ')}; ${m.cells.length} cells)  moment-key: ${m.key}`);
    return 0;
  }
  if (cmd === 'summary') {
    const dir = pos[0] ?? 'report';
    process.stdout.write(markdown(JSON.parse(fs.readFileSync(path.join(dir, 'report.json'), 'utf8')), readFindings(dir)));
    return 0;
  }
  if (cmd === 'judge') {
    if (!o.merge || !pos.length) { console.error('usage: flow-review judge --merge <rubric.json>... [--report report]'); return 2; }
    const res = judgeMerge({ files: pos, report: o.report ?? 'report' });
    if (!res.ok) { console.error(`flow-review judge: not merged\n  ${res.problems.join('\n  ')}`); return 2; }
    console.error(`flow-review judge: ${res.judges} judges in report.json`);
    return 0;
  }
  if (cmd === 'schema') {
    const which = pos[0] ?? 'flow';
    if (!SCHEMAS[which]) { console.error(`no schema ${which}; one of ${Object.keys(SCHEMAS).join(', ')}`); return 2; }
    console.log(JSON.stringify(SCHEMAS[which], null, 2));
    return 0;
  }
  if (cmd === 'validate') {
    const loaded = await loadFlows(pos);
    for (const l of loaded) console.log(`ok ${l.file}: ${l.flow.name} (${l.flow.surface}, ${unitsOf([l]).length} units)`);
    return 0;
  }
  console.error(`unknown command ${cmd}\n\n${USAGE}`);
  return 2;
}
