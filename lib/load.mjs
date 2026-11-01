// Finds flow files, loads them (.flow.ts through Node's type stripping, .flow.json as JSON) and validates them.
import fs from 'node:fs';
import path from 'node:path';
import module from 'node:module';
import { pathToFileURL } from 'node:url';
import { validate } from './schema.mjs';
import { CHECKS } from './constants.mjs';

export const DEFAULT_GLOBS = ['flows/**/*.flow.ts', 'flows/**/*.flow.json'];

let hooked = false;
/** Lets a flow file `import { defineFlow } from "@ourostack/flow-review"` without the product repo installing the package. */
function hookPackage() {
  if (hooked) return;
  hooked = true;
  const url = new URL('./index.mjs', import.meta.url).href;
  if (typeof module.registerHooks === 'function') {
    module.registerHooks({
      resolve(specifier, context, next) {
        return specifier === '@ourostack/flow-review' ? { url, shortCircuit: true } : next(specifier, context);
      },
    });
  } else {
    const hooks = `export async function resolve(s, c, n) { return s === '@ourostack/flow-review' ? { url: ${JSON.stringify(url)}, shortCircuit: true } : n(s, c); }`;
    module.register(`data:text/javascript,${encodeURIComponent(hooks)}`);
  }
}

/** Expands globs (relative to cwd) to sorted, unique, relative file paths. Brace sets like {ts,json} expand first. */
export function discover(globs, cwd = process.cwd()) {
  const expand = (g) => {
    const m = /\{([^{}]+)\}/.exec(g);
    return m ? m[1].split(',').flatMap((alt) => expand(g.slice(0, m.index) + alt + g.slice(m.index + m[0].length))) : [g];
  };
  const files = new Set();
  for (const g of (globs.length ? globs : DEFAULT_GLOBS).flatMap(expand)) {
    if (!/[*?[]/.test(g)) {
      if (fs.existsSync(path.resolve(cwd, g))) files.add(path.relative(cwd, path.resolve(cwd, g)).split(path.sep).join('/'));
      continue;
    }
    for (const f of fs.globSync(g, { cwd })) files.add(f.split(path.sep).join('/'));
  }
  return [...files].filter((f) => /\.flow\.(ts|mts|js|mjs|json)$/.test(f)).sort();
}

/** A RegExp in a TS flow (a target's name) becomes { regex, flags }, the JSON form. */
const plain = (v) => (v instanceof RegExp ? { regex: v.source, flags: v.flags } : Array.isArray(v) ? v.map(plain) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, plain(x)])) : v);

/** Loads and validates one flow file. Returns { file, dir, flow } or throws with every schema error. */
export async function loadFlow(file, cwd = process.cwd()) {
  const abs = path.resolve(cwd, file);
  let flow;
  if (file.endsWith('.json')) flow = JSON.parse(fs.readFileSync(abs, 'utf8'));
  else {
    hookPackage();
    const mod = await import(pathToFileURL(abs).href);
    flow = mod.default ?? mod.flow;
  }
  if (!flow || typeof flow !== 'object') throw new Error(`${file}: no flow (default-export defineFlow({...}))`);
  flow = plain(flow);
  const errors = validate('flow', flow);
  if (errors.length) throw new Error(`${file} is not a valid flow-review/0 flow:\n  ${errors.join('\n  ')}`);
  flow.name ??= flow.id ? `${flow.id} ${flow.title}` : flow.title;
  return { file, dir: path.dirname(abs), flow };
}

export async function loadFlows(globs, cwd = process.cwd()) {
  const files = discover(globs, cwd);
  if (!files.length) throw new Error(`no flow files match ${(globs.length ? globs : DEFAULT_GLOBS).join(' ')}`);
  const out = [];
  const names = new Map();
  for (const f of files) {
    const l = await loadFlow(f, cwd);
    if (names.has(l.flow.name)) throw new Error(`${f}: flow name "${l.flow.name}" is also used by ${names.get(l.flow.name)}`);
    names.set(l.flow.name, f);
    out.push(l);
  }
  return out;
}

export const CONFIG_NAME = 'flow-review.config.json';

