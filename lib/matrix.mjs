// The matrix: every flow × engine × viewport × theme × reduced-motion cell is one unit of work, and shards split the units.
import fs from 'node:fs';
import { DEFAULT_ENGINE, speaksCdp } from './engines.mjs';

export const DEFAULT_TIMES = 'flows/flow-review-times.json';
/** What a unit with no recorded time is assumed to take, when no unit has one. */
export const DEFAULT_MS = 30_000;

const isAgent = (surface) => surface === 'agent-cli' || surface === 'agent-http';
export const sideOf = (surface) => (isAgent(surface) ? 'agent' : 'human');

/**
 * The engines a flow runs on in a run naming `engines`: all of them, less those the flow's matrix.engines leaves out,
 * and, for a cdp flow (attached over the DevTools protocol), less WebKit. `notRun` says which were left out and why.
 */
export function enginesOf(flow, engines = [DEFAULT_ENGINE]) {
  if (isAgent(flow.surface)) return { run: [], notRun: [] };
  const pinned = flow.matrix?.engines;
  const run = [];
  const notRun = [];
  for (const e of engines) {
    if (pinned && !pinned.includes(e)) notRun.push({ engine: e, why: `the flow's matrix.engines is ${pinned.join(', ')}` });
    else if (flow.surface === 'cdp' && !speaksCdp(e)) notRun.push({ engine: e, why: 'a cdp flow attaches over the DevTools protocol, which this engine does not speak' });
    else run.push(e);
  }
  return { run, notRun };
}

export function cellsOf(flow, engines = [DEFAULT_ENGINE]) {
  if (isAgent(flow.surface)) return [null];
  const m = flow.matrix ?? {};
  const out = [];
  for (const engine of enginesOf(flow, engines).run) {
    // The config's engines.<engine>.cells: the cells that engine runs in, by name.
    const only = flow.engineCells?.[engine]?.cells;
    for (const viewport of m.viewports ?? ['1280x800']) for (const theme of m.themes ?? ['light']) for (const reducedMotion of m.reducedMotion ?? [false]) {
      if (!only || only.includes(`${viewport}-${theme}${reducedMotion ? '-rm' : ''}`)) out.push({ viewport, theme, reducedMotion, engine });
    }
  }
  return out;
}

/** The cells of a flow's matrix an engine leaves out under the config's engines.<engine>.cells, by name. */
export function trimmedOf(flow, engine) {
  const only = flow.engineCells?.[engine]?.cells;
  if (!only || isAgent(flow.surface)) return [];
  const m = flow.matrix ?? {};
  const out = [];
  for (const viewport of m.viewports ?? ['1280x800']) for (const theme of m.themes ?? ['light']) for (const reducedMotion of m.reducedMotion ?? [false]) {
    const name = `${viewport}-${theme}${reducedMotion ? '-rm' : ''}`;
    if (!only.includes(name)) out.push(name);
  }
  return out;
}

/** The engine a cell ran on: a cell from before engines (no engine) ran on Chromium. */
export const engineOfCell = (cell) => (cell ? cell.engine ?? DEFAULT_ENGINE : null);
// Chromium's keys are as they were before engines, so recorded times and earlier reports still match.
export const cellKey = (cell) => (cell ? `${cell.viewport}-${cell.theme}${cell.reducedMotion ? '-rm' : ''}${engineOfCell(cell) !== DEFAULT_ENGINE ? `@${cell.engine}` : ''}` : 'agent');
export const unitKey = (file, cell) => `${file}#${cellKey(cell)}`;

/** Every unit of the loaded flows on these engines, in a stable order. */
export function unitsOf(loaded, engines = [DEFAULT_ENGINE]) {
  return loaded.flatMap(({ file, flow }) => cellsOf(flow, engines).map((cell) => ({ key: unitKey(file, cell), file, flow, cell })));
}

/** The browser flows that leave out an engine the run names, by engine: { webkit: [{ flow, file, why }] }. */
export function notRunByEngine(loaded, engines = [DEFAULT_ENGINE]) {
  const out = {};
  for (const { file, flow } of loaded) {
    const e = enginesOf(flow, engines);
    for (const n of e.notRun) (out[n.engine] ??= []).push({ flow: flow.name, file, why: n.why });
    for (const engine of e.run) {
      const left = trimmedOf(flow, engine);
      if (left.length) (out[engine] ??= []).push({ flow: flow.name, file, why: `the config's engines.${engine}.cells is ${flow.engineCells[engine].cells.join(', ')}`, cells: left });
    }
  }
  return out;
}

export function parseShard(text) {
  if (!text) return { index: 1, total: 1 };
  const m = /^(\d+)\/(\d+)$/.exec(text);
  const [index, total] = m ? [Number(m[1]), Number(m[2])] : [0, 0];
  if (!m || total < 1 || index < 1 || index > total) throw new Error(`--shard ${text} is not k/n with 1 <= k <= n`);
  return { index, total };
}

/**
 * Splits units into `total` shards of about equal time: longest first, each into the shard with least so far (ties to
 * the lower shard), keys breaking ties in time. A unit with no recorded time counts as the median recorded time, or
 * DEFAULT_MS when nothing is recorded, so a first run splits by count. Every unit lands in exactly one shard.
 */
export function partition(keys, times, total) {
  if (!Number.isInteger(total) || total < 1) throw new Error(`shard total ${total} is not a positive whole number`);
  const known = keys.map((k) => times[k]).filter((v) => typeof v === 'number' && v >= 0).sort((a, b) => a - b);
  const fallback = known.length ? known[Math.floor(known.length / 2)] : DEFAULT_MS;
  const ms = (k) => (typeof times[k] === 'number' && times[k] >= 0 ? times[k] : fallback);
  const order = [...new Set(keys)].sort((a, b) => ms(b) - ms(a) || (a < b ? -1 : a > b ? 1 : 0));
  const shards = Array.from({ length: total }, () => ({ ms: 0, keys: [] }));
  for (const k of order) {
    let least = shards[0];
    for (const s of shards) if (s.ms < least.ms) least = s;
    least.keys.push(k);
    least.ms += ms(k);
  }
  return shards.map((s) => ({ ms: s.ms, keys: s.keys.sort() }));
}

export function readTimes(file) {
  if (!file || !fs.existsSync(file)) return {};
  const t = JSON.parse(fs.readFileSync(file, 'utf8'));
  return t && typeof t === 'object' ? t.units ?? t : {};
}

/** The units of one shard. */
export function shardUnits(units, shard, times) {
  const parts = partition(units.map((u) => u.key), times, shard.total);
  const mine = new Set(parts[shard.index - 1].keys);
  return { units: units.filter((u) => mine.has(u.key)), parts };
}

/** Checks a set of shard key lists covers `expected` exactly once each. Returns { missing, duplicated, unexpected }. */
export function exactlyOnce(expected, shardKeys) {
  const seen = new Map();
  for (const keys of shardKeys) for (const k of keys) seen.set(k, (seen.get(k) ?? 0) + 1);
  const exp = new Set(expected);
  return {
    missing: [...exp].filter((k) => !seen.has(k)).sort(),
    duplicated: [...seen].filter(([k, n]) => n > 1 && exp.has(k)).map(([k]) => k).sort(),
    unexpected: [...seen.keys()].filter((k) => !exp.has(k)).sort(),
  };
}
