// Every deterministic check as a function of a Playwright page. Each returns findings
// ({ check, pass, measured, threshold, selector, label, fix, ref?, offset? }) and never throws on a failing page, so a
// repository can use any of them as its own conformance test:
//   import { checks, expectNoFindings } from '@ourostack/flow-review';
//   expectNoFindings(await checks.targetSize(page, { thresholds: { targetPx: 24 } }));
import { readFileSync } from 'node:fs';
import { DEFAULT_THRESHOLDS, FOCUS_GUARDS, POPUP_LAYERS } from './constants.mjs';

export const PAGE_SCRIPT = readFileSync(new URL('./page.js', import.meta.url), 'utf8');
const IMPACT = ['minor', 'moderate', 'serious', 'critical'];

/** Puts the in-page half of the checks into the page when it isn't there (an attached page, or a test's own page). */
export async function ensure(page) {
  const has = await page.evaluate(() => !!window.__fr).catch(() => false);
  if (!has) await page.evaluate(PAGE_SCRIPT);
}

const th = (opts, key) => opts?.thresholds?.[key] ?? DEFAULT_THRESHOLDS[key];

const toFindings = (check, res, passLabel) => {
  const items = res.items ?? [];
  const failing = items.filter((i) => !i.pass);
  const out = failing.map((i) => ({ check, pass: false, measured: i.measured, threshold: i.threshold, selector: i.selector, label: i.label, fix: i.fix, ref: i.ref, offset: i.offset }));
  if (!failing.length) out.push({ check, pass: true, measured: res.measured ?? (items.length ? items.map((i) => i.measured) : passLabel ?? 'ok'), threshold: items[0]?.threshold });
  return out;
};

async function run(page, fn, args) {
  await ensure(page);
  return page.evaluate(([name, a]) => window.__fr[name](a), [fn, args]);
}