/** The nearest flow-review.config.json from a flow's folder up to cwd, or the one given. */
export function configFor(file, cwd, given) {
  const read = (f) => {
    const c = JSON.parse(fs.readFileSync(f, 'utf8'));
    const errors = validate('config', c);
    if (errors.length) throw new Error(`${path.relative(cwd, f)} is not a valid flow-review-config/0:\n  ${errors.join('\n  ')}`);
    return c;
  };
  if (given) return read(path.resolve(cwd, given));
  const top = path.resolve(cwd);
  for (let d = path.dirname(path.resolve(cwd, file)); ; d = path.dirname(d)) {
    const rel = path.relative(top, d);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    const f = path.join(d, CONFIG_NAME);
    if (fs.existsSync(f)) return read(f);
    if (d === top) return null;
  }
}

export const DEFAULT_TIMEOUTS = Object.freeze({ cellMs: 120_000, stepMs: 60_000 });

/**
 * A flow's time limits and what fails it: the flow's own, over its surface's in the config, over the config's own.
 * `failOn` is undefined when none of them sets it (the run's --fail-on applies).
 */
export function policyOf(flow, config) {
  const surface = config?.surfaces?.[flow.surface] ?? {};
  const timeouts = { ...DEFAULT_TIMEOUTS, ...config?.timeouts, ...surface.timeouts, ...flow.timeouts };
  // Without a cellMs of its own, a flow whose steps ask to wait longer than the default gets that wait and 30 s more.
  if (timeouts.cellMs === DEFAULT_TIMEOUTS.cellMs && ![config?.timeouts, surface.timeouts, flow.timeouts].some((t) => t?.cellMs !== undefined)) {
    const longest = Math.max(0, ...(flow.steps ?? []).map((s) => Math.max(s.waitFor?.ms ?? 0, s.timeoutMs ?? 0)));
    timeouts.cellMs = Math.max(timeouts.cellMs, longest + 30_000);
  }
  const failOn = flow.failOn ?? surface.failOn ?? config?.failOn;
  if (failOn !== undefined && failOn !== 'any' && failOn !== 'none') {
    const unknown = failOn.split(',').filter((c) => ![...CHECKS.ui, ...CHECKS.agent, 'step', 'timeout'].includes(c));
    if (unknown.length) throw new Error(`flow "${flow.name}" fails on unknown check ${unknown.join(', ')}`);
  }
  return { timeouts, failOn };
}

/**
 * Readies a loaded flow to run: a flow without its own `app` takes its surface's from the config, with the config's
 * `vars` under the flow's own, and its time limits and failOn (policyOf); then ${target} (the run's, else app.target),
 * ${workdir} (this run's scratch folder) and ${flow.<field>:-default} are filled everywhere. ${start.<key>} waits for
 * the app to announce it.
 */
export function prepare(flow, { target, workdir, config } = {}) {
  const defaults = config?.surfaces?.[flow.surface] ?? {};
  const { timeouts, failOn } = policyOf(flow, config);
  const merged = { ...flow, app: flow.app ?? defaults.app, vars: { ...defaults.vars, ...flow.vars }, timeouts, ...(failOn !== undefined ? { failOn } : {}), ...(config?.checkAliases ? { checkAliases: config.checkAliases } : {}) };
  if (!merged.app) delete merged.app;
  const t = target ?? merged.app?.target;
  let used = false;
  const sub = (v) => {
    if (typeof v === 'string') {
      if (v.includes('${target}')) used = true;
      return v
        .replace(/\$\{target\}/g, (all) => t ?? all)
        .replace(/\$\{workdir\}/g, workdir ?? '${workdir}')
        .replace(/\$\{flow\.(\w+)(?::-([^}]*))?\}/g, (all, k, d) => (typeof flow[k] === 'string' || typeof flow[k] === 'number' ? String(flow[k]) : d ?? ''));
    }
    if (Array.isArray(v)) return v.map(sub);
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [sub(k), sub(x)]));
    return v;
  };
  const out = sub(merged);
  if (used && t === undefined) throw new Error(`flow "${flow.name}" runs \${target}: pass --target <path|url>, set FLOW_REVIEW_TARGET, or give app.target`);
  return { flow: out, target: used ? t : undefined };
}

export const withTarget = (flow, target) => prepare(flow, { target });
