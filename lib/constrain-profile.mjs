// Constrained-computer profiles and the settings a run passes to everything it constrains. Product-neutral: a profile
// describes a computer, never an app.

/** The environment variable that turns constrained mode on for a harness and carries the settings to child processes. */
export const CONSTRAINED_ENV = 'FLOW_REVIEW_CONSTRAINED';

/**
 * Named profiles. Each number is overridable. `cpu` is how many times slower every CPU-bound step runs; `memoryMB` caps
 * the launched process tree; `disk` adds `latencyMs` to each file-system call of a Node process and limits its
 * throughput to `mbPerSec` megabytes a second; `network` adds `latencyMs` of round trip and limits throughput to
 * `downKbps` / `upKbps` kilobits a second.
 */
export const PROFILES = Object.freeze({
  // A few-year-old budget Windows laptop: a dual-core mobile CPU about a quarter of a CI runner core's speed, 4 GB of
  // RAM of which half is left for the app, a slow SATA disk, and weak Wi-Fi.
  'old-windows-laptop': Object.freeze({
    cpu: 4,
    memoryMB: 2048,
    disk: Object.freeze({ latencyMs: 4, mbPerSec: 60 }),
    network: Object.freeze({ latencyMs: 150, downKbps: 5000, upKbps: 1000 }),
  }),
});

export const DEFAULT_PROFILE = 'old-windows-laptop';

const num = (v, name, { min = 0 } = {}) => {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min) throw new Error(`${name} must be a number of at least ${min}, not ${JSON.stringify(v)}`);
  return n;
};

/**
 * The full settings for a profile name with overrides: `{ profile, cpu, memoryMB, disk, network }`. A cpu of 1, or a
 * memoryMB, latency or throughput of 0, turns that part off.
 */
export function resolveSettings(profile = DEFAULT_PROFILE, overrides = {}) {
  const base = PROFILES[profile];
  if (!base) throw new Error(`unknown constrained profile ${JSON.stringify(profile)}; profiles are ${Object.keys(PROFILES).join(', ')}`);
  const o = overrides ?? {};
  const pick = (v, d) => (v === undefined || v === null ? d : v);
  const s = {
    profile,
    cpu: num(pick(o.cpu, base.cpu), 'cpu', { min: 1 }),
    memoryMB: num(pick(o.memoryMB, base.memoryMB), 'memoryMB'),
    disk: { latencyMs: num(pick(o.disk?.latencyMs, base.disk.latencyMs), 'disk.latencyMs'), mbPerSec: num(pick(o.disk?.mbPerSec, base.disk.mbPerSec), 'disk.mbPerSec') },
    network: { latencyMs: num(pick(o.network?.latencyMs, base.network.latencyMs), 'network.latencyMs'), downKbps: num(pick(o.network?.downKbps, base.network.downKbps), 'network.downKbps'), upKbps: num(pick(o.network?.upKbps, base.network.upKbps), 'network.upKbps') },
  };
  const changed = [];
  if (s.cpu !== base.cpu) changed.push('cpu');
  if (s.memoryMB !== base.memoryMB) changed.push('memoryMB');
  for (const k of ['latencyMs', 'mbPerSec']) if (s.disk[k] !== base.disk[k]) changed.push(`disk.${k}`);
  for (const k of ['latencyMs', 'downKbps', 'upKbps']) if (s.network[k] !== base.network[k]) changed.push(`network.${k}`);
  if (changed.length) s.overridden = changed;
  return s;
}

export const diskOn = (s) => !!s && (s.disk.latencyMs > 0 || s.disk.mbPerSec > 0);
export const networkOn = (s) => !!s && (s.network.latencyMs > 0 || s.network.downKbps > 0 || s.network.upKbps > 0);

/**
 * Constrained mode as the environment asks for it, or null. FLOW_REVIEW_CONSTRAINED holds a profile name (a harness
 * turned it on: constrain its pages) or the JSON `flow-review constrain` passes to the tree it launched, whose `tree`
 * says the processes are already CPU-throttled and whose `calibration` is the slowdown measured for this run.
 */
export function constrainedFromEnv(env = process.env) {
  const v = env[CONSTRAINED_ENV]?.trim();
  if (!v || v === '0' || v === 'false' || v === 'off') return null;
  if (v.startsWith('{')) {
    const j = JSON.parse(v);
    return { ...resolveSettings(j.profile, j), ...(j.tree ? { tree: j.tree } : {}), ...(j.proxy ? { proxy: j.proxy } : {}) };
  }
  return resolveSettings(v === '1' || v === 'true' || v === 'on' ? DEFAULT_PROFILE : v);
}

const kbps = (k) => (k >= 1000 ? `${+(k / 1000).toFixed(1)} Mbps` : `${k} kbps`);

/** One line that can't be mistaken for a normal run's output. */
export function bannerLine(s, extra = {}) {
  const parts = [];
  const cpu = extra.cpu;
  parts.push(s.cpu > 1 ? `CPU ${s.cpu}× slower${cpu?.achieved ? ` (measured ${cpu.achieved.toFixed(2)}×${cpu.burst?.achieved ? `, 10 ms tasks ${cpu.burst.achieved.toFixed(2)}×` : ''}, ${cpu.mechanism})` : ''}` : 'CPU unthrottled');
  parts.push(s.memoryMB ? `memory ${s.memoryMB} MB${extra.memory ? ` (${extra.memory.enforcement})` : ''}` : 'memory uncapped');
  parts.push(diskOn(s) ? `disk +${s.disk.latencyMs} ms/op, ${s.disk.mbPerSec || '∞'} MB/s (Node fs)` : 'disk normal');
  parts.push(networkOn(s) ? `network +${s.network.latencyMs} ms, ${kbps(s.network.downKbps)} down / ${kbps(s.network.upKbps)} up` : 'network normal');
  return `CONSTRAINED COMPUTER (${s.profile}${s.overridden ? `, overridden: ${s.overridden.join(', ')}` : ''}): ${parts.join(' · ')}`;
}
