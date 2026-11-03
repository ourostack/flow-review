// Constrained computer: run a command, and everything it starts, as if on a slow old laptop. CPU and memory are
// constrained for the whole process tree by the operating system where it can (a Windows job object, a Linux cgroup)
// and by a stop/continue duty cycle and a memory watch where it can't (macOS); the disk is slowed inside Node processes;
// the network through a local delaying proxy, and in browser pages through the DevTools protocol (constrain-cdp.mjs).
// Each run measures the CPU slowdown it achieved and says which limits were enforced, which only detected, and which
// were hit.
import { spawn, spawnSync, execFile } from 'node:child_process';
import { Worker } from 'node:worker_threads';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CONSTRAINED_ENV, resolveSettings, diskOn, networkOn, bannerLine } from './constrain-profile.mjs';
import { factorOf, within } from './constrain-calibrate.mjs';
import { startDelayProxy } from './constrain-proxy.mjs';

const here = (f) => fileURLToPath(new URL(f, import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export const CONSTRAINED_SCHEMA = 'flow-review-constrained-0';
const MB = 1024 * 1024;

const ENFORCEMENT = {
  'job-cpu-rate': ['enforced', 'tree'], 'cgroup-cpu-max': ['enforced', 'tree'], 'duty-cycle': ['enforced', 'thread'],
  'job-memory': ['enforced'], 'cgroup-memory-max': ['enforced'], 'rss-watch': ['detected'],
};

/** Whether this Linux machine can make a cgroup v2 for the run without asking for a password. */
export function cgroupAvailable() {
  if (process.platform !== 'linux' || !fs.existsSync('/sys/fs/cgroup/cgroup.controllers')) return false;
  return spawnSync('sudo', ['-n', 'true'], { stdio: 'ignore' }).status === 0;
}

/**
 * How this platform constrains CPU and memory: `{ cpu, memory }`, each a mechanism name or null when that part is off.
 * Windows: a job object (`job-cpu-rate`, `job-memory`). Linux: a cgroup (`cgroup-cpu-max`, `cgroup-memory-max`) when CI
 * is true and sudo needs no password, or when `cpuMechanism` is `cgroup`; otherwise, as on macOS, `duty-cycle` and
 * `rss-watch`.
 */
export function pickMechanisms(settings, { cpuMechanism = 'auto', platform = process.platform, env = process.env, cgroup = cgroupAvailable } = {}) {
  const wantCpu = settings.cpu > 1;
  const wantMem = settings.memoryMB > 0;
  if (!['auto', 'job', 'cgroup', 'duty-cycle'].includes(cpuMechanism)) throw new Error(`unknown CPU mechanism ${cpuMechanism}; use auto, job, cgroup or duty-cycle`);
  if (platform === 'win32') {
    if (!['auto', 'job'].includes(cpuMechanism)) throw new Error(`${cpuMechanism} isn't available on Windows; it uses a job object`);
    return { cpu: wantCpu ? 'job-cpu-rate' : null, memory: wantMem ? 'job-memory' : null };
  }
  if (cpuMechanism === 'job') throw new Error('job objects are Windows only');
  let useCgroup = false;
  if (platform === 'linux' && (wantCpu || wantMem)) {
    if (cpuMechanism === 'cgroup') {
      if (!cgroup()) throw new Error('a cgroup needs cgroup v2 and sudo without a password (sudo -n)');
      useCgroup = true;
    } else if (cpuMechanism === 'auto') useCgroup = env.CI === 'true' && cgroup();
  } else if (cpuMechanism === 'cgroup') throw new Error('cgroups are Linux only');
  return {
    cpu: wantCpu ? (useCgroup ? 'cgroup-cpu-max' : 'duty-cycle') : null,
    memory: wantMem ? (useCgroup ? 'cgroup-memory-max' : 'rss-watch') : null,
  };
}

/** The Windows job's CPU rate (cycles per 10,000 across all processors) that leaves the tree one core at 1/factor. */
export const jobCpuRate = (factor, cpus = os.availableParallelism()) => Math.max(1, Math.round(10000 / (factor * cpus)));

/** Quote a command line for cmd.exe, which runs .cmd and .bat files (npm, npx) that Windows can't start directly. */
export function windowsCommandLine(command, args) {
  const q = (a) => (/^[\w\-.,/:=@\\+]+$/.test(a) ? a : `"${a.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`);
  return [command, ...args].map(q).join(' ');
}

/** The environment a constrained command runs with: settings for its harness, the slow-disk preload and the proxy. */
export function constrainedEnv(env, info, proxyUrl) {
  const out = { ...env, [CONSTRAINED_ENV]: JSON.stringify(info) };
  if (diskOn(info)) out.NODE_OPTIONS = `${env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(here('./constrain-fs.mjs')).href}`.trim();
  if (proxyUrl) {
    for (const k of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy']) out[k] = proxyUrl;
    // Traffic to this computer isn't network: the app's own local services stay fast.
    const noProxy = [env.NO_PROXY ?? env.no_proxy, 'localhost,127.0.0.1,::1'].filter(Boolean).join(',');
    out.NO_PROXY = noProxy;
    out.no_proxy = noProxy;
    // Node's fetch and http use the proxy only when asked to; the flag that asks warns it is experimental, and a
    // warning on stderr would fail checks that expect a quiet stderr.
    out.NODE_USE_ENV_PROXY = '1';
    out.NODE_OPTIONS = `${out.NODE_OPTIONS ?? ''} --disable-warning=UNDICI-EHPA`.trim();
  }
  return out;
}

// A mailbox for a child's IPC messages, so each step can wait for the one it needs.
function mailbox(child) {
  const queue = [];
  const waiting = [];
  let closed = null;
  const deliver = (m) => {
    const i = waiting.findIndex((w) => w.type === m.type);
    if (i >= 0) waiting.splice(i, 1)[0].resolve(m);
    else queue.push(m);
  };
  child.on('message', deliver);
  child.on('exit', (code, signal) => {
    closed = { code, signal };
    for (const w of waiting.splice(0)) w.type === 'exit' ? w.resolve({ type: 'exit', code: code ?? 1, signal, lost: true }) : w.reject(new Error(`the constrained tree's gate ended (${signal ?? code}) before ${w.type}`));
  });
  return (type, ms = 0) => new Promise((resolve, reject) => {
    const i = queue.findIndex((m) => m.type === type);
    if (i >= 0) return resolve(queue.splice(i, 1)[0]);
    if (closed) return type === 'exit' ? resolve({ type: 'exit', code: closed.code ?? 1, signal: closed.signal, lost: true }) : reject(new Error(`the constrained tree's gate ended before ${type}`));
    const w = { type, resolve, reject };
    waiting.push(w);
    if (ms) setTimeout(() => { const j = waiting.indexOf(w); if (j >= 0) { waiting.splice(j, 1); reject(new Error(`timed out after ${ms} ms waiting for ${type}`)); } }, ms).unref();
  });
}

// The Windows job helper, a PowerShell process that holds the job and answers one JSON line per command.
function startJob({ cpuRate, memoryBytes }) {
  const ps = spawn('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', here('./constrain-job.ps1'), '-CpuRate', String(cpuRate), '-MemoryBytes', String(memoryBytes)], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const lines = [];
  const waiting = [];
  let buf = '';
  let err = '';
  let ended = false;
  const failAll = () => { for (const w of waiting.splice(0)) w.reject(new Error(`the Windows job helper ended: ${err.trim().split('\n').slice(-6).join(' ') || 'no output'}`)); };
  ps.stdout.setEncoding('utf8').on('data', (d) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line.startsWith('{')) continue;
      const m = JSON.parse(line);
      const w = waiting.shift();
      if (w) (m.error ? w.reject(new Error(m.error)) : w.resolve(m));
      else lines.push(m);
    }
  });
  ps.stderr.setEncoding('utf8').on('data', (d) => { err += d; });
  ps.on('exit', () => { ended = true; failAll(); });
  ps.on('error', (e) => { err += e.message; ended = true; failAll(); });
  const answer = (ms) => new Promise((resolve, reject) => {
    const m = lines.shift();
    if (m) return m.error ? reject(new Error(m.error)) : resolve(m);
    if (ended) return reject(new Error(`the Windows job helper ended: ${err.trim() || 'no output'}`));
    const w = { resolve, reject };
    waiting.push(w);
    setTimeout(() => { const j = waiting.indexOf(w); if (j >= 0) { waiting.splice(j, 1); reject(new Error(`the Windows job helper didn't answer in ${ms} ms: ${err.trim()}`)); } }, ms).unref();
  });
  return {
    ready: () => answer(120000),
    assign: (pid) => { ps.stdin.write(`assign ${pid}\n`); return answer(30000); },
    report: async () => { ps.stdin.write('report\n'); const r = await answer(30000); ps.stdin.end(); return r; },
    kill: () => { try { ps.kill(); } catch { /* gone */ } },
  };
}

