// Starts a flow's app once per run and stops it at the end. `app.start` runs in a shell from the working directory (or
// app.cwd). The app is up when `app.ready` (default app.url) answers any HTTP status, or, with `ready: "stdout-json"`,
// when it prints a line holding a JSON object, whose fields become ${start.<field>} for the flow (ports it chose itself).
// `app.files` are written first; `app.guard` runs once it is up and must exit 0 (a check that it is the mock).
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { runCommand } from './agent.mjs';

const running = new Map();

// One app per start command, folder and environment: flows that deep-link into the same app share it. With
// `scope: "flow"`, each flow gets its own, started for it and stopped after it.
export const appKey = (app, cwd, unitKey) => JSON.stringify([app?.start ?? '', path.resolve(cwd, app?.cwd ?? '.'), app?.env ?? {}, app?.scope === 'flow' ? unitKey : null]);

async function answers(url) {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000), redirect: 'manual' });
    await res.body?.cancel().catch(() => {});
    return true;
  } catch {
    return false;
  }
}

export async function waitReady(url, timeoutMs, child, log) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    if (child && child.exitCode !== null) throw new Error(`the app exited (${child.exitCode}) before ${url} answered:\n${log().slice(-2000)}`);
    if (await answers(url)) return;
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`${url} did not answer within ${timeoutMs} ms${log ? `:\n${log().slice(-2000)}` : ''}`);
}

/** The first stdout line that is a JSON object, its string and number fields as start variables. */
function announced(child, timeoutMs, log) {
  return new Promise((resolve, reject) => {
    let buf = '';
    const timer = setTimeout(() => reject(new Error(`the app printed no JSON line within ${timeoutMs} ms:\n${log().slice(-2000)}`)), timeoutMs);
    const onData = (d) => {
      buf += d;
      for (let nl = buf.indexOf('\n'); nl >= 0; nl = buf.indexOf('\n')) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        try {
          const v = JSON.parse(line);
          if (v && typeof v === 'object' && !Array.isArray(v)) {
            clearTimeout(timer);
            child.stdout.off('data', onData);
            return resolve(Object.fromEntries(Object.entries(v).filter(([, x]) => typeof x === 'string' || typeof x === 'number').map(([k, x]) => [k, String(x)])));
          }
        } catch {}
      }
    };
    child.stdout.on('data', onData);
    child.once('exit', (code) => { clearTimeout(timer); reject(new Error(`the app exited (${code}) before it said where it listens:\n${log().slice(-2000)}`)); });
  });
}

/** ${start.<key>} placeholders filled from what the app announced. */
export function withStart(value, vars) {
  if (typeof value === 'string') return value.replace(/\$\{start\.(\w+)\}/g, (all, k) => vars[k] ?? all);
  if (Array.isArray(value)) return value.map((x) => withStart(x, vars));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, x]) => [k, withStart(x, vars)]));
  return value;
}

export function writeFiles(files, cwd) {
  for (const [file, content] of Object.entries(files ?? {})) {
    const abs = path.resolve(cwd, file);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content.base64 !== undefined ? Buffer.from(content.base64, 'base64') : content.text ?? '');
  }
}

/** Starts the app when it has a start command (once per distinct app); resolves to its start variables. */
export async function startApp(app, cwd, unitKey) {
  writeFiles(app?.files, cwd);
  if (!app?.start) {
    if (app?.ready && app.ready !== 'stdout-json') await waitReady(app.ready, app.readyTimeoutMs ?? 60_000);
    return {};
  }
  const key = appKey(app, cwd, unitKey);
  if (!running.has(key)) {
    const entry = {};
    running.set(key, entry);
    entry.ready = launch(app, cwd, entry);
  }
  return running.get(key).ready;
}

async function launch(app, cwd, entry) {
  const json = app.ready === 'stdout-json';
  const probe = json ? null : app.ready ?? app.url;
  if (probe && (await answers(probe))) throw new Error(`${probe} already answers before app.start ran: another server holds the port. Stop it or give the flow another port.`);
  let out = '';
  // Variables the app hasn't announced yet mean nothing to the app itself.
  const env = Object.fromEntries(Object.entries(app.env ?? {}).filter(([, v]) => !String(v).includes('${start.')));
  const child = spawn(app.start, { shell: true, cwd: path.resolve(cwd, app.cwd ?? '.'), env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
  const keep = (d) => { out = (out + d).slice(-20000); };
  child.stdout.on('data', keep);
  child.stderr.on('data', keep);
  Object.assign(entry, { child, log: () => out });
  const timeout = app.readyTimeoutMs ?? 60_000;
  let vars = {};
  if (json) vars = await announced(child, timeout, () => out);
  else if (probe) await waitReady(probe, timeout, child, () => out);
  else await new Promise((r) => setTimeout(r, 1000));
  if (app.guard) {
    const g = await runCommand(withStart(app.guard, vars), { cwd: path.resolve(cwd, app.cwd ?? '.'), timeoutMs: 30_000 });
    if (g.code !== 0) throw new Error(`app.guard refused the app (exit ${g.code}): ${(g.stderr || g.stdout).trim().slice(0, 500)}`);
  }
  return vars;
}

async function stop(child) {
  if (!child || child.exitCode !== null) return;
  try {
    if (process.platform !== 'win32') process.kill(-child.pid, 'SIGTERM');
    else child.kill();
  } catch {}
  await new Promise((r) => { const t = setTimeout(r, 3000); child.once('exit', () => { clearTimeout(t); r(); }); });
  if (child.exitCode === null) try { process.kill(-child.pid, 'SIGKILL'); } catch {}
}

/** Stops a flow-scoped app once its flow is done. */
export async function stopFlowApp(app, cwd, unitKey) {
  if (app?.scope !== 'flow') return;
  const key = appKey(app, cwd, unitKey);
  const entry = running.get(key);
  running.delete(key);
  await stop(entry?.child);
}

export async function stopApps() {
  for (const { child } of running.values()) await stop(child);
  running.clear();
}
