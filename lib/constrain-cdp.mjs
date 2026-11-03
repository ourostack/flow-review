// Constrained mode for browser pages, through the DevTools protocol: Chromium's own CPU throttling and network
// emulation, as DevTools' throttling menus apply them. For Playwright pages (constrainPage, constrainContext) and for
// any Chromium-based browser or WebView2 reached on its remote-debugging port (constrainCdp).
import { constrainedFromEnv, networkOn } from './constrain-profile.mjs';
import { factorOf } from './constrain-calibrate.mjs';

// The calibration loop as page script: the same work as constrain-calibrate.mjs, run in the page's main thread. One
// function is kept on the page, so every timing, unthrottled or throttled, runs the same, already optimised, code.
const SPIN = 'const spin = (globalThis.__flowReviewSpin ??= (n) => { let x = 1; for (let i = 0; i < n; i++) x = (Math.imul(x, 1103515245) + 12345 + i) | 0; return x; }); const time = (n) => { const t = performance.now(); spin(n); return performance.now() - t; }; const median = (a) => a.sort((p, q) => p - q)[Math.floor(a.length / 2)];';
const SIZE = (targetMs) => `(() => { ${SPIN} let n = 1 << 16; spin(n); while (time(n) < ${targetMs} / 8 && n < 2 ** 34) n *= 2; return Math.max(1, Math.round(n * ${targetMs} / median([time(n), time(n), time(n)]))); })()`;
const TIME = (n) => `(() => { ${SPIN} return time(${n}); })()`;
// Unthrottled and throttled timings in turn, each throttled one against the unthrottled one just before it. Chromium
// throttles a page in short slices timed by a thread the operating system wakes every 200 µs, and it counts at most
// 1 ms of running before each pause: when the system wakes that thread late (as macOS's timers can, on a busy or
// virtual machine), the page runs longer than its share and the slowdown dips for as long as the delay lasts, and the
// page's own speed drifts as it moves between cores. The median of five adjacent pairs is the slowdown the page had
// for most of the calibration, not that of one moment.
const PAIRS = 5;
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

async function evaluate(send, expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(`calibration failed in the page: ${r.exceptionDetails.text}`);
  return r.result.value;
}

/**
 * Applies the settings to one page target through `send(method, params)`. CPU throttling is skipped when the page's
 * processes are already in a constrained tree (`settings.tree.cpu`), so nothing is slowed twice; pass `cpu: true` to
 * force it. With `calibrate`, times the loop in the page unthrottled and throttled in turn, five times, and reports the
 * median factor of the pairs (`factors` has each).
 */
export async function applyCdpConstraints(send, settings, { cpu, network, calibrate = false, calibrateMs = 100 } = {}) {
  const cpuOn = cpu ?? (settings.cpu > 1 && !settings.tree?.cpu);
  const netOn = network ?? networkOn(settings);
  const out = { cpu: { rate: null, skipped: null, achieved: null }, network: null };
  if (!cpuOn) out.cpu.skipped = settings.cpu > 1 ? 'the page runs in a constrained process tree' : 'cpu is 1';
  if (cpuOn && calibrate) {
    const n = await evaluate(send, SIZE(calibrateMs));
    const baseMs = [];
    const constrainedMs = [];
    let throttled = false;
    try {
      for (let k = 0; k < PAIRS; k++) {
        if (throttled) await send('Emulation.setCPUThrottlingRate', { rate: 1 });
        throttled = false;
        baseMs.push(await evaluate(send, TIME(n)));
        await send('Emulation.setCPUThrottlingRate', { rate: settings.cpu });
        throttled = true;
        constrainedMs.push(await evaluate(send, TIME(n)));
      }
    } finally {
      if (!throttled) await send('Emulation.setCPUThrottlingRate', { rate: settings.cpu });
    }
    const factors = baseMs.map((b, k) => factorOf(constrainedMs[k], b));
    out.cpu.achieved = median(factors);
    out.cpu.factors = factors;
    out.cpu.baselineMs = Math.round(median(baseMs) * 10) / 10;
    out.cpu.constrainedMs = Math.round(median(constrainedMs) * 10) / 10;
    out.cpu.iterations = n;
  } else if (cpuOn) await send('Emulation.setCPUThrottlingRate', { rate: settings.cpu });
  if (cpuOn) out.cpu.rate = settings.cpu;
  if (netOn) {
    const n = settings.network;
    const conditions = { offline: false, latency: n.latencyMs, downloadThroughput: n.downKbps > 0 ? (n.downKbps * 1000) / 8 : -1, uploadThroughput: n.upKbps > 0 ? (n.upKbps * 1000) / 8 : -1 };
    await send('Network.enable', {});
    await send('Network.emulateNetworkConditions', conditions);
    out.network = { latencyMs: n.latencyMs, downKbps: n.downKbps, upKbps: n.upKbps };
  }
  return out;
}