// A Linux cgroup v2 made (with sudo -n) for one run.
function startCgroup({ factor, memoryBytes }) {
  const dir = `/sys/fs/cgroup/flow-review-constrain-${process.pid}-${Date.now()}`;
  const sh = (script) => {
    const r = spawnSync('sudo', ['-n', 'sh', '-c', script], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`cgroup: ${script}: ${(r.stderr || r.error?.message || '').trim()}`);
  };
  const period = 100000;
  const lines = ['set -e'];
  for (const c of ['cpu', 'memory']) lines.push(`grep -qw ${c} /sys/fs/cgroup/cgroup.subtree_control || echo +${c} > /sys/fs/cgroup/cgroup.subtree_control`);
  lines.push(`mkdir ${dir}`);
  if (factor > 1) lines.push(`echo "${Math.round(period / factor)} ${period}" > ${dir}/cpu.max`);
  if (memoryBytes > 0) lines.push(`echo ${memoryBytes} > ${dir}/memory.max`, `[ ! -e ${dir}/memory.swap.max ] || echo 0 > ${dir}/memory.swap.max`);
  sh(lines.join('\n'));
  const read = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return ''; } };
  const kv = (text) => Object.fromEntries(text.trim().split('\n').filter(Boolean).map((l) => l.split(/\s+/)).map(([k, v]) => [k, Number(v)]));
  return {
    dir,
    quota: factor > 1 ? `${Math.round(period / factor)} ${period}` : null,
    assign: (pid) => sh(`echo ${pid} > ${dir}/cgroup.procs`),
    report: () => {
      const events = kv(read('memory.events'));
      const cpu = kv(read('cpu.stat'));
      const peak = Number(read('memory.peak').trim()) || null;
      const left = read('cgroup.procs').trim().split('\n').filter(Boolean).length;
      return { events, cpu, peak, left };
    },
    remove: () => {
      try { sh(`[ ! -e ${dir}/cgroup.kill ] || echo 1 > ${dir}/cgroup.kill; for i in 1 2 3 4 5 6 7 8 9 10; do rmdir ${dir} 2>/dev/null && exit 0; sleep 0.2; done; exit 1`); } catch { /* left for the system to clean */ }
    },
  };
}

