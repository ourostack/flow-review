# Constrained computer

One switch that makes this computer behave like a slow old laptop, as a browser's slow-network mode does for the
network. An app that has to run well on cheap, old Windows machines is measured on one: a run under the switch is
slower on purpose, and its budgets are set for that.

```sh
flow-review constrain -- npm run budgets            # the whole command and everything it starts
flow-review constrain --summary report/constrained.json -- node journeys.mjs
flow-review run flows/*.flow.ts --constrained old-windows-laptop   # only flow-review's pages, through DevTools
FLOW_REVIEW_CONSTRAINED=old-windows-laptop node my-harness.mjs     # any harness that calls constrainPage
```

It isn't part of the review engine: any app or harness can use it, from the command line or from code.

## The `old-windows-laptop` profile

| Resource | Setting | Override |
| --- | --- | --- |
| CPU | 4× slower | `--cpu 4` |
| Memory | 2048 MB for the whole process tree | `--memory-mb 2048` |
| Disk | +4 ms a call, 60 MB/s | `--disk-latency-ms 4 --disk-mb-per-sec 60` |
| Network | +150 ms round trip, 5 Mbps down, 1 Mbps up | `--net-latency-ms 150 --net-down-kbps 5000 --net-up-kbps 1000` |

A few-year-old budget laptop: a dual-core mobile CPU about a quarter of a CI runner core's speed, 4 GB of RAM with half
left for the app, a slow SATA disk and weak Wi-Fi. A CPU of 1, or a 0 anywhere else, turns that part off. The
performance owner sets the budgets a constrained run is held to; this tool only makes the computer slow, and says how
slow it was.

## What is slowed, and how, on each platform

**Enforced** means the operating system holds the process tree to the limit. **Detected** means the tool watches for
the limit and, when the tree passes it, stops the tree and fails the run: the limit can't be exceeded unnoticed, but
the app never feels the pressure of being near it.

| | Windows | Linux in CI | Linux elsewhere, macOS |
| --- | --- | --- | --- |
| CPU, processes | Enforced: a job object's hard CPU-rate cap | Enforced: a cgroup v2 `cpu.max` | Enforced: a stop/continue duty cycle |
| CPU, browser pages | Enforced: DevTools CPU throttling | the same | the same |
| Memory | Enforced: the job's committed-memory limit | Enforced: the cgroup's `memory.max`, with no swap | Detected: the tree's resident memory, sampled 4 times a second |
| Disk | Node processes' `fs` calls | the same | the same |
| Network | A local proxy for anything that honours `HTTP_PROXY`; DevTools for pages | the same | the same |

**CPU.** `flow-review constrain` starts a small gate process, times a fixed loop in it, puts it under the constraint,
times the loop again, and only then has the gate start the command, so the command and everything it starts are
constrained from their first instruction. The two timings are the slowdown achieved; when it is more than ±25%
(`--tolerance`) from the profile's, the command doesn't run and the exit code is 4. The measured factor is in the
banner, the summary and the command's `FLOW_REVIEW_CONSTRAINED`.

- Windows: the job's cap is a share of the whole machine, set so the tree has one core at a quarter of its speed
  (`10000 / (4 × logical CPUs)` cycles in 10,000). A single thread runs 4× slower; work spread over several threads is
  slowed more, because the threads share that one slowed core.
