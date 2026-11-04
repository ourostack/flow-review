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
import { CONSTRAINED_ENV, resolveSettings, diskOn, networkOn, bannerLine, sandboxedHost, assertSandboxedHost } from './constrain-profile.mjs';
import { factorOf, within, pairedFactor, converge, enoughPairs } from './constrain-calibrate.mjs';
import { startDelayProxy } from './constrain-proxy.mjs';

const here = (f) => fileURLToPath(new URL(f, import.meta.url));
const VERSION = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
export const CONSTRAINED_SCHEMA = 'flow-review-constrained-0';
const MB = 1024 * 1024;
const ENDING_SIGNALS = ['SIGINT', 'SIGTERM', 'SIGHUP'];

// A signal that ends this process runs no 'exit' handlers, and a tree left mid-cycle would stay stopped: one handler,
// while any run is active, releases every run and then lets the signal end the process as it would have. Where
// something else here handles the signal (the CLI stops its run and reports it), it is left to that.
const activeRuns = new Set();
function onEndingSignal(signal) {
  if (process.listenerCount(signal) > 1) return;
  for (const s of ENDING_SIGNALS) process.off(s, onEndingSignal);
  for (const release of activeRuns) release();
  activeRuns.clear();
  try { process.kill(process.pid, signal); } catch { process.exit(128 + (os.constants.signals[signal] ?? 0)); }
}
function trackRun(release) {
  if (!activeRuns.size) for (const s of ENDING_SIGNALS) process.on(s, onEndingSignal);
  activeRuns.add(release);
  return () => {
    if (activeRuns.delete(release) && !activeRuns.size) for (const s of ENDING_SIGNALS) process.off(s, onEndingSignal);
  };
}

export { SANDBOX_ENV, sandboxedHost, assertSandboxedHost } from './constrain-profile.mjs';

/** How far the measured slowdown on long work may be from the profile's, as a fraction, before a run is refused. */
export const DEFAULT_TOLERANCE = 0.1;
/** How far the measured slowdown on 10 ms tasks may be from the profile's, as a fraction. */
export const DEFAULT_BURST_TOLERANCE = 0.25;
// Adjacent unconstrained and constrained timings in each calibration measurement: at least three, and more, up to nine,
// until the median is known to within half the aim (enoughPairs); and the most corrections before the factor measured is
// final.
const MIN_PAIRS = 3;
const MAX_PAIRS = 9;
const MAX_CORRECTIONS = 6;
const percent = (fraction) => `${Math.round(fraction * 1000) / 10}%`;

/** The longest a constrained run may last by default, in minutes, before its whole tree is killed. */
export const DEFAULT_TIMEOUT_MINUTES = 60;

const ENFORCEMENT = {
  'job-cpu-rate': ['enforced', 'tree'], 'cgroup-cpu-max': ['enforced', 'tree'], 'duty-cycle': ['enforced', 'thread'], 'job-duty-cycle': ['enforced', 'thread'],
  'job-memory': ['enforced'], 'cgroup-memory-max': ['enforced'], 'rss-watch': ['detected'],
};

/** Whether this Linux machine can make a cgroup v2 for the run without asking for a password. */
export function cgroupAvailable() {
  if (process.platform !== 'linux' || !fs.existsSync('/sys/fs/cgroup/cgroup.controllers')) return false;
  return spawnSync('sudo', ['-n', 'true'], { stdio: 'ignore' }).status === 0;
}

/**
 * How this platform constrains CPU and memory: `{ cpu, memory }`, each a mechanism name or null when that part is off.
 * `cpuMechanism` is `auto`, `duty-cycle` (stop and continue the tree in turn, so every thread runs 1/factor of the
 * time: `job-duty-cycle` on Windows, `duty-cycle` elsewhere) or `hard-cap` (the operating system's cap on the tree's CPU
 * time: `job-cpu-rate` on Windows, `cgroup-cpu-max` on Linux, none on macOS). Auto is the duty cycle on Windows and
 * macOS, and the cgroup on Linux where it is available (CI, with sudo that needs no password). Memory: the Windows job
 * (`job-memory`), the Linux cgroup where it is available (`cgroup-memory-max`), or a watch (`rss-watch`).
 */