// Watches a POSIX process tree with ps: the root's descendants and its process group. Feeds the duty cycle the members
// that left the group, and sums their resident memory.
function watchTree(root, { intervalMs = 250, onSample }) {
  let stopped = false;
  let timer = null;
  let members = new Set([root]);
  const tick = () => {
    execFile('ps', ['-A', '-o', 'pid=,ppid=,pgid=,rss='], { maxBuffer: 16 * MB }, (err, out) => {
      if (stopped) return;
      if (!err) {
        const rows = out.trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number)).filter((r) => r.length >= 4 && r.every(Number.isFinite));
        const kids = new Map();
        for (const [pid, ppid] of rows) { if (!kids.has(ppid)) kids.set(ppid, []); kids.get(ppid).push(pid); }
        const byPid = new Map(rows.map((r) => [r[0], r]));
        const tree = new Set();
        const stack = [root, ...rows.filter((r) => r[2] === root).map((r) => r[0])];
        while (stack.length) {
          const p = stack.pop();
          if (tree.has(p) || !byPid.has(p)) continue;
          tree.add(p);
          stack.push(...(kids.get(p) ?? []));
        }
        members = tree;
        const rss = [...tree].reduce((sum, p) => sum + (byPid.get(p)?.[3] ?? 0) * 1024, 0);
        onSample({ rss, outsideGroup: [...tree].filter((p) => byPid.get(p)?.[2] !== root) });
      }
      timer = setTimeout(tick, intervalMs);
    });
  };
  tick();
  return { stop: () => { stopped = true; clearTimeout(timer); }, members: () => members };
}

