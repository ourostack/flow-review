// Capability parity: does a product meet a floor of capabilities and interaction models on the data its person really
// has? A parity spec (schema/parity-0.schema.json) names surfaces and their capabilities. Each capability pairs a data
// detector (which of the records the product already reads call for it) with a floor: data checks over those records,
// and checks through stable hooks (ARIA, data-* attributes) on the product's page with a sample of them open. It compares
// capability, not pixels.
//
// The run is read-only and private by construction: the product hands over its records and a way to open one in its
// page; the guard (guardContext) aborts every request but the ones the product allows (by default, GET and HEAD to this
// computer); and the report keeps counts, capability ids and salted hashes of record keys, never a record's text, a
// name, an id or a picture.
import { createHash } from 'node:crypto';
import { validate } from './schema.mjs';
import { TOOL } from './report.mjs';

export const PARITY_STATUSES = Object.freeze(['pass', 'gap', 'unread', 'not-present']);
const DEFAULT_SAMPLES = 3;
const DEFAULT_WAIT_MS = 4000;
const LOOPBACK = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);

// ---------------------------------------------------------------------------------------------------------------------
// Records and detectors

/** The value at a dotted path ("sender.displayName"); a number segment indexes an array. */
export function valueAt(record, path) {
  let v = record;
  for (const part of String(path).split('.')) {
    if (v === null || v === undefined) return undefined;
    v = v[part];
  }
  return v;
}

const present = (v) => v !== undefined && v !== null && !(typeof v === 'string' && v === '') && !(Array.isArray(v) && v.length === 0);

/** Every object anywhere under `v` (itself included), depth first. */
function* objectsUnder(v, depth = 0) {
  if (depth > 64 || v === null || typeof v !== 'object') return;
  if (!Array.isArray(v)) yield v;
  for (const x of Array.isArray(v) ? v : Object.values(v)) yield* objectsUnder(x, depth + 1);
}

/** Whether a record meets one condition of a detector's `where` (or a data floor's). */
export function meets(record, c) {
  if (c.anyOf) return c.anyOf.some((alt) => (Array.isArray(alt) ? alt : [alt]).every((x) => meets(record, x)));
  if (c.not) return !(Array.isArray(c.not) ? c.not : [c.not]).every((x) => meets(record, x));
  const v = c.path === undefined || c.path === '' ? record : valueAt(record, c.path);
  if ('exists' in c && present(v) !== c.exists) return false;
  if ('eq' in c && v !== c.eq) return false;
  if ('ne' in c && v === c.ne) return false;
  if ('in' in c && !c.in.includes(v)) return false;
  if ('notIn' in c && c.notIn.includes(v)) return false;
  if ('gte' in c && !(typeof v === 'number' && v >= c.gte)) return false;
  if ('lte' in c && !(typeof v === 'number' && v <= c.lte)) return false;
  if ('match' in c && !(typeof v === 'string' && new RegExp(c.match, c.flags ?? '').test(v))) return false;
  if ('minItems' in c && !(Array.isArray(v) && v.length >= c.minItems)) return false;
  // some: an item of the array at path meets every inner condition; deep: any object anywhere under path does.
  if ('some' in c && !(Array.isArray(v) && v.some((item) => c.some.every((x) => meets(item, x))))) return false;
  if ('deep' in c) {
    let found = false;
    for (const o of objectsUnder(v)) if (c.deep.every((x) => meets(o, x))) { found = true; break; }
    if (!found) return false;
  }
  return true;
}

const meetsAll = (record, where = []) => where.every((c) => meets(record, c));

/** A salted, shortened sha256 of a record's key: stable within a salt, and never the key itself. */
export const hashKey = (key, salt = '') => `h:${createHash('sha256').update(`${salt}\u0000${String(key)}`).digest('hex').slice(0, 12)}`;