async function axe(page, opts = {}, only) {
  const { AxeBuilder } = await import('@axe-core/playwright');
  // An open menu, listbox, tooltip or popover renders in a portal outside the page's landmarks by design: axe's region
  // check counts each popup layer as a region of its own, as axe already does for dialogs and svg.
  const regionMatcher = ['dialog', 'svg', ...POPUP_LAYERS, ...(opts.popupLayers ?? [])].join(', ');
  let b = new AxeBuilder({ page }).options({ checks: { region: { options: { regionMatcher } } } }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa', 'best-practice']);
  b = only ? b.withRules(only) : b.disableRules(['color-contrast', 'color-contrast-enhanced', 'target-size']);
  if (opts.ignore) b = b.exclude(opts.ignore);
  // Focus guards (hidden, focusable sentinels a focus trap puts at its edges) are aria-hidden and focusable on purpose.
  for (const g of [...FOCUS_GUARDS, ...(opts.focusGuards ?? [])]) b = b.exclude(g);
  if (opts.include) b = b.include(opts.include);
  const res = await b.analyze();
  return res.violations;
}

// How long contrast waits for what is moving to settle, and how many times it measures when something moved under it.
const STILL_MS = 3000;
const STILL_TRIES = 3;

/** Waits for fonts and for what is moving toward an end; true when it settled, false when the wait ran out. */
async function still(page) {
  await page.evaluate(() => document.fonts?.ready.then(() => {})).catch(() => {});
  await page.evaluate(() => window.__fr.watchMotion()).catch(() => {});
  return page.waitForFunction(() => window.__fr.moving() === 0, null, { timeout: STILL_MS, polling: 'raf' }).then(() => true, () => false);
}

async function measureContrast(page, opts) {
  const out = [];
  for (const v of await axe(page, opts, ['color-contrast'])) {
    for (const n of v.nodes) {
      const d = n.any?.[0]?.data ?? {};
      out.push({ check: 'contrast', pass: false, measured: d.contrastRatio ?? 'unknown', threshold: Number(String(d.expectedContrastRatio ?? th(opts, 'contrastText')).replace(':1', '')), selector: n.target.join(' '), label: `text ${d.fgColor ?? ''} on ${d.bgColor ?? ''}`.trim(), fix: `Raise the text's contrast to ${d.expectedContrastRatio ?? `${th(opts, 'contrastText')}:1`} (now ${d.contrastRatio}:1).`, axeTarget: n.target });
    }
  }
  const ui = await run(page, 'uiContrast', { min: th(opts, 'contrastUi'), ignore: opts.ignore });
  out.push(...toFindings('contrast', ui).filter((f) => !f.pass));
  if (!out.length) out.push({ check: 'contrast', pass: true, measured: `text >= ${th(opts, 'contrastText')}, ${ui.items.length} icons >= ${th(opts, 'contrastUi')}`, threshold: th(opts, 'contrastText') });
  return out;
}

export const checks = {
  /** axe-core's WCAG 2.2 A/AA and best-practice rules, except colour contrast and target size (their own checks own them). */
  async axe(page, opts = {}) {
    const min = IMPACT.indexOf(th(opts, 'axeImpact'));
    const out = [];
    for (const v of await axe(page, opts)) {
      if (IMPACT.indexOf(v.impact ?? 'minor') < min) continue;
      for (const n of v.nodes.slice(0, 10)) out.push({ check: 'axe', pass: false, measured: `${v.id} (${v.impact})`, threshold: `impact < ${th(opts, 'axeImpact')}`, selector: n.target.join(' '), label: v.help, fix: `${n.failureSummary?.split('\n').slice(0, 3).join(' ') ?? v.help} ${v.helpUrl}`.trim(), axeTarget: n.target });
      if (v.nodes.length > 10) out.push({ check: 'axe', pass: false, measured: `${v.id}: ${v.nodes.length - 10} more`, threshold: 'none', label: v.help });
    }
    if (!out.length) out.push({ check: 'axe', pass: true, measured: 'no violations', threshold: `impact < ${th(opts, 'axeImpact')}` });
    return out;
  },

  /**
   * Text contrast through axe's color-contrast rule, and icon-only controls' glyphs against their background, measured
   * on what the page rests at: once fonts are in and nothing is moving toward an end, and again when something started
   * moving while it was measured (a pane fading in as it arrives reads at its starting opacity mid-measurement).
   */
  async contrast(page, opts = {}) {
    await ensure(page);
    // An attached page can hold an older engine's page script, which can't say what moved: it is measured as it is.
    if (!(await page.evaluate(() => typeof window.__fr.motionMark === 'function').catch(() => false))) return measureContrast(page, opts);
    let out;
    for (let i = 0; ; i++) {
      const settled = await still(page);
      await page.evaluate((s) => window.__fr.motionMark(s), settled);
      out = await measureContrast(page, opts);
      if (i === STILL_TRIES - 1 || !(await page.evaluate(() => window.__fr.movedSinceMark()).catch(() => false))) return out;
    }
  },

  async targetSize(page, opts = {}) {
    return toFindings('targetSize', await run(page, 'targetSize', { min: th(opts, 'targetPx'), ignore: opts.ignore }));
  },

  async overflow(page, opts = {}) {
    return toFindings('overflow', await run(page, 'overflow', { maxPx: th(opts, 'overflowPx'), allowTruncation: !!opts.thresholds?.allowTruncation, minShown: th(opts, 'truncationMinShown'), ignore: opts.ignore }));
  },

  async deadSpace(page, opts = {}) {
    const res = await run(page, 'deadSpace', { max: th(opts, 'deadSpace'), sections: opts.sections ?? 'main section[id], [data-section]', minSectionPx: th(opts, 'deadSpaceMinSectionPx'), ignore: opts.ignore });
    const out = res.items.map((i) => ({ check: 'deadSpace', pass: i.pass, measured: i.measured, threshold: i.threshold, selector: i.selector, label: i.label, fix: i.pass ? undefined : i.fix, ref: i.ref, offset: i.offset }));
    return out.length ? out : [{ check: 'deadSpace', pass: true, measured: 'no sections', threshold: th(opts, 'deadSpace') }];
  },

  async repetition(page, opts = {}) {
    return toFindings('repetition', await run(page, 'repetition', { minChars: th(opts, 'repetitionMinChars'), max: th(opts, 'repetitionMax'), ignore: opts.ignore }));
  },

  /** Needs `designSystem.marker`; without one there is nothing to check against. */
  async designSystem(page, opts = {}) {
    const ds = opts.designSystem;
    if (!ds?.marker) return [];
    return toFindings('designSystem', await run(page, 'designSystem', { marker: ds.marker, depth: ds.depth ?? 2, ignore: [opts.ignore, ds.ignore].filter(Boolean).join(', ') || undefined }));
  },

  async proofNotice(page, opts = {}) {
    const p = opts.proofNotice ?? {};
    const res = await run(page, 'proofNotice', { proof: p.proof, notice: p.notice, minChars: p.minChars ?? 10, ignore: opts.ignore });
    return res.items.length ? toFindings('proofNotice', res) : [{ check: 'proofNotice', pass: true, measured: 'no proof pictures', threshold: p.minChars ?? 10 }];
  },

  /** A declared empty, error or loading state says something human. `opts.state` names it; `opts.region` scopes it. */
  async states(page, opts = {}) {
    return toFindings('states', await run(page, 'state', { state: opts.state ?? 'declared', region: opts.region, regionRef: opts.regionRef, minChars: th(opts, 'stateMinChars') }));
  },

  /** Cumulative layout shift's largest session window, from shifts after `opts.since` (performance.now ms). */
  async cls(page, opts = {}) {
    const res = await run(page, 'cls', { since: opts.since ?? 0, max: th(opts, 'clsMax') });
    return toFindings('cls', res);
  },

  /** Long tasks over longTaskMs, and the share of slow frames inside `opts.windows` ([from, to] pairs). */
  async jank(page, opts = {}) {
    const res = await run(page, 'jank', { since: opts.since ?? 0, longTaskMs: th(opts, 'longTaskMs'), frameMs: th(opts, 'frameMs'), slowFrameShare: th(opts, 'slowFrameShare'), minFrames: opts.thresholds?.jankMinFrames, windows: opts.windows ?? [] });
    return toFindings('jank', res);
  },

  /**
   * Duo art never in the way: it paints below every control and text block (hit tests), takes no pointer events over
   * a control, and text over it reads at its contrast on the real pixels behind it (the worst tenth of them).
   * `opts.duo.art` is the art's selector (default [data-duo]).
   */
  async duoOverlap(page, opts = {}) {
    const art = opts.duo?.art ?? '[data-duo]';
    const res = await run(page, 'duoHits', { art });
    if (!res.arts) return [{ check: 'duoOverlap', pass: true, measured: 'no duo art', threshold: 'duo art below content' }];
    const out = res.items.map((i) => ({ check: 'duoOverlap', pass: false, measured: i.measured, threshold: i.threshold, selector: i.selector, label: i.label, fix: i.fix, ref: i.ref }));
    let decoder = null;
    try {
      for (const o of res.over) {
        await page.evaluate(([r]) => window.__fr.hideText(r, true), [o.ref]);
        let png;
        try {
          png = await page.screenshot({ clip: { x: o.box.x, y: o.box.y, width: o.box.w, height: o.box.h }, animations: 'disabled' });
        } finally {
          await page.evaluate(([r]) => window.__fr.hideText(r, false), [o.ref]);
        }
        decoder ??= await page.context().newPage();
        const ratio = await decoder.evaluate(async ({ src, fg }) => {
          const img = new Image();
          img.src = src;
          await img.decode();
          const c = document.createElement('canvas');
          c.width = img.naturalWidth;
          c.height = img.naturalHeight;
          const ctx = c.getContext('2d', { willReadFrequently: true });
          ctx.drawImage(img, 0, 0);
          const d = ctx.getImageData(0, 0, c.width, c.height).data;
          const lum = (r, g, b) => { const f = (v) => ((v /= 255) <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b); };
          const ratios = [];
          for (let i = 0; i < d.length; i += 4) {
            const a = fg[3];
            const t = [0, 1, 2].map((k) => fg[k] * a + d[i + k] * (1 - a));
            const [x, y] = [lum(...t), lum(d[i], d[i + 1], d[i + 2])].sort((p, q) => q - p);
            ratios.push((x + 0.05) / (y + 0.05));
          }
          ratios.sort((p, q) => p - q);
          return ratios[Math.floor(ratios.length * 0.1)] ?? 21;
        }, { src: `data:image/png;base64,${png.toString('base64')}`, fg: o.color });
        const min = o.large ? th(opts, 'contrastLarge') : th(opts, 'contrastText');
        const r = +ratio.toFixed(2);
        if (r < min) out.push({ check: 'duoOverlap', pass: false, measured: r, threshold: min, selector: o.selector, label: `"${o.label}" over duo art`, fix: `The words read at ${r}:1 on the art behind them (worst tenth of its pixels); need ${min}:1. Fade the art behind text, or give the words a backing.`, ref: o.ref });
      }
    } finally {
      await decoder?.close();
    }
    if (!out.length) out.push({ check: 'duoOverlap', pass: true, measured: `${res.arts} duo art, ${res.over.length} text blocks over it read`, threshold: 'duo art below content' });
    return out;
  },

  /** Under reduced motion, duo art stands still: no running animation, playing video or animated image. */
  async duoReducedMotion(page, opts = {}) {
    const res = await run(page, 'duoMotion', { art: opts.duo?.art ?? '[data-duo]' });
    return toFindings('duoReducedMotion', res, 'still');
  },

  /** The duo's assets this page fetched stay within the byte budget (default 150 KB). */
  async duoBytes(page, opts = {}) {
    const d = opts.duo ?? {};
    const res = await run(page, 'duoAssets', { art: d.art ?? '[data-duo]', quiet: d.quiet ?? '[data-duo-quiet]', assets: d.assets });
    const max = th(opts, 'duoBytes');
    const kb = (n) => `${Math.round(n / 1024)} KB`;
    const top = [...res.assets].sort((a, b) => b.bytes - a.bytes).slice(0, 3).map((a) => `${a.url.split('/').pop()} ${kb(a.bytes)}`).join(', ');
    return [{ check: 'duoBytes', pass: res.bytes <= max, measured: res.bytes, threshold: max, label: `${res.assets.length} duo assets, ${kb(res.bytes)}`, fix: res.bytes <= max ? undefined : `Bring the duo's assets on this page under ${kb(max)} (now ${kb(res.bytes)}: ${top}).`, urls: res.urls }];
  },

  /** Tab order reaches every interactive element, with no traps. */
  async keyboard(page, opts = {}) {
    return (await traverse(page, opts)).filter((f) => f.check === 'keyboard');
  },

  /** Every element Tab reaches shows a visible focus indicator. */
  async focusVisible(page, opts = {}) {
    return (await traverse(page, opts)).filter((f) => f.check === 'focusVisible');
  },
};

/**
 * Presses Tab through the page (or the open modal), once, and returns keyboard and focusVisible findings. An element
 * shows focus when its style, its pseudo-elements', its parent's or its first children's change on focus, or when it has
 * an outline or ring; failing that, when a crop of it differs focused and unfocused.
 */
export async function traverse(page, opts = {}) {
  await ensure(page);
  await page.mouse.move(0, 0).catch(() => {});
  const within = opts.within;
  const start = await page.evaluate(({ within, ignore }) => {
    const fr = window.__fr;
    const root = fr.modalRoot();
    const modal = !!root;
    // Where the app left focus, and every look, before the traversal moves anything.
    const at = fr.focusInfo();
    const region = within ? document.querySelector(within) : null;
    if (!region && !modal) document.activeElement?.blur?.();
    // Expected in tab order: everything focusable, and controls that should be but aren't (a div with role=button and
    // no tabindex). tabindex="-1" is a deliberate choice (roving focus), and composite items move by arrow keys.
    const els = fr.interactive({ within, ignore }).filter((el) => el.tabIndex >= 0 || (!el.hasAttribute('tabindex') && el.matches('[role="button"], [role="link"], [role="checkbox"], [role="switch"], [role="slider"], [role="spinbutton"], [role="textbox"], [role="combobox"]') && !el.closest('[aria-activedescendant]')));
    const result = {
      modal,
      expected: els.map((el) => ({ ref: fr.ref(el), selector: fr.selector(el), label: `${el.getAttribute('role') ?? el.localName} "${fr.label(el).slice(0, 40)}"`, group: el.matches('input[type="radio"][name]') ? `radio:${el.name}` : null, tabbable: el.tabIndex >= 0 })),
      looks: fr.looks(els),
      startsOutside: modal && (!at || at.outsideModal) ? (at?.label ?? 'the page') : null,
    };
    if (region) {
      // Start just inside the region, so Tab doesn't spend its budget on the page before it.
      const had = region.getAttribute('tabindex');
      if (had === null) region.setAttribute('tabindex', '-1');
      region.focus({ preventScroll: true });
      if (had === null) region.removeAttribute('tabindex');
    }
    return result;
  }, { within, ignore: opts.ignore });
  const base = new Map(start.expected.map((e, i) => [e.ref, start.looks[i]]));
  const max = opts.max ?? Math.min(400, start.expected.length * 2 + 20);
  const visited = [];
  const seen = new Set();
  const out = [];
  let first = null;
  let prev = null;
  let empty = 0;
  let trap = null;
  let escaped = null;
  let cycled = false;
  let prevInfo = null;
  let accepted = null;
  const expectedKeys = start.expected.map((e) => e.ref);
  const groupOf = new Map(start.expected.map((e) => [e.ref, e.group]));
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    let info = await page.evaluate(() => window.__fr.focusInfo());
    // A focus guard hands focus on, sometimes a frame later; it is never a stop of its own.
    if (info?.guard) {
      await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
      info = await page.evaluate(() => window.__fr.focusInfo());
      if (info?.guard) continue;
    }
    if (!info) {
      if (++empty >= 2) break;
      continue;
    }
    empty = 0;
    if (info.ref === prev && start.expected.filter((e) => e.tabbable).length > 1) {
      // A field with its suggestions open may take one Tab to accept one (as a chat's @ picker does): the popup was open, or
      // the field suggests and Tab changed its text. The next Tab must move on.
      if ((prevInfo?.popup || (info.autocomplete && prevInfo?.value !== info.value)) && accepted !== info.ref) {
        accepted = info.ref;
        prevInfo = info;
        continue;
      }
      trap = info;
      break;
    }
    prev = info.ref;
    prevInfo = info;
    if (first === null) first = info.ref;
    else if (info.ref === first) { cycled = true; break; }
    if (seen.has(info.ref)) continue;
    seen.add(info.ref);
    // Behind an open modal dialog: focus got out, and how it looks there is hidden by the dialog anyway.
    if (start.modal && info.outsideModal) {
      escaped ??= info;
      continue;
    }
    visited.push(info);
    // An outline or shadow it always has says nothing about focus: only a change counts, or a ring when no unfocused
    // look was recorded (an element that appeared during the traversal).
    let shows = base.has(info.ref) ? base.get(info.ref) !== info.look : info.ring;
    if (!shows) {
      // Pixel fallback: the element's crop focused and blurred.
      const box = await page.evaluate((r) => {
        const el = window.__fr.refs.get(r);
        const b = el.getBoundingClientRect();
        return { x: Math.max(0, b.left - 6), y: Math.max(0, b.top - 6), width: Math.min(innerWidth, b.right + 6) - Math.max(0, b.left - 6), height: Math.min(innerHeight, b.bottom + 6) - Math.max(0, b.top - 6) };
      }, info.ref);
      if (box.width > 0 && box.height > 0) {
        const a = await page.screenshot({ clip: box, animations: 'disabled' });
        await page.evaluate((r) => window.__fr.refs.get(r).blur(), info.ref);
        const b = await page.screenshot({ clip: box, animations: 'disabled' });
        await page.evaluate((r) => window.__fr.refs.get(r).focus(), info.ref);
        shows = !a.equals(b);
      }
    }
    if (!shows) out.push({ check: 'focusVisible', pass: false, measured: 'no visible change on focus', threshold: 'outline, ring or visible change', selector: info.selector, label: info.label, ref: info.ref, fix: `Give ${info.label} a visible focus indicator (:focus-visible outline or ring of at least 2 px).` });
    // In a region, every expected stop reached: the rest of the cycle only leaves the region. (A modal dialog's cycle runs
    // on, to see whether Tab gets out.)
    if (within && !start.modal && expectedKeys.every((k) => seen.has(k) || (groupOf.get(k) && [...seen].some((r) => groupOf.get(r) === groupOf.get(k))))) { cycled = true; break; }
  }
  const reachedGroups = new Set(start.expected.filter((e) => seen.has(e.ref) && e.group).map((e) => e.group));
  // Tab ran out of presses before it came round: what it didn't reach may be further on, not unreachable.
  const outOfPresses = !cycled && !trap && empty < 2 && seen.size >= max - 1;
  let missing = outOfPresses ? [] : start.expected.filter((e) => !seen.has(e.ref) && !(e.group && reachedGroups.has(e.group)));
  if (missing.length && !trap) missing = await rovingReach(page, missing, seen, { keepFocus: start.modal || !!within });
  // A control can be disabled or gone for a moment while the sweep passes it (a write in flight, a refresh), and back by
  // the end. One more plain Tab cycle, outside a modal, decides: what Tab reaches in either cycle is reachable.
  if (missing.length && !trap && !start.modal && !within) missing = await secondSweep(page, missing, max);
  // What the traversal itself removed or hid (reading a conversation marks it read, and its Mark read button goes) can't
  // be reached any more, and isn't a defect of the tab order.
  if (missing.length) {
    const present = await page.evaluate((refs) => refs.map((r) => window.__fr.present(r)), missing.map((m) => m.ref));
    missing = missing.filter((_, i) => present[i]);
  }
  if (outOfPresses) out.push({ check: 'keyboard', pass: false, measured: `Tab budget of ${max} presses ran out after ${seen.size} stops, before it came round`, threshold: 'the whole tab order', fix: `Raise tabTraverse.max above ${start.expected.length + 10} (the page has ${start.expected.length} tab stops), or give it a smaller region with within.` });
  if (start.startsOutside) out.push({ check: 'keyboard', pass: false, measured: `focus is on ${start.startsOutside}, outside the open dialog`, threshold: 'focus inside the open dialog', fix: 'Move focus into the dialog when it opens (its first control, or the dialog itself).' });
  if (escaped) out.push({ check: 'keyboard', pass: false, measured: 'Tab leaves the open dialog', threshold: 'Tab stays inside the open dialog', selector: escaped.selector, label: escaped.label, ref: escaped.ref, fix: `Keep Tab inside the open dialog: it reached ${escaped.label} behind it.` });
  if (trap) out.push({ check: 'keyboard', pass: false, measured: 'focus trapped', threshold: 'Tab moves on', selector: trap.selector, label: trap.label, ref: trap.ref, fix: `Tab stays on ${trap.label}: let Tab move focus on.` });
  for (const m of missing.slice(0, 25)) out.push({ check: 'keyboard', pass: false, measured: 'not reached by Tab', threshold: 'reached', selector: m.selector, label: m.label, ref: m.ref, fix: `Make ${m.label} reachable in tab order${start.modal ? ' inside the open dialog' : ''} (or remove it from the page when it can't be used).` });
  if (missing.length > 25) out.push({ check: 'keyboard', pass: false, measured: `${missing.length - 25} more not reached`, threshold: 'reached' });
  if (!out.some((f) => f.check === 'keyboard')) out.push({ check: 'keyboard', pass: true, measured: `${visited.length} reached, ${start.expected.length} expected`, threshold: 'all reached, no trap' });
  if (!out.some((f) => f.check === 'focusVisible')) out.push({ check: 'focusVisible', pass: true, measured: `${visited.length} show focus`, threshold: 'outline, ring or visible change' });
  return out;
}