function startDuty(group, { factor, periodMs }) {
  const shared = new SharedArrayBuffer(4 * 1027);
  const s = new Int32Array(shared);
  s[1] = group;
  const worker = new Worker(here('./constrain-duty.mjs'), { workerData: { shared, factor, periodMs } });
  const done = new Promise((resolve) => { worker.once('message', resolve); worker.once('error', (e) => resolve({ error: e.message })); worker.once('exit', () => resolve({})); });
  return {
    setExtra: (pids) => {
      const list = pids.slice(0, 1024);
      Atomics.store(s, 2, 0);
      list.forEach((p, i) => Atomics.store(s, 3 + i, p));
      Atomics.store(s, 2, list.length);
    },
    stop: async () => { Atomics.store(s, 0, 1); Atomics.notify(s, 0); const r = await done; await worker.terminate(); return r; },
    // Synchronous, for process exit: the worker may not get to run again.
    release: () => { Atomics.store(s, 0, 1); Atomics.notify(s, 0); try { process.kill(-group, 'SIGCONT'); } catch { /* gone */ } },
  };
}

function githubNotice(title, text) {
  if (process.env.GITHUB_ACTIONS !== 'true') return;
  process.stdout.write(`::notice title=${title}::${text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}\n`);
}

/**
 * Runs `command` with `args` on a constrained computer. Returns `{ ready, done, stop(signal) }`: `ready` resolves once
 * the constraint is measured and the command started (with `{ env, cpu, mechanisms }`), `done` with the run's summary
 * (`flow-review schema constrained`) when the command and everything it left running have ended.
 *
 * Options: `settings` (from resolveSettings) or `profile` and `overrides`; `tolerance` for the measured CPU factor
 * (default 0.25: a 4× profile must measure 3× to 5×, or the command doesn't run); `cpuMechanism` (auto, job, cgroup,
 * duty-cycle); `periodMs` for the duty cycle (default 50); `cwd`, `env`; `summary`, a file to write the summary to;
 * `log`, where the banner goes (default stderr; null for none).
 */
export function launchConstrained(command, args = [], options = {}) {
  let resolveReady;
  let rejectReady;
  const ready = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });
  ready.catch(() => {});
  const control = { stopWith: null, gate: null };
  const done = runConstrained(command, args, options, { resolveReady, rejectReady, control });
  done.catch((e) => rejectReady(e));
  return {
    ready,
    done,
    stop: (signal = 'SIGTERM') => {
      control.stopWith = signal;
      try { control.gate?.send({ type: 'signal', name: signal }); } catch { /* gone */ }
    },
  };
}

