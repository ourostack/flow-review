// The known-failing list: cells that fail on an engine today, each with its issue and owner, in the shape the basics
// gate and the window tests use ({ about, enforce?, entries: [{ case, legs, issue, owner, why, until? }] }). A case is a
// flow file (every cell of the flow) or `<file>:<cell name>` (split at the first `.flow.<ext>:`, since names hold colons);
// legs are engines. A listed cell's failing findings are reported as known (they never fail the run); a listed case that
// passes, or no longer runs, is a failing `known` finding, so the entry comes off. The list only shrinks against the
// base branch's (`flow-review known-failing --check <file> --base <file>`). Nothing is skipped and no limit loosened.
import fs from 'node:fs';
import path from 'node:path';
import { ENGINES } from './engines.mjs';
import { engineOfCell } from './matrix.mjs';

export const DEFAULT_KNOWN_FAILING = 'flows/flow-review-known-failing.json';

/** Splits a case at its first `.flow.<ext>:`: { file, cell } (cell null for a whole flow). */
export function caseOf(c) {
  const m = /\.flow\.(?:ts|mts|js|mjs|json):/.exec(c);
  return m ? { file: c.slice(0, m.index + m[0].length - 1), cell: c.slice(m.index + m[0].length) } : { file: c, cell: null };
}

/** A cell's name in a case: its key without the engine (the engine is the leg). */
export const cellName = (cell) => `${cell.viewport}-${cell.theme}${cell.reducedMotion ? '-rm' : ''}`;

/** What is wrong with a list: each entry names a case, engines as legs, an issue (#N), an owner and why. */
export function malformed(list) {
  const out = [];
  if (!list || typeof list !== 'object' || !Array.isArray(list.entries)) return ['the list needs an entries array'];
  if ('enforce' in list && typeof list.enforce !== 'boolean') out.push('enforce is true or false');
  const seen = new Set();
  for (const [i, e] of list.entries.entries()) {
    const at = `entry ${i + 1} (${e?.case})`;
    if (typeof e?.case !== 'string' || !e.case.trim()) { out.push(`entry ${i + 1}: names no case`); continue; }
    if (!Array.isArray(e.legs) || !e.legs.length) out.push(`${at}: names no leg`);
    for (const l of e.legs ?? []) {
      if (!ENGINES.includes(l)) out.push(`${at}: leg "${l}" is not an engine (${ENGINES.join(', ')})`);
      if (seen.has(`${e.case}@${l}`)) out.push(`${at}: ${e.case} on ${l} is listed twice`);
      seen.add(`${e.case}@${l}`);
    }
    if (!/^#\d+$/.test(e.issue ?? '')) out.push(`${at}: its issue must be #N`);
    if (!e.owner?.trim?.()) out.push(`${at}: names no owner`);
    if (!e.why?.trim?.()) out.push(`${at}: says no why`);
    if (e.until !== undefined && (typeof e.until !== 'string' || !e.until.trim())) out.push(`${at}: until names a file`);
  }
  return out;
}

/** Reads and checks a list; null when `file` is unset or (for the default) absent. Throws on a malformed list. */
export function readKnownFailing(file, cwd = process.cwd(), { required = true } = {}) {
  if (!file) return null;
  const abs = path.resolve(cwd, file);
  if (!fs.existsSync(abs)) {
    if (required) throw new Error(`known-failing list ${file} doesn't exist`);
    return null;
  }
  const list = JSON.parse(fs.readFileSync(abs, 'utf8'));
  const bad = malformed(list);
  if (bad.length) throw new Error(`${file} is not a valid known-failing list:\n  ${bad.join('\n  ')}`);
  return { ...list, file: path.relative(cwd, abs).split(path.sep).join('/') };
}

/** The entry (and leg) a unit falls under, or null. */
export function entryFor(list, unitFile, cell) {
  const engine = engineOfCell(cell);
  if (!list || !engine) return null;
  return list.entries.find((e) => e.legs.includes(engine) && (({ file, cell: c }) => file === unitFile && (c === null || c === cellName(cell)))(caseOf(e.case))) ?? null;
}

/** Marks the failing findings of listed cells known (their entry's issue), in place. Returns how many it marked. */
export function markKnown(list, findings, fileOfFlow) {
  let n = 0;
  if (!list) return n;
  for (const f of findings) {
    if (f.pass || f.advisory || f.known || !f.cell || f.check === 'known') continue;
    const e = entryFor(list, fileOfFlow(f.flow), f.cell);
    if (e) { f.known = e.issue; f.knownCase = e.case; n++; }
  }
  return n;
}

/**
 * Each listed case and leg, against the units that ran (all of them: an unsharded run, or a merge): a case none of
 * whose cells ran on that leg no longer runs, and one whose cells have no failure left passes. Either is a failing
 * `known` finding (advisory when the list's enforce is false), naming the entry to take off.
 */
export function knownVerdict(list, units, findings, ran = null, engines = null) {
  if (!list) return { findings: [], summary: null };
  const out = [];
  const summary = { file: list.file ?? null, enforce: list.enforce !== false, entries: list.entries.length, failing: 0, passes: [], notRun: [], notJudged: [] };
  for (const e of list.entries) {
    const { file, cell } = caseOf(e.case);
    for (const leg of e.legs) {
      // A leg the run didn't name (a Chromium-only run, say) isn't judged here.
      if (engines && !engines.includes(leg)) { summary.notJudged.push(`${e.case}@${leg}`); continue; }
      const mine = units.filter((u) => u.cell && engineOfCell(u.cell) === leg && u.file === file && (cell === null || cellName(u.cell) === cell));
      const flow = mine[0]?.flow ?? file;
      const base = { flow, step: 'known-failing', surface: mine[0]?.surface ?? 'web', cell: mine[0]?.cell ?? null, check: 'known', pass: false, threshold: 'a listed case still runs and still fails', ms: 0, knownCase: e.case, ...(summary.enforce ? {} : { advisory: true }) };
      if (!mine.length) {
        summary.notRun.push(`${e.case}@${leg}`);
        out.push({ ...base, measured: `${e.case} on ${leg} (${e.issue}) no longer runs`, fix: `Take ${e.case} on ${leg} off ${list.file ?? 'the known-failing list'}: no cell of it ran (the flow or cell is gone, or the run doesn't name ${leg}).` });
        continue;
      }
      // A cell expected but missing (a cancelled shard) is a coverage finding already: no verdict on it here.
      if (ran && mine.some((u) => !ran.has(u.key))) continue;
      const keys = new Set(mine.map((u) => `${u.flow}\u0000${JSON.stringify(u.cell)}`));
      const still = findings.some((f) => !f.pass && !f.advisory && f.check !== 'known' && f.known === e.issue && f.knownCase === e.case && keys.has(`${f.flow}\u0000${JSON.stringify(f.cell)}`));
      if (still) summary.failing++;
      else {
        summary.passes.push(`${e.case}@${leg}`);
        out.push({ ...base, measured: `${e.case} on ${leg} (${e.issue}) passes now`, fix: `Take ${e.case} on ${leg} off ${list.file ?? 'the known-failing list'}, and close or update ${e.issue}: it passes.` });
      }
    }
  }
  return { findings: out, summary };
}

/** Pairs (case@leg) a list has that its base didn't: the list may only shrink. */
export function grown(list, base) {
  const pairs = (l) => new Set((l?.entries ?? []).flatMap((e) => e.legs.map((leg) => `${e.case}@${leg}`)));
  if (!base) return [];
  const had = pairs(base);
  return [...pairs(list)].filter((p) => !had.has(p));
}