/** A second plain Tab cycle from the top of the page, for elements the first one missed. */
async function secondSweep(page, missing, max) {
  await page.evaluate(() => document.activeElement?.blur?.());
  const reached = new Set();
  let first = null;
  let empty = 0;
  for (let i = 0; i < max; i++) {
    await page.keyboard.press('Tab');
    const info = await page.evaluate(() => window.__fr.focusInfo());
    if (!info) { if (++empty >= 2) break; continue; }
    empty = 0;
    if (info.guard) continue;
    if (first === null) first = info.ref;
    else if (info.ref === first) break;
    reached.add(info.ref);
  }
  return missing.filter((m) => !reached.has(m.ref));
}

/**
 * Drives composite widgets for what a plain Tab sweep missed: in a roving list, toolbar, grid or the like, Tab reaches
 * one item and the arrow keys move between items, and an element inside another item is reached by arrowing to that
 * item and pressing Tab. For each item holding a missed element, whose composite the sweep entered, this focuses the
 * composite's stop, presses Home and then Down (or Right) until the item is current, then Tab until focus leaves the
 * item. What it reaches is reached; the rest stays missing.
 */
async function rovingReach(page, missing, seen, { keepFocus = false } = {}) {
  const paths = await page.evaluate((refs) => refs.map((r) => window.__fr.rovingPath(r)), missing.map((m) => m.ref));
  const byItem = new Map();
  missing.forEach((m, i) => {
    const p = paths[i];
    if (!p || !seen.has(p.entry)) return;
    if (!byItem.has(p.item)) byItem.set(p.item, { ...p, refs: [] });
    byItem.get(p.item).refs.push(m.ref);
  });
  const reached = new Set();
  // Arrow to an item from the composite's current stop: Home, then Down (or Right) until it is current.
  const land = async (item, entry, viaActive, items) => {
    const enter = () => page.evaluate(([i, v]) => window.__fr.rovingEnter(i, v), [item, viaActive]);
    if (!(await enter())) return false;
    const at = () => page.evaluate(([i, e, v]) => window.__fr.rovingAt(i, e, v), [item, entry, viaActive]);
    if ((await at()) === 'on') return true;
    for (const step of ['ArrowDown', 'ArrowRight']) {
      await enter();
      await page.keyboard.press('Home');
      if ((await at()) === 'on') return true;
      for (let k = 0; k < items + 1; k++) {
        await page.keyboard.press(step);
        if ((await at()) === 'on') return true;
      }
    }
    return false;
  };
  // Where each composite stood, so the drive leaves it as it found it (moving its current item can change a selection
  // that later steps rely on).
  const origins = new Map();
  for (const p of byItem.values()) {
    if (origins.has(p.entry)) continue;
    const cur = await page.evaluate(([i, v]) => window.__fr.rovingCurrent(i, v), [p.item, p.viaActive]);
    if (cur !== null) origins.set(p.entry, { ...p, item: cur });
  }
  for (const p of byItem.values()) {
    if (!(await land(p.item, p.entry, p.viaActive, p.items))) continue;
    const at = () => page.evaluate(([i, e, v]) => window.__fr.rovingAt(i, e, v), [p.item, p.entry, p.viaActive]);
    for (let k = 0; k < p.refs.length + 8; k++) {
      await page.keyboard.press('Tab');
      const info = await page.evaluate(() => window.__fr.focusInfo());
      if (!info || (await at()) === 'off') break;
      reached.add(info.ref);
    }
  }
  if (byItem.size) {
    for (const o of origins.values()) await land(o.item, o.entry, o.viaActive, o.items);
    // Inside a modal dialog or a region, focus stays on the restored item, as the traversal itself leaves it there.
    if (!keepFocus) await page.evaluate(() => document.activeElement?.blur?.());
  }
  return missing.filter((m) => !reached.has(m.ref));
}

/** Throws, listing every failing finding, when any finding failed. For a repository's own tests. */
export function expectNoFindings(findings, message = 'flow-review findings') {
  const failing = (findings ?? []).filter((f) => !f.pass);
  if (!failing.length) return;
  const lines = failing.map((f) => `- ${f.check}: ${f.label ?? ''} ${f.selector ? `(${f.selector})` : ''} measured ${JSON.stringify(f.measured)}, threshold ${JSON.stringify(f.threshold)}${f.fix ? `. ${f.fix}` : ''}`);
  const err = new Error(`${message}: ${failing.length} failing\n${lines.join('\n')}`);
  err.findings = failing;
  throw err;
}