async function runConstrained(command, args, options, { resolveReady, rejectReady, control }) {
  const {
    profile, overrides, tolerance = 0.25, cpuMechanism = 'auto', periodMs = 50, cwd = process.cwd(), env = process.env, summary: summaryFile = null,
    log = (line) => process.stderr.write(`${line}\n`), calibrateMs = 150,
  } = options;
  const settings = options.settings ?? resolveSettings(profile, overrides);
  const mechanisms = pickMechanisms(settings, { cpuMechanism, env });
  const startedAt = new Date();
  const posix = process.platform !== 'win32';
  const cpus = os.availableParallelism();
  const say = (line) => { if (log) log(line); };
  const cpu = { target: settings.cpu, mechanism: mechanisms.cpu, enforcement: mechanisms.cpu ? ENFORCEMENT[mechanisms.cpu][0] : null, scope: mechanisms.cpu ? ENFORCEMENT[mechanisms.cpu][1] : null, achieved: null, tolerance, within: null, baselineMs: null, constrainedMs: null, iterations: null, cpus };
  const memory = { capMB: settings.memoryMB || null, mechanism: mechanisms.memory, enforcement: mechanisms.memory ? ENFORCEMENT[mechanisms.memory][0] : null, peakMB: null, hit: false };
  const disk = { ...settings.disk, mechanism: diskOn(settings) ? 'node-fs-preload' : null };
  const network = { ...settings.network, mechanism: networkOn(settings) ? 'delay-proxy' : null, proxy: null };
  let error = null;
  let exit = { code: null, signal: null };

  let proxy = null;
  let job = null;
  let cgroup = null;
  let duty = null;
  let watch = null;
  let gate = null;
  let memoryKilled = false;
  const release = () => duty?.release();
  process.on('exit', release);

  const killTree = () => {
    if (!posix || !gate?.pid) return;
    const pids = watch ? [...watch.members()] : [];
    for (const target of [-gate.pid, ...pids]) { try { process.kill(target, 'SIGCONT'); process.kill(target, 'SIGKILL'); } catch { /* gone */ } }
  };

  try {
    if (network.mechanism) {
      proxy = await startDelayProxy(settings.network);
      network.proxy = proxy.url;
    }
    if (process.platform === 'win32' && (mechanisms.cpu || mechanisms.memory)) {
      const cpuRate = mechanisms.cpu ? jobCpuRate(settings.cpu, cpus) : 0;
      job = startJob({ cpuRate, memoryBytes: mechanisms.memory ? settings.memoryMB * MB : 0 });
      cpu.rate = cpuRate || null;
    }
    if (mechanisms.cpu === 'cgroup-cpu-max' || mechanisms.memory === 'cgroup-memory-max') {
      cgroup = startCgroup({ factor: settings.cpu, memoryBytes: mechanisms.memory ? settings.memoryMB * MB : 0 });
      cpu.quota = cgroup.quota;
    }

    const gateEnv = { ...env };
    delete gateEnv.NODE_OPTIONS;
    gate = spawn(process.execPath, [here('./constrain-gate.mjs')], { cwd, env: gateEnv, stdio: ['inherit', 'inherit', 'inherit', 'ipc'], detached: posix, windowsHide: true });
    control.gate = gate;
    const next = mailbox(gate);
    await next('hello', 30000);

    if (mechanisms.cpu) {
      gate.send({ type: 'calibrate', targetMs: calibrateMs });
      const b = await next('baseline', 60000);
      cpu.baselineMs = Math.round(b.ms * 10) / 10;
      cpu.iterations = b.iterations;
    }
    if (job) await job.ready().then(() => job.assign(gate.pid));
    if (cgroup) cgroup.assign(gate.pid);
    if (mechanisms.cpu === 'duty-cycle') duty = startDuty(gate.pid, { factor: settings.cpu, periodMs });
    if (posix && (duty || mechanisms.memory === 'rss-watch')) {
      let peak = 0;
      watch = watchTree(gate.pid, {
        onSample: ({ rss, outsideGroup }) => {
          duty?.setExtra(outsideGroup);
          peak = Math.max(peak, rss);
          memory.peakMB = Math.round(peak / MB);
          if (mechanisms.memory === 'rss-watch' && rss > settings.memoryMB * MB && !memoryKilled) {
            memoryKilled = true;
            memory.hit = true;
            say(`flow-review constrain: the tree's resident memory, ${Math.round(rss / MB)} MB, is over the ${settings.memoryMB} MB cap; stopping it (this platform detects the cap; it can't enforce it)`);
            killTree();
          }
        },
      });
    }
    if (mechanisms.cpu) {
      gate.send({ type: 'measure' });
      const m = await next('measured', 120000);
      cpu.constrainedMs = Math.round(m.ms * 10) / 10;
      cpu.achieved = factorOf(m.ms, cpu.baselineMs);
      cpu.within = within(cpu.achieved, settings.cpu, tolerance);
      if (!cpu.within) {
        error = `the CPU constraint measured ${cpu.achieved}×, outside ${settings.cpu}× ±${Math.round(tolerance * 100)}%: the command didn't run`;
        gate.send({ type: 'abort' });
        exit = { code: null, signal: null };
        await next('exit', 30000).catch(() => {});
      }
    }

    if (!error) {
      const info = {
        profile: settings.profile, cpu: settings.cpu, memoryMB: settings.memoryMB, disk: settings.disk, network: settings.network,
        ...(settings.overridden ? { overridden: settings.overridden } : {}),
        proxy: proxy?.url ?? null,
        tree: { cpu: mechanisms.cpu, memory: mechanisms.memory, achieved: cpu.achieved },
      };
      const childEnv = constrainedEnv(env, info, proxy?.url);
      const shell = process.platform === 'win32' && !/\.exe$/i.test(command) && command !== process.execPath && command !== 'node';
      const cmd = command === 'node' ? process.execPath : command;
      say(bannerLine(settings, { cpu, memory }));
      githubNotice('Constrained computer', bannerLine(settings, { cpu, memory }));
      gate.send(shell ? { type: 'run', command: windowsCommandLine(cmd, args), args: [], cwd, env: childEnv, shell: true } : { type: 'run', command: cmd, args, cwd, env: childEnv, shell: false });
      resolveReady({ env: childEnv, cpu: { ...cpu }, mechanisms, proxy: proxy?.url ?? null });
      const e = await next('exit');
      exit = { code: e.code, signal: e.signal };
      if (e.error) error = `the command didn't start: ${e.error}`;
    }
  } catch (e) {
    error = e.message;
    rejectReady(e);
  } finally {
    if (gate && gate.exitCode === null && gate.signalCode === null) { try { gate.disconnect?.(); } catch { /* gone */ } }
    if (duty) cpu.duty = await duty.stop();
    duty = null;
    // What the command left running ends with the run.
    killTree();
    watch?.stop();
    if (job) {
      try {
        const r = await job.report();
        memory.peakMB = Math.round(r.peakJobMemory / MB);
        memory.limitHits = r.memoryLimitHits;
        if (mechanisms.memory && r.memoryLimitHits > 0) memory.hit = true;
        cpu.cpuSeconds = Math.round(r.cpuSeconds * 100) / 100;
        cpu.processes = r.processes;
      } catch (e) { error ??= e.message; }
      job.kill();
    }
    if (cgroup) {
      const r = cgroup.report();
      if (r.peak) memory.peakMB = Math.round(r.peak / MB);
      memory.events = { max: r.events.max ?? 0, oom: r.events.oom ?? 0, oomKill: r.events.oom_kill ?? 0 };
      if (mechanisms.memory && (memory.events.oom > 0 || memory.events.oomKill > 0)) memory.hit = true;
      if (r.cpu.nr_throttled !== undefined) cpu.throttledPeriods = r.cpu.nr_throttled;
      cgroup.remove();
    }
    if (proxy) {
      Object.assign(network, proxy.stats());
      await proxy.close();
    }
    process.off('exit', release);
  }

  const capsHit = memory.hit ? ['memory'] : [];
  const finishedAt = new Date();
  const summary = {
    schema: CONSTRAINED_SCHEMA,
    tool: { name: 'flow-review', version: VERSION },
    profile: settings.profile,
    settings: { cpu: settings.cpu, memoryMB: settings.memoryMB, disk: settings.disk, network: settings.network },
    overridden: settings.overridden ?? [],
    platform: `${process.platform}-${process.arch}`,
    command: [command, ...args],
    startedAt: startedAt.toISOString(),
    finishedAt: finishedAt.toISOString(),
    ms: finishedAt - startedAt,
    cpu,
    memory,
    disk,
    network,
    capsHit,
    exitCode: exit.code,
    signal: exit.signal ?? control.stopWith ?? null,
    error,
    ok: !error && cpu.within !== false && !capsHit.length && exit.code === 0,
  };
  if (summaryFile) {
    fs.mkdirSync(path.dirname(path.resolve(cwd, summaryFile)), { recursive: true });
    fs.writeFileSync(path.resolve(cwd, summaryFile), `${JSON.stringify(summary, null, 2)}\n`);
  }
  const end = `${bannerLine(settings, { cpu, memory })}: ${error ? `ERROR ${error}` : `exit ${exit.code ?? exit.signal}`}${capsHit.length ? `; caps hit: ${capsHit.join(', ')}` : '; no caps hit'}`;
  say(end);
  githubNotice('Constrained computer', end);
  return summary;
}

/** Runs a command on a constrained computer and resolves with its summary; see launchConstrained. */
export const runConstrainedCommand = (command, args, options) => launchConstrained(command, args, options).done;
