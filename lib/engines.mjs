// Browser engines. A web flow runs on each engine a run names, as one more matrix dimension: the people a product ships
// to see it through their own engine (WKWebView on a Mac is WebKit; WebView2 on Windows is Microsoft Edge's Chromium),
// and a page smooth on one can stall on another. Every check runs on every engine; where an engine lacks what a check
// measures with, the check measures another way or says so (GAPS), never passes quietly.

/** The engines flow-review runs: Playwright's Chromium, Playwright's WebKit, and installed Microsoft Edge. */
export const ENGINES = Object.freeze(['chromium', 'webkit', 'msedge']);
export const DEFAULT_ENGINE = 'chromium';

/** Which Playwright browser type drives an engine. */
export const browserTypeOf = (engine) => (engine === 'webkit' ? 'webkit' : 'chromium');

/** Whether an engine speaks the Chrome DevTools Protocol (CDP sessions, connectOverCDP, DevTools throttling). */
export const speaksCdp = (engine) => browserTypeOf(engine) === 'chromium';

/** Parses an engine list (`chromium,webkit`, or an array); throws on an unknown engine. Order kept, duplicates dropped. */
export function parseEngines(value) {
  const list = (Array.isArray(value) ? value : String(value ?? '').split(',')).map((e) => String(e).trim()).filter(Boolean);
  if (!list.length) return [DEFAULT_ENGINE];
  const unknown = list.filter((e) => !ENGINES.includes(e));
  if (unknown.length) throw new Error(`unknown engine ${unknown.join(', ')}; engines are ${ENGINES.join(', ')}`);
  return [...new Set(list)];
}

/**
 * Launch options for an engine on top of `base`. Chromium takes FLOW_REVIEW_CHROMIUM (an executable) and
 * FLOW_REVIEW_CHANNEL (chrome, say); msedge is the installed Microsoft Edge (Playwright's msedge channel); WebKit takes
 * FLOW_REVIEW_WEBKIT (an executable).
 */
export function launchOptionsFor(engine, base = {}, env = process.env) {
  if (engine === 'msedge') return { ...base, channel: 'msedge' };
  if (engine === 'webkit') return { ...base, ...(env.FLOW_REVIEW_WEBKIT ? { executablePath: env.FLOW_REVIEW_WEBKIT } : {}) };
  return { ...base, executablePath: env.FLOW_REVIEW_CHROMIUM || undefined, channel: env.FLOW_REVIEW_CHANNEL || undefined };
}

/**
 * The key that moves focus to the next item. WebKit, as Safari and WKWebView ship, moves Tab only between text fields
 * and lists unless the Mac's Keyboard navigation setting is on; Option-Tab reaches every item, as Tab does in Chromium.
 * flow-review presses Option-Tab on WebKit, so keyboard measures the same reachability on every engine.
 */
export const tabKeyOf = (engine) => (engine === 'webkit' ? 'Alt+Tab' : 'Tab');

/** A flow step's key, as the engine needs it pressed: Tab and Shift+Tab become their Option forms on WebKit. */
export function keyFor(engine, key) {
  if (engine !== 'webkit' || typeof key !== 'string') return key;
  const parts = key.split('+');
  if (parts.at(-1) !== 'Tab' || parts.includes('Alt')) return key;
  return ['Alt', ...parts].join('+');
}

/** The engine a Playwright page runs on: webkit, or chromium for Chromium and Edge (both speak CDP). */
export function engineOfPage(page) {
  try {
    return page.context().browser()?.browserType().name() === 'webkit' ? 'webkit' : 'chromium';
  } catch {
    return 'chromium';
  }
}

/**
 * What an engine can't measure the way Chromium does, and what flow-review does instead. Each is reported in
 * report.json's engines.<engine>.gaps and in the summary, and documented in the README's engine table.
 */
export const GAPS = Object.freeze({
  chromium: [],
  msedge: [],
  webkit: Object.freeze([
    Object.freeze({ check: 'cls', what: 'no Layout Instability API (layout-shift entries)', instead: 'positions of the content in view are read each frame after a change and scored as the API scores a shift (impact x distance, moves under 3 px and within 500 ms of input ignored); findings say method "sampled"' }),
    Object.freeze({ check: 'jank', what: 'no Long Tasks API (longtask entries)', instead: 'a 16 ms timer measures how late the main thread let it run; a lateness of longTaskMs or more is a long task (method "timer")' }),
    Object.freeze({ check: 'jank', what: 'no Long Animation Frames API', instead: 'a slow frame cannot be told apart as raster-bound, so every frame over frameMs counts (stricter than Chromium, never looser)' }),
    Object.freeze({ check: 'constrained', what: 'no DevTools protocol, so no page CPU or network throttling', instead: 'a constrained run on WebKit needs flow-review constrain around it (the whole process tree is slowed); without it the run is refused' }),
    Object.freeze({ check: 'cdp', what: 'no DevTools protocol, so a cdp flow (attached over a debugging port) cannot run on WebKit', instead: 'cdp flows run on chromium and msedge only; a run naming webkit lists them as not run, in engines.webkit.notRun' }),
    Object.freeze({ check: 'duoBytes', what: 'no resource-timing sizes for some responses (one a route answered, say)', instead: 'an asset fetched with no size is read again from the cache and its body counted (method says so), never counted as 0 bytes' }),
    Object.freeze({ check: 'errors', what: 'Playwright puts a style sheet in the page for each WebKit screenshot, which a strict style-src refuses with a console error', instead: 'that one error is left out while flow-review\'s own screenshot is being taken; the page\'s own refused styles still fail' }),
    Object.freeze({ check: 'keyboard', what: 'Tab reaches only text fields and lists unless the Mac has Keyboard navigation on', instead: 'traversals and flow steps press Option-Tab (Alt+Tab), which reaches every item' }),
  ]),
});
