// The matrix: every flow × viewport × theme × reduced-motion cell is one unit of work, and shards split the units.
import fs from 'node:fs';

export const DEFAULT_TIMES = 'flows/flow-review-times.json';
/** What a unit with no recorded time is assumed to take, when no unit has one. */
export const DEFAULT_MS = 30_000;

const isAgent = (surface) => surface === 'agent-cli' || surface === 'agent-http';
export const sideOf = (surface) => (isAgent(surface) ? 'agent' : 'human');

export function cellsOf(flow) {
  if (isAgent(flow.surface)) return [null];
  const m = flow.matrix ?? {};
  const out = [];
  for (const viewport of m.viewports ?? ['1280x800']) for (const theme of m.themes ?? ['light']) for (const reducedMotion of m.reducedMotion ?? [false]) out.push({ viewport, theme, reducedMotion });
  return out;
}

export const cellKey = (cell) => (cell ? `${cell.viewport}-${cell.theme}${cell.reducedMotion ? '-rm' : ''}` : 'agent');
export const unitKey = (file, cell) => `${file}#${cellKey(cell)}`;

/** Every unit of the loaded flows, in a stable order. */
export function unitsOf(loaded) {
  return loaded.flatMap(({ file, flow }) => cellsOf(flow).map((cell) => ({ key: unitKey(file, cell), file, flow, cell })));
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