/** What a detector finds in its records: the matching ones, and whether the records carry the fields it needs at all. */
export function detect(detector, records) {
  const list = Array.isArray(records) ? records : [];
  const scoped = list.filter((r) => meetsAll(r, detector.scope));
  // With nothing in scope there is no evidence either way: not present, never unread.
  const unread = scoped.length ? (detector.requires ?? []).filter((p) => !scoped.some((r) => present(valueAt(r, p)))) : [];
  const found = unread.length ? [] : scoped.filter((r) => meetsAll(r, detector.where));
  return { scoped: scoped.length, found, unread };
}

/** The first `n` records by their hashed key: the same records every run on the same data, whatever order they came in. */
export function pickSamples(found, { key = 'id', n = DEFAULT_SAMPLES, salt = '' } = {}) {
  return found
    // A record without its key is keyed by its whole content, so the order it came in still doesn't matter.
    .map((r) => { const k = valueAt(r, key); return { r, h: hashKey(present(k) ? k : `record:${JSON.stringify(r)}`, salt) }; })
    .sort((a, b) => (a.h < b.h ? -1 : a.h > b.h ? 1 : 0))
    .slice(0, n);
}

// ---------------------------------------------------------------------------------------------------------------------
// The page: a guard that keeps it read-only, and the floor's hook checks

const isLoopback = (url) => {
  try {
    const u = new URL(url);
    if (u.protocol === 'data:' || u.protocol === 'blob:' || u.protocol === 'about:') return true;
    return LOOPBACK.has(u.hostname);
  } catch {
    return false;
  }
};

/** The default rule: only reads (GET, HEAD) of this computer, plus data:, blob: and about: URLs. */
export const readOnlyLoopback = ({ url, method }) => isLoopback(url) && (method === 'GET' || method === 'HEAD' || url.startsWith('data:') || url.startsWith('blob:'));

/**
 * Installs the read-only guard on a Playwright browser context, before any page opens: every request and web socket
 * the rule doesn't allow is aborted. Returns live counts (allowed, blocked by method and by "remote" or "local"), never
 * a URL. `allow({ url, method, resourceType })` decides; the default allows only reads of this computer.
 */
export async function guardContext(context, { allow = readOnlyLoopback } = {}) {
  const counts = { allowed: 0, blocked: 0, blockedByMethod: {}, blockedRemote: 0, blockedLocal: 0, sockets: { allowed: 0, blocked: 0 }, escaped: 0 };
  const allows = (ask) => { try { return !!allow(ask); } catch { return false; } };
  // What a route can't stop is counted as escaped, and runParity refuses a report with any: a redirect's later hops
  // (Playwright routes only a redirect chain's first request) and a service worker's fetches (contexts must block them).
  context.on('request', (req) => {
    if (req.redirectedFrom() && !allows({ url: req.url(), method: req.method(), resourceType: req.resourceType() })) counts.escaped++;
  });
  context.on('serviceworker', () => { counts.escaped++; });
  await context.route('**/*', async (route) => {
    const req = route.request();
    const ask = { url: req.url(), method: req.method(), resourceType: req.resourceType() };
    if (allows(ask)) { counts.allowed++; return route.continue(); }
    counts.blocked++;
    counts.blockedByMethod[ask.method] = (counts.blockedByMethod[ask.method] ?? 0) + 1;
    if (isLoopback(ask.url)) counts.blockedLocal++; else counts.blockedRemote++;
    return route.abort('blockedbyclient');
  });
  if (typeof context.routeWebSocket === 'function') {
    await context.routeWebSocket(/.*/, (ws) => {
      if (allows({ url: ws.url(), method: 'WEBSOCKET', resourceType: 'websocket' })) { counts.sockets.allowed++; ws.connectToServer(); return; }
      counts.sockets.blocked++;
      ws.close({ code: 1008, reason: 'read-only' });
    });
  }
  return counts;
}