/**
 * Constrains a Playwright Chromium page (also one reached with connectOverCDP). `settings` defaults to the
 * environment's (FLOW_REVIEW_CONSTRAINED); returns null when constrained mode is off. The DevTools session stays
 * attached for the page's life: closing it would lift the throttling.
 */
export async function constrainPage(page, settings = constrainedFromEnv(), options = {}) {
  if (!settings) return null;
  const session = await page.context().newCDPSession(page);
  return applyCdpConstraints((method, params) => session.send(method, params), settings, options);
}

/** Constrains every page a Playwright context has and opens from now on. Returns null when constrained mode is off. */
export async function constrainContext(context, settings = constrainedFromEnv(), options = {}) {
  if (!settings) return null;
  const applied = [];
  const one = async (page) => { applied.push(await constrainPage(page, settings, options)); };
  context.on('page', (page) => { one(page).catch(() => {}); });
  await Promise.all(context.pages().map(one));
  return { applied };
}

// A minimal DevTools protocol client over the WebSocket Node has built in.
async function cdpClient(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error(`can't connect to ${wsUrl}`)); });
  let id = 0;
  const pending = new Map();
  const listeners = new Map();
  ws.onmessage = (e) => {
    const m = JSON.parse(typeof e.data === 'string' ? e.data : Buffer.from(e.data).toString('utf8'));
    if (m.id !== undefined) {
      const p = pending.get(m.id);
      pending.delete(m.id);
      if (m.error) p?.reject(new Error(`${p.method}: ${m.error.message}`));
      else p?.resolve(m.result);
    } else for (const fn of listeners.get(m.method) ?? []) fn(m.params, m.sessionId);
  };
  ws.onclose = () => { for (const p of pending.values()) p.reject(new Error('the DevTools connection closed')); pending.clear(); };
  return {
    send: (method, params = {}, sessionId) => new Promise((resolve, reject) => {
      const n = ++id;
      pending.set(n, { resolve, reject, method });
      ws.send(JSON.stringify({ id: n, method, params, ...(sessionId ? { sessionId } : {}) }));
    }),
    on: (method, fn) => { if (!listeners.has(method)) listeners.set(method, []); listeners.get(method).push(fn); },
    close: () => ws.close(),
  };
}

/**
 * Constrains every page of a Chromium-based browser or WebView2 on its remote-debugging endpoint
 * (`http://127.0.0.1:9222`, or the browser's `ws://` URL), including pages it opens later. Keep the returned handle open
 * for as long as the throttling should last; `close()` lifts it from every page and disconnects. Returns null when
 * constrained mode is off.
 */
export async function constrainCdp(endpoint, settings = constrainedFromEnv(), options = {}) {
  if (!settings) return null;
  let wsUrl = endpoint;
  if (/^https?:/.test(endpoint)) {
    const res = await fetch(new URL('/json/version', endpoint));
    wsUrl = (await res.json()).webSocketDebuggerUrl;
  }
  const client = await cdpClient(wsUrl);
  // Each page once, whether it was found by the listing or announced as created; the listing's are awaited.
  const attaching = new Map();
  const applied = [];
  const sessions = [];
  const attach = (info) => {
    if (info.type !== 'page') return null;
    if (!attaching.has(info.targetId)) {
      attaching.set(info.targetId, (async () => {
        const { sessionId } = await client.send('Target.attachToTarget', { targetId: info.targetId, flatten: true });
        const result = await applyCdpConstraints((m, p) => client.send(m, p, sessionId), settings, options);
        sessions.push({ sessionId, result });
        applied.push({ targetId: info.targetId, url: info.url, ...result });
      })());
    }
    return attaching.get(info.targetId);
  };
  client.on('Target.targetCreated', (p) => { attach(p.targetInfo)?.catch(() => {}); });
  await client.send('Target.setDiscoverTargets', { discover: true });
  const { targetInfos } = await client.send('Target.getTargets');
  await Promise.all(targetInfos.map(attach));
  // Chromium throttles a page's CPU by holding its main thread in a busy wait for the slowed share of the time, so a
  // throttled page keeps a core busy even when idle: closing lifts the throttling on every page before disconnecting.
  const close = async () => {
    const lift = sessions.map(({ sessionId, result }) => Promise.all([
      result.cpu.rate ? client.send('Emulation.setCPUThrottlingRate', { rate: 1 }, sessionId).catch(() => {}) : null,
      result.network ? client.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, sessionId).catch(() => {}) : null,
    ]));
    await Promise.race([Promise.all(lift), new Promise((r) => setTimeout(r, 2000).unref())]);
    client.close();
  };
  return { applied, close };
}
