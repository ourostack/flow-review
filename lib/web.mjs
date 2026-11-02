// Runs one web or cdp unit: a flow's steps in one matrix cell, with checks at every capture, at tab traversals, at
// declared states and at the end.
import fs from 'node:fs';
import path from 'node:path';
import { checks, traverse, ensure, PAGE_SCRIPT } from './checks.mjs';
import { crop, moment, failureShot } from './evidence.mjs';

// Timing checks first: the others (axe above all) run long tasks of their own in the page.
export const CAPTURE_CHECKS = ['errors', 'cls', 'jank', 'axe', 'contrast', 'targetSize', 'overflow', 'deadSpace', 'repetition', 'designSystem', 'proofNotice', 'duoOverlap', 'duoReducedMotion', 'duoBytes'];
const EVIDENCE_PER_CHECK = 3;
const EVIDENCE_PER_UNIT = 40;
const FINDINGS_PER_CHECK = 25;

const TYPES = { '.json': 'application/json; charset=utf-8', '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.png': 'image/png', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.txt': 'text/plain' };

export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') { re += '.*'; i++; if (glob[i + 1] === '/') { re += '/?'; i++; } }
    else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export const routeMatches = (glob, url) => {
  const re = globToRegExp(glob);
  const u = new URL(url);
  return re.test(url) || re.test(`${u.origin}${u.pathname}`) || (glob.startsWith('/') && re.test(u.pathname));
};

export function resolveUrl(base, p) {
  if (/^[a-z]+:\/\//i.test(p)) return p;
  if (!base) throw new Error(`goto ${p} needs app.url`);
  const b = new URL(base);
  if (p.startsWith('/')) return `${b.origin}${b.pathname.replace(/\/$/, '')}${p}`;
  return new URL(p, b.href.endsWith('/') ? b.href : `${b.href}/`).href;
}

/** A target's locator: role and name first, then text, then CSS. Text and CSS matches count only when visible, unless
 * the step waits for something to go away. */
function locate(page, t, { visible = true } = {}) {
  let loc;
  if (t.role) loc = page.getByRole(t.role, t.name === undefined ? {} : { name: typeof t.name === 'object' ? new RegExp(t.name.regex, t.name.flags) : t.name, exact: t.exact });
  else if (t.text) loc = page.getByText(t.text, { exact: t.exact });
  else if (t.selector) loc = page.locator(t.selector);
  else return null;
  if (t.role && t.selector) loc = page.locator(t.selector).and(loc);
  if (visible && !t.role) loc = loc.filter({ visible: true });
  return t.nth !== undefined ? loc.nth(t.nth) : loc.first();
}

// Deterministic waits before anything is measured: fonts, the images on screen (a lazy one below the fold isn't waited
// for), running finite animations, then two frames, so no layout shift is pending.
async function settle(page) {
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  await page.waitForFunction(() => [...document.images].every((i) => {
    if (i.complete || !i.getClientRects().length || !i.checkVisibility()) return true;
    // An unsized image on screen is 0x0 while it loads, and the likeliest to shift the layout: it is waited for.
    const r = i.getBoundingClientRect();
    return r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth;
  }), null, { timeout: 3000, polling: 'raf' }).catch(() => {});
  await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running' || !Number.isFinite(a.effect?.getComputedTiming().endTime ?? Infinity)), null, { timeout: 3000, polling: 'raf' }).catch(() => {});
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))).catch(() => {});
}

const stepKind = (s) => ['goto', 'act', 'waitFor', 'capture', 'tabTraverse', 'setTheme', 'resize', 'scroll'].find((k) => k in s);
/** A step's name: its id, its capture's moment, or its place (`3-act`; a held step's `3.1-waitFor`). */
export const stepId = (s, i, parent) => s.id ?? (s.capture ? s.capture.moment : `${parent ? `${parent}.` : ''}${i + 1}-${stepKind(s) ?? 'step'}`);
const isHold = (s) => s?.act?.verb === 'hold';

