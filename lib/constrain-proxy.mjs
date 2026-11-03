// A small local proxy that makes the network slow for any process that honours HTTP_PROXY / HTTPS_PROXY: every byte
// waits half the round-trip latency in each direction, and each direction shares one link of the given throughput, as
// a real slow connection does. HTTPS goes through CONNECT tunnels, so it is slowed without being decrypted.
import http from 'node:http';
import net from 'node:net';

const HIGH_WATER = 1 << 20;
const LOW_WATER = 1 << 18;

/**
 * One direction of the link. `send(bytes, fn)` runs `fn` when `bytes` sent now would have arrived: half the round trip
 * later, and after everything sent before it has crossed at the link's throughput. Arrivals are in order, so one timer
 * serves the whole queue.
 */
function link(kbps, oneWayMs, count) {
  let free = 0;
  const queue = [];
  let timer = null;
  const next = () => {
    timer = null;
    const now = performance.now();
    while (queue.length && queue[0].at <= now + 0.5) {
      const { bytes, fn } = queue.shift();
      count(bytes);
      fn();
    }
    if (queue.length) timer = setTimeout(next, Math.max(0, queue[0].at - performance.now()));
  };
  return (bytes, fn) => {
    const start = Math.max(performance.now() + oneWayMs, free);
    free = start + (kbps > 0 ? (bytes * 8) / kbps : 0);
    queue.push({ at: free, bytes, fn });
    if (!timer) timer = setTimeout(next, Math.max(0, queue[0].at - performance.now()));
  };
}

/** Copies `from` to `to` across a link, holding back the source while too much is in flight. */
function pipe(from, to, send) {
  let pending = 0;
  from.on('data', (chunk) => {
    pending += chunk.length;
    if (pending > HIGH_WATER) from.pause();
    send(chunk.length, () => {
      pending -= chunk.length;
      if (!to.destroyed) to.write(chunk);
      if (pending < LOW_WATER && from.isPaused()) from.resume();
    });
  });
  from.on('end', () => send(0, () => to.end()));
  from.on('error', () => to.destroy());
  to.on('error', () => from.destroy());
}

/**
 * Starts the proxy on 127.0.0.1 (an ephemeral port unless `port` is given). Returns `{ url, port, stats(), close() }`;
 * `stats()` counts requests, tunnels and bytes each way.
 */
export async function startDelayProxy({ latencyMs = 0, downKbps = 0, upKbps = 0, port = 0, host = '127.0.0.1' } = {}) {
  const stats = { requests: 0, tunnels: 0, failed: 0, bytesUp: 0, bytesDown: 0 };
  const up = link(upKbps, latencyMs / 2, (n) => { stats.bytesUp += n; });
  const down = link(downKbps, latencyMs / 2, (n) => { stats.bytesDown += n; });
  const sockets = new Set();

  const server = http.createServer((req, res) => {
    let target;
    try { target = new URL(req.url); } catch { res.writeHead(400).end('flow-review constrain proxy: absolute URL expected\n'); return; }
    if (target.protocol !== 'http:') { res.writeHead(400).end('flow-review constrain proxy: use CONNECT for https\n'); return; }
    stats.requests++;
    const headers = { ...req.headers };
    delete headers['proxy-connection'];
    delete headers['proxy-authorization'];
    const out = http.request({ host: target.hostname, port: target.port || 80, method: req.method, path: `${target.pathname}${target.search}`, headers, setHost: false });
    out.on('response', (r) => {
      down(Buffer.byteLength(r.rawHeaders.join('')) + 32, () => { if (!res.destroyed) res.writeHead(r.statusCode, r.statusMessage, r.rawHeaders); });
      pipe(r, res, down);
    });
    out.on('error', (e) => {
      stats.failed++;
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'text/plain' });
      res.end(`flow-review constrain proxy: ${e.message}\n`);
    });
    // The request line and headers cross the link before the body.
    up(Buffer.byteLength(`${req.method} ${req.url}`) + Buffer.byteLength(req.rawHeaders.join('')) + 32, () => out.flushHeaders());
    pipe(req, out, up);
  });

  server.on('connect', (req, client, head) => {
    const [h, p] = splitHostPort(req.url);
    stats.tunnels++;
    const remote = net.connect({ host: h, port: p });
    sockets.add(remote);
    remote.on('close', () => sockets.delete(remote));
    client.on('error', () => remote.destroy());
    remote.once('error', () => {
      stats.failed++;
      if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\n\r\n');
    });
    remote.once('connect', () => {
      // A new connection costs a round trip before anything is sent.
      setTimeout(() => {
        if (client.destroyed) { remote.destroy(); return; }
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head?.length) up(head.length, () => remote.write(head));
        pipe(client, remote, up);
        pipe(remote, client, down);
      }, latencyMs);
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });

  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
  const actual = server.address().port;
  return {
    url: `http://${host}:${actual}`,
    port: actual,
    stats: () => ({ ...stats }),
    close: () => new Promise((resolve) => { for (const s of sockets) s.destroy(); server.close(() => resolve()); }),
  };
}

function splitHostPort(s) {
  const m = /^\[([^\]]+)\]:(\d+)$/.exec(s) ?? /^([^:]+):(\d+)$/.exec(s);
  return m ? [m[1], Number(m[2])] : [s, 443];
}