export function pickMechanisms(settings, { cpuMechanism = 'auto', platform = process.platform, env = process.env, cgroup = cgroupAvailable } = {}) {
  const wantCpu = settings.cpu > 1;
  const wantMem = settings.memoryMB > 0;
  if (!['auto', 'hard-cap', 'duty-cycle'].includes(cpuMechanism)) throw new Error(`unknown CPU mechanism ${cpuMechanism}; use auto, hard-cap or duty-cycle`);
  if (platform === 'win32') {
    return { cpu: wantCpu ? (cpuMechanism === 'hard-cap' ? 'job-cpu-rate' : 'job-duty-cycle') : null, memory: wantMem ? 'job-memory' : null };
  }
  if (platform !== 'linux') {
    if (cpuMechanism === 'hard-cap' && wantCpu) throw new Error(`${platform} has no hard CPU cap for a process tree; use auto or duty-cycle`);
    return { cpu: wantCpu ? 'duty-cycle' : null, memory: wantMem ? 'rss-watch' : null };
  }
  let useCgroup = false;
  if (wantCpu || wantMem) {
    if (cpuMechanism === 'hard-cap' && wantCpu) {
      if (!cgroup()) throw new Error('a hard cap on Linux is a cgroup, which needs cgroup v2 and sudo without a password (sudo -n)');
      useCgroup = true;
    } else useCgroup = env.CI === 'true' && cgroup();
  }
  return {
    cpu: wantCpu ? (useCgroup && cpuMechanism !== 'duty-cycle' ? 'cgroup-cpu-max' : 'duty-cycle') : null,
    memory: wantMem ? (useCgroup ? 'cgroup-memory-max' : 'rss-watch') : null,
  };
}

/** The Windows job's CPU rate (cycles per 10,000 across all processors) that leaves the tree one core at 1/factor. */
export const jobCpuRate = (factor, cpus = os.availableParallelism()) => Math.max(1, Math.round(10000 / (factor * cpus)));

// cmd.exe's metacharacters. Each is escaped with ^, so cmd passes it on as it is, quotes included.
const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/**
 * The command line for cmd.exe (`cmd /d /s /c`), which runs the .cmd and .bat files (npm, npx) that Windows can't start
 * directly: each argument quoted for the program (backslashes and quotes as Windows programs read them), then every cmd
 * metacharacter escaped with ^, so cmd neither splits the line at & or | nor expands %VAR%. A .cmd or .bat file that
 * passes its arguments on through %* (npm, npx, a node_modules\.bin shim) has cmd read them a second time, so for one
 * (`batch`) they are escaped twice.
 */
export function windowsCommandLine(command, args, { batch = false } = {}) {
  const arg = (a) => {
    const quoted = `"${String(a).replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/, '$1$1')}"`.replace(CMD_META, '^$1');
    return batch ? quoted.replace(CMD_META, '^$1') : quoted;
  };
  return [command.replace(CMD_META, '^$1'), ...args.map(arg)].join(' ');
}

/**
 * Whether cmd.exe would run `command` as a .cmd or .bat file that passes its arguments on through %*: found as cmd
 * finds it, in `cwd` and then on PATH. One that reads them as %1 or %~1 gets them escaped once, so its quotes come off.
 */
export function windowsBatchForwardsArgs(command, env = process.env, cwd = process.cwd()) {
  const get = (k) => Object.entries(env).find(([key]) => key.toUpperCase() === k)?.[1];
  const exts = /\.[^.\\/]+$/.test(command) ? [''] : (get('PATHEXT') ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean);
  const dirs = /[\\/]/.test(command) ? [''] : [cwd, ...(get('PATH') ?? '').split(';').filter(Boolean)];
  for (const dir of dirs) {
    for (const ext of exts) {
      const file = path.resolve(cwd, dir, command + ext);
      let text;
      try { if (!fs.statSync(file).isFile()) continue; text = /\.(?:cmd|bat)$/i.test(file) ? fs.readFileSync(file, 'utf8') : ''; } catch { continue; }
      return text.includes('%*');
    }
  }
  return false;
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
  let readied = null;
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
  // A helper killed with its job (a timeout) can't be written to; its answers fail where they are awaited.
  ps.stdin.on('error', () => {});
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
    // The helper's first line says it is ready; it is read once, here, whether or not the run got as far as asking, so a
    // report never takes it for its answer.
    ready: () => (readied ??= answer(120000)),
    assign: (pid) => { ps.stdin.write(`assign ${pid}\n`); return answer(30000); },
    rate: (n) => { ps.stdin.write(`rate ${n}\n`); return answer(30000); },
    duty: (ratio, periodMs) => { ps.stdin.write(`duty ${ratio} ${periodMs}\n`); return answer(30000); },
    ratio: async (r) => {
      ps.stdin.write(`ratio ${r}\n`);
      const m = await answer(30000);
      if (m.held !== undefined && m.held !== (r <= 1)) throw new Error(`the Windows job helper's duty cycle didn't ${r <= 1 ? 'hold' : 'start again'} within 2 s`);
      return m;
    },
    report: async () => {
      await (readied ??= answer(120000)).catch(() => {});
      ps.stdin.write('report\n');
      const r = await answer(30000);
      ps.stdin.end();
      if (!Number.isFinite(r.peakJobMemory) || !Number.isFinite(r.cpuSeconds)) throw new Error(`the Windows job helper's report was incomplete: ${JSON.stringify(r)}`);
      return r;
    },
    kill: () => { try { ps.kill(); } catch { /* gone */ } },
  };
}