const shown = (v) => (v && typeof v === 'object' && 'regex' in v ? `/${v.regex}/${v.flags ?? ''}` : JSON.stringify(v));
/** What a step works on, for a finding: its target's role, name, text and selector, or the URL it goes to. */
export function targetOf(s) {
  const t = s.act ?? s.waitFor ?? s.scroll?.target;
  if (t && typeof t === 'object') {
    const parts = [t.role && `role=${t.role}`, t.name !== undefined && `name=${shown(t.name)}`, t.text !== undefined && `text=${shown(t.text)}`, t.selector && `css=${t.selector}`, s.act?.key && `key=${s.act.key}`].filter(Boolean);
    if (parts.length) return parts.join(' ');
  }
  if ('goto' in s) return `goto ${s.goto}`;
  return undefined;
}

/** How long a step may take: timeouts.stepMs, or a waitFor's own ms (or a hold's) and 5 s more when that is longer. */
const stepLimit = (s, stepMs, afterGoto) => Math.max(stepMs, typeof s.waitFor?.ms === 'number' ? s.waitFor.ms + 5000 : 0, isHold(s) && typeof s.act.ms === 'number' ? s.act.ms + 5000 : 0, 'goto' in s && typeof afterGoto?.ms === 'number' ? afterGoto.ms + 35_000 : 0);

/** `work`, or a rejection once `ms` pass. The work keeps going and its own rejection is swallowed: the caller closes
 * the page under it. */
function within(work, ms, message) {
  let timer;
  work.catch(() => {});
  const late = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message())), ms); });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/**
 * @param {{ unit, browser, cwd, outDir, only?: string[], emit: (f) => void, addMoment: (m) => void }} o
 */
