// flow-review constrain: the command line for the constrained computer.
import { parseArgs } from 'node:util';
import os from 'node:os';
import { PROFILES, DEFAULT_PROFILE, resolveSettings } from './constrain-profile.mjs';
import { launchConstrained, pickMechanisms } from './constrain.mjs';
import { startDelayProxy } from './constrain-proxy.mjs';

export const CONSTRAIN_USAGE = `  flow-review constrain [--profile ${DEFAULT_PROFILE}] [--cpu n] [--memory-mb n] [--disk-latency-ms n] [--disk-mb-per-sec n]
                        [--net-latency-ms n] [--net-down-kbps n] [--net-up-kbps n] [--tolerance 0.25]
                        [--cpu-mechanism auto|job|cgroup|duty-cycle] [--summary <file>] -- <command> [args...]
      Runs a command, and everything it starts, on a constrained computer (profiles: ${Object.keys(PROFILES).join(', ')}):
      CPU n times slower, memory capped, Node's file system calls slowed and the network slowed through a local proxy
      (HTTP_PROXY). It measures the CPU slowdown first and doesn't run the command unless it's within --tolerance
      (exit 4). Prints a banner, sets FLOW_REVIEW_CONSTRAINED for the command's harness, and writes a summary
      (flow-review schema constrained) to --summary. Exits with the command's code, or 3 when the tree went over the
      memory cap. A cpu of 1, or a 0, turns that part off.
  flow-review constrain --print [--profile ...] [overrides]
      Prints the settings and the mechanisms this computer would use, without running anything.
  flow-review constrain --proxy [--net-latency-ms n] [--net-down-kbps n] [--net-up-kbps n] [--port n]
      Runs only the slow-network proxy, printing its URL, until stopped.`;

const OPTIONS = {
  profile: { type: 'string' }, cpu: { type: 'string' }, 'memory-mb': { type: 'string' }, 'disk-latency-ms': { type: 'string' }, 'disk-mb-per-sec': { type: 'string' },
  'net-latency-ms': { type: 'string' }, 'net-down-kbps': { type: 'string' }, 'net-up-kbps': { type: 'string' }, tolerance: { type: 'string' }, 'cpu-mechanism': { type: 'string' },
  summary: { type: 'string' }, print: { type: 'boolean' }, proxy: { type: 'boolean' }, port: { type: 'string' }, help: { type: 'boolean', short: 'h' },
};

/** The settings the options ask for. */
export function settingsFromOptions(o) {
  return resolveSettings(o.profile ?? DEFAULT_PROFILE, {
    cpu: o.cpu, memoryMB: o['memory-mb'],
    disk: { latencyMs: o['disk-latency-ms'], mbPerSec: o['disk-mb-per-sec'] },
    network: { latencyMs: o['net-latency-ms'], downKbps: o['net-down-kbps'], upKbps: o['net-up-kbps'] },
  });
}

export async function constrainMain(argv, { log = console.error, out = console.log } = {}) {
  const dash = argv.indexOf('--');
  const own = dash >= 0 ? argv.slice(0, dash) : argv;
  const [command, ...args] = dash >= 0 ? argv.slice(dash + 1) : [];
  let o;
  let settings;
  try {
    ({ values: o } = parseArgs({ args: own, options: OPTIONS, allowPositionals: false }));
    if (o.help) { out(CONSTRAIN_USAGE); return 0; }
    settings = settingsFromOptions(o);
  } catch (e) {
    log(`flow-review constrain: ${e.message}`);
    return 2;
  }
  if (o.print) {
    try {
      out(JSON.stringify({ ...settings, platform: `${process.platform}-${process.arch}`, cpus: os.availableParallelism(), mechanisms: pickMechanisms(settings, { cpuMechanism: o['cpu-mechanism'] ?? 'auto' }) }, null, 2));
      return 0;
    } catch (e) { log(`flow-review constrain: ${e.message}`); return 2; }
  }
  if (o.proxy) {
    const proxy = await startDelayProxy({ ...settings.network, port: o.port ? Number(o.port) : 0 });
    out(proxy.url);
    await new Promise((resolve) => { for (const s of ['SIGINT', 'SIGTERM']) process.once(s, resolve); });
    await proxy.close();
    return 0;
  }
  if (!command) {
    log('flow-review constrain: put the command to run after --, as in: flow-review constrain -- npm test');
    return 2;
  }
  const tolerance = o.tolerance === undefined ? 0.25 : Number(o.tolerance);
  if (!(tolerance > 0 && tolerance < 1)) { log('flow-review constrain: --tolerance is a fraction between 0 and 1, such as 0.25'); return 2; }
  let run;
  try {
    run = launchConstrained(command, args, { settings, tolerance, cpuMechanism: o['cpu-mechanism'] ?? 'auto', summary: o.summary ?? null, log });
  } catch (e) {
    log(`flow-review constrain: ${e.message}`);
    return 2;
  }
  const forward = (s) => run.stop(s);
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(s, forward);
  const summary = await run.done;
  for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.off(s, forward);
  if (summary.cpu.within === false) return 4;
  if (summary.capsHit.length) return 3;
  if (summary.error && summary.exitCode === null) return 2;
  return summary.exitCode === 0 ? 0 : summary.exitCode ?? 1;
}