const cssString = (v) => String(v).replace(/[\\"]/g, (ch) => `\\${ch}`).replace(/\n/g, '\\a ');

/** A selector or step text with ${name} filled from a sample's arguments, quoted for use inside a CSS string. */
export function fill(text, args = {}) {
  return String(text).replace(/\$\{([A-Za-z_][\w]*)\}/g, (_, k) => (k in args ? cssString(args[k]) : ''));
}

/** Runs one step on the page; throws when it can't. */
async function step(page, s, args, waitMs) {
  if (s.click) await page.locator(fill(s.click, args)).first().click({ timeout: s.timeoutMs ?? waitMs });
  else if (s.hover) await page.locator(fill(s.hover, args)).first().hover({ timeout: s.timeoutMs ?? waitMs });
  else if (s.focus) await page.locator(fill(s.focus, args)).first().focus({ timeout: s.timeoutMs ?? waitMs });
  else if (s.press) await page.keyboard.press(s.press);
  else if (s.waitFor) await page.locator(fill(s.waitFor, args)).first().waitFor({ state: 'attached', timeout: s.timeoutMs ?? waitMs });
  else if (s.waitMs) await page.waitForTimeout(Math.min(s.waitMs, 10000));
}

/**
 * Checks one hook expectation on the page. Returns null when it holds, else why not: "missing" (too few), "extra" (too
 * many), "attr" (an attribute differs) or "text" (an element's text is one the floor rules out). Text is compared in
 * the page and never leaves it.
 */
export async function expectHook(page, e, args = {}, waitMs = DEFAULT_WAIT_MS) {
  const sel = fill(e.selector, args);
  const loc = page.locator(sel);
  const min = e.min ?? 1;
  if (min > 0) {
    try { await loc.nth(min - 1).waitFor({ state: 'attached', timeout: e.timeoutMs ?? waitMs }); } catch { return 'missing'; }
  }
  const n = await loc.count();
  if (n < min) return 'missing';
  if (e.max !== undefined && n > e.max) return 'extra';
  if (e.attr || e.textNot || e.visible) {
    const verdict = await loc.evaluateAll((els, { attr, textNot, visible }) => {
      for (const el of els) {
        if (attr) for (const [name, want] of Object.entries(attr)) {
          const have = el.getAttribute(name);
          if (want === null ? have !== null : want === true ? have === null : have !== want) return 'attr';
        }
        if (textNot) {
          const t = (el.textContent ?? '').trim();
          if (textNot.some((x) => t === x)) return 'text';
        }
        if (visible) {
          const r = el.getBoundingClientRect();
          if (!(r.width > 0 && r.height > 0)) return 'hidden';
        }
      }
      return null;
    }, { attr: e.attr ?? null, textNot: e.textNot ?? null, visible: !!e.visible });
    if (verdict) return verdict;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// The run

/** Validates a parity spec; returns readable errors (empty when valid), with ids checked for uniqueness. */
export function validateParitySpec(spec) {
  const errors = validate('parity', spec);
  if (errors.length) return errors;
  const seen = new Set();
  for (const s of spec.surfaces) for (const c of s.capabilities) {
    const id = `${s.id}/${c.id}`;
    if (seen.has(id)) errors.push(`/surfaces duplicate capability ${id}`);
    seen.add(id);
    const floors = new Set();
    for (const f of c.floor) { if (floors.has(f.id)) errors.push(`/surfaces ${id} duplicate floor ${f.id}`); floors.add(f.id); }
  }
  return errors;
}

const specHash = (spec) => createHash('sha256').update(JSON.stringify(spec)).digest('hex').slice(0, 16);

/**
 * Runs a parity spec. `records(name)` returns the product's records of one kind (it is asked once per name); `page` is
 * a Playwright page behind guardContext, needed only when some floor checks hooks; `open(page, opener, args)` shows one
 * record in it (the product's own navigation: a route, a click, a call to its local API). Returns the report object
 * (schema/parity-report-0.schema.json): per capability its status, counts and floors, and the salted hashes of the
 * records it opened.
 */
export async function runParity({ spec, records, page = null, open = null, samples, salt, guard = null, target = null, waitMs = DEFAULT_WAIT_MS, only = null, log = () => {} }) {
  const errors = validateParitySpec(spec);
  if (errors.length) throw new Error(`parity spec ${spec?.name ?? ''} is not valid:\n  ${errors.join('\n  ')}`);
  if (samples !== undefined && !(Number.isInteger(samples) && samples >= 1)) throw new Error(`samples must be a whole number of at least 1, not ${samples}`);
  const startedAt = new Date();
  // The salt keys the hashes: pass a secret one, kept stable on this machine, so a hash can't be checked against a
  // guessed id. Without one, the spec's name is used, which only keeps the hashes stable.
  const saltUsed = salt ?? spec.name;
  const cache = new Map();
  const recordsOf = async (name) => {
    if (!cache.has(name)) cache.set(name, Promise.resolve(records(name)).then((r) => (Array.isArray(r) ? r : [])));
    return cache.get(name);
  };
  const results = [];
  for (const surface of spec.surfaces) {
    for (const cap of surface.capabilities) {
      const id = `${surface.id}/${cap.id}`;
      if (only && !only.some((o) => id === o || id.startsWith(`${o}/`) || surface.id === o)) continue;
      const t0 = Date.now();
      const list = await recordsOf(cap.detect.records);
      const { scoped, found, unread } = detect(cap.detect, list);
      const result = {
        surface: surface.id, capability: cap.id, title: cap.title, owner: cap.owner ?? surface.owner ?? null,
        status: 'not-present', scoped, detected: found.length, checked: 0, passed: 0, floors: [], samples: [], ms: 0,
      };
      if (unread.length) { result.status = 'unread'; result.unread = unread; }
      else if (found.length) {
        const floors = cap.floor.map((f) => ({ id: f.id, kind: f.data ? 'data' : 'hook', pass: 0, fail: 0, reasons: {} }));
        const tally = (i, why) => {
          if (why) { floors[i].fail++; floors[i].reasons[why] = (floors[i].reasons[why] ?? 0) + 1; } else floors[i].pass++;
        };
        // Data floors: over every detected record.
        cap.floor.forEach((f, i) => {
          if (!f.data) return;
          const ok = found.filter((r) => meetsAll(r, f.data.where)).length;
          const ratio = ok / found.length;
          floors[i].pass = ok;
          floors[i].fail = found.length - ok;
          floors[i].ratio = Math.round(ratio * 10000) / 10000;
          floors[i].min = f.data.min ?? 1;
          if (ratio < floors[i].min) floors[i].reasons.ratio = 1;
        });
        // Hook floors: on a sample, opened in the page.
        const hookFloors = cap.floor.map((f, i) => [f, i]).filter(([f]) => !f.data);
        let samplesOk = 0;
        if (hookFloors.length) {
          const picked = pickSamples(found, { key: cap.detect.key ?? 'id', n: cap.samples ?? samples ?? spec.samples ?? DEFAULT_SAMPLES, salt: saltUsed });
          for (const { r, h } of picked) {
            result.samples.push(h);
            result.checked++;
            const args = Object.fromEntries(Object.entries(cap.open?.args ?? {}).map(([k, p]) => [k, valueAt(r, p)]));
            let opened = true;
            if (!page || !open) opened = false;
            else {
              try { await open(page, cap.open?.with ?? cap.detect.records, args); } catch (e) { opened = false; log(`${id}: open failed (${String(e?.message ?? e).split('\n')[0].slice(0, 80)})`); }
            }
            let all = true;
            for (const [f, i] of hookFloors) {
              let why = opened ? null : 'open';
              if (!why) {
                for (const s of f.act ?? []) {
                  // An optional step (expanding a fold that may not be there) can't fail the floor.
                  try { await step(page, s, args, s.optional ? Math.min(waitMs, 1000) : waitMs); } catch { if (!s.optional) { why = 'step'; break; } }
                }
              }
              if (!why) why = await expectHook(page, f.expect, args, waitMs).catch(() => 'error');
              tally(i, why);
              if (why) all = false;
            }
            if (all) samplesOk++;
          }
        }
        result.passed = hookFloors.length ? samplesOk : found.filter((r) => cap.floor.every((f) => !f.data || meetsAll(r, f.data.where))).length;
        result.floors = floors.map((f) => (Object.keys(f.reasons).length ? f : (({ reasons, ...rest }) => rest)(f)));
        const dataOk = floors.every((f) => f.kind !== 'data' || !f.reasons.ratio);
        const hooksOk = !hookFloors.length || (result.checked > 0 && samplesOk === result.checked);
        result.status = dataOk && hooksOk ? 'pass' : 'gap';
      }
      result.ms = Date.now() - t0;
      results.push(result);
      log(`${id}: ${result.status} (${result.detected} detected, ${result.passed}/${result.checked || result.detected} passed)`);
    }
  }
  if (guard?.escaped) throw new Error(`the read-only guard saw ${guard.escaped} request(s) it couldn't stop (a redirect's later hop or a service worker); no report`);
  const finishedAt = new Date();
  const summary = Object.fromEntries(PARITY_STATUSES.map((s) => [s, results.filter((r) => r.status === s).length]));
  return {
    schema: 'flow-review-parity-report-0',
    tool: { name: TOOL.name, version: TOOL.version },
    spec: { name: spec.name, version: spec.version, sha256: specHash(spec) },
    target,
    startedAt: startedAt.toISOString(), finishedAt: finishedAt.toISOString(), ms: finishedAt - startedAt,
    guard: guard ? { ...guard, blockedByMethod: { ...guard.blockedByMethod }, sockets: { ...guard.sockets } } : null,
    only: only ?? null,
    summary, results,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// What a run says: a table, issue intents, and a comparison with a baseline

/** The report as a markdown table: surface, capability, status and counts. */
export function parityTable(report) {
  const rows = report.results.map((r) => {
    const floors = r.floors.filter((f) => f.fail).map((f) => `${f.id} ${f.fail}`).join(', ');
    return `| ${r.surface} | ${r.capability} | ${r.status} | ${r.detected} | ${r.checked ? `${r.passed}/${r.checked}` : r.status === 'pass' || r.status === 'gap' ? 'data' : '-'} | ${r.status === 'unread' ? `unread: ${r.unread.join(', ')}` : floors} |`;
  });
  const s = report.summary;
  return [
    `Parity ${report.spec.name} v${report.spec.version}: ${s.pass} pass, ${s.gap} gap, ${s.unread} unread, ${s['not-present']} not present`,
    '',
    '| Surface | Capability | Status | Detected | Passed | Failing floors |',
    '|---|---|---|---:|---:|---|',
    ...rows,
  ].join('\n');
}

/**
 * Every gap and unread capability as an issue intent: a stable dedupe key (`parity:<spec>:<surface>/<capability>`,
 * the same every run), its owner, a title and a counts-only body. A product files them with its own tracker; the key
 * finds one it filed before.
 */
export function parityIssues(report, spec = null) {
  const capOf = (r) => spec?.surfaces.find((s) => s.id === r.surface)?.capabilities.find((c) => c.id === r.capability) ?? null;
  const surfaceOf = (r) => spec?.surfaces.find((s) => s.id === r.surface) ?? null;
  return report.results.filter((r) => r.status === 'gap' || r.status === 'unread').map((r) => {
    const cap = capOf(r);
    const key = `parity:${report.spec.name}:${r.surface}/${r.capability}`;
    const why = r.status === 'unread'
      ? `The records don't carry ${r.unread.map((p) => `\`${p}\``).join(', ')}, which the detector needs (${r.scoped} records in scope).`
      : `${r.detected} records call for it; ${r.checked ? `${r.passed} of ${r.checked} opened samples met the floor` : 'the data floor fails'}.`;
    const floorLines = r.floors.filter((f) => f.fail || f.reasons).map((f) => {
      const def = cap?.floor.find((x) => x.id === f.id);
      const reasons = f.reasons ? Object.entries(f.reasons).map(([k, v]) => `${k} ${v}`).join(', ') : '';
      return `- \`${f.id}\`${def?.title ? ` (${def.title})` : ''}: ${f.kind === 'data' ? `${f.pass} of ${f.pass + f.fail} records (needs ${Math.round((f.min ?? 1) * 100)}%)` : `${f.fail} of ${f.pass + f.fail} samples fail`}${reasons ? `; ${reasons}` : ''}`;
    });
    const body = [
      `**Parity ${r.status}: ${surfaceOf(r)?.title ?? r.surface}, ${cap?.title ?? r.capability}.** ${why}`,
      '',
      ...(cap?.intent ? [`**The floor.** ${cap.intent}`, ''] : []),
      ...(floorLines.length ? ['**Failing floors.**', ...floorLines, ''] : []),
      `Spec \`${report.spec.name}\` v${report.spec.version} (sha256 ${report.spec.sha256}), flow-review ${report.tool.version}, run ${report.finishedAt}. Counts only.`,
      '',
      `parity-key: ${key}`,
    ].join('\n');
    return { key, surface: r.surface, capability: r.capability, status: r.status, owner: r.owner, title: `Parity: ${surfaceOf(r)?.title ?? r.surface}: ${cap?.title ?? r.capability}`, body };
  });
}

/** A report's statuses as a baseline: `{ "<surface>/<capability>": status }`. */
export const parityBaseline = (report) => Object.fromEntries(report.results.map((r) => [`${r.surface}/${r.capability}`, r.status]));

/**
 * Compares a report with a baseline. A regression is a capability the baseline passed that doesn't pass now, or one
 * the baseline had that this run lacks; an improvement is one that passes now and didn't.
 */
export function parityCompare(report, baseline) {
  const now = parityBaseline(report);
  const regressions = [];
  const improvements = [];
  // A run limited with only compares only what it ran.
  const ran = (id) => !report.only || report.only.some((o) => id === o || id.startsWith(`${o}/`));
  for (const [id, was] of Object.entries(baseline)) {
    if (!ran(id)) continue;
    if (!(id in now)) { regressions.push({ id, was, now: 'missing' }); continue; }
    if (was === 'pass' && now[id] !== 'pass') regressions.push({ id, was, now: now[id] });
  }
  for (const [id, is] of Object.entries(now)) if (is === 'pass' && baseline[id] !== 'pass') improvements.push({ id, was: baseline[id] ?? 'new', now: is });
  return { regressions, improvements };
}

/**
 * A headless Chromium page behind the read-only guard: launched through launchBrowser (never a visible window outside
 * CI), the guard on its context before the first request, then `url` loaded. Returns the page, its guard's counts and a
 * close function.
 */
export async function launchGuarded({ url = null, allow = readOnlyLoopback, viewport = { width: 1440, height: 900 }, launch = {}, waitUntil = 'load', timeoutMs = 60000 } = {}) {
  const { chromium } = await import('playwright');
  const { launchBrowser } = await import('./browser.mjs');
  const browser = await launchBrowser(chromium, { executablePath: process.env.FLOW_REVIEW_CHROMIUM || undefined, channel: process.env.FLOW_REVIEW_CHANNEL || undefined, ...launch });
  try {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1, serviceWorkers: 'block' });
    const guard = await guardContext(context, { allow });
    const page = await context.newPage();
    if (url) await page.goto(url, { waitUntil, timeout: timeoutMs });
    return { browser, context, page, guard, close: () => browser.close() };
  } catch (e) {
    await browser.close().catch(() => {});
    throw e;
  }
}