// A Linux cgroup v2 made (with sudo -n) for one run.
function startCgroup({ factor, memoryBytes, periodUs = null }) {
  const dir = `/sys/fs/cgroup/flow-review-constrain-${process.pid}-${Date.now()}`;
  const sh = (script) => {
    const r = spawnSync('sudo', ['-n', 'sh', '-c', script], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`cgroup: ${script}: ${(r.stderr || r.error?.message || '').trim()}`);
  };
  // A short period, so a short task is slowed too, not let run at full speed until a long period's quota is spent; longer
  // only when the quota would be under the kernel's minimum of 1 ms (a factor over 10).
  const period = periodUs ?? Math.min(1_000_000, Math.max(10000, Math.ceil(1000 * factor)));
  const lines = ['set -e'];
  for (const c of ['cpu', 'memory']) lines.push(`grep -qw ${c} /sys/fs/cgroup/cgroup.subtree_control || echo +${c} > /sys/fs/cgroup/cgroup.subtree_control`);
  lines.push(`mkdir ${dir}`);
  const quota = Math.max(1000, Math.round(period / factor));
  if (factor > 1) lines.push(`echo "${quota} ${period}" > ${dir}/cpu.max`);
  if (memoryBytes > 0) lines.push(`echo ${memoryBytes} > ${dir}/memory.max`, `[ ! -e ${dir}/memory.swap.max ] || echo 0 > ${dir}/memory.swap.max`);
  sh(lines.join('\n'));
  const read = (f) => { try { return fs.readFileSync(path.join(dir, f), 'utf8'); } catch { return ''; } };
  const kv = (text) => Object.fromEntries(text.trim().split('\n').filter(Boolean).map((l) => l.split(/\s+/)).map(([k, v]) => [k, Number(v)]));
  return {
    dir,
    period,
    quota: factor > 1 ? `${quota} ${period}` : null,
    setQuota: (q) => { sh(`echo "${q} ${period}" > ${dir}/cpu.max`); return `${q} ${period}`; },
    assign: (pid) => sh(`echo ${pid} > ${dir}/cgroup.procs`),
    report: () => {
      const events = kv(read('memory.events'));
      const cpu = kv(read('cpu.stat'));
      const peak = Number(read('memory.peak').trim()) || null;
      const left = read('cgroup.procs').trim().split('\n').filter(Boolean).length;
      return { events, cpu, peak, left };
    },
    // Every process in the cgroup, wherever it is in the tree.
    kill: () => { try { sh(`[ ! -e ${dir}/cgroup.kill ] || echo 1 > ${dir}/cgroup.kill`); } catch { /* gone, or left for remove */ } },
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
  // Once in the tree, a process stays in it while it lives, even after its parent exits and it is reparented: it keeps
  // being slowed, and is never left stopped.
  const adopted = new Set();
  const tick = () => {
    execFile('ps', ['-A', '-o', 'pid=,ppid=,pgid=,rss='], { maxBuffer: 16 * MB }, (err, out) => {
      if (stopped) return;
      if (!err) {
        const rows = out.trim().split('\n').map((l) => l.trim().split(/\s+/).map(Number)).filter((r) => r.length >= 4 && r.every(Number.isFinite));
        const kids = new Map();
        for (const [pid, ppid] of rows) { if (!kids.has(ppid)) kids.set(ppid, []); kids.get(ppid).push(pid); }
        const byPid = new Map(rows.map((r) => [r[0], r]));
        const tree = new Set();
        const stack = [root, ...rows.filter((r) => r[2] === root).map((r) => r[0]), ...adopted];
        while (stack.length) {
          const p = stack.pop();
          if (tree.has(p) || !byPid.has(p)) continue;
          tree.add(p);
          stack.push(...(kids.get(p) ?? []));
        }
        members = tree;
        for (const p of adopted) if (!byPid.has(p)) adopted.delete(p);
        for (const p of tree) adopted.add(p);
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
  // [0] the ratio, [1] the period, [2] the worker's answer to a hold (1 held, 0 cycling): see constrain-duty.mjs.
  const ratio = new Float64Array(new SharedArrayBuffer(24));
  ratio[0] = factor;
  ratio[1] = periodMs;
  let heldAt = null;
  const answered = async (held, what) => {
    const until = performance.now() + 2000;
    while (ratio[2] !== held) {
      if (performance.now() > until) throw new Error(`the duty cycle didn't ${what} within 2 s`);
      await new Promise((r) => setTimeout(r, 1));
    }
  };
  // Not the flags this process was started with: --input-type (a harness run with node -e) would stop the worker loading.
  const worker = new Worker(here('./constrain-duty.mjs'), { workerData: { shared, ratio: ratio.buffer }, execArgv: [] });
  const done = new Promise((resolve) => { worker.once('message', resolve); worker.once('error', (e) => resolve({ error: e.message })); worker.once('exit', () => resolve({})); });
  return {
    setExtra: (pids) => {
      const list = pids.slice(0, 1024);
      Atomics.store(s, 2, 0);
      list.forEach((p, i) => Atomics.store(s, 3 + i, p));
      Atomics.store(s, 2, list.length);
    },
    // The duty cycle's own stop-to-run ratio, corrected when a stop takes effect late (as on macOS, where a signal
    // reaches a running thread at its next trap): the calibration says how far off it was.
    ratio: () => ratio[0],
    setRatio: (r) => { ratio[0] = r; },
    period: () => ratio[1],
    setPeriod: (ms) => { ratio[1] = ms; },
    // Holds the cycle with the tree running, answered once the worker has continued it, and starts it again at the ratio
    // it had, answered once the worker is cycling.
    hold: async () => { if (heldAt !== null) return; heldAt = ratio[0]; ratio[0] = 1; await answered(1, 'hold'); },
    unhold: async () => { if (heldAt === null) return; ratio[0] = heldAt; heldAt = null; await answered(0, 'start again'); },
    stop: async () => { Atomics.store(s, 0, 1); Atomics.notify(s, 0); const r = await done; await worker.terminate(); return r; },
    // Synchronous, for process exit: the worker may not get to run again.
    release: () => {
      Atomics.store(s, 0, 1);
      Atomics.notify(s, 0);
      for (const target of [-group, ...Array.from({ length: Atomics.load(s, 2) }, (_, i) => Atomics.load(s, 3 + i))]) { try { process.kill(target, 'SIGCONT'); } catch { /* gone */ } }
    },
  };
}

// Short tasks, as an app's events are: the constraining process sends the gate an event and times it until the gate
// answers, so a tree that is stopped when its event arrives answers late, as on a slow computer, and the timing doesn't
// depend on the gate's own timers (which wake on a 15.6 ms tick in a windowless Windows process). Gaps of 20 to 32 ms
// between them leave the tree idle, as between a user's clicks. Returns every time, in order.
// `from` continues the gaps' pattern from an earlier call, so tasks timed in rounds still see every gap from 20 to 32 ms,
// and so every phase of a duty cycle restarted at each round.
async function timeEvents(send, next, count = 16, from = 0) {
  const ms = [];
  for (let k = from; k < from + count; k++) {
    await new Promise((r) => setTimeout(r, 20 + ((k * 7) % 13)));
    const t = performance.now();
    send({ type: 'event' });
    await next('handled', 30000);
    ms.push(performance.now() - t);
  }
  return ms;
}
const medianOf = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

// The constraint's controls for the calibration. `correct(k)` makes it `k` times stronger (a duty cycle's ratio grows
// with k, a hard cap's rate or quota shrinks), each within bounds of where it started, and says how much stronger it
// actually made it (`strength`, after those bounds) and whether it started again from the profile (`reset`, when the
// duty cycle's period doubled). A hard cap with a duty cycle under it has both corrected together, so they never pull
// against each other. `lift()` lets the tree run unconstrained, for the calibration's unconstrained timings, and
// `restore()` puts the constraint back as it was: the duty cycle held with the tree running, the cap at no limit.
function controls(mechanism, { settings, duty, job, cgroup, cpu, dutied }) {
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  let ratio = settings.cpu;
  const dutyKnob = async (k) => {
    const before = ratio;
    const wanted = ratio * k;
    // A tree slowed far more than its ratio says is losing most of each run to resuming (a virtual machine that wakes a
    // continued process a millisecond or two late): a smaller ratio would only make the cycle's runs shorter still. So
    // the period doubles, up to 40 ms, and the ratio starts again from the profile's.
    if (duty && wanted < settings.cpu * 0.6 && duty.period() < 40) {
      duty.setPeriod(Math.min(40, duty.period() * 2));
      ratio = settings.cpu;
      cpu.dutyPeriodMs = duty.period();
      duty.setRatio(ratio);
      cpu.dutyRatio = ratio;
      return { strength: 1, reset: true };
    }
    ratio = Math.round(clamp(wanted, settings.cpu / 2, settings.cpu * 3) * 100) / 100;
    if (duty) duty.setRatio(ratio);
    else await job.ratio(ratio);
    cpu.dutyRatio = ratio;
    return { strength: ratio / before, reset: false };
  };
  // A ratio of 1 holds the Windows helper's duty cycle with every process in the job running.
  const dutyLift = async () => { if (duty) await duty.hold(); else await job.ratio(1); };
  const dutyRestore = async () => { if (duty) await duty.unhold(); else await job.ratio(ratio); };
  if (mechanism === 'duty-cycle' || mechanism === 'job-duty-cycle') return { correct: dutyKnob, lift: dutyLift, restore: dutyRestore };
  let capKnob;
  let capLift;
  let capRestore;
  if (mechanism === 'job-cpu-rate') {
    const start = cpu.rate;
    capKnob = async (k) => {
      const before = cpu.rate;
      cpu.rate = Math.round(clamp(cpu.rate / k, Math.max(1, start / 4), start * 2));
      await job.rate(cpu.rate);
      return { strength: before / cpu.rate, reset: false };
    };
    capLift = () => job.rate(10000);
    capRestore = () => job.rate(cpu.rate);
  } else {
    const start = Math.max(1000, Math.round(cgroup.period / settings.cpu));
    let quota = start;
    capKnob = async (k) => {
      const before = quota;
      quota = Math.round(clamp(quota / k, Math.max(1000, start / 4), start * 2));
      cpu.quota = cgroup.setQuota(quota);
      return { strength: before / quota, reset: false };
    };
    capLift = async () => { cgroup.setQuota('max'); };
    capRestore = async () => { cgroup.setQuota(quota); };
  }
  if (!dutied) return { correct: capKnob, lift: capLift, restore: capRestore };
  return {
    correct: async (k) => { await capKnob(k); return dutyKnob(k); },
    lift: async () => { await capLift(); await dutyLift(); },
    restore: async () => { await capRestore(); await dutyRestore(); },
  };
}

function githubNotice(title, text) {
  if (process.env.GITHUB_ACTIONS !== 'true') return;
  process.stderr.write(`::notice title=${title}::${text.replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A')}\n`);
}

/**
 * Runs `command` with `args` on a constrained computer. Returns `{ ready, done, stop(signal) }`: `ready` resolves once
 * the constraint is measured and the command started (with `{ env, cpu, mechanisms }`), `done` with the run's summary
 * (`flow-review schema constrained`) when the command and everything it left running have ended.
 *
 * Options: `settings` (from resolveSettings) or `profile` and `overrides`; `tolerance` for the CPU factor measured on
 * long work (default 0.1: a 4× profile must measure 3.6× to 4.4× once corrected, or the command doesn't run) and
 * `burstTolerance` for 10 ms tasks' (default 0.25: 3× to 5×); `cpuMechanism` (auto, duty-cycle,
 * hard-cap); `periodMs` for the duty cycle (default 10, so a 10 ms task spans a cycle and is slowed too); `cwd`, `env`; `summary`, a file to write the summary to;
 * `capDuty: false` (a hard cap without the duty cycle under it, which lets short tasks through: the tests plant that
 * defect with it) and `cgroupPeriodUs` (the cgroup's cpu.max period);
 * `log`, where the banner goes (default stderr; null for none); `timeoutMinutes` (default 60), after which the whole
 * tree is killed and the run ends with `timedOut`.
 *
 * It runs only on a CI runner or a declared sandbox (see sandboxedHost) and throws, starting nothing, anywhere else.
 * Every process it starts is killed when the run ends, when it times out and when this process exits: the gate and the
 * command's tree (their process group, every descendant seen, and on Windows and Linux in CI the job or cgroup), and
 * the Windows job helper. The proxy and the duty cycle run inside this process.
 */
export function launchConstrained(command, args = [], options = {}) {
  // Checked before anything starts, and against this process's own environment, not the command's.
  assertSandboxedHost(process.env);
  const timeoutMinutes = options.timeoutMinutes ?? DEFAULT_TIMEOUT_MINUTES;
  if (!(typeof timeoutMinutes === 'number' && timeoutMinutes > 0)) throw new Error('timeoutMinutes is a number of minutes above 0, such as 60');
  let resolveReady;
  let rejectReady;
  const ready = new Promise((res, rej) => { resolveReady = res; rejectReady = rej; });
  ready.catch(() => {});
  const control = { stopWith: null, send: null, lift: null };
  const done = runConstrained(command, args, options, { resolveReady, rejectReady, control });
  done.catch((e) => rejectReady(e));
  return {
    ready,
    done,
    stop: (signal = 'SIGTERM') => {
      control.stopWith = signal;
      control.send?.({ type: 'signal', name: signal });
    },
    lift: () => (control.lift ? control.lift(true) : Promise.reject(new Error(NOT_LIFTABLE))),
    restore: () => (control.lift ? control.lift(false) : Promise.reject(new Error(NOT_LIFTABLE))),
  };
}

const NOT_LIFTABLE = "the constraint can be lifted only while the command runs: after ready resolves, before done";

/**
 * A run's lift and restore, for a harness that measures its own processes the way the calibration measures the tree:
 * `lift(true)` lets the whole tree run unconstrained (the controls' lift: the duty cycle held with the tree running, a
 * hard cap at no limit) and `lift(false)` puts back the constraint as calibrated (its corrected ratio, rate or quota),
 * each answered once it has taken effect. Calls run one at a time in the order made; lifting a lifted run, or
 * restoring a constrained one, changes nothing and answers at once. Every lifted interval is kept (`cpu.lifted`, ms from
 * the run's start), so no timing in it is taken for the constraint's; a run that ends lifted closes its last interval.
 */
function lifter(ctl, cpu, startedAt) {
  let lifted = null;
  let queue = Promise.resolve();
  cpu.lifted = [];
  const now = () => Math.round(performance.now() - startedAt);
  const change = async (on) => {
    if (on === (lifted !== null)) return { lifted: on };
    if (on) {
      await ctl.lift();
      lifted = { from: now() };
      cpu.lifted.push(lifted);
    } else {
      await ctl.restore();
      lifted.to = now();
      lifted = null;
    }
    return { lifted: on };
  };
  return {
    lift: (on) => (queue = queue.then(() => change(on), () => change(on))),
    close: () => { if (lifted) lifted.to = now(); },
  };
}

async function runConstrained(command, args, options, { resolveReady, rejectReady, control }) {
  const {
    profile, overrides, tolerance = DEFAULT_TOLERANCE, burstTolerance = DEFAULT_BURST_TOLERANCE, cpuMechanism = 'auto', periodMs = 10, cwd = process.cwd(), env = process.env, summary: summaryFile = null,
    log = (line) => process.stderr.write(`${line}\n`), calibrateMs = 150, timeoutMinutes = DEFAULT_TIMEOUT_MINUTES, cgroupPeriodUs = null, capDuty = true,
  } = options;
  const sandbox = sandboxedHost(process.env);
  const settings = options.settings ?? resolveSettings(profile, overrides);
  const mechanisms = pickMechanisms(settings, { cpuMechanism, env });
  const startedAt = new Date();
  const t0 = performance.now();
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
  let ctl = null;
  let lift = null;
  let watch = null;
  let gate = null;
  let memoryKilled = false;
  let timedOut = false;
  const timeoutError = `the run went past its ${timeoutMinutes}-minute limit (--timeout-minutes): its whole process tree was killed`;

  // Kills the gate and everything under it: on POSIX its process group and every descendant seen, even those that left
  // the group; on Linux with a cgroup, the cgroup; on Windows, the job's helper, whose job ends every process in it when
  // it closes. Synchronous, so it can run as this process exits.
  const killTree = ({ closeJob = false } = {}) => {
    if (posix && gate?.pid) {
      const pids = watch ? [...watch.members()] : [];
      for (const target of [-gate.pid, ...pids]) { try { process.kill(target, 'SIGCONT'); process.kill(target, 'SIGKILL'); } catch { /* gone */ } }
    }
    cgroup?.kill();
    if (!posix) { try { gate?.kill('SIGKILL'); } catch { /* gone */ } }
    if (closeJob) job?.kill();
  };
  // A run cut short by this process exiting (an uncaught error, process.exit) leaves nothing running or stopped.
  const release = () => { duty?.release(); killTree({ closeJob: true }); };
  process.on('exit', release);
  const untrack = trackRun(release);
  const timer = setTimeout(() => {
    timedOut = true;
    say(`flow-review constrain: ${timeoutError}`);
    killTree({ closeJob: true });
  }, Math.min(timeoutMinutes * 60000, 2 ** 31 - 1));

  try {
    if (network.mechanism) {
      proxy = await startDelayProxy(settings.network);
      network.proxy = proxy.url;
    }
    // On Windows the job is made even when CPU and memory are off: closing it ends every process in the tree.
    if (process.platform === 'win32') {
      const cpuRate = mechanisms.cpu === 'job-cpu-rate' ? jobCpuRate(settings.cpu, cpus) : 0;
      job = startJob({ cpuRate, memoryBytes: mechanisms.memory ? settings.memoryMB * MB : 0 });
      if (cpuRate) cpu.rate = cpuRate;
    }
    if (mechanisms.cpu === 'cgroup-cpu-max' || mechanisms.memory === 'cgroup-memory-max') {
      // The CPU is capped only when the cgroup is the CPU mechanism: under the duty cycle it holds memory alone.
      cgroup = startCgroup({ factor: mechanisms.cpu === 'cgroup-cpu-max' ? settings.cpu : 1, memoryBytes: mechanisms.memory ? settings.memoryMB * MB : 0, periodUs: cgroupPeriodUs });
      cpu.quota = cgroup.quota;
    }

    if (timedOut) throw new Error(timeoutError);
    const gateEnv = { ...env };
    delete gateEnv.NODE_OPTIONS;
    gate = spawn(process.execPath, [here('./constrain-gate.mjs')], { cwd, env: gateEnv, stdio: ['inherit', 'inherit', 'inherit', 'ipc'], detached: posix, windowsHide: true });
    gate.on('error', () => {});
    // A send to a gate that has gone is dropped: its exit is handled where the run waits for it.
    const send = (m) => { if (gate.connected) gate.send(m, () => {}); };
    control.send = send;
    const stopped = () => {
      if (timedOut) throw new Error(timeoutError);
      if (control.stopWith) throw new Error(`stopped (${control.stopWith}) before the command started`);
    };
    const next = mailbox(gate);
    await next('hello', 30000);

    if (mechanisms.cpu) {
      // The loop warmed up and sized in the gate, before anything constrains it.
      stopped();
      send({ type: 'calibrate', targetMs: calibrateMs });
      const b = await next('baseline', 60000);
      cpu.iterations = b.iterations;
    }
    if (job) await job.ready().then(() => job.assign(gate.pid));
    if (cgroup) cgroup.assign(gate.pid);
    // A hard cap holds the whole tree to one slowed core, but over a window long enough that a short task, after idle,
    // runs at full speed until the window's share is spent; the duty cycle under it slows every task from its start.
    const dutied = mechanisms.cpu === 'duty-cycle' || mechanisms.cpu === 'job-duty-cycle' || (capDuty && (mechanisms.cpu === 'job-cpu-rate' || mechanisms.cpu === 'cgroup-cpu-max'));
    if (dutied && posix) duty = startDuty(gate.pid, { factor: settings.cpu, periodMs });
    if (dutied && !posix) await job.duty(settings.cpu, periodMs);
    cpu.dutyCycle = dutied;
    // The tree is watched on every POSIX run, so the members that leave its process group are slowed and killed with it.
    if (posix) {
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
      ctl = controls(mechanisms.cpu, { settings, duty, job, cgroup, cpu, dutied: cpu.dutyCycle });
      // Windows' hard cap holds a job to its rate over intervals of its own, much longer than a cgroup's 10 ms period, so
      // one constrained timing just after the cap is put back lands on wherever that interval is: the median of three.
      const constrainedSamples = mechanisms.cpu === 'job-cpu-rate' ? 3 : 1;
      // How close to the profile's factor the calibration corrects to: half the tolerance, at most ±5%.
      const aim = Math.min(0.05, tolerance / 2);
      // One measurement: the loop timed with the constraint lifted and then under it, in adjacent pairs, so both sides
      // of each pair ran on the computer as it was at that moment (see pairedFactor); three pairs, and more, up to nine,
      // while they scatter too much for their median to be known to within half the aim, as on a busy computer.
      const measure = async () => {
        const base = [];
        const constrained = [];
        const factors = [];
        while (!enoughPairs(factors, { precision: aim / 2, min: MIN_PAIRS, max: MAX_PAIRS })) {
          stopped();
          await ctl.lift();
          send({ type: 'measure', samples: 1 });
          base.push((await next('measured', 120000)).ms);
          await ctl.restore();
          send({ type: 'measure', samples: constrainedSamples });
          constrained.push((await next('measured', 120000)).ms);
          factors.push(constrained.at(-1) / base.at(-1));
        }
        const m = pairedFactor(base, constrained);
        if (m.achieved === null) throw new Error('the calibration loop gave no timing');
        return m;
      };
      // Measured, corrected and measured again until the factor is within half the tolerance of the profile's (at most
      // ±5%), up to six corrections: a duty cycle's ratio, a hard cap's rate or quota. Each correction learns from the
      // ones before how far the factor moves for a change in the constraint (nextCorrection). The factor reported is the
      // last one measured, before the command starts.
      const step = () => ({ ...(cpu.dutyRatio ? { dutyRatio: cpu.dutyRatio } : {}), ...(cpu.dutyPeriodMs ? { dutyPeriodMs: cpu.dutyPeriodMs } : {}), ...(cpu.rate ? { rate: cpu.rate } : {}), ...(cpu.quota ? { quota: cpu.quota } : {}) });
      const m = await converge({ target: settings.cpu, tolerance, aim, maxCorrections: MAX_CORRECTIONS, measure, correct: ctl.correct, step });
      cpu.calibration = m.calibration;
      cpu.corrections = m.corrections;
      cpu.achieved = m.achieved;
      cpu.factors = m.factors;
      cpu.baselineMs = Math.round(m.baselineMs * 10) / 10;
      cpu.constrainedMs = Math.round(m.constrainedMs * 10) / 10;
      // Short tasks, as an app's events are, timed from when each was sent: a constraint measured only over long stretches
      // could let them run at full speed, or keep them waiting longer than a slow computer would. Timed in four rounds of
      // three with the constraint lifted and then four under it, so load that comes and goes falls on both sides, and held
      // to their own tolerance (`burstTolerance`, ±25% by default): an app's clicks and keys are short tasks, and they are
      // what it feels like.
      const baseEvents = [];
      const events = [];
      for (let round = 0; round < 4; round++) {
        stopped();
        await ctl.lift();
        baseEvents.push(...await timeEvents(send, next, 3, round * 3));
        await ctl.restore();
        stopped();
        events.push(...await timeEvents(send, next, 4, round * 4));
      }
      cpu.burst = { baselineMs: Math.round(medianOf(baseEvents) * 10) / 10, constrainedMs: Math.round(medianOf(events) * 10) / 10, achieved: factorOf(medianOf(events), medianOf(baseEvents)), tolerance: burstTolerance };
      cpu.burst.within = within(cpu.burst.achieved, settings.cpu, burstTolerance);
      const longWithin = m.within;
      cpu.within = longWithin && cpu.burst.within;
      if (!cpu.within) {
        const missed = [!longWithin && `${cpu.achieved}× on long work (±${percent(tolerance)} allowed) after ${cpu.corrections} corrections`, !cpu.burst.within && `${cpu.burst.achieved}× on 10 ms tasks (±${percent(burstTolerance)} allowed)`].filter(Boolean).join(' and ');
        error = `the CPU constraint measured ${missed}, against ${settings.cpu}×: the command didn't run`;
        send({ type: 'abort' });
        exit = { code: null, signal: null };
        await next('exit', 30000).catch(() => {});
      }
    }

    if (!error) {
      const info = {
        profile: settings.profile, cpu: settings.cpu, memoryMB: settings.memoryMB, disk: settings.disk, network: settings.network,
        ...(settings.overridden ? { overridden: settings.overridden } : {}),
        proxy: proxy?.url ?? null,
        tree: { cpu: mechanisms.cpu, memory: mechanisms.memory, achieved: cpu.achieved, burst: cpu.burst?.achieved ?? null },
      };
      const childEnv = constrainedEnv(env, info, proxy?.url);
      const shell = process.platform === 'win32' && !/\.exe$/i.test(command) && command !== process.execPath && command !== 'node';
      const cmd = command === 'node' ? process.execPath : command;
      stopped();
      say(bannerLine(settings, { cpu, memory }));
      githubNotice('Constrained computer', bannerLine(settings, { cpu, memory }));
      send(shell ? { type: 'run', command: windowsCommandLine(cmd, args, { batch: windowsBatchForwardsArgs(cmd, childEnv, cwd) }), args: [], cwd, env: childEnv, shell: true } : { type: 'run', command: cmd, args, cwd, env: childEnv, shell: false });
      if (ctl) {
        lift = lifter(ctl, cpu, t0);
        control.lift = lift.lift;
      } else {
        // No CPU constraint: nothing to lift, and every call answers so.
        control.lift = async () => ({ lifted: false });
      }
      resolveReady({ env: childEnv, cpu: { ...cpu }, mechanisms, proxy: proxy?.url ?? null });
      const e = await next('exit');
      exit = { code: e.code, signal: e.signal };
      if (e.error) error = `the command didn't start: ${e.error}`;
    }
  } catch (e) {
    error = e.message;
  } finally {
    control.lift = null;
    lift?.close();
    clearTimeout(timer);
    if (timedOut) error = timeoutError;
    rejectReady(new Error(error ?? 'the run ended before the command started'));
    if (gate?.connected) { try { gate.disconnect(); } catch { /* gone */ } }
    if (duty) cpu.duty = await duty.stop();
    if (cpu.duty?.error) error = `the duty cycle stopped: ${cpu.duty.error}${error ? `; ${error}` : ''}`;
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
        if (cpu.dutyCycle) cpu.duty = { ranMs: r.dutyRanMs, pausedMs: r.dutyPausedMs, cycles: r.dutyCycles, timer: r.dutyTimer };
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
    untrack();
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
    sandbox,
    timeoutMinutes,
    timedOut,
    ok: !error && !timedOut && cpu.within !== false && !capsHit.length && exit.code === 0,
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
