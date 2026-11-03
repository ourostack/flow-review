// Slow disk for Node processes: loaded with `--import` (flow-review constrain adds it to NODE_OPTIONS), it makes each
// call through the `fs` module wait as a slow disk would. One disk serves every call in the process in turn: a call
// takes `latencyMs`, plus its bytes at `mbPerSec`, after the calls before it. Callbacks and promises are delivered that
// much later; synchronous calls block for it.
//
// What it slows: the public fs, fs/promises and fs.promises functions listed below, and what is built on them (streams
// read and write through fs.read and fs.write). What it can't: Node's own module loading, FileHandle methods, native
// addons, and any process that isn't Node.
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { CONSTRAINED_ENV } from './constrain-profile.mjs';

const require = createRequire(import.meta.url);
const fs = require('node:fs');
const fsp = require('node:fs/promises');

const META = ['access', 'appendFile', 'chmod', 'copyFile', 'fstat', 'fsync', 'ftruncate', 'lstat', 'mkdir', 'mkdtemp', 'open', 'opendir', 'readdir', 'readlink', 'realpath', 'rename', 'rm', 'rmdir', 'stat', 'truncate', 'unlink', 'utimes'];
const DATA = ['read', 'readv', 'write', 'writev', 'readFile', 'writeFile'];

let settings = {};
try { settings = JSON.parse(process.env[CONSTRAINED_ENV] || '{}').disk ?? {}; } catch { settings = {}; }
const latencyMs = Number(settings.latencyMs) || 0;
const mbPerSec = Number(settings.mbPerSec) || 0;
let free = 0;
const counts = { calls: 0, bytes: 0, waitedMs: 0 };

/** The ms from now until a call that moved `bytes` completes on the slow disk. */
function charge(bytes) {
  const now = performance.now();
  const start = Math.max(now, free);
  free = start + latencyMs + (mbPerSec > 0 ? bytes / (mbPerSec * 1000) : 0);
  counts.calls++;
  counts.bytes += bytes;
  counts.waitedMs += free - now;
  return free - now;
}

const blocker = new Int32Array(new SharedArrayBuffer(4));
const block = (ms) => { if (ms > 0) Atomics.wait(blocker, 0, 0, ms); };

const len = (v) => (v == null ? 0 : typeof v === 'string' ? Buffer.byteLength(v) : typeof v === 'number' ? v : v.byteLength ?? v.length ?? v.bytesRead ?? v.bytesWritten ?? 0);
// Bytes a call moved, from its arguments and its result.
const SIZE = {
  read: (a, r) => len(r), readv: (a, r) => len(r), write: (a, r) => len(r), writev: (a, r) => len(r),
  readFile: (a, r) => len(r), writeFile: (a) => len(a[1]), appendFile: (a) => len(a[1]),
};
const sizeOf = (name, args, result) => { try { return SIZE[name]?.(args, result) ?? 0; } catch { return 0; } };

function keepProps(wrapped, original) {
  for (const k of Reflect.ownKeys(original)) {
    if (k === 'length' || k === 'name' || k === 'prototype') continue;
    Object.defineProperty(wrapped, k, Object.getOwnPropertyDescriptor(original, k));
  }
  return wrapped;
}

function wrapCallback(name) {
  const original = fs[name];
  if (typeof original !== 'function') return;
  fs[name] = keepProps(function (...args) {
    const cb = args.at(-1);
    if (typeof cb !== 'function') return original.apply(this, args);
    args[args.length - 1] = function (err, ...res) {
      setTimeout(() => cb.call(this, err, ...res), charge(err ? 0 : sizeOf(name, args, res[0])));
    };
    return original.apply(this, args);
  }, original);
}

function wrapSync(name) {
  const original = fs[`${name}Sync`];
  if (typeof original !== 'function') return;
  fs[`${name}Sync`] = keepProps(function (...args) {
    let result;
    try {
      result = original.apply(this, args);
    } finally {
      block(charge(sizeOf(name, args, result)));
    }
    return result;
  }, original);
}

function wrapPromise(name) {
  const original = fsp[name];
  if (typeof original !== 'function') return;
  fsp[name] = keepProps(async function (...args) {
    let result;
    try {
      result = await original.apply(this, args);
    } catch (e) {
      await new Promise((r) => setTimeout(r, charge(0)));
      throw e;
    }
    await new Promise((r) => setTimeout(r, charge(sizeOf(name, args, result))));
    return result;
  }, original);
}

if (latencyMs > 0 || mbPerSec > 0) {
  for (const name of [...META, ...DATA]) {
    wrapCallback(name);
    wrapSync(name);
    wrapPromise(name);
  }
  const existsSync = fs.existsSync;
  fs.existsSync = keepProps(function (...args) { try { return existsSync.apply(this, args); } finally { block(charge(0)); } }, existsSync);
  syncBuiltinESMExports();
  globalThis[Symbol.for('flow-review.constrain.disk')] = { latencyMs, mbPerSec, counts };
}