export async function runWebUnit({ unit, browser, cwd, outDir, only, emit: emitOut, addMoment, addState = () => {}, chromium, signal }) {
  const { flow, file, cell } = unit;
  // Once the cell is stopped at its time limit, what it was doing fails only because its page was closed under it.
  const emit = (f) => { if (!signal?.aborted) emitOut(f); };
  const stepMs = flow.timeouts?.stepMs ?? 60_000;
  const dir = path.dirname(path.resolve(cwd, file));
  const cfg = flow.checks ?? {};
  const enabled = (name) => (!only || only.includes(name)) && (!cfg.only || cfg.only.includes(name)) && !(cfg.skip ?? []).includes(name);
  const opts = { thresholds: cfg.thresholds, designSystem: cfg.designSystem, proofNotice: cfg.proofNotice, sections: cfg.sections, ignore: cfg.ignore, duo: cfg.duo, focusGuards: cfg.focusGuards, popupLayers: cfg.popupLayers };
  const duo = { art: cfg.duo?.art ?? '[data-duo]', quiet: cfg.duo?.quiet ?? '[data-duo-quiet]', celebrate: cfg.duo?.celebrate ?? '[data-celebrate]' };
  const duoUrls = new Set();
  const duoRe = cfg.duo?.assets ? new RegExp(cfg.duo.assets) : null;
  const [w, h] = cell.viewport.split('x').map(Number);
  const base = flow.app?.url;
  const origin = base ? new URL(base).origin : null;
  let evidenceLeft = EVIDENCE_PER_UNIT;

  let context;
  let page;
  let cdpBrowser = null;
  // Stopping the cell closes its page (a cdp browser is only disconnected), which ends whatever it was waiting on. It
  // listens from the moment there is something to close, so a cell stuck in setup is stopped too.
  const stop = async () => { await (cdpBrowser ? cdpBrowser.close() : context?.close())?.catch(() => {}); };
  signal?.addEventListener('abort', stop, { once: true });
  try {
    if (flow.surface === 'cdp') {
      cdpBrowser = await chromium.connectOverCDP(flow.app.cdpUrl);
      if (signal?.aborted) throw new Error('stopped');
      context = cdpBrowser.contexts()[0] ?? (await cdpBrowser.newContext());
      page = context.pages()[0] ?? (await context.newPage());
      await page.setViewportSize({ width: w, height: h });
      await page.emulateMedia({ colorScheme: cell.theme, reducedMotion: cell.reducedMotion ? 'reduce' : 'no-preference' });
      await context.addInitScript(PAGE_SCRIPT);
      await ensure(page);
    } else {
      context = await browser.newContext({ viewport: { width: w, height: h }, deviceScaleFactor: 1, colorScheme: cell.theme, reducedMotion: cell.reducedMotion ? 'reduce' : 'no-preference' });
      if (signal?.aborted) throw new Error('stopped');
      await context.addInitScript(PAGE_SCRIPT);
      page = await context.newPage();
    }
  } catch (e) {
    signal?.removeEventListener('abort', stop);
    await stop();
    throw e;
  }

  // Routes: the flow's fixtures, then the current step's; other origins are aborted unless blockExternal is false.
  const flowRoutes = flow.fixtures?.route ?? {};
  let stepRoutes = {};
  const expectedFail = new Set();
  const aborted = new Set();
  const body = (fx) => {
    if (typeof fx === 'string') fx = { file: fx };
    if (fx.file) return { status: fx.status ?? 200, contentType: fx.contentType ?? TYPES[path.extname(fx.file)] ?? 'application/octet-stream', body: fs.readFileSync(path.resolve(dir, fx.file)) };
    if ('json' in fx) return { status: fx.status ?? 200, contentType: fx.contentType ?? 'application/json; charset=utf-8', body: JSON.stringify(fx.json) };
    return { status: fx.status ?? 200, contentType: fx.contentType ?? 'text/plain; charset=utf-8', body: fx.body ?? '' };
  };
  if (flow.surface !== 'cdp' || Object.keys(flowRoutes).length) {
    await context.route('**/*', async (route) => {
      const url = route.request().url();
      const table = { ...flowRoutes, ...stepRoutes };
      for (const glob of Object.keys(table)) {
        if (!/^https?:/.test(url) || !routeMatches(glob, url)) continue;
        const fx = table[glob];
        if (fx.abort) { expectedFail.add(url.split('?')[0]); return route.abort(); }
        const res = body(fx);
        if (res.status >= 400) expectedFail.add(url.split('?')[0]);
        return route.fulfill(res);
      }
      if (flow.app?.blockExternal !== false && origin && /^https?:/.test(url) && new URL(url).origin !== origin) { aborted.add(url.split('?')[0]); return route.abort(); }
      return route.fallback();
    });
  }

  const errors = [];
  const allow = (cfg.allowErrors ?? []).map((r) => new RegExp(r));
  const known = (url) => !!url && (expectedFail.has(url.split('?')[0]) || aborted.has(url.split('?')[0]));
  const note = (kind, text, url) => { if (!known(url) && !allow.some((r) => r.test(text))) errors.push(`${kind}: ${text.slice(0, 300)}`); };
  page.on('pageerror', (e) => note('page error', e.message));
  page.on('console', (m) => { if (m.type() === 'error') note('console', m.text(), m.location()?.url); });
  page.on('response', (r) => { if (r.status() >= 400) note(`HTTP ${r.status()}`, r.url(), r.url()); });
  // net::ERR_ABORTED is a request the page itself gave up (a navigation, an AbortController), not a failure.
  page.on('requestfailed', (r) => { const f = r.failure()?.errorText ?? ''; if (!/ERR_ABORTED/.test(f)) note('request failed', `${r.url()} ${f}`, r.url()); });

  let since = 0;
  let windows = [];
  let lastCheckpoint = null;
  let traversed = false;
  const now = () => page.evaluate(() => performance.now()).catch(() => 0);
  const inMotion = async (fn) => {
    const from = await now();
    await fn();
    await settle(page);
    windows.push([from, (await now()) + 50]);
  };

  const record = async (stepName, all, t0, perCheck) => {
    const ms = Math.round(performance.now() - t0);
    // At most FINDINGS_PER_CHECK failures of a check at one moment, then one finding that counts the rest.
    const list = [];
    const seen = {};
    for (const f of all) {
      if (f.pass || (seen[f.check] = (seen[f.check] ?? 0) + 1) <= FINDINGS_PER_CHECK) list.push(f);
    }
    for (const [check, n] of Object.entries(seen)) if (n > FINDINGS_PER_CHECK) list.push({ check, pass: false, measured: `${n - FINDINGS_PER_CHECK} more like these`, threshold: all.find((f) => f.check === check && !f.pass)?.threshold, label: `and ${n - FINDINGS_PER_CHECK} more`, more: n - FINDINGS_PER_CHECK });
    for (const f of list) {
      if (!f.pass && f.ref === undefined && f.axeTarget?.length === 1 && typeof f.axeTarget[0] === 'string') {
        f.ref = await page.evaluate((sel) => { const el = document.querySelector(sel); return el ? window.__fr.ref(el) : undefined; }, f.axeTarget[0]).catch(() => undefined);
      }
      if (!f.pass && f.ref !== undefined && evidenceLeft > 0 && (perCheck[f.check] = (perCheck[f.check] ?? 0) + 1) <= EVIDENCE_PER_CHECK) {
        f.evidence = await crop(page, browser ?? cdpBrowser, outDir, f);
        if (f.evidence) evidenceLeft--;
      }
      const { ref, offset, axeTarget, ...clean } = f;
      emit({ step: stepName, ...clean, ms });
    }
  };

  // States on screen (empty, loading, error, first-run, success) and whether each holds its Moment: listed, not judged.
  const momentMarker = cfg.moments?.marker ?? '[data-moment="{kind}"]';
  const inventory = async (stepName, declared = []) => {
    try {
      const list = await page.evaluate((o) => window.__fr.states(o), { moment: momentMarker, declared, ignore: cfg.ignore });
      for (const st of list) addState({ step: stepName, kind: st.kind, selector: st.selector, label: st.label, how: st.how, hasMoment: st.hasMoment });
    } catch {}
  };

  const checkpoint = async (stepName, kinds, last = false) => {
    await inventory(stepName);
    const perCheck = {};
    for (const k of kinds) {
      if (!enabled(k)) continue;
      const t0 = performance.now();
      let list;
      try {
        if (k === 'errors') {
          list = errors.length ? errors.splice(0).map((e) => ({ check: 'errors', pass: false, measured: e, threshold: 'no errors', fix: 'Fix the error, or list it in checks.allowErrors when it is expected.' })) : [{ check: 'errors', pass: true, measured: 'none', threshold: 'no errors' }];
        } else if (k === 'duoReducedMotion' && !cell.reducedMotion) {
          continue;
        } else if (k === 'duoBytes') {
          list = await checks.duoBytes(page, opts);
          for (const f of list) { for (const u of f.urls ?? []) duoUrls.add(u); delete f.urls; }
        } else if (k === 'cls' || k === 'jank') {
          if (k === 'jank' && last) windows.push(await page.evaluate(() => window.__fr.scrollProbe()));
          list = await checks[k](page, { ...opts, since, windows });
        } else list = await checks[k](page, opts);
      } catch (e) {
        list = [{ check: k, pass: false, measured: `check failed: ${String(e.message).split('\n')[0]}`, threshold: 'runs' }];
      }
      await record(stepName, list, t0, perCheck);
    }
    if (enabled('cls') || enabled('jank')) {
      since = await now();
      windows = [];
    }
    lastCheckpoint = stepName;
  };

  const doTraverse = async (stepName, o = {}) => {
    traversed = true;
    if (!enabled('keyboard') && !enabled('focusVisible')) return;
    const t0 = performance.now();
    let list;
    try {
      list = (await traverse(page, { ...opts, within: o.within, max: o.max })).filter((f) => enabled(f.check));
    } catch (e) {
      list = [{ check: 'keyboard', pass: false, measured: `check failed: ${String(e.message).split('\n')[0]}`, threshold: 'runs' }];
    }
    await record(stepName, list, t0, {});
  };

  const verify = async (ex) => {
    if (!ex) return;
    const t = 5000;
    if (ex.role) await locate(page, { role: ex.role, name: ex.name }).waitFor({ state: 'visible', timeout: t });
    if (ex.text) await page.getByText(ex.text).first().waitFor({ state: 'visible', timeout: t });
    if (ex.url && !page.url().includes(ex.url)) throw new Error(`expected the URL to contain ${ex.url}; it is ${page.url()}`);
    if (ex.focus) {
      const loc = locate(page, ex.focus);
      const ok = await loc.evaluate((el) => el === document.activeElement || el.contains(document.activeElement), null, { timeout: t }).catch(() => false);
      if (!ok) throw new Error(`expected focus on ${JSON.stringify(ex.focus)}; it is on ${await page.evaluate(() => window.__fr?.focusInfo()?.label ?? 'nothing')}`);
    }
    if (ex.count) {
      const n = await (ex.count.target.role ? page.getByRole(ex.count.target.role, ex.count.target.name ? { name: ex.count.target.name } : {}) : page.locator(ex.count.target.selector)).count();
      if ((ex.count.equals !== undefined && n !== ex.count.equals) || (ex.count.min !== undefined && n < ex.count.min) || (ex.count.max !== undefined && n > ex.count.max)) throw new Error(`expected count ${JSON.stringify(ex.count)}; found ${n}`);
    }
  };

  const setTheme = async (theme) => {
    const steps = flow.matrix?.themeVia === 'steps' ? flow.themeSteps?.[theme] : null;
    if (steps?.length) for (const s of steps) await doStep(s, '(theme)');
    else await page.emulateMedia({ colorScheme: theme });
    await settle(page);
  };

  // Duo art that appears, animates or moves in the working path while the person acts there, including art that
  // mounts a little after the act settles (checks.duo.watchMs, default 300).
  const workingPath = async (stepName, before, during) => {
    const t0 = performance.now();
    await page.waitForTimeout(cfg.duo?.watchMs ?? 300);
    const after = await page.evaluate((art) => window.__fr.duoState(art), duo.art).catch(() => []);
    const wp = await page.evaluate(() => window.__fr.workingPath()).catch(() => null);
    const list = [];
    if (wp) {
      const was = new Map(before.map((b) => [`${b.doc}:${b.ref}`, b]));
      const mid = new Map(during.map((b) => [`${b.doc}:${b.ref}`, b]));
      for (const a of after) {
        const b = was.get(`${a.doc}:${a.ref}`);
        const inPath = await page.evaluate(([x, y]) => window.__fr.meets(x, y), [a.view, wp]);
        if (!a.visible || !inPath) continue;
        const why = !b?.visible ? 'appeared' : Math.abs(a.rect.x - b.rect.x) > 2 || Math.abs(a.rect.y - b.rect.y) > 2 || Math.abs(a.rect.w - b.rect.w) > 2 || Math.abs(a.rect.h - b.rect.h) > 2 ? 'moved' : mid.get(a.ref)?.running || a.running ? 'animated' : null;
        if (why) list.push({ check: 'duoOverlap', pass: false, measured: `duo art ${why} in the working path`, threshold: 'duo art stays out of the working path while the person acts', label: `duo art ${why} by ${wp.label}`, fix: `Keep the duo still and away from ${wp.label} and its form or dialog while the person acts; show it after, or elsewhere.`, ref: a.ref });
      }
    }
    if (list.length) await record(stepName, list, t0, {});
  };

  // Celebrations: each time one comes into view counts once.
  let celebrating = new Set();
  let celebrations = 0;
  const countCelebrations = async () => {
    const now = await page.evaluate((sel) => window.__fr.celebrations(sel).map((c) => ({ ...c, ref: `${window.__fr.doc}:${c.ref}` })), duo.celebrate).catch(() => []);
    const refs = new Set(now.map((c) => c.ref));
    for (const r of refs) if (!celebrating.has(r)) celebrations++;
    celebrating = refs;
  };

  // What a goto waits for after navigating (app.readyAfterGoto): the load event by default. networkidle is opt-in, since
  // it never comes while the page holds an event stream or socket open, and would cost its whole 3 s on every goto.
  const afterGoto = flow.app?.readyAfterGoto ?? 'load';
  const readyAfterGoto = async () => {
    if (afterGoto === 'networkidle') await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
    else if (afterGoto && typeof afterGoto === 'object') {
      const loc = locate(page, afterGoto);
      if (!loc) throw new Error(`app.readyAfterGoto ${JSON.stringify(afterGoto)} names no role, text or selector`);
      await loc.waitFor({ state: 'visible', timeout: afterGoto.ms ?? 15_000 });
    }
  };

  // A held key: down on the target (focused first) when there is one, else on the page, for at least its ms.
  const keyDown = async (a) => {
    const loc = locate(page, a);
    if (loc) await loc.focus();
    await inMotion(async () => {
      await page.keyboard.down(a.key);
      if (a.ms) await page.waitForTimeout(a.ms);
    });
  };
  const keyUp = (a) => inMotion(() => page.keyboard.up(a.key));

  let themed = false;
  const doStep = async (s, name) => {
    stepRoutes = s.route ?? {};
    if ('goto' in s) {
      await page.goto(resolveUrl(base, s.goto), { waitUntil: afterGoto === 'domcontentloaded' ? 'domcontentloaded' : 'load', timeout: 30_000 });
      await readyAfterGoto();
      await settle(page);
      since = 0;
      windows = [];
      if (!themed && flow.matrix?.themeVia === 'steps') { themed = true; await setTheme(cell.theme); }
    } else if (isHold(s)) {
      // A hold among theme or quiet steps: down, its steps, up, with nothing measured (the flow's own are run below).
      await keyDown(s.act);
      try {
        for (const [j, d] of (s.act.during ?? []).entries()) await doStep(d, stepId(d, j, name));
      } finally {
        await keyUp(s.act).catch(() => {});
      }
    } else if ('act' in s) {
      const a = s.act;
      const loc = locate(page, a);
      const watchDuo = enabled('duoOverlap');
      const before = watchDuo ? await page.evaluate((art) => window.__fr.duoState(art), duo.art).catch(() => []) : [];
      let during = [];
      await inMotion(async () => {
        if (a.verb === 'press') await (loc ? loc.press(a.key ?? 'Enter') : page.keyboard.press(a.key ?? 'Enter'));
        else if (!loc) throw new Error(`act ${a.verb} needs a role, text or selector`);
        else if (a.verb === 'click') await loc.click();
        else if (a.verb === 'type') await loc.fill(a.text ?? '');
        else if (a.verb === 'hover') await loc.hover();
        else if (a.verb === 'focus') await loc.focus();
        if (watchDuo) during = await page.evaluate((art) => window.__fr.duoState(art), duo.art).catch(() => []);
      });
      if (watchDuo) await workingPath(name, before, during);
    } else if ('waitFor' in s) {
      const wf = s.waitFor;
      const loc = locate(page, wf, { visible: !['hidden', 'detached'].includes(wf.state) });
      if (loc) await loc.waitFor({ state: wf.state ?? 'visible', timeout: wf.ms ?? 15_000 });
      else await page.waitForTimeout(wf.ms ?? 0);
      await settle(page);
    } else if ('setTheme' in s) await inMotion(() => setTheme(s.setTheme));
    else if ('resize' in s) {
      const [rw, rh] = s.resize.split('x').map(Number);
      await inMotion(() => page.setViewportSize({ width: rw, height: rh }));
    } else if ('scroll' in s) {
      const sc = s.scroll;
      if (sc.target) await inMotion(() => locate(page, sc.target).scrollIntoViewIfNeeded());
      else if (enabled('jank')) {
        windows.push(await page.evaluate(() => window.__fr.scrollProbe()));
        await page.evaluate((to) => scrollTo({ top: to === 'bottom' ? document.documentElement.scrollHeight : 0, behavior: 'instant' }), sc.to);
      } else await page.evaluate((to) => scrollTo({ top: to === 'bottom' ? document.documentElement.scrollHeight : 0, behavior: 'instant' }), sc.to);
    }
    await verify(s.expect);
  };

  // Quiet mode: the flow's own steps turn it on; then, on this page and after a reload, no duo is shown or fetched.
  const quietMode = async () => {
    const t0 = performance.now();
    const list = [];
    try {
      for (const s of cfg.duo.quietSteps) await doStep(s, 'quiet');
      const fetched = [];
      const onRequest = (r) => fetched.push(r.url());
      page.on('request', onRequest);
      await page.reload({ waitUntil: 'load' });
      await readyAfterGoto();
      // Quiet mode is about what the page fetches, so it waits for the network to go quiet whatever readyAfterGoto says.
      if (afterGoto !== 'networkidle') await page.waitForLoadState('networkidle', { timeout: 3000 }).catch(() => {});
      await settle(page);
      page.off('request', onRequest);
      const shown = await page.evaluate((o) => window.__fr.duoShown(o), { art: duo.art, quiet: duo.quiet });
      for (const el of shown) list.push({ check: 'quietMode', pass: false, measured: 'shown after quiet mode', threshold: 'hidden', selector: el.selector, label: `duo "${el.label}" still shown`, fix: 'Hide every [data-duo] and [data-duo-quiet] element while quiet mode is on, after a reload too.', ref: el.ref });
      const loaded = [...new Set(fetched.filter((u) => duoUrls.has(u) || (duoRe && duoRe.test(u))))];
      for (const u of loaded) list.push({ check: 'quietMode', pass: false, measured: `fetched ${u.split('/').pop()}`, threshold: 'no duo assets fetched', label: 'duo asset fetched in quiet mode', fix: `Don't fetch the duo's assets while quiet mode is on (${u}).` });
      if (!list.length) list.push({ check: 'quietMode', pass: true, measured: `nothing shown, nothing fetched (${duoUrls.size} duo assets known)`, threshold: 'hidden, not fetched' });
    } catch (e) {
      list.push({ check: 'quietMode', pass: false, measured: `quiet steps failed: ${String(e.message).split('\n')[0]}`, threshold: 'quiet mode turns on' });
    }
    await record('quiet', list, t0, {});
  };

  // One of the flow's steps and what is measured after it; false when it failed and the flow stops there. A hold takes
  // its own steps while the key is down (their captures measure the held page), lets the key go whatever they did, and
  // checks its expect once the key is up.
  const runStep = async (s, name, last) => {
    const target = targetOf(s);
    const st = performance.now();
    const limit = stepLimit(s, stepMs, flow.app?.readyAfterGoto);
    const late = (what, ms) => () => `${what} took over ${ms} ms (timeouts.stepMs)${target ? `: ${target}` : ''}`;
    const fail = async (e) => {
      const evidence = await failureShot(page, browser ?? cdpBrowser, outDir);
      emit({ step: name, check: 'step', pass: false, measured: String(e.message).split('\n')[0].slice(0, 300), threshold: 'step runs', ...(target ? { selector: target } : {}), evidence, fix: 'The flow could not do this step: check the target names, or the app.', ms: Math.round(performance.now() - st) });
      await checkpoint(name, ['errors']);
    };
    unit.at = { step: name, target };
    try {
      if (isHold(s)) {
        stepRoutes = s.route ?? {};
        await within(keyDown(s.act), limit, late('act', limit));
      } else if (!('capture' in s) && !('tabTraverse' in s)) await within(doStep(s, name), limit, late(stepKind(s), limit));
      else stepRoutes = {};
    } catch (e) {
      if (signal?.aborted) return false;
      if (isHold(s)) await page.keyboard.up(s.act.key).catch(() => {});
      await fail(e);
      return false;
    }
    if (isHold(s)) {
      let ok = true;
      for (const [j, d] of (s.act.during ?? []).entries()) {
        if (!(await runStep(d, stepId(d, j, name), false))) { ok = false; break; }
      }
      if (signal?.aborted) return false;
      unit.at = { step: name, target };
      try {
        await within((async () => {
          await keyUp(s.act);
          if (ok) await verify(s.expect);
        })(), stepMs, late('letting the key go', stepMs));
      } catch (e) {
        if (signal?.aborted) return false;
        if (ok) await fail(e);
        return false;
      }
      if (!ok) return false;
    }
    emit({ step: name, check: 'step', pass: true, measured: stepKind(s), threshold: 'step runs', ms: Math.round(performance.now() - st) });
    if (enabled('celebrationCap')) await countCelebrations();
    if ('act' in s && !(s.state && s.state !== 'normal')) await inventory(name);
    if (s.state && s.state !== 'normal') {
      const ct = performance.now();
      let list;
      try {
        let regionRef;
        if (s.stateRegion) {
          const loc = locate(page, s.stateRegion);
          await loc.waitFor({ state: 'visible', timeout: 5000 }).catch(() => {});
          regionRef = (await loc.isVisible().catch(() => false)) ? await loc.evaluate((el) => window.__fr.ref(el)) : null;
        }
        await inventory(name, [{ kind: s.state, regionRef: regionRef ?? undefined }]);
        if (enabled('states')) {
          list = regionRef === null
            ? [{ check: 'states', pass: false, measured: `${JSON.stringify(s.stateRegion)} not shown`, threshold: 'the state is reachable', fix: `The ${s.state} state never showed its region.` }]
            : await checks.states(page, { ...opts, state: s.state, regionRef, region: s.stateRegion?.selector });
        }
      } catch (e) {
        if (enabled('states')) list = [{ check: 'states', pass: false, measured: String(e.message).split('\n')[0], threshold: 'reachable' }];
      }
      if (list) await record(name, list, ct, {});
    }
    if ('capture' in s) {
      await settle(page);
      const region = s.capture.region ? locate(page, s.capture.region) : null;
      try {
        addMoment({ step: name, moment: s.capture.moment, crop: await moment(page, browser ?? cdpBrowser, outDir, region) });
      } catch {}
      await checkpoint(name, CAPTURE_CHECKS, last);
    }
    if ('tabTraverse' in s) await doTraverse(name, s.tabTraverse === true ? {} : s.tabTraverse);
    return true;
  };

  const t0 = performance.now();
  try {
    for (const [i, s] of flow.steps.entries()) {
      if (!(await runStep(s, stepId(s, i), i === flow.steps.length - 1))) return;
    }
    unit.at = { step: 'end' };
    if (lastCheckpoint !== stepId(flow.steps.at(-1), flow.steps.length - 1)) await checkpoint('end', CAPTURE_CHECKS, true);
    if (!traversed) await doTraverse('end');
    if (enabled('celebrationCap')) {
      const max = cfg.thresholds?.celebrationMax ?? 1;
      emit({ step: 'end', check: 'celebrationCap', pass: celebrations <= max, measured: celebrations, threshold: max, fix: celebrations <= max ? undefined : `Celebrate at most ${max} time${max === 1 ? '' : 's'} in this flow (it celebrated ${celebrations}): keep the big moment for the big moment.`, ms: 0 });
    }
    if (enabled('quietMode') && cfg.duo?.quietSteps?.length) { unit.at = { step: 'quiet' }; await quietMode(); }
  } finally {
    signal?.removeEventListener('abort', stop);
    if (!signal?.aborted) unit.ms = Math.round(performance.now() - t0);
    await stop();
  }
}
