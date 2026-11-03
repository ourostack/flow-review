// flow-review parity: run a parity spec through a product's adapter, print its table, its issue intents, or how it
// compares with a baseline.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { runParity, parityTable, parityIssues, parityCompare, parityBaseline, validateParitySpec, launchGuarded, guardContext, readOnlyLoopback } from './parity.mjs';
import { validate } from './schema.mjs';

export const PARITY_USAGE = `  flow-review parity run <spec.json> --adapter <module> [--out dir] [--samples n] [--only <ids>]
                         [--baseline <file>] [--write-baseline <file>]
      Runs a parity spec. The adapter module exports setup(helpers), which returns { records(name), page?, open?(page,
      opener, args), guard?, target?, salt?, close?() }; helpers are { launchGuarded, guardContext, readOnlyLoopback }. Writes
      <out>/parity.json (default parity) and prints the table. With --baseline, exit 1 when a capability the baseline
      passed no longer passes.
  flow-review parity validate <spec.json>
  flow-review parity table <parity.json>
  flow-review parity issues <parity.json> [--spec <spec.json>]
      Prints each gap and unread capability as one JSON line: key (stable, for dedupe), owner, title, counts-only body.
  flow-review parity compare <parity.json> --baseline <file>
      Prints regressions and improvements; exit 1 on a regression.`;

const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

export async function parityMain(argv) {
  const [sub, ...rest] = argv;
  const { values: o, positionals: pos } = parseArgs({
    args: rest,
    allowPositionals: true,
    options: { adapter: { type: 'string' }, out: { type: 'string' }, samples: { type: 'string' }, only: { type: 'string' }, baseline: { type: 'string' }, 'write-baseline': { type: 'string' }, spec: { type: 'string' } },
  });
  if (!sub || !pos[0]) { console.error(`usage:\n${PARITY_USAGE}`); return 2; }
  if (sub === 'validate') {
    const errors = validateParitySpec(readJson(pos[0]));
    if (errors.length) { console.error(errors.join('\n')); return 1; }
    console.log(`${pos[0]}: valid`);
    return 0;
  }
  if (sub === 'table' || sub === 'issues' || sub === 'compare') {
    const report = readJson(pos[0]);
    const errors = validate('parity-report', report);
    if (errors.length) { console.error(`${pos[0]} is not a parity report:\n  ${errors.join('\n  ')}`); return 2; }
    if (sub === 'table') { console.log(parityTable(report)); return 0; }
    if (sub === 'issues') {
      for (const i of parityIssues(report, o.spec ? readJson(o.spec) : null)) console.log(JSON.stringify(i));
      return 0;
    }
    if (!o.baseline) { console.error('compare needs --baseline <file>'); return 2; }
    return printCompare(parityCompare(report, readJson(o.baseline)));
  }
  if (sub !== 'run') { console.error(`unknown parity command ${sub}\n${PARITY_USAGE}`); return 2; }
  if (!o.adapter) { console.error('parity run needs --adapter <module>'); return 2; }
  const spec = readJson(pos[0]);
  const mod = await import(pathToFileURL(path.resolve(o.adapter)).href);
  const setup = mod.setup ?? mod.default?.setup ?? mod.default;
  if (typeof setup !== 'function') { console.error(`${o.adapter} exports no setup function`); return 2; }
  const samples = o.samples === undefined ? undefined : Number(o.samples);
  if (samples !== undefined && !(Number.isInteger(samples) && samples >= 1)) { console.error(`--samples ${o.samples} is not a whole number of at least 1`); return 2; }
  // Read before the run, so --write-baseline to the same file never compares a run with itself.
  const baseline = o.baseline ? readJson(o.baseline) : null;
  const a = await setup({ launchGuarded, guardContext, readOnlyLoopback });
  let report;
  try {
    report = await runParity({ spec, records: a.records, page: a.page ?? null, open: a.open ?? null, guard: a.guard ?? null, target: a.target ?? null, salt: a.salt ?? (process.env.FLOW_REVIEW_PARITY_SALT || undefined), samples, only: o.only ? o.only.split(',').map((s) => s.trim()) : null, log: (l) => console.error(l) });
  } finally {
    await a.close?.();
  }
  const out = o.out ?? 'parity';
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, 'parity.json'), `${JSON.stringify(report, null, 2)}\n`);
  console.log(parityTable(report));
  const code = baseline ? printCompare(parityCompare(report, baseline)) : 0;
  if (o['write-baseline']) fs.writeFileSync(o['write-baseline'], `${JSON.stringify(parityBaseline(report), null, 2)}\n`);
  return code;
}

function printCompare({ regressions, improvements }) {
  for (const r of regressions) console.log(`regression ${r.id}: ${r.was} -> ${r.now}`);
  for (const r of improvements) console.log(`improvement ${r.id}: ${r.was} -> ${r.now}`);
  if (!regressions.length) console.log(`no regressions${improvements.length ? `, ${improvements.length} improved (update the baseline)` : ''}`);
  return regressions.length ? 1 : 0;
}
