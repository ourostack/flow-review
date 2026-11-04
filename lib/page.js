// Injected into every page before its own scripts (and into an attached page on first use). It records layout shifts,
// long tasks and frame times from the start, and holds the DOM side of every check. Plain browser JavaScript, no imports.
(() => {
  if (window.__fr) return;
  const fr = (window.__fr = { shifts: [], longTasks: [], frames: [], refs: new Map(), nextRef: 1, doc: Math.random().toString(36).slice(2) });
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (!e.hadRecentInput) fr.shifts.push({ t: e.startTime, v: e.value, nodes: (e.sources ?? []).map((s) => s.node).filter(Boolean) });
    }).observe({ type: 'layout-shift', buffered: true });
  } catch {}
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) fr.longTasks.push({ t: e.startTime, d: e.duration });
    }).observe({ type: 'longtask', buffered: true });
  } catch {}
  // Long animation frames (over 50 ms) say how much of a slow frame was the page's own main-thread work (scripts,
  // style, layout, paint records). A frame that was slow while the main thread had little to do waited on raster and
  // compositing, which a GPU-less headless browser does in software: the machine's cost, not the page's.
  fr.loafs = [];
  fr.loafSupported = !!PerformanceObserver.supportedEntryTypes?.includes('long-animation-frame');
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        const scripts = (e.scripts ?? []).reduce((a, s) => a + s.duration, 0);
        const render = e.renderStart ? e.startTime + e.duration - e.renderStart : 0;
        fr.loafs.push({ t: e.startTime, end: e.startTime + e.duration, work: scripts + render, block: e.blockingDuration ?? 0 });
        if (fr.loafs.length > 5000) fr.loafs.splice(0, 2500);
      }
    }).observe({ type: 'long-animation-frame', buffered: true });
  } catch {}
  let last = 0;
  const tick = (t) => {
    if (last) {
      fr.frames.push([t, t - last]);
      if (fr.frames.length > 20000) fr.frames.splice(0, 10000);
    }
    last = t;
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);

  // ---- motion: every animation or transition that starts is counted, so a measurement can tell it was moved under ----
  // Shadow roots are watched too: their animations aren't the document's, and their animation events don't leave them.
  fr.motionStarts = 0;
  const started = () => { fr.motionStarts++; };
  const roots = new Set();
  const watch = (root) => {
    if (roots.has(root)) return;
    roots.add(root);
    root.addEventListener('transitionrun', started, true);
    root.addEventListener('animationstart', started, true);
  };
  watch(document);
  const animate = Element.prototype.animate;
  if (typeof animate === 'function') {
    Element.prototype.animate = function (...a) {
      fr.motionStarts++;
      return animate.apply(this, a);
    };
  }
  const attachShadow = Element.prototype.attachShadow;
  if (typeof attachShadow === 'function') {
    Element.prototype.attachShadow = function (...a) {
      const root = attachShadow.apply(this, a);
      watch(root);
      return root;
    };
  }
  /** Animations and transitions running toward an end; an endless one never settles, so it isn't one of them. */
  const moving = () => [...roots].flatMap((r) => r.getAnimations?.() ?? []).filter((a) => a.playState === 'running' && Number.isFinite(a.effect?.getComputedTiming().endTime ?? Infinity));
  fr.moving = () => moving().length;
  let mark = null;
  /** Watches the open shadow roots the page declared in its HTML, or made before this script was put in. */
  fr.watchShadows = () => {
    const visit = (root) => {
      const walk = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT);
      for (let n = walk.nextNode(); n; n = walk.nextNode()) {
        if (n.shadowRoot) {
          watch(n.shadowRoot);
          visit(n.shadowRoot);
        }
      }
    };
    visit(document);
  };
  fr.motionMark = () => { mark = { starts: fr.motionStarts, moving: new Set(moving()) }; };
  /** Whether anything started moving since motionMark (one already moving then doesn't count). */
  fr.movedSinceMark = () => !mark || fr.motionStarts !== mark.starts || moving().some((a) => !mark.moving.has(a));

  // ---- helpers -------------------------------------------------------------------------------------------------------
  const ref = (el) => {
    for (const [k, v] of fr.refs) if (v === el) return k;
    const k = fr.nextRef++;
    fr.refs.set(k, el);
    return k;
  };
  fr.ref = ref;
  const esc = (s) => (window.CSS?.escape ? CSS.escape(s) : s.replace(/[^\w-]/g, '\\$&'));
  const selector = (el) => {
    if (!(el instanceof Element)) return '';
    const parts = [];
    for (let n = el, depth = 0; n && n.nodeType === 1 && depth < 7; n = n.parentElement, depth++) {
      // Ids a framework generates per render (React's useId, Radix, Base UI) change between builds: not a stable anchor.
      if (n.id && !/^(_?r_|:r|«r|radix-|base-ui-|headlessui-|mui-)|^[\d_:«-]|[«»]|[_:]r[0-9a-z]+[_:]?$|[0-9a-f]{8,}/i.test(n.id) && document.querySelectorAll(`#${esc(n.id)}`).length === 1) {
        parts.unshift(`#${esc(n.id)}`);
        return parts.join(' > ');
      }
      const tag = n.localName;
      const testid = n.getAttribute('data-testid');
      if (testid) {
        parts.unshift(`${tag}[data-testid="${testid}"]`);
        continue;
      }
      const sib = n.parentElement ? [...n.parentElement.children].filter((c) => c.localName === tag) : [];
      parts.unshift(sib.length > 1 ? `${tag}:nth-of-type(${sib.indexOf(n) + 1})` : tag);
      if (tag === 'body' || tag === 'html') break;
    }
    return parts.join(' > ');
  };
  fr.selector = selector;
  const text = (s, n = 60) => (s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  const label = (el) => {
    const by = el.getAttribute('aria-labelledby');
    // A control named only by its picture (an image's alt, an svg's label or title) is named by that picture.
    const pic = el.querySelector?.('img[alt]:not([alt=""]), svg[aria-label], svg > title');
    const lab = el.getAttribute('aria-label') || (by && by.split(/\s+/).map((id) => document.getElementById(id)?.textContent ?? '').join(' ')) || el.getAttribute('alt') || el.getAttribute('title') || text(el.textContent) || (pic && (pic.getAttribute('alt') || pic.getAttribute('aria-label') || pic.textContent)) || el.getAttribute('placeholder') || el.value;
    return text(lab, 50);
  };
  fr.label = label;
  const roleOf = (el) => el.getAttribute('role') || ({ a: 'link', button: 'button', input: 'input', select: 'select', textarea: 'textbox', summary: 'summary' }[el.localName] ?? el.localName);
  const visible = (el) => {
    if (!el.isConnected) return false;
    if (el.checkVisibility && !el.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true })) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const hiddenFromAll = (el) => !!el.closest('[inert], [aria-hidden="true"]');
  const ignored = (el, ignore) => !!(ignore && el.closest(ignore));
  const pageRect = (r) => ({ x: Math.round(r.left + scrollX), y: Math.round(r.top + scrollY), w: Math.round(r.width), h: Math.round(r.height) });
  const INTERACTIVE = 'a[href], button, input:not([type="hidden"]), select, textarea, summary, [tabindex], [contenteditable="true"], [role="button"], [role="link"], [role="checkbox"], [role="switch"], [role="tab"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="radio"], [role="option"], [role="slider"], [role="spinbutton"], [role="combobox"], [role="textbox"], [role="treeitem"]';
  const disabled = (el) => el.matches(':disabled') || el.getAttribute('aria-disabled') === 'true';
  // The modal dialog in front, if any. A dialog is modal when it says so (a <dialog> opened with showModal(), or
  // aria-modal="true"), or when it hides the page behind it: overlay libraries (Base UI, Radix) leave aria-modal off and
  // make everything outside the dialog aria-hidden or inert. A non-modal dialog, such as a toast, a popover or a <dialog>
  // opened with show(), neither traps focus nor scopes the checks. What lies behind a modal isn't what the person sees.
  const pageHidden = (d) => {
    let top = d;
    while (top.parentElement && top.parentElement !== document.body) top = top.parentElement;
    if (top.parentElement !== document.body) return false;
    const others = [...document.body.children].filter((c) => c !== top && !/^(script|style|template|link|meta|noscript)$/.test(c.localName) && c.getBoundingClientRect().width * c.getBoundingClientRect().height > 0);
    return others.length > 0 && others.every((c) => c.inert || c.getAttribute('aria-hidden') === 'true');
  };
  const isModal = (d) => (d.localName === 'dialog' ? d.matches(':modal') : d.getAttribute('aria-modal') === 'true' || pageHidden(d));
  const modalRoot = () => {
    const modals = [...document.querySelectorAll('dialog, [role="dialog"], [role="alertdialog"]')].filter((d) => visible(d) && !d.closest('[inert]') && isModal(d));
    return modals.at(-1) ?? null;
  };
  fr.modalRoot = modalRoot;
  /** Interactive elements a person can reach: visible, enabled, not inert or hidden, inside the open modal if one is. */
  const interactive = (opts = {}) => {
    const root = (opts.within && document.querySelector(opts.within)) || modalRoot() || document.body;
    return [...root.querySelectorAll(INTERACTIVE)].filter((el) => {
      if (el.matches('[data-base-ui-focus-guard], [data-floating-ui-focus-guard], [data-focus-guard], [data-radix-focus-guard]')) return false;
      if (el.matches('[tabindex]') && !el.matches(INTERACTIVE.replace(', [tabindex]', '')) && el.tabIndex < 0) return false;
      if (!visible(el) || disabled(el) || hiddenFromAll(el) || ignored(el, opts.ignore)) return false;
      if (el.closest('details:not([open])') && !el.matches('details > summary')) return false;
      return true;
    });
  };
  fr.interactive = interactive;
  // A control a person presses or types into, not a focusable container (a scrollable region, a code block, a tab panel).
  const CONTROL_ROLES = /^(button|link|checkbox|switch|tab|menuitem|menuitemcheckbox|menuitemradio|radio|option|slider|spinbutton|combobox|textbox|treeitem|searchbox)$/;
  const control = (el) => (el.matches('a[href], button, input, select, textarea, summary') && !el.getAttribute('role')) || CONTROL_ROLES.test(el.getAttribute('role') ?? '');

  // ---- colour ---------------------------------------------------------------------------------------------------------
  const cv = document.createElement('canvas');
  cv.width = cv.height = 1;
  let cx = null;
  /** Any CSS colour (rgb, oklch, color(), named) to [r, g, b, a] with r..b in 0..255 and a in 0..1. */
  const rgba = (color) => {
    const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:\s*[,/]\s*([\d.]+%?))?\s*\)$/.exec(color);
    if (m) return [+m[1], +m[2], +m[3], m[4] === undefined ? 1 : m[4].endsWith('%') ? parseFloat(m[4]) / 100 : +m[4]];
    if (!color || color === 'transparent') return [0, 0, 0, 0];
    cx ??= cv.getContext('2d', { willReadFrequently: true });
    cx.clearRect(0, 0, 1, 1);
    cx.fillStyle = '#000';
    cx.fillStyle = color;
    cx.fillRect(0, 0, 1, 1);
    const d = cx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  };
  const blend = (top, under) => {
    const a = top[3] + under[3] * (1 - top[3]);
    if (a === 0) return [0, 0, 0, 0];
    return [0, 1, 2].map((i) => (top[i] * top[3] + under[i] * under[3] * (1 - top[3])) / a).concat(a);
  };
  const lum = ([r, g, b]) => {
    const f = (c) => ((c /= 255) <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
  };
  const ratio = (a, b) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  /** The colour behind an element: its and its ancestors' backgrounds composed; null when an image lies behind it. */
  const backdrop = (el) => {
    const layers = [];
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const st = getComputedStyle(n);
      if (st.backgroundImage !== 'none' && !/^linear-gradient\(\s*(rgba?\([^)]*\)|transparent)\s*,\s*\1\s*\)$/.test(st.backgroundImage)) return null;
      const c = rgba(st.backgroundColor);
      if (c[3] > 0) layers.push(c);
      if (c[3] >= 1) break;
    }
    const dark = /dark/.test(getComputedStyle(document.documentElement).colorScheme) && !/light/.test(getComputedStyle(document.documentElement).colorScheme);
    let out = dark ? [18, 18, 18, 1] : [255, 255, 255, 1];
    for (const c of layers.reverse()) out = blend(c, out);
    return out;
  };
  /**
   * The opacity an element is drawn with on its backdrop: its own and its ancestors', up to the first with an opaque
   * background (that box's own opacity fades it and what's drawn on it together).
   */
  const drawnOpacity = (el) => {
    let op = 1;
    for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
      const st = getComputedStyle(n);
      if (n !== el && rgba(st.backgroundColor)[3] >= 1) break;
      op *= parseFloat(st.opacity);
    }
    return op;
  };
  fr.contrast = { rgba, ratio, backdrop, drawnOpacity };

  // ---- states: every empty, loading, error, first-run and success state on screen, and whether it has its Moment ------
  const STATE_SELECTORS = {
    loading: '[aria-busy="true"], [role="progressbar"], [data-state="loading"]',
    error: '[role="alert"], [data-state="error"]',
    empty: '[data-state="empty"]',
    'first-run': '[data-state="first-run"]',
    success: '[data-state="success"]',
  };
  const STATUS_WORDS = [
    ['error', /\b(couldn['’]?t|can['’]?t|cannot|failed|error|isn['’]?t available|not available|unavailable|went wrong)\b/i],
    ['loading', /\b(loading|syncing|fetching|please wait)\b|…$/i],
    ['empty', /\b(nothing|no \w+ (yet|here|found)|empty|none yet|all caught up)\b/i],
  ];
  // Success has no word rule: a status line that says "Updated" or "Saved" is often standing information, not the
  // moment something worked. It is found by data-state="success", or declared on the step that succeeds.
  /** States shown now, with `declared` ({ kind, region }) from the flow; each says whether it holds its Moment. */
  fr.states = ({ moment = '[data-moment="{kind}"]', declared = [], ignore } = {}) => {
    const found = new Map();
    const add = (kind, el, how) => {
      if (!el || ignored(el, ignore)) return;
      const key = `${kind} ${selector(el)}`;
      if (found.has(key)) return;
      const sel = moment.replaceAll('{kind}', kind);
      const hasMoment = el.matches(sel) || !!el.querySelector(sel) || !!el.closest(sel);
      found.set(key, { kind, ref: ref(el), selector: selector(el), label: text(el.innerText || el.getAttribute('aria-label') || '', 80), how, hasMoment });
    };
    const shown = (el) => visible(el) && el.getBoundingClientRect().width > 2 && el.getBoundingClientRect().height > 2 && !hiddenFromAll(el);
    // A declared state names its element's kind; the word rules don't second-guess it.
    const named = new Set();
    for (const d of declared) {
      const el = (d.regionRef !== undefined && fr.refs.get(d.regionRef)) || (d.region && document.querySelector(d.region)) || document.querySelector('main') || document.body;
      add(d.kind, el, 'declared');
      named.add(el);
    }
    for (const [kind, sel] of Object.entries(STATE_SELECTORS)) for (const el of document.querySelectorAll(sel)) if (shown(el) && !named.has(el)) add(kind, el, 'marked');
    for (const el of document.querySelectorAll('[role="status"], [role="alert"], output')) {
      if (!shown(el) || named.has(el)) continue;
      const words = text(el.innerText, 300);
      const hit = STATUS_WORDS.find(([, re]) => re.test(words));
      if (hit) add(hit[0], el, 'status words');
    }
    // A list, table or grid that is on the page with nothing in it.
    for (const el of document.querySelectorAll('main ul, main ol, [role="list"], [role="listbox"], [role="grid"], table')) {
      if (!el.checkVisibility?.({ checkVisibilityCSS: true }) || hiddenFromAll(el) || el.closest('nav, menu, [role="menu"], [role="toolbar"], [aria-live], [popover]')) continue;
      // An empty list has no size of its own: it counts when it sits in a section that is shown, not in an overlay layer.
      const home = el.closest('section, [role="region"], [data-section], main');
      let layer = false;
      for (let n = el; n && n !== home; n = n.parentElement) if (/fixed|sticky/.test(getComputedStyle(n).position)) layer = true;
      if (!shown(el) && (layer || !home || !shown(home))) continue;
      const items = el.querySelectorAll(':scope > li, [role="listitem"], [role="option"], [role="row"], tbody > tr');
      if (items.length === 0) add('empty', el.closest('section, [role="region"], [data-section]') ?? el, 'empty list');
    }
    return [...found.values()];
  };

  // ---- checks: each returns { items: [{ ref, selector, label, pass, measured, threshold, rect, fix }], measured } -----

  /** Icon-only controls whose glyph reads under the UI ratio against what is behind it (WCAG 1.4.11). */
  fr.uiContrast = ({ min = 3, ignore } = {}) => {
    const items = [];
    for (const el of interactive({ ignore })) {
      if (text(el.innerText).length > 0) continue;
      const shape = el.querySelector('svg path, svg circle, svg rect, svg line, svg polyline, svg polygon, svg use, svg ellipse');
      if (!shape || !visible(shape.closest('svg'))) continue;
      const st = getComputedStyle(shape);
      const paint = [st.stroke, st.fill].find((p) => p && p !== 'none' && !p.startsWith('url'));
      if (!paint) continue;
      // What the glyph is drawn on: its nearest painted ancestor (a badge's disc or pill), not the control behind that.
      const bg = backdrop(shape);
      if (!bg) continue;
      let fg = rgba(paint);
      const op = drawnOpacity(shape);
      // A transparent glyph is hidden on purpose (an unchecked box's tick), not faint.
      if (fg[3] * op < 0.05) continue;
      fg = blend([fg[0], fg[1], fg[2], fg[3] * op], bg);
      const r = +ratio(fg, bg).toFixed(2);
      items.push({ ref: ref(el), selector: selector(el), label: `${roleOf(el)} "${label(el)}" icon`, pass: r >= min, measured: r, threshold: min, rect: pageRect(el.getBoundingClientRect()), fix: `Give the icon a colour of at least ${min}:1 against its background (now ${r}:1).` });
    }
    return { items };
  };

  // A control's pseudo-elements that are absolutely placed over an ancestor (the stretched-link pattern: an ::after with
  // inset 0 over a row that is position: relative): their boxes, in viewport px.
  const pseudoHits = (el) => {
    const out = [];
    for (const which of ['::before', '::after']) {
      const ps = getComputedStyle(el, which);
      if (!ps.content || /^(none|normal)$/.test(ps.content) || ps.display === 'none' || ps.pointerEvents === 'none' || !/^(absolute|fixed)$/.test(ps.position)) continue;
      let cb = { left: 0, top: 0, right: innerWidth, bottom: innerHeight };
      if (ps.position === 'absolute') {
        for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
          const s = getComputedStyle(n);
          if (s.position !== 'static' || s.transform !== 'none' || s.filter !== 'none' || /paint|layout|strict|content/.test(s.contain)) {
            const b = n.getBoundingClientRect();
            cb = { left: b.left + n.clientLeft, top: b.top + n.clientTop, right: b.left + n.clientLeft + n.clientWidth, bottom: b.top + n.clientTop + n.clientHeight };
            break;
          }
        }
      }
      const px = (v) => (v === 'auto' || v === '' ? null : parseFloat(v));
      const [t, l, rt, bt, w, h] = [ps.top, ps.left, ps.right, ps.bottom, ps.width, ps.height].map(px);
      const left = l != null ? cb.left + l : rt != null && w != null ? cb.right - rt - w : null;
      const top = t != null ? cb.top + t : bt != null && h != null ? cb.bottom - bt - h : null;
      const right = w != null && left != null ? left + w : rt != null ? cb.right - rt : null;
      const bottom = h != null && top != null ? top + h : bt != null ? cb.bottom - bt : null;
      if ([left, top, right, bottom].some((v) => v == null || Number.isNaN(v)) || right - left < 1 || bottom - top < 1) continue;
      out.push({ left, top, right, bottom });
    }
    return out;
  };
  /**
   * A small control's real hit area: its box and line boxes, plus any pseudo-element stretched over an ancestor or any
   * descendant reaching past it, then
   * confirmed by hit-testing a grid of points over that candidate (a point counts when the topmost element there is the
   * control or inside it). Returns the extent of the confirmed points, or null when nothing beyond the box is in play.
   */
  const hitBox = (el, min = 24) => {
    // What can reach past the control's own box: a stretched pseudo-element, or a descendant (an icon in an inline link).
    const beyond = () => {
      const r = el.getBoundingClientRect();
      const kids = [...el.querySelectorAll('*')].slice(0, 50).map((d) => d.getBoundingClientRect()).filter((b) => b.width > 0 && b.height > 0);
      return [...pseudoHits(el), ...kids].filter((b) => b.left < r.left - 0.5 || b.top < r.top - 0.5 || b.right > r.right + 0.5 || b.bottom > r.bottom + 0.5);
    };
    if (!beyond().length) return null;
    const cand = () => {
      const boxes = [el.getBoundingClientRect(), ...el.getClientRects(), ...beyond()];
      return { left: Math.min(...boxes.map((b) => b.left)), top: Math.min(...boxes.map((b) => b.top)), right: Math.max(...boxes.map((b) => b.right)), bottom: Math.max(...boxes.map((b) => b.bottom)) };
    };
    // Bringing it into view scrolls the window and any scrolling ancestor; every one is put back.
    // The flat tree up from the control (through slots and shadow hosts): every box that scrolls or clips it.
    const up = [];
    for (let n = el.assignedSlot ?? el.parentElement ?? el.getRootNode()?.host; n && n.nodeType === 1; n = n.assignedSlot ?? n.parentElement ?? n.getRootNode()?.host) up.push(n);
    const clips = () => up.filter((n) => n !== document.documentElement && n !== document.body).flatMap((n) => {
      const st = getComputedStyle(n);
      const cx = st.overflowX !== 'visible', cy = st.overflowY !== 'visible';
      if (!cx && !cy) return [];
      const b = n.getBoundingClientRect();
      return [{ left: cx ? b.left + n.clientLeft : -Infinity, top: cy ? b.top + n.clientTop : -Infinity, right: cx ? b.left + n.clientLeft + n.clientWidth : Infinity, bottom: cy ? b.top + n.clientTop + n.clientHeight : Infinity }];
    });
    // Bringing it into view scrolls the window and any scrolling ancestor; every one is put back.
    const scrolled = up.filter((n) => n.scrollTop || n.scrollLeft || n.scrollHeight > n.clientHeight || n.scrollWidth > n.clientWidth).map((n) => [n, n.scrollLeft, n.scrollTop]);
    const sx = scrollX, sy = scrollY;
    // What is on screen: the viewport and every clipping ancestor's inside.
    const shown = () => clips().reduce((a, b) => ({ left: Math.max(a.left, b.left), top: Math.max(a.top, b.top), right: Math.min(a.right, b.right), bottom: Math.min(a.bottom, b.bottom) }), { left: 0, top: 0, right: innerWidth, bottom: innerHeight });
    try {
      let c = cand();
      let v = shown();
      if (c.top < v.top || c.left < v.left || c.bottom > v.bottom || c.right > v.right) {
        el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
        c = cand();
        v = shown();
      }
      // Only what is on screen can be hit-tested.
      c = { left: Math.max(v.left, c.left), top: Math.max(v.top, c.top), right: Math.min(v.right, c.right), bottom: Math.min(v.bottom, c.bottom) };
      if (c.right - c.left < 1 || c.bottom - c.top < 1) return null;
      const isHit = (x, y) => { const t = document.elementFromPoint(x, y); return !!t && (t === el || el.contains(t)); };
      // 1. Points every min / 2 px: any min x min square holds a 2 x 2 block of them, so only such blocks can be in one.
      const s = min / 2;
      const L = Math.floor(c.left), T = Math.floor(c.top), R = Math.ceil(c.right), B = Math.ceil(c.bottom);
      const cols = Math.max(1, Math.ceil((R - L) / s)), rows = Math.max(1, Math.ceil((B - T) / s));
      if (cols * rows > 60000) return null;
      const px = (i) => L + s * (i + 0.5), py = (j) => T + s * (j + 0.5);
      const hit = new Uint8Array(cols * rows);
      let any = null;
      let sx2 = 0, sy2 = 0, count = 0;
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) {
        if (px(i) >= R || py(j) >= B || !isHit(px(i), py(j))) continue;
        hit[j * cols + i] = 1;
        sx2 += i; sy2 += j; count++;
        any ??= [i, j];
      }
      if (!any) return null;
      // 2. Each block's window holds every min x min square through its four points; a square counts only when all its
      // min x min pixel centres hit the control. Windows inside one already checked are skipped; the pixel budget is capped.
      const need = Math.ceil(min);
      const checked = [];
      // The hit area is the pixels whose centres the browser's own hit test gives to the control. Hit testing snaps edges by
      // up to a pixel, so the measure is good to about a pixel: an area a pixel or more under the minimum always fails, and
      // one within a pixel of it is judged by those centres. Each centre is tested once, however many windows hold it,
      // against a budget.
      const memo = new Map();
      let budget = 150000;
      const pix = (x, y) => {
        const k = x * 100003 + y;
        let v = memo.get(k);
        if (v === undefined) { v = isHit(x + 0.5, y + 0.5); memo.set(k, v); budget--; }
        return v;
      };
      const confirm = (w) => {
        const wc = w.right - w.left, wr = w.bottom - w.top;
        if (wc < need || wr < need) return false;
        const run = new Int32Array(wc);
        for (let y = 0; y < wr && budget > 0; y++) {
          let span = 0;
          for (let x = 0; x < wc; x++) {
            run[x] = pix(w.left + x, w.top + y) ? run[x] + 1 : 0;
            span = run[x] >= need ? span + 1 : 0;
            if (span >= need) return true;
          }
        }
        return false;
      };
      // Blocks whose 3 x 3 neighbourhood is all hit (an area at least min across) first, then the rest.
      const at = (i, j) => i >= 0 && j >= 0 && i < cols && j < rows && hit[j * cols + i] === 1;
      const blocks = [[], []];
      for (let j = 0; j + 1 < rows; j++) for (let i = 0; i + 1 < cols; i++) {
        if (!(at(i, j) && at(i + 1, j) && at(i, j + 1) && at(i + 1, j + 1))) continue;
        blocks[at(i + 2, j) && at(i, j + 2) && at(i + 1, j + 2) && at(i + 2, j + 1) && at(i + 2, j + 2) ? 0 : 1].push([i, j]);
      }
      let square = false;
      for (const [i, j] of [...blocks[0], ...blocks[1]]) {
        if (square || budget <= 0) break;
        const w = { left: Math.max(L, Math.floor(px(i + 1) - min)), top: Math.max(T, Math.floor(py(j + 1) - min)), right: Math.min(R, Math.ceil(px(i) + min)), bottom: Math.min(B, Math.ceil(py(j) + min)) };
        if (checked.some((o) => o.left <= w.left && o.top <= w.top && o.right >= w.right && o.bottom >= w.bottom)) continue;
        checked.push(w);
        square = confirm(w);
      }
      // 3. The hit area's size for the finding: runs of hit pixel centres through the hit point nearest their middle.
      let [ci, cj] = any;
      let best = Infinity;
      const mx = sx2 / count, my = sy2 / count;
      for (let j = 0; j < rows; j++) for (let i = 0; i < cols; i++) if (hit[j * cols + i] && (i - mx) ** 2 + (j - my) ** 2 < best) { best = (i - mx) ** 2 + (j - my) ** 2; ci = i; cj = j; }
      const x0 = Math.floor(px(ci)) + 0.5, y0 = Math.floor(py(cj)) + 0.5;
      let l = x0, r = x0, t = y0, bt = y0;
      while (l - 1 >= L && isHit(l - 1, y0)) l--;
      while (r + 1 < R && isHit(r + 1, y0)) r++;
      while (t - 1 >= T && isHit(x0, t - 1)) t--;
      while (bt + 1 < B && isHit(x0, bt + 1)) bt++;
      return { width: r - l + 1, height: bt - t + 1, square };
    } finally {
      for (const [n, l, t] of scrolled) n.scrollTo({ left: l, top: t, behavior: 'instant' });
      if (scrollX !== sx || scrollY !== sy) scrollTo({ left: sx, top: sy, behavior: 'instant' });
    }
  };
  fr.hitBox = (r) => hitBox(fr.refs.get(r));

  /** Pointer targets at least `min` CSS px on each side, with WCAG 2.5.8's inline, spacing and user-agent exceptions. */
  fr.targetSize = ({ min = 24, ignore } = {}) => {
    const all = interactive({ ignore }).filter(control);
    const rects = all.map((el) => el.getBoundingClientRect());
    const small = (r) => r.width < min - 0.01 || r.height < min - 0.01;
    const items = [];
    all.forEach((el, i) => {
      const r = rects[i];
      if (r.width <= 1 && r.height <= 1) return;
      if (!small(r)) return;
      // Its real hit area, when a stretched pseudo-element or a descendant makes it bigger than its box.
      const hit = hitBox(el, min);
      if (hit?.square) return;
      const st = getComputedStyle(el);
      // Inline: a link inside a sentence, whose block holds other words.
      if (el.localName === 'a' && st.display === 'inline') {
        let b = el.parentElement;
        while (b && getComputedStyle(b).display === 'inline') b = b.parentElement;
        if (b && text(b.textContent.replace(el.textContent, '')).length > 0) return;
      }
      // User agent control: a native checkbox or radio inside a label that is itself big enough.
      if (el.matches('input[type="checkbox"], input[type="radio"]')) {
        const lab = el.closest('label') ?? (el.id && document.querySelector(`label[for="${esc(el.id)}"]`));
        if (lab) {
          const lr = lab.getBoundingClientRect();
          if (lr.width >= min && lr.height >= min) return;
        }
      }
      // Spacing: a min-diameter circle on its centre reaches no other target, nor another small target's circle.
      const c = [r.left + r.width / 2, r.top + r.height / 2];
      const spaced = rects.every((o, j) => {
        if (j === i || all[j].contains(el) || el.contains(all[j])) return true;
        const dx = Math.max(o.left - c[0], 0, c[0] - o.right);
        const dy = Math.max(o.top - c[1], 0, c[1] - o.bottom);
        if (Math.hypot(dx, dy) < min / 2) return false;
        if (small(o)) return Math.hypot(o.left + o.width / 2 - c[0], o.top + o.height / 2 - c[1]) >= min;
        return true;
      });
      if (spaced) return;
      const box = hit ?? r;
      const m = `${Math.round(box.width * 10) / 10}x${Math.round(box.height * 10) / 10}`;
      items.push({ ref: ref(el), selector: selector(el), label: `${roleOf(el)} "${label(el)}"${hit ? ' (hit area)' : ''}`, pass: false, measured: m, threshold: min, rect: pageRect(r), fix: `Make the target at least ${min}x${min} px (its hit area is ${m}), or space it ${min} px from its neighbours.` });
    });
    return { items, measured: { targets: all.length } };
  };

  const CONTROLS = 'button, a[href], input, select, textarea, summary, [role="button"], [role="link"], [role="combobox"], [role="menuitem"], [role="menuitemcheckbox"], [role="menuitemradio"], [role="tab"], [role="treeitem"], [role="row"], [role="gridcell"], [role="option"], [role="switch"], [role="checkbox"]';
  const opensElsewhere = (n) => n.matches('[role="combobox"], [role="treeitem"], [role="row"]') || (n.getAttribute('aria-haspopup') ?? 'false') !== 'false' || (n.getAttribute('aria-controls') ?? '').split(/\s+/).some((id) => id && document.getElementById(id) && !n.contains(document.getElementById(id)));
  const folded = (el) => {
    if (el.closest('details:not([open]), [hidden], [inert]')) return true;
    for (let n = el; n && n !== document.body; n = n.parentElement) {
      // A collapsed region, or a control that expands its own text. On a control that opens something else (a menu
      // button, a combobox, a tree item's group), aria-expanded describes that, and the control's own text is on screen.
      if (n.getAttribute('aria-expanded') === 'false' && !(n.matches(CONTROLS) && opensElsewhere(n))) return true;
      if (n.id) {
        const ctl = document.querySelector(`[aria-controls~="${esc(n.id)}"][aria-expanded="false"]`);
        if (ctl && visible(ctl) && !hiddenFromAll(ctl)) return true;
      }
    }
    return false;
  };

  /** Whether a box with this style contains (clips, scrolls) a descendant that escapes as `escape` ('', absolute, fixed). */
  const holdsOut = (ps, escape) =>
    !escape ||
    (escape === 'absolute' && ps.position !== 'static') ||
    [ps.transform, ps.translate, ps.rotate, ps.scale, ps.perspective, ps.filter, ps.backdropFilter].some((v) => v && v !== 'none') ||
    /paint|layout|strict|content/.test(ps.contain) ||
    /transform|translate|rotate|scale|perspective|filter/.test(ps.willChange);

  /** Sideways page scroll, and text cut off by a box that hides its overflow. */
  fr.overflow = ({ maxPx = 1, allowTruncation = false, minShown = 0.5, ignore } = {}) => {
    const items = [];
    const se = document.scrollingElement ?? document.documentElement;
    const extra = se.scrollWidth - innerWidth;
    if (extra > maxPx) {
      // The element reaching furthest right, outside any box that scrolls or clips sideways.
      let worst = null;
      let far = innerWidth + maxPx;
      for (const el of document.body.querySelectorAll('*')) {
        const r = el.getBoundingClientRect();
        if (r.right + scrollX <= far || r.width === 0) continue;
        let clipped = false;
        for (let p = el.parentElement; p && p !== document.body; p = p.parentElement) if (getComputedStyle(p).overflowX !== 'visible') { clipped = true; break; }
        if (clipped || ignored(el, ignore)) continue;
        worst = el;
        far = r.right + scrollX;
      }
      const t = worst ?? document.body;
      items.push({ ref: ref(t), selector: selector(t), label: `page scrolls sideways by ${extra}px`, pass: false, measured: extra, threshold: maxPx, rect: pageRect(t.getBoundingClientRect()), fix: `Keep the page within the viewport: ${selector(t)} reaches ${Math.round(far)}px of ${innerWidth}px.` });
    }
    const scope = modalRoot();
    for (const el of (scope ?? document.body).querySelectorAll('*')) {
      const st = getComputedStyle(el);
      const clipX = st.overflowX === 'hidden' || st.overflowX === 'clip';
      const clipY = st.overflowY === 'hidden' || st.overflowY === 'clip';
      if (!clipX && !clipY) continue;
      const overX = clipX && el.scrollWidth > el.clientWidth + 1;
      const overY = clipY && el.scrollHeight > el.clientHeight + 1;
      if (!overX && !overY) continue;
      const box = el.getBoundingClientRect();
      if (box.width <= 2 || box.height <= 2 || !visible(el) || ignored(el, ignore) || el.closest('svg')) continue;
      const truncation = st.textOverflow === 'ellipsis' ? 'ellipsis' : st.webkitLineClamp && st.webkitLineClamp !== 'none' ? 'line clamp' : '';
      if (truncation && allowTruncation) continue;
      // Any text inside that runs past the box on a clipped side.
      const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.textContent.trim() && !n.parentElement.closest('svg, script, style') ? 1 : 3) });
      const cuts = [];
      for (let n = tw.nextNode(); n; n = tw.nextNode()) {
        // Text inside a nested box that scrolls is reachable. Text a nested box clips is that box's to report: here
        // only the part of it the nested boxes show counts. A box clips or scrolls only what it contains as a
        // containing block: text in an absolutely positioned box escapes boxes up to its positioned ancestor.
        let scrolls = false;
        let inner = null;
        let escape = '';
        for (let p = n.parentElement; p && p !== el; p = p.parentElement) {
          const ps = getComputedStyle(p);
          const holds = holdsOut(ps, escape);
          if (holds) escape = '';
          if (holds && /(auto|scroll)/.test(ps.overflowX + ps.overflowY)) { scrolls = true; break; }
          const px = holds && /hidden|clip/.test(ps.overflowX);
          const py = holds && /hidden|clip/.test(ps.overflowY);
          if (px || py) {
            // The padding box: what lies under the border isn't shown either.
            const pr = p.getBoundingClientRect();
            const left = pr.left + p.clientLeft;
            const top = pr.top + p.clientTop;
            inner ??= { left: -Infinity, right: Infinity, top: -Infinity, bottom: Infinity };
            if (px) { inner.left = Math.max(inner.left, left); inner.right = Math.min(inner.right, left + p.clientWidth); }
            if (py) { inner.top = Math.max(inner.top, top); inner.bottom = Math.min(inner.bottom, top + p.clientHeight); }
          }
          if (ps.position === 'absolute' || ps.position === 'fixed') escape = escape === 'fixed' || ps.position === 'fixed' ? 'fixed' : 'absolute';
        }
        // Text that escapes the box itself isn't the box's to clip.
        if (scrolls || !visible(n.parentElement) || !holdsOut(st, escape)) continue;
        const rg = document.createRange();
        rg.selectNodeContents(n);
        for (const r0 of rg.getClientRects()) {
          if (r0.width < 1) continue;
          const r = inner ? { left: Math.max(r0.left, inner.left), right: Math.min(r0.right, inner.right), top: Math.max(r0.top, inner.top), bottom: Math.min(r0.bottom, inner.bottom) } : r0;
          if (r.right - r.left < 1 || r.bottom - r.top < 1) continue;
          if ((overX && (r.right > box.right + 1 || r.left < box.left - 1)) || (overY && (r.bottom > box.bottom + 1 || r.top < box.top - 1))) { cuts.push(n); break; }
        }
      }
      if (!cuts.length) continue;
      // A collapsed disclosure folds its content on purpose: inside a closed <details>, a hidden or inert region, an
      // element marked aria-expanded="false", or a box a visible control (aria-controls, aria-expanded="false") opens.
      if (folded(el)) continue;
      const cut = cuts[0];
      // Deliberate truncation (an ellipsis or a line clamp) is a design, not clipping, when nothing is lost: what it
      // hides is in the accessible name and one hover or click away (a tooltip, or the dialog the control opens), and it
      // still shows enough of the text to say what it is.
      let why = '';
      let advice = '';
      if (truncation) {
        const access = truncatedAccess(el, cuts);
        const shown = shownWords(el, box);
        if (access.ok && shown.share >= minShown) continue;
        why = !access.ok ? `; ${access.missing}` : `; shows ${shown.shown} of ${shown.total} words`;
        advice = access.ok ? 'let it show more of the text' : 'put the hidden words in the accessible name and a tooltip or the dialog it opens';
      }
      const how = `${overX ? `${el.scrollWidth}>${el.clientWidth} wide` : ''}${overX && overY ? ', ' : ''}${overY ? `${el.scrollHeight}>${el.clientHeight} tall` : ''}`;
      items.push({ ref: ref(el), selector: selector(el), label: `"${text(cut.textContent, 40)}" cut off${truncation ? ` (${truncation}${why})` : ''}`, pass: false, measured: how, threshold: truncation ? `whole text in the name and a tooltip or dialog, ${Math.round(minShown * 100)}% of words shown` : 'no clipped text', rect: pageRect(box), fix: truncation ? `Show the whole of "${text(cut.textContent, 30)}", or keep the ${truncation} and ${advice}.` : `Let the text wrap or the box grow; overflow hides part of "${text(cut.textContent, 30)}".` });
    }
    return { items, measured: { sideways: Math.max(0, extra) } };
  };

  const norm = (s) => (s ?? '').replace(/[\s\u00a0]+/g, ' ').trim().toLowerCase();
  const idsText = (el, attr) => (el.getAttribute(attr) ?? '').split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
  /** Whether what a truncation hides reaches assistive technology and the eye some other way. */
  const CONTROL_SEL = 'button, a[href], summary, [role="button"], [role="link"], [role="tab"], [role="menuitem"], [role="option"], [role="treeitem"], [role="checkbox"], [role="radio"], [role="switch"]';
  const truncatedAccess = (el, cuts) => {
    for (const n of cuts) {
      const words = norm(n.textContent);
      const from = n.parentElement;
      if (!words) continue;
      if (from.closest('[aria-hidden="true"]')) return { ok: false, missing: 'hidden from assistive technology' };
      // Assistive technology: a control named over its content (whose content is then presentational) must carry the
      // words in its name or description; otherwise the clamped words are read as they are.
      const ctl = from.closest(CONTROL_SEL);
      if (ctl?.matches('[aria-label], [aria-labelledby]')) {
        const said = norm(`${idsText(ctl, 'aria-labelledby') || ctl.getAttribute('aria-label')} ${idsText(ctl, 'aria-describedby')} ${ctl.getAttribute('aria-description') ?? ''}`);
        if (!said.includes(words)) return { ok: false, missing: 'the hidden words are not in the accessible name' };
      }
      // The eye: a tooltip that holds them, or a control that opens a dialog.
      let shown = false;
      for (let p = from; p && p !== document.body && !shown; p = p.parentElement) shown = norm(p.getAttribute('title')).includes(words);
      if (!shown && !/^(dialog|true)$/.test(ctl?.getAttribute('aria-haspopup') ?? '')) return { ok: false, missing: 'no tooltip or dialog shows the whole text' };
    }
    return { ok: true };
  };
  /** How many of an element's words lie inside its box, whole. */
  const shownWords = (el, box) => {
    let shown = 0, total = 0;
    const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.textContent.trim() && visible(n.parentElement) ? 1 : 3) });
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      const re = /\S+/g;
      for (let m = re.exec(n.textContent); m; m = re.exec(n.textContent)) {
        total++;
        const rg = document.createRange();
        rg.setStart(n, m.index);
        rg.setEnd(n, m.index + m[0].length);
        const r = rg.getBoundingClientRect();
        if (r.width >= 1 && r.left >= box.left - 1 && r.right <= box.right + 1 && r.top >= box.top - 1 && r.bottom <= box.bottom + 1) shown++;
      }
    }
    return { shown, total, share: total ? shown / total : 1 };
  };

  /** The largest empty rectangle in each section, as a share of the section's area inside its padding. */
  fr.deadSpace = ({ max = 0.25, sections = 'main section[id], [data-section]', minSectionPx = 120, ignore, cell = 8 } = {}) => {
    // With a modal open, only it and its own sections count: what lies behind it isn't in view.
    const modal = modalRoot();
    const all = [...(modal ? [modal, ...modal.querySelectorAll(sections)] : document.querySelectorAll(sections))].filter((s) => visible(s) && !ignored(s, ignore));
    const secs = modal ? all : all.filter((s) => !all.some((o) => o !== s && o.contains(s)));
    const rects = [];
    const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.textContent.trim() && !n.parentElement.closest('script, style, noscript, [hidden]') ? 1 : 3) });
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      const st = getComputedStyle(n.parentElement);
      if (st.visibility === 'hidden' || +st.opacity === 0) continue;
      const rg = document.createRange();
      rg.selectNodeContents(n);
      for (const r of rg.getClientRects()) if (r.width > 1 && r.height > 1) rects.push(r);
    }
    for (const el of document.body.querySelectorAll('img, svg, video, canvas, iframe, button, input, select, textarea, [role="img"], [role="progressbar"], [role="meter"], [data-dead-space-content]')) {
      if (el.closest('svg') && el.localName !== 'svg') continue;
      const r = el.getBoundingClientRect();
      if (r.width >= 12 && r.height >= 12 && visible(el)) rects.push(r);
    }
    const items = [];
    for (const s of secs) {
      const r0 = s.getBoundingClientRect();
      if (r0.height < minSectionPx) continue;
      const cs = getComputedStyle(s);
      // Boxes with their own fill or border (cards, panels) hold their space, when they are smaller than the section.
      const sbg = cs.backgroundColor;
      for (const el of s.querySelectorAll('*')) {
        const st = getComputedStyle(el);
        const r = el.getBoundingClientRect();
        if (r.width < 24 || r.height < 24 || r.width * r.height > 0.5 * r0.width * r0.height) continue;
        const filled = rgba(st.backgroundColor)[3] > 0.05 && st.backgroundColor !== sbg;
        const bordered = parseFloat(st.borderTopWidth) > 0 && rgba(st.borderTopColor)[3] > 0.05 && parseFloat(st.borderLeftWidth) > 0;
        if (filled || bordered || st.boxShadow !== 'none') rects.push(r);
      }
      const b = { left: r0.left + parseFloat(cs.paddingLeft), right: r0.right - parseFloat(cs.paddingRight), top: r0.top + parseFloat(cs.paddingTop), bottom: r0.bottom - parseFloat(cs.paddingBottom) };
      const cols = Math.max(1, Math.round((b.right - b.left) / cell));
      const rows = Math.max(1, Math.round((b.bottom - b.top) / cell));
      const full = new Uint8Array(cols * rows);
      for (const r of rects) {
        if (r.right <= b.left || r.left >= b.right || r.bottom <= b.top || r.top >= b.bottom) continue;
        const x0 = Math.max(0, Math.floor((r.left - b.left) / cell));
        const x1 = Math.min(cols, Math.ceil((r.right - b.left) / cell));
        const y0 = Math.max(0, Math.floor((r.top - b.top) / cell));
        const y1 = Math.min(rows, Math.ceil((r.bottom - b.top) / cell));
        for (let y = y0; y < y1; y++) full.fill(1, y * cols + x0, y * cols + x1);
      }
      // Largest all-empty rectangle: a histogram of empty runs per column, row by row.
      const hgt = new Int32Array(cols);
      let best = 0;
      let bx = 0, by = 0, bw = 0, bh = 0;
      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) hgt[x] = full[y * cols + x] ? 0 : hgt[x] + 1;
        const st = [];
        for (let x = 0; x <= cols; x++) {
          const hh = x < cols ? hgt[x] : 0;
          let start = x;
          while (st.length && st.at(-1)[1] >= hh) {
            const [i, v] = st.pop();
            const a = v * (x - i);
            if (a > best) { best = a; bw = x - i; bh = v; bx = i; by = y - v + 1; }
            start = i;
          }
          st.push([start, hh]);
        }
      }
      const share = +(best / (cols * rows)).toFixed(3);
      const name = s === modal ? `dialog "${label(s)}"` : s.id ? `#${s.id}` : s.getAttribute('aria-label') ?? s.getAttribute('data-section') ?? selector(s);
      const empty = { x: Math.round(b.left - r0.left + bx * cell), y: Math.round(b.top - r0.top + by * cell), w: bw * cell, h: bh * cell };
      items.push({ ref: ref(s), selector: selector(s), label: `section ${name}`, pass: share <= max, measured: share, threshold: max, rect: pageRect(r0), offset: empty, fix: `Section ${name} has an empty ${empty.w}x${empty.h} px area (${Math.round(share * 100)}% of it): fill it, tighten it or let content use the width.` });
    }
    return { items };
  };

  /** Sentences of at least minChars that appear more than max times on the visible page. */
  fr.repetition = ({ minChars = 40, max = 2, ignore } = {}) => {
    const blockOf = (el) => {
      for (let n = el; n && n !== document.body; n = n.parentElement) if (!/^(inline|contents)$/.test(getComputedStyle(n).display)) return n;
      return document.body;
    };
    const own = new Map();
    const tw = document.createTreeWalker(modalRoot() ?? document.body, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.textContent.trim() && !n.parentElement.closest('script, style, noscript, template, [hidden], [aria-hidden="true"]') ? 1 : 3) });
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      if (!visible(n.parentElement) || ignored(n.parentElement, ignore)) continue;
      const b = blockOf(n.parentElement);
      own.set(b, (own.get(b) ?? '') + n.textContent);
    }
    const seen = new Map();
    for (const [b, t] of own) {
      for (const sentence of t.split(/(?<=[.!?…])\s+|\n+/)) {
        const norm = sentence.toLowerCase().replace(/\s+/g, ' ').replace(/^[\s"'“”‘’([{-]+|[\s"'“”‘’)\]}.,;:!?…-]+$/g, '').trim();
        if (norm.length < minChars) continue;
        if (!seen.has(norm)) seen.set(norm, []);
        seen.get(norm).push(b);
      }
    }
    const items = [];
    for (const [sentence, blocks] of seen) {
      if (blocks.length <= max) continue;
      items.push({ ref: ref(blocks[0]), selector: selector(blocks[0]), label: `"${text(sentence, 70)}" ×${blocks.length}`, pass: false, measured: blocks.length, threshold: max, rect: pageRect(blocks[0].getBoundingClientRect()), fix: `Say it once: this sentence appears ${blocks.length} times (${blocks.slice(0, 4).map(selector).join(', ')}).` });
    }
    return { items, measured: { sentences: seen.size } };
  };

  /** Every interactive element carries the design system's marker, itself or on an ancestor within `depth`. */
  fr.designSystem = ({ marker, depth = 2, ignore } = {}) => {
    const items = [];
    const all = interactive({ ignore }).filter(control);
    for (const el of all) {
      let ok = false;
      for (let n = el, d = 0; n && d <= depth && !ok; n = n.parentElement, d++) ok = n.matches(marker);
      if (!ok) items.push({ ref: ref(el), selector: selector(el), label: `${roleOf(el)} "${label(el)}"`, pass: false, measured: 'no marker', threshold: marker, rect: pageRect(el.getBoundingClientRect()), fix: `Build this control from the design system (expected ${marker} on it or within ${depth} ancestors).` });
    }
    return { items, measured: { controls: all.length } };
  };

  /** Every image inside a proof element has a notice: its description, its figure's caption or a notice element. */
  fr.proofNotice = ({ proof = '[data-proof]', notice = '[data-proof-note], [data-notice], figcaption', minChars = 10, ignore } = {}) => {
    const items = [];
    const imgs = [...document.querySelectorAll(proof)].flatMap((p) => [...p.querySelectorAll('img, svg[role="img"], [role="img"], canvas')]);
    for (const img of [...new Set(imgs)]) {
      if (!visible(img) || ignored(img, ignore)) continue;
      const desc = (img.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? '').join(' ');
      const cap = img.closest('figure')?.querySelector('figcaption')?.textContent ?? '';
      // A notice can sit on any proof container round the picture: a pair states one notice for both halves.
      const boxes = [];
      for (let b = img.closest(proof); b; b = b.parentElement?.closest(proof)) boxes.push(b);
      // A notice belongs to the picture when its own nearest proof container is one of the picture's, not a neighbour's.
      const notes = boxes.flatMap((b) => [...b.querySelectorAll(notice)].filter((n) => !n.contains(img) && boxes.includes(n.closest(proof)))).map((n) => n.textContent).join(' ');
      const best = [desc, cap, notes].map((t) => text(t, 400)).sort((a, b) => b.length - a.length)[0];
      const pass = best.length >= minChars;
      items.push({ ref: ref(img), selector: selector(img), label: `proof picture "${text(img.getAttribute('alt') ?? '', 40)}"`, pass, measured: best.length, threshold: minChars, rect: pageRect(img.getBoundingClientRect()), fix: pass ? undefined : 'Say what to notice in this proof picture: a notice line, a figcaption or aria-describedby text.' });
    }
    return { items, measured: { pictures: items.length } };
  };

  /** A declared state shows human words, not a raw error. */
  fr.state = ({ region, regionRef, minChars = 20, state }) => {
    const found = regionRef !== undefined ? fr.refs.get(regionRef) : region ? [...document.querySelectorAll(region)].find(visible) : null;
    if ((region || regionRef !== undefined) && !found) return { items: [{ label: `${state} state`, pass: false, measured: `${region} not shown`, threshold: 'the state is reachable', fix: `The ${state} state never showed ${region}.` }] };
    const el = found || document.querySelector('main') || document.body;
    const words = text(el.innerText, 2000);
    const raw = /\b(undefined|NaN|\[object \w+\]|(Type|Syntax|Reference|Range)Error|Unexpected token|ENOENT|ECONNREFUSED|stack trace|Internal Server Error|HTTP [45]\d\d|at [\w$.<>]+ \([^)]*:\d+:\d+\)|at \S+:\d+:\d+)/.exec(words);
    const pass = words.length >= minChars && !raw;
    return { items: [{ ref: ref(el), selector: selector(el), label: `${state} state`, pass, measured: raw ? `raw: ${raw[0]}` : `${words.length} chars: "${text(words, 80)}"`, threshold: `>= ${minChars} chars, no raw errors`, rect: pageRect(el.getBoundingClientRect()), fix: pass ? undefined : raw ? `Replace the raw "${raw[0]}" with words a person understands.` : `Say what this ${state} state means and what to do next.` }] };
  };

  /** CLS: the largest session window (gaps under 1 s, windows under 5 s) among shifts after `since`. */
  fr.cls = ({ since = 0, max = 0.1 } = {}) => {
    const shifts = fr.shifts.filter((s) => s.t > since);
    let best = 0, cur = 0, start = 0, prev = -Infinity, worst = null, curWorst = null;
    for (const s of shifts) {
      if (s.t - prev > 1000 || s.t - start > 5000) { cur = 0; start = s.t; curWorst = null; }
      cur += s.v;
      if (!curWorst || s.v > curWorst.v) curWorst = s;
      prev = s.t;
      if (cur > best) { best = cur; worst = curWorst; }
    }
    const node = worst?.nodes.find((n) => n.nodeType === 1) ?? worst?.nodes[0]?.parentElement;
    const v = +best.toFixed(4);
    return { now: performance.now(), items: [{ ref: node ? ref(node) : undefined, selector: node ? selector(node) : undefined, label: `layout shift ${v}`, pass: v <= max, measured: v, threshold: max, rect: node?.isConnected ? pageRect(node.getBoundingClientRect()) : undefined, fix: v <= max ? undefined : `Reserve space for ${node ? selector(node) : 'late content'} so it doesn't push the page (${shifts.length} shifts).` }] };
  };

  /** Long tasks and slow frames during motion windows ([from, to] in performance.now time) after `since`. */
  fr.jank = ({ since = 0, longTaskMs = 200, frameMs = 33, slowFrameShare = 0.1, minFrames, windows = [] } = {}) => {
    const items = [];
    for (const t of fr.longTasks.filter((x) => x.t > since && x.d >= 50)) {
      if (t.d >= longTaskMs) items.push({ label: `long task ${Math.round(t.d)} ms`, pass: false, measured: Math.round(t.d), threshold: longTaskMs, fix: `Split the work that blocks the main thread for ${Math.round(t.d)} ms at ${Math.round(t.t)} ms.` });
    }
    const inMotion = fr.frames.filter(([t]) => t > since && windows.some(([a, b]) => t >= a && t <= b));
    // Frame times come from requestAnimationFrame, in whole vsyncs: two at 60 Hz is 33.3 ms, so 1 ms is rounding.
    const over = inMotion.filter(([, d]) => d > frameMs + 1);
    // A slow frame is raster-bound when long-animation-frame timing covers it and shows the main thread had little to
    // do (scripts, style, layout and paint under frameMs, nothing blocking). Without that evidence it counts.
    const rasterBound = ([t, d]) => {
      // The frame that renders at t is the one whose work starts after the previous frame's rendering, at t - d.
      const ls = fr.loafs.filter((l) => l.t > t - d && l.t < t);
      return ls.length > 0 && ls.every((l) => l.work < frameMs && l.block === 0);
    };
    const slow = fr.loafSupported ? over.filter((f) => !rasterBound(f)) : over;
    const waited = over.length - slow.length;
    const share = inMotion.length ? +(slow.length / inMotion.length).toFixed(3) : 0;
    const longCount = fr.longTasks.filter((x) => x.t > since && x.d >= 50).length;
    // A share needs enough frames that no single frame decides it: by default twice the frames one slow frame is the share of
    // (20 at 0.1). A click's few frames are its response, which the long-task measure judges, not motion.
    const enough = minFrames ?? (slowFrameShare > 0 ? Math.max(5, Math.ceil(2 / slowFrameShare)) : 5);
    items.push({ label: `${slow.length} of ${inMotion.length} motion frames over ${frameMs} ms${waited ? ` from the page's own work (${waited} more waited on raster and compositing)` : ''}`, pass: inMotion.length < enough || share <= slowFrameShare, measured: share, threshold: slowFrameShare, fix: share > slowFrameShare ? `Make scrolling and transitions cheaper: ${slow.length} frames took over ${frameMs} ms (worst ${Math.round(Math.max(...slow.map(([, d]) => d)))} ms).` : undefined });
    return { now: performance.now(), items, measured: { longTasks: longCount, frames: inMotion.length, slowFrames: slow.length, rasterBound: waited, ...(inMotion.length < enough ? { tooFewToJudge: enough } : {}) } };
  };

  /** Scrolls the page through itself a step per frame, back to where it was, for the jank check's frame samples. */
  fr.scrollProbe = async ({ maxFrames = 90 } = {}) => {
    const se = document.scrollingElement ?? document.documentElement;
    const start = scrollY;
    const total = se.scrollHeight - innerHeight;
    const from = performance.now();
    if (total <= 0) return [from, from];
    const step = Math.max(innerHeight / 6, total / maxFrames);
    for (let y = 0; y <= total; y += step) {
      scrollTo({ top: y, behavior: 'instant' });
      await new Promise((r) => requestAnimationFrame(r));
    }
    scrollTo({ top: start, behavior: 'instant' });
    await new Promise((r) => requestAnimationFrame(r));
    return [from, performance.now()];
  };

  // ---- the duo: art that helps and never gets in the way ----------------------------------------------------------
  // Text that isn't painted isn't content a person sees: the screen-reader-only pattern (a clip or clip-path that leaves
  // an empty or 1 px box, or a box 1 px or less across that hides its overflow), opacity 0, or visibility hidden.
  const clipsAway = (cs) => {
    const m = /^rect\(([-\d.]+)px,?\s*([-\d.]+)px,?\s*([-\d.]+)px,?\s*([-\d.]+)px\)$/.exec(cs.clip ?? '');
    if (m && /absolute|fixed/.test(cs.position) && (+m[2] - +m[4] <= 1 || +m[3] - +m[1] <= 1)) return true;
    const cp = cs.clipPath ?? '';
    if (/^inset\(\s*(5\d|[6-9]\d|100)(\.\d+)?%/.test(cp)) return true;
    if (/^(rect|xywh)\(\s*0(px)?\s+0(px)?\s+0(px)?\s+0(px)?\s*\)$/.test(cp)) return true;
    return false;
  };
  // Per check (styles change between captures): what each element does to everything inside it, and, apart, whether
  // its tiny clipping box hides what it contains (which an absolutely placed descendant can escape).
  let unpaintedEl = new WeakMap();
  fr.unpaintedReset = () => { unpaintedEl = new WeakMap(); };
  const unpainted = (n) => {
    const start = n.nodeType === 1 ? n : n.parentElement;
    if (!start) return true;
    if (getComputedStyle(start).visibility !== 'visible') return true;
    let escape = '';
    for (let e = start; e && e !== document.documentElement; e = e.parentElement) {
      let v = unpaintedEl.get(e);
      if (v === undefined) {
        const cs = getComputedStyle(e);
        const r = e.getBoundingClientRect();
        v = { all: +cs.opacity === 0 || clipsAway(cs), tiny: (r.width <= 1 || r.height <= 1) && /hidden|clip/.test(cs.overflowX + cs.overflowY), cs };
        unpaintedEl.set(e, v);
      }
      if (v.all) return true;
      if (v.tiny && holdsOut(v.cs, escape)) return true;
      if (holdsOut(v.cs, escape)) escape = '';
      if (v.cs.position === 'absolute' || v.cs.position === 'fixed') escape = escape === 'fixed' || v.cs.position === 'fixed' ? 'fixed' : 'absolute';
    }
    return false;
  };
  fr.unpainted = (r) => unpainted(fr.refs.get(r));
  /** Elements with their own painted words, as blocks, outside `except`. */
  const textBlocks = (except) => {
    const out = new Set();
    const tw = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.textContent.trim() && !n.parentElement.closest('script, style, noscript, template, [hidden], [aria-hidden="true"], svg') ? 1 : 3) });
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      if (unpainted(n)) continue;
      let b = n.parentElement;
      while (b && b !== document.body && /^(inline|contents)$/.test(getComputedStyle(b).display)) b = b.parentElement;
      if (!b || b === document.body || (except && b.closest(except)) || !visible(b)) continue;
      const r = b.getBoundingClientRect();
      if (r.width > 2 && r.height > 2) out.add(b);
    }
    return [...out];
  };
  const rectOf = (el) => { const r = el.getBoundingClientRect(); return { x: r.left, y: r.top, w: r.width, h: r.height }; };
  /** Where a block's own words are: the union of its text's line boxes, not the block's full width. */
  const wordsBox = (b) => {
    let l = Infinity, t = Infinity, r = -Infinity, btm = -Infinity;
    const tw = document.createTreeWalker(b, NodeFilter.SHOW_TEXT, { acceptNode: (n) => (n.textContent.trim() && !unpainted(n) ? 1 : 3) });
    for (let n = tw.nextNode(); n; n = tw.nextNode()) {
      const rg = document.createRange();
      rg.selectNodeContents(n);
      for (const x of rg.getClientRects()) if (x.width > 0 && x.height > 0) { l = Math.min(l, x.left); t = Math.min(t, x.top); r = Math.max(r, x.right); btm = Math.max(btm, x.bottom); }
    }
    return l === Infinity ? null : { left: l, top: t, right: r, bottom: btm, width: r - l, height: btm - t };
  };
  // The engine's own rules go in a constructed style sheet, not a <style> element: a page whose Content-Security-Policy
  // forbids inline styles would otherwise block them and report a violation that isn't the page's. The page's own inline
  // styles still meet its policy.
  const engineStyle = (css) => {
    const sheet = new CSSStyleSheet();
    sheet.replaceSync(css);
    document.adoptedStyleSheets = [...document.adoptedStyleSheets, sheet];
    return { remove: () => { document.adoptedStyleSheets = document.adoptedStyleSheets.filter((x) => x !== sheet); } };
  };
  const meets = (a, b) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
  fr.duoArt = (art) => [...document.querySelectorAll(art)].filter((el) => visible(el) && !el.parentElement?.closest(art));

  /**
   * Duo art painting above content: hit tests at the centre and four inset corners of every visible control and text
   * block in the viewport, with the art made hit-testable. A hit on art is a finding; on a control, so is art that
   * takes pointer events. Text blocks lying over art are returned for the pixel contrast check.
   */
  fr.duoHits = ({ art = '[data-duo]', max = 400 } = {}) => {
    fr.unpaintedReset();
    const arts = fr.duoArt(art);
    if (!arts.length) return { arts: 0, items: [], over: [] };
    const st = engineStyle(`:is(${art}), :is(${art}) * { pointer-events: auto !important; }`);
    const controls = new Set(interactive().filter((el) => !el.closest(art)));
    const targets = [...controls, ...textBlocks(art)].slice(0, max);
    const hits = [];
    for (const el of targets) {
      const r = controls.has(el) ? el.getBoundingClientRect() : wordsBox(el);
      if (!r) continue;
      if (r.bottom <= 0 || r.top >= innerHeight || r.right <= 0 || r.left >= innerWidth) continue;
      const i = Math.min(4, r.width / 4, r.height / 4);
      const pts = [[r.left + r.width / 2, r.top + r.height / 2], [r.left + i, r.top + i], [r.right - i, r.top + i], [r.left + i, r.bottom - i], [r.right - i, r.bottom - i]];
      for (const [x, y] of pts) {
        if (x < 0 || y < 0 || x >= innerWidth || y >= innerHeight) continue;
        const h = document.elementFromPoint(x, y);
        const a = h?.closest(art);
        if (a && !el.contains(h)) { hits.push({ el, a, h }); break; }
      }
    }
    st.remove();
    const items = [];
    for (const { el, a, h } of hits) {
      const control = controls.has(el);
      items.push({ ref: ref(el), selector: selector(el), label: `${control ? roleOf(el) : 'text'} "${label(el) || text(el.innerText, 40)}" under duo art`, pass: false, measured: `hit ${selector(a)}`, threshold: 'duo art paints below content', rect: pageRect(el.getBoundingClientRect()), fix: `Put the duo art (${selector(a)}) below the content in paint order (z-index), or move it out of the way.` });
      if (control && getComputedStyle(h).pointerEvents !== 'none') items.push({ ref: ref(el), selector: selector(el), label: `${roleOf(el)} "${label(el)}" covered by duo art that takes the pointer`, pass: false, measured: `pointer-events: ${getComputedStyle(h).pointerEvents} on ${selector(h)}`, threshold: 'pointer-events: none', rect: pageRect(el.getBoundingClientRect()), fix: `Give the duo art pointer-events: none, so a press reaches ${label(el)}.` });
    }
    const hitSet = new Set(hits.map((x) => x.el));
    const artRects = arts.map(rectOf);
    const over = textBlocks(art).filter((b) => !hitSet.has(b)).filter((b) => { const w = wordsBox(b); const r = w && { x: w.left, y: w.top, w: w.width, h: w.height }; return r && r.y < innerHeight && r.y + r.h > 0 && artRects.some((a) => meets(r, a)); }).slice(0, 20).map((b) => {
      const cs = getComputedStyle(b);
      const size = parseFloat(cs.fontSize);
      const large = size >= 24 || (size >= 18.66 && (parseInt(cs.fontWeight, 10) || 400) >= 700);
      const r = wordsBox(b);
      return { ref: ref(b), selector: selector(b), label: text(b.innerText, 40), color: rgba(cs.color), large, box: { x: Math.max(0, r.left), y: Math.max(0, r.top), w: Math.min(innerWidth, r.right) - Math.max(0, r.left), h: Math.min(innerHeight, r.bottom) - Math.max(0, r.top) } };
    }).filter((o) => o.box.w > 2 && o.box.h > 2);
    return { arts: arts.length, items, over };
  };

  let hideStyle = null;
  /** Hides a text block's glyphs (to sample the pixels behind them), or shows them again. */
  fr.hideText = (r, hide) => {
    const el = fr.refs.get(r);
    if (!el) return;
    if (hide) {
      hideStyle ??= engineStyle('[data-fr-hide], [data-fr-hide] * { color: transparent !important; -webkit-text-fill-color: transparent !important; text-shadow: none !important; text-decoration-color: transparent !important; caret-color: transparent !important; }');
      el.setAttribute('data-fr-hide', '');
    } else {
      el.removeAttribute('data-fr-hide');
      hideStyle?.remove();
      hideStyle = null;
    }
  };

  /** Where the duo art is and whether it moves: for the working path, before and after an act. */
  // rect is page-relative, so a scroll into view (Playwright's, before it acts) doesn't read as the art moving; view is
  // where it is on screen now, for the working path.
  fr.duoState = (art = '[data-duo]') => [...document.querySelectorAll(art)].map((el) => ({ doc: fr.doc, ref: ref(el), visible: visible(el), rect: { ...rectOf(el), x: rectOf(el).x + scrollX, y: rectOf(el).y + scrollY }, view: rectOf(el), running: el.getAnimations({ subtree: true }).some((a) => a.playState === 'running') || [...el.querySelectorAll('video')].some((v) => !v.paused) }));

  /** The working path: the focused element's box joined with its form, editor or dialog. */
  fr.workingPath = () => {
    let el = document.activeElement;
    if (!el || el === document.body) return null;
    const region = el.closest('form, [contenteditable="true"], [role="textbox"], [role="dialog"], [role="alertdialog"], dialog');
    const a = el.getBoundingClientRect();
    const b = region ? region.getBoundingClientRect() : a;
    const x = Math.min(a.left, b.left), y = Math.min(a.top, b.top);
    return { x, y, w: Math.max(a.right, b.right) - x, h: Math.max(a.bottom, b.bottom) - y, label: `${roleOf(el)} "${label(el)}"` };
  };
  fr.meets = meets;

  /** Under reduced motion, duo art that still moves: running animations, playing or autoplay video, animated images. */
  fr.duoMotion = ({ art = '[data-duo]' } = {}) => {
    const items = [];
    for (const a of fr.duoArt(art)) {
      const running = a.getAnimations({ subtree: true }).filter((x) => x.playState === 'running' && (x.effect?.getComputedTiming().duration ?? 0) > 0);
      if (running.length) items.push({ ref: ref(a), selector: selector(a), label: `duo art animates (${running.length})`, pass: false, measured: running.map((x) => x.animationName ?? x.constructor.name).slice(0, 3).join(', '), threshold: 'no motion under reduced motion', rect: pageRect(a.getBoundingClientRect()), fix: 'Stop the duo art\'s animations under prefers-reduced-motion (a still pose).' });
      for (const v of a.querySelectorAll('video')) if (!v.paused || v.autoplay) items.push({ ref: ref(v), selector: selector(v), label: 'duo video plays', pass: false, measured: v.paused ? 'autoplay' : 'playing', threshold: 'no motion under reduced motion', rect: pageRect(v.getBoundingClientRect()), fix: 'Show the still poster under prefers-reduced-motion; don\'t autoplay.' });
      for (const img of [...(a.matches('img') ? [a] : []), ...a.querySelectorAll('img')]) if (/\.(gif|apng)(\?|#|$)/i.test(img.currentSrc || img.src)) items.push({ ref: ref(img), selector: selector(img), label: 'duo image is animated', pass: false, measured: (img.currentSrc || img.src).split('/').pop(), threshold: 'no motion under reduced motion', rect: pageRect(img.getBoundingClientRect()), fix: 'Use the still variant under prefers-reduced-motion.' });
    }
    return { items, measured: { arts: fr.duoArt(art).length } };
  };

  /** The duo's assets this page fetched, by URL, and the bytes they took. */
  fr.duoAssets = ({ art = '[data-duo]', quiet = '[data-duo-quiet]', assets } = {}) => {
    const urls = new Set();
    const abs = (u) => { try { return new URL(u, location.href).href; } catch { return null; } };
    for (const root of document.querySelectorAll(`${art}, ${quiet}`)) {
      for (const el of [root, ...root.querySelectorAll('*')]) {
        for (const u of [el.currentSrc, el.getAttribute?.('src'), el.getAttribute?.('poster'), el.getAttribute?.('href'), el.getAttribute?.('xlink:href')]) if (u && !u.startsWith('#') && !u.startsWith('data:')) urls.add(abs(u));
        for (const u of (el.getAttribute?.('srcset') ?? '').split(',').map((x) => x.trim().split(/\s+/)[0]).filter(Boolean)) urls.add(abs(u));
        const bg = getComputedStyle(el).backgroundImage;
        for (const m of bg.matchAll(/url\(["']?([^"')]+)["']?\)/g)) if (!m[1].startsWith('data:')) urls.add(abs(m[1]));
      }
    }
    const re = assets ? new RegExp(assets) : null;
    let bytes = 0;
    const seen = [];
    for (const e of performance.getEntriesByType('resource')) {
      if (!urls.has(e.name) && !(re && re.test(e.name))) continue;
      const b = e.transferSize || e.encodedBodySize || e.decodedBodySize || 0;
      bytes += b;
      seen.push({ url: e.name, bytes: b });
    }
    urls.delete(null);
    return { bytes, assets: seen, urls: [...urls] };
  };

  /** Celebrations on screen now. */
  fr.celebrations = (sel = '[data-celebrate]') => [...document.querySelectorAll(sel)].filter(visible).map((el) => ({ ref: ref(el), selector: selector(el) }));

  /** After quiet mode: every duo element still shown. */
  fr.duoShown = ({ art = '[data-duo]', quiet = '[data-duo-quiet]' } = {}) => [...document.querySelectorAll(`${art}, ${quiet}`)].filter(visible).map((el) => ({ ref: ref(el), selector: selector(el), label: text(el.getAttribute('aria-label') || el.getAttribute('alt') || el.innerText || el.localName, 40), rect: pageRect(el.getBoundingClientRect()) }));

  /** What a focused element looks like, to compare with how it looked unfocused. */
  const look = (el) => {
    // An outline that isn't drawn (style none) can change its width, colour or offset unseen.
    const pick = (st) => [...(st.outlineStyle === 'none' ? ['none'] : [st.outlineStyle, st.outlineWidth, st.outlineColor, st.outlineOffset]), st.boxShadow, st.borderTopColor, st.borderBottomColor, st.borderTopWidth, st.borderBottomWidth, st.backgroundColor, st.color, st.textDecorationLine, st.opacity, st.transform].join('|');
    const parts = [pick(getComputedStyle(el)), pick(getComputedStyle(el, '::before')), pick(getComputedStyle(el, '::after'))];
    if (el.parentElement) parts.push(pick(getComputedStyle(el.parentElement)));
    for (const c of [...el.children].slice(0, 3)) parts.push(pick(getComputedStyle(c)));
    return parts.join('/');
  };
  fr.looks = (els) => els.map(look);
  // Focus guards: hidden, focusable sentinels a dialog's focus trap puts at its edges to send focus back inside.
  const guard = (el) => el.matches('[data-base-ui-focus-guard], [data-floating-ui-focus-guard], [data-focus-guard], [data-radix-focus-guard]') || (el.getAttribute('aria-hidden') === 'true' && el.tabIndex >= 0);
  // A suggestion list or menu this field has open: by aria-expanded, or (for a field that suggests) any visible listbox,
  // menu or grid popup that isn't the field's own container.
  const popupOpen = (el) => el.getAttribute('aria-expanded') === 'true' || (el.matches('[role="combobox"], [aria-autocomplete], [aria-haspopup]:not([aria-haspopup="false"])') && [...document.querySelectorAll('[role="listbox"], [role="menu"], [role="grid"], [role="tree"]')].some((p) => !p.contains(el) && visible(p)));
  fr.focusInfo = () => {
    let el = document.activeElement;
    while (el?.shadowRoot?.activeElement) el = el.shadowRoot.activeElement;
    if (!el || el === document.body || el === document.documentElement) return null;
    if (guard(el)) return { guard: true, ref: ref(el), selector: selector(el), label: 'focus guard' };
    const st = getComputedStyle(el);
    const ring = (st.outlineStyle !== 'none' && parseFloat(st.outlineWidth) > 0 && rgba(st.outlineColor)[3] > 0) || (st.boxShadow !== 'none' && /\d/.test(st.boxShadow));
    const modal = modalRoot();
    return { ref: ref(el), selector: selector(el), label: `${roleOf(el)} "${label(el)}"`, look: look(el), ring, rect: pageRect(el.getBoundingClientRect()), outsideModal: !!modal && !modal.contains(el), popup: popupOpen(el), autocomplete: el.matches('[role="combobox"], [aria-autocomplete="list"], [aria-autocomplete="both"], [aria-autocomplete="inline"], [list]'), value: 'value' in el ? String(el.value) : el.isContentEditable ? el.textContent : null };
  };

  /** Whether an element is still on the page and shown (the traversal itself can remove or hide one). */
  fr.present = (r) => { const el = fr.refs.get(r); return !!el && el.isConnected && visible(el) && !hiddenFromAll(el); };

  // Composite widgets move focus with the arrow keys, not Tab: a listbox, grid, tree, toolbar, menu or tab list, a
  // container that tracks its item with aria-activedescendant, or a set of items, at any depth inside one container,
  // that rove one tabindex="0" among tabindex="-1" (a message list, whose thread keeps its first post and its replies in
  // different containers). An element inside such an item is reached by Tab once the arrow keys make the item current;
  // the traversal presses them and follows where focus really goes.
  const COMPOSITE = '[role="listbox"], [role="grid"], [role="treegrid"], [role="tree"], [role="toolbar"], [role="menu"], [role="menubar"], [role="tablist"], [role="radiogroup"], [aria-activedescendant]';
  const kindOf = (n) => `${n.localName}|${n.getAttribute('role') ?? ''}`;
  const peersOf = (item) => {
    const same = (box) => [...box.querySelectorAll('[tabindex], [id]')].filter((p) => kindOf(p) === kindOf(item) && (p === item || (!p.contains(item) && !item.contains(p))));
    // The widget is the nearest composite role, or else the outermost container whose same-kind items still rove one
    // stop: a nested container (a thread's replies, a tree's group) holds only part of the items the arrows move through.
    let best = null;
    for (let box = item.parentElement; box && box !== document.body; box = box.parentElement) {
      const peers = same(box);
      if (peers.length < 2) continue;
      if (box.matches(COMPOSITE)) return { box, peers };
      const stops = peers.filter((p) => p.hasAttribute('tabindex') && p.tabIndex >= 0);
      if (peers.every((p) => p.hasAttribute('tabindex')) && stops.length === 1) best = { box, peers };
      else if (best) break;
    }
    return best;
  };
  /** For an element Tab didn't reach: the roving item that holds it, the stop Tab enters its composite by, and the items. */
  fr.rovingPath = (r) => {
    const el = fr.refs.get(r);
    if (!el) return null;
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      if (!n.hasAttribute('tabindex') && !n.id) continue;
      const pp = peersOf(n);
      if (!pp || pp.peers.length < 2 || !pp.peers.includes(n)) continue;
      const active = pp.box.getAttribute('aria-activedescendant');
      if (active !== null && n.id) return { item: ref(n), entry: ref(pp.box), viaActive: true, items: pp.peers.length };
      const stops = pp.peers.filter((p) => p.hasAttribute('tabindex') && p.tabIndex >= 0);
      const roving = pp.peers.every((p) => p.hasAttribute('tabindex')) && stops.length === 1 && pp.peers.some((p) => p.tabIndex < 0);
      if (roving || pp.box.matches(COMPOSITE)) {
        const entry = stops[0] ?? (pp.box.tabIndex >= 0 ? pp.box : null);
        if (entry) return { item: ref(n), entry: ref(entry), viaActive: false, items: pp.peers.length };
      }
    }
    return null;
  };
  /** Where focus is relative to a roving item: on it, inside it, or elsewhere (or, for aria-activedescendant, its id). */
  fr.rovingAt = (itemRef, entryRef, viaActive) => {
    const item = fr.refs.get(itemRef);
    const entry = fr.refs.get(entryRef);
    const a = document.activeElement;
    if (viaActive) return entry?.getAttribute('aria-activedescendant') === item?.id && entry.contains(a) ? 'on' : 'off';
    return a === item ? 'on' : item?.contains(a) ? 'in' : 'off';
  };
  /** The item a composite holds current now: its roving stop, or the item its aria-activedescendant names. */
  fr.rovingCurrent = (itemRef, viaActive) => {
    const item = fr.refs.get(itemRef);
    const pp = item && peersOf(item);
    if (!pp) return null;
    const cur = viaActive ? document.getElementById(pp.box.getAttribute('aria-activedescendant') ?? '') : pp.peers.find((p) => p.hasAttribute('tabindex') && p.tabIndex >= 0);
    return cur && pp.peers.includes(cur) ? ref(cur) : null;
  };
  /** Enters an item's composite at its stop as it is now (driving earlier items moves a roving stop); true when focus is in. */
  fr.rovingEnter = (itemRef, viaActive) => {
    const item = fr.refs.get(itemRef);
    const pp = item && peersOf(item);
    if (!pp) return false;
    const stop = viaActive ? pp.box : pp.peers.find((p) => p.hasAttribute('tabindex') && p.tabIndex >= 0) ?? (pp.box.tabIndex >= 0 ? pp.box : null);
    stop?.focus({ preventScroll: true });
    return !!stop && pp.box.contains(document.activeElement);
  };

  /** Draws a red box over an element (or an area inside it) for an evidence crop; returns the box in viewport px. */
  fr.mark = (r, offset) => {
    fr.unmark();
    const el = fr.refs.get(r);
    let box;
    if (el?.isConnected) {
      el.scrollIntoView({ block: 'center', inline: 'nearest', behavior: 'instant' });
      const b = el.getBoundingClientRect();
      if (offset) {
        el.scrollIntoView({ block: 'start', behavior: 'instant' });
        const c = el.getBoundingClientRect();
        const y = c.top + offset.y;
        if (y + offset.h / 2 > innerHeight || y < 0) scrollBy({ top: y - Math.max(0, (innerHeight - offset.h) / 2), behavior: 'instant' });
        const d = el.getBoundingClientRect();
        box = { x: d.left + offset.x, y: d.top + offset.y, w: offset.w, h: offset.h };
      } else box = { x: b.left, y: b.top, w: b.width, h: b.height };
    } else return null;
    const o = document.createElement('div');
    o.id = '__fr-mark';
    o.style.cssText = `position:fixed;left:${box.x - 3}px;top:${box.y - 3}px;width:${box.w + 6}px;height:${box.h + 6}px;border:3px solid #e00000;box-sizing:border-box;z-index:2147483647;pointer-events:none;box-shadow:0 0 0 1px #fff`;
    document.documentElement.appendChild(o);
    return box;
  };
  fr.unmark = () => document.getElementById('__fr-mark')?.remove();
})();
