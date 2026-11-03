// Constrained mode for browser pages, through the DevTools protocol: Chromium's own CPU throttling and network
// emulation, as DevTools' throttling menus apply them. For Playwright pages (constrainPage, constrainContext) and for
// any Chromium-based browser or WebView2 reached on its remote-debugging port (constrainCdp).
import { constrainedFromEnv, networkOn, assertSandboxedHost } from './constrain-profile.mjs';
import { factorOf } from './constrain-calibrate.mjs';

// The calibration loop as page script: the same work as constrain-calibrate.mjs, run in the page's main thread. One
// function is kept on the page, so every timing, unthrottled or throttled, runs the same, already optimised, code.
const SPIN = 'const spin = (globalThis.__flowReviewSpin ??= (n) => { let x = 1; for (let i = 0; i < n; i++) x = (Math.imul(x, 1103515245) + 12345 + i) | 0; return x; }); const time = (n) => { const t = performance.now(); spin(n); return performance.now() - t; }; const median = (a) => a.sort((p, q) => p - q)[Math.floor(a.length / 2)];';
// Warmed up first, as warmUp() in constrain-calibrate.mjs, so the loop is sized on the optimised code every timing runs.
const SIZE = (targetMs) => `(() => { ${SPIN} for (let i = 0; i < 200; i++) spin(1 << 14); let n = 1 << 16; while (time(n) < ${targetMs} / 8 && n < 2 ** 34) n *= 2; return Math.max(1, Math.round(n * ${targetMs} / median([time(n), time(n), time(n)]))); })()`;
const TIME = (n) => `(() => { ${SPIN} return time(${n}); })()`;
// Unthrottled and throttled timings in turn, each throttled one against the unthrottled one just before it. Chromium
// throttles a page in short slices timed by a thread the operating system wakes every 200 µs, and it counts at most
// 1 ms of running before each pause: when the system wakes that thread late (as macOS's timers can, on a busy or
// virtual machine), the page runs longer than its share and the slowdown dips for as long as the delay lasts, and the
// page's own speed drifts as it moves between cores. The median of five adjacent pairs is the slowdown the page had
// for most of the calibration, not that of one moment.
const PAIRS = 5;
const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

// Whether these settings throttle a page's CPU: not when its processes are already in a constrained tree.
const pageCpuOn = (settings, cpu) => cpu ?? (settings.cpu > 1 && !settings.tree?.cpu);
// DevTools CPU throttling holds a core busy for every throttled page, so it runs only where constrain may.
const refuseOffSandbox = (settings, options) => { if (pageCpuOn(settings, options.cpu)) assertSandboxedHost(process.env, { what: 'page-cpu' }); };

async function evaluate(send, expression) {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) throw new Error(`calibration failed in the page: ${r.exceptionDetails.text}`);
  return r.result.value;
}

/**
 * Applies the settings to one page target through `send(method, params)`. CPU throttling is skipped when the page's
 * processes are already in a constrained tree (`settings.tree.cpu`), so nothing is slowed twice; pass `cpu: true` to
 * force it, or `cpu: false` to slow only the network. Throttling the CPU throws, before anything is sent, on a host that
 * isn't a CI runner or a declared sandbox (FLOW_REVIEW_CONSTRAIN_SANDBOX=1). With `calibrate`, times the loop in the page unthrottled and throttled in turn, five times, and reports the
 * median factor of the pairs (`factors` has each).
 */
export async function applyCdpConstraints(send, settings, { cpu, network, calibrate = false, calibrateMs = 100 } = {}) {
  refuseOffSandbox(settings, { cpu });
  const cpuOn = pageCpuOn(settings, cpu);
  const netOn = network ?? networkOn(settings);
  const out = { cpu: { rate: null, skipped: null, achieved: null }, network: null };
  if (!cpuOn) out.cpu.skipped = settings.cpu > 1 ? 'the page runs in a constrained process tree' : 'cpu is 1';
  if (cpuOn && calibrate) {
    let n = null;
    const baseMs = [];
    const constrainedMs = [];
    let throttled = false;
    // However the calibration ends, the page is left throttled at the rate asked for.
    try {
      n = await evaluate(send, SIZE(calibrateMs));
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
  refuseOffSandbox(settings, options);
  const session = await page.context().newCDPSession(page);
  return applyCdpConstraints((method, params) => session.send(method, params), settings, options);
}

/**
 * Constrains every page a Playwright context has and opens from now on. Returns null when constrained mode is off. A
 * page opened later that couldn't be constrained (it closed first, say) is listed in `failed` with the error.
 */
export async function constrainContext(context, settings = constrainedFromEnv(), options = {}) {
  if (!settings) return null;
  refuseOffSandbox(settings, options);
  const applied = [];
  const failed = [];
  const one = async (page) => { applied.push(await constrainPage(page, settings, options)); };
  context.on('page', (page) => { one(page).catch((e) => { failed.push({ url: page.url(), error: e.message }); }); });
  await Promise.all(context.pages().map(one));
  return { applied, failed };
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
 * constrained mode is off. When a page open now can't be constrained, it lifts the throttling it applied, disconnects
 * and throws; a page opened later that can't be is listed in `failed`.
 */
export async function constrainCdp(endpoint, settings = constrainedFromEnv(), options = {}) {
  if (!settings) return null;
  refuseOffSandbox(settings, options);
  let wsUrl = endpoint;
  if (/^https?:/.test(endpoint)) {
    const res = await fetch(new URL('/json/version', endpoint));
    wsUrl = (await res.json()).webSocketDebuggerUrl;
  }
  const client = await cdpClient(wsUrl);
  // Each page once, whether it was found by the listing or announced as created; the listing's are awaited.
  const attaching = new Map();
  const applied = [];
  const failed = [];
  const sessions = [];
  const attach = (info) => {
    if (info.type !== 'page') return null;
    if (!attaching.has(info.targetId)) {
      attaching.set(info.targetId, (async () => {
        const { sessionId } = await client.send('Target.attachToTarget', { targetId: info.targetId, flatten: true });
        // Every page attached to is let go on close, even one whose constraining failed part way.
        sessions.push(sessionId);
        const result = await applyCdpConstraints((m, p) => client.send(m, p, sessionId), settings, options);
        applied.push({ targetId: info.targetId, url: info.url, ...result });
      })());
    }
    return attaching.get(info.targetId);
  };
  client.on('Target.targetCreated', (p) => { attach(p.targetInfo)?.catch((e) => { failed.push({ targetId: p.targetInfo.targetId, url: p.targetInfo.url, error: e.message }); }); });
  // Chromium throttles a page's CPU by holding its main thread in a busy wait for the slowed share of the time, so a
  // throttled page keeps a core busy even when idle: closing lifts the throttling on every page before disconnecting.
  const close = async () => {
    const lift = sessions.map((sessionId) => Promise.all([
      client.send('Emulation.setCPUThrottlingRate', { rate: 1 }, sessionId).catch(() => {}),
      client.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, sessionId).catch(() => {}),
    ]));
    await Promise.race([Promise.all(lift), new Promise((r) => setTimeout(r, 2000).unref())]);
    client.close();
  };
  // A page that can't be constrained now fails the call, after the pages already throttled are let go.
  try {
    await client.send('Target.setDiscoverTargets', { discover: true });
    const { targetInfos } = await client.send('Target.getTargets');
    await Promise.all(targetInfos.map(attach));
  } catch (e) {
    await Promise.allSettled(attaching.values());
    await close();
    throw e;
  }
  return { applied, failed, close };
}