- Linux: when `CI=true` and `sudo -n` works (as on GitHub's runners), a cgroup with `cpu.max` of a quarter of one core:
  the same as Windows. `--cpu-mechanism cgroup` asks for it anywhere; `duty-cycle` refuses it.
- macOS, and Linux without the cgroup: the tree is stopped (`SIGSTOP`) and continued (`SIGCONT`) in turn, running a
  quarter of every 50 ms. Every thread runs 4× slower, in parallel, so parallel work isn't slowed more. Processes that
  leave the tree's process group (a browser Playwright launches) are found by parent and signalled one by one, within
  a quarter of a second of starting. If the constraining process is killed outright, the tree may be left stopped;
  `kill -CONT -<pid>` frees it.
- Browser pages: `Emulation.setCPUThrottlingRate`, as DevTools' CPU throttling. `constrainPage(page, settings,
  { calibrate: true })` measures it too. A page whose processes are already in a constrained tree isn't throttled
  again, so nothing is slowed twice.

The factor is relative to this computer at the moment it runs: on a busy computer the baseline is slower too.

**Memory.** Windows caps the tree's committed memory (private bytes), so an allocation past the cap fails, as it would
on a computer out of memory. Linux caps resident memory and page cache and kills the largest process past it. macOS
can't cap a process tree without root, so the tool samples the tree's resident memory and stops the tree when it is
over. Linux without the cgroup does the same: `RLIMIT_AS` would cap virtual address space, which V8 and Chromium
reserve far beyond what they use, so it would fail healthy apps. A run over the cap exits 3 and lists `memory` in the
summary's `capsHit`.

**Disk.** A preload added to `NODE_OPTIONS` (`--import`) makes each call through Node's `fs`, `fs/promises` and
`fs.promises` wait as a slow disk would: one disk serves the process's calls in turn, each taking the latency plus its
bytes at the throughput. Callbacks and promises arrive that much later; synchronous calls block for it. Streams are
slowed, as they read and write through `fs.read` and `fs.write`. Not slowed: processes that aren't Node (a browser, a
.NET or native service), `FileHandle` methods, native addons, Electron processes that ignore `NODE_OPTIONS`, and Node's
module loading wherever it bypasses these functions. Operating-system disk throttling needs administrator rights on
every platform (a Linux cgroup's `io.max` is the closest), so the tool doesn't attempt it.

**Network.** A local proxy is started for the run, and `HTTP_PROXY`, `HTTPS_PROXY` and `NODE_USE_ENV_PROXY=1` point
the command at it; `NO_PROXY` keeps this computer's own addresses direct, so an app's local services stay fast. Every
byte waits half the round trip in each direction, and each direction is one shared link at the given throughput. HTTPS
passes through `CONNECT` tunnels unread, after a round trip to connect. Only clients that honour the proxy variables
are slowed: curl, Node's `fetch` and `http` with `NODE_USE_ENV_PROXY`, most CLIs. Browsers usually don't; their pages
are slowed through DevTools' `Network.emulateNetworkConditions` instead (responses a test fulfils itself, with routes,
may skip it). WebView2 can also be pointed at the proxy with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--proxy-server=<url>`
when DevTools isn't attached. `flow-review constrain --proxy` runs the proxy alone.

## Turning it on in a harness

Run the harness under `flow-review constrain`, which constrains every process it starts and hands it the settings in
`FLOW_REVIEW_CONSTRAINED` (JSON: the profile, the settings, the proxy, and in `tree` the mechanisms and the measured
factor). The harness then constrains its browser pages and records the run as constrained:

```js
import { constrainedFromEnv, constrainPage, constrainCdp } from '@ourostack/flow-review';

const constrained = constrainedFromEnv(); // null when the switch is off
if (constrained) {
  await constrainPage(page, constrained); // a Playwright Chromium page: network, and CPU unless its tree is throttled
  const webview = await constrainCdp('http://127.0.0.1:9222', constrained); // any Chromium or WebView2 on a debugging port
  report.constrained = constrained; // so a budget result can't be mistaken for a normal run's
}
```

`FLOW_REVIEW_CONSTRAINED=old-windows-laptop` (a profile name) turns on the page side alone, for a harness not run
under `flow-review constrain`. From code, `launchConstrained(command, args, { profile, overrides, summary })` does what
the command line does and returns `{ ready, done, stop }`; `startDelayProxy({ latencyMs, downKbps, upKbps })` is the
proxy on its own.

## Can't be mistaken for a normal run

- A banner on stderr before the command starts and after it ends, starting `CONSTRAINED COMPUTER (old-windows-laptop)`,
  with the measured factor and the caps hit; in GitHub Actions, a notice on the run too.
- `FLOW_REVIEW_CONSTRAINED` in the command's environment.
- The summary (`--summary <file>`, `flow-review schema constrained`): the profile, the settings and any overrides, the
  achieved CPU factor and its baseline and constrained timings, each mechanism and whether it was enforced or detected,
  peak memory, `capsHit`, the proxy's traffic, and how the command ended. `ok` is true only when the slowdown was
  within tolerance, no cap was hit and the command exited 0.
- `flow-review run` under the switch puts `provenance.constrained` in report.json and a line in summary.md.

## Exit codes

The command's own, or: 2 when the switch can't constrain as asked (a usage error, or a mechanism this computer doesn't
have; it never falls back to an unconstrained run); 3 when the tree went over the memory cap; 4 when the measured CPU
slowdown was outside the tolerance, and the command didn't run.
