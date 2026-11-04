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

## Where it runs: only on a machine it may slow

`flow-review constrain` starts helper processes, stops and continues a process tree and, on Linux, makes a cgroup with
`sudo`, and DevTools CPU throttling keeps a core busy for every page it slows, so both run only where nobody is
working:

- on a CI runner: `GITHUB_ACTIONS=true` or `CI=true` (GitHub's runners set both);
- on a disposable machine that declares itself a sandbox with `FLOW_REVIEW_CONSTRAIN_SANDBOX=1`, such as a Dev Box, VM
  or container made for the run. Set it in that machine's own environment (a Dev Box's machine-level variables, its
  image or its customization task), never in a shell profile on a computer someone works on.

Anywhere else it refuses with exit code 2 before it starts anything: no proxy, no gate, no command, no summary.
`launchConstrained` throws the same way, checking the environment of the process that calls it, not the one it would
give the command. `--print` starts nothing, so it works anywhere. Throttling the CPU of browser pages (`flow-review run
--constrained`, `constrainPage`, `constrainContext`, `constrainCdp`) is refused the same way, before a browser is
launched or a page is reached. To slow only the network of pages on your own computer, give them a CPU of 1:
`constrainPage(page, settings, { cpu: false })`, or `FLOW_REVIEW_CONSTRAINED='{"profile":"old-windows-laptop","cpu":1}'`.

## It slows the tree it starts, and loads nothing else

- **Only the command's tree is slowed.** The duty cycle signals only the gate's process group and the members of the
  tree it has seen; the Windows job and the Linux cgroup hold only the gate and what it starts. The duty cycle's own
  beat is a thread that sleeps between signals (on its event loop's timers in the constraining process on macOS and
  Linux, on a high-resolution waitable timer in the job's helper on Windows); it never spins.
- **The calibration is a bounded loop in the constrained process.** It is a fixed number of iterations of integer
  arithmetic on one thread, sized to take about 150 ms here, run in the gate, which is the first process of the
  constrained tree, not in a separate load generator. The gate sizes it before the constraint (under a second of one
  core), then times it in pairs, once with the constraint lifted and once under it (three to nine pairs a
  measurement, up to seven measurements when it corrects); and twelve tasks of about 10 ms with the constraint lifted
  and sixteen under it, each sent by the constraining process with an idle gap before it. It never runs on more than one thread, and it ends before the command starts.
- **Nothing it starts outlives the run.** The gate leads a process group (POSIX) or is in a job (Windows, which closes
  the job and every process in it when the run ends) or a cgroup (Linux in CI). When the command ends, when the run
  times out, and when the constraining process exits, the whole tree is killed: the process group, every descendant the
  tree's watch has seen even if it left the group, the cgroup's processes, and the job's. The watch samples the tree
  four times a second, so on macOS (and Linux without the cgroup) a process that leaves the group and whose parent ends
  within a quarter of a second of it starting can escape; the job and the cgroup leave no such gap. If the gate loses
  the constraining process, it kills its own process group. A harness calling `launchConstrained` that is ended by
  `SIGINT`, `SIGTERM` or `SIGHUP` kills the tree first (continuing it if the duty cycle had it stopped), then ends as
  the signal would have ended it, unless it handles that signal itself, as the CLI does to stop the run and report.
- **A hard time limit.** `--timeout-minutes` (default 60; `timeoutMinutes` from code) ends the run when it is reached,
  however far it got: the whole tree is killed, the summary has `timedOut: true` and the exit code is 5.
- **Browser pages are throttled by Chromium itself.** DevTools' CPU throttling holds the page's main thread in a busy
  wait for the slowed share of every moment, so a throttled page keeps about one core busy until it is closed or the
  throttling is lifted, even when idle, which is why it runs only on a CI runner or a declared sandbox. `constrainCdp`'s
  `close()` lifts it from every page it attached to, and so does a `constrainCdp` that fails; close a Playwright page
  or browser throttled with `constrainPage` when you're done with it.

This repository's own tests check the same for every harness here: `test/no-load-generators.test.mjs` fails on any
spawn of `yes`, `stress` or `stress-ng`, and on any endless loop, in the engine, its tests and fixtures, the workflows,
the action and the npm scripts. The only CPU-burning loops it allows are the calibration loops above, each named in the
test and checked to be bounded by its iteration count.

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
| CPU, processes | Enforced: a suspend/resume duty cycle of a job object's processes | Enforced: a cgroup v2 `cpu.max`, with a stop/continue duty cycle under it | Enforced: a stop/continue duty cycle |
| CPU, browser pages | Enforced: DevTools CPU throttling | the same | the same |
| Memory | Enforced: the job's committed-memory limit | Enforced: the cgroup's `memory.max`, with no swap | Detected: the tree's resident memory, sampled 4 times a second |
| Disk | Node processes' `fs` calls | the same | the same |
| Network | A local proxy for anything that honours `HTTP_PROXY`; DevTools for pages | the same | the same |

**CPU.** `flow-review constrain` starts a small gate process, sizes a fixed loop in it, puts it under the constraint
and times the loop in adjacent pairs: once with the constraint lifted (the duty cycle held with the tree running, a
hard cap set to no limit), then once under it. A measurement is three pairs, and more, up to nine, while they scatter
too much for their median to be known to within ±2.5% (a busy computer's pairs scatter). Each lift is answered once it has taken
effect (within 20 ms, as the duty cycle's runs and pauses are cut short for it), and one not answered within 2 s fails
the run. The median of the pairs' factors is the
slowdown achieved on long work. A median is unmoved by a minority of wild pairs, up to one of three or four of nine,
however wild (a pair caught by a moment's load reads 2.9× or 4.8× among 4.0s). They still count in the scatter (the
larger of the pairs' standard deviation and their scaled median absolute deviation), so a measurement with them takes
more pairs. At nine the median is taken however the pairs scatter, and the correction and the ±10% check judge it: a
majority of disturbed pairs moves the median, and a run whose last measurement is outside ±10% doesn't go ahead. Both halves of a pair run on the computer as it is at that moment, so a runner that
slows down for a while (another virtual machine on its host, its own background work) slows both and isn't taken for
the constraint; one baseline taken before the constraint and compared with every later reading took it for exactly
that. Only then does the gate start the command, so the command and everything it starts are constrained from their
first instruction. Then it times short tasks, as an app's clicks, keys and view switches are: twelve of about 10 ms with
the constraint lifted and sixteen under it, in four rounds of three and four so load that comes and goes falls on both
sides, each sent to the gate as a message after an idle gap of 20 to 32 ms and
timed by the constraining process from sending it to the gate's answer. A tree that is stopped when its task arrives
answers late, as a slow computer does, and the timing doesn't depend on the gate's own timers, which wake on a 15.6 ms
tick in a windowless Windows process. The factor is the ratio of the two medians. When long work is more than ±10%
(`--tolerance`) from the profile's, or short tasks more than ±25% (`--burst-tolerance`), the command doesn't run and
the exit code is 4, and the error says what each measured and after how many corrections: an app's interactions are
short tasks, and a constraint that slowed only
long work would read optimistic exactly where it matters. Both factors are in the banner, the summary (`cpu.achieved`,
`cpu.burst.achieved`) and the command's `FLOW_REVIEW_CONSTRAINED` (`tree.achieved`, `tree.burst`).

Every mechanism here slows a short task from its first millisecond. An operating system's hard cap alone doesn't: it
gives the tree its share over a window (Windows' job cap over a window of its own choosing; a cgroup over its period),
so a task that starts after idle runs at full speed until the window's share is spent. Measured on GitHub's runners,
10 ms tasks ran 0.9–1.5× slower under the job cap and 2.7–3.0× under a 10 ms cgroup period while long work ran 4×. So
each hard cap has the duty cycle under it (the summary's `cpu.dutyCycle`): the duty cycle slows every thread from the
moment it runs, and the cap holds work spread over several threads to one slowed core. When the calibration corrects
one, it corrects both.

- Windows: every process in the job is suspended and resumed in turn, running a quarter of every 10 ms, so every
  thread runs 4× slower, as with the duty cycle below. The beat is a high-resolution waitable timer, which wakes within
  a fraction of a millisecond whatever the system's timer resolution, in a helper that opts out of Windows 11's power
  throttling; a plain sleep wakes on the timer's tick, which Windows 11 may keep at 15.6 ms for a process with no
  visible window, and a cycle that coarse would let a 10 ms task run through a whole slice at full speed (the summary's
  `cpu.duty.timer` says which kept the beat). `--cpu-mechanism hard-cap` adds the job's hard CPU-rate cap: a share of
  the whole machine, set so the tree has one core at a quarter of its speed (`10000 / (4 × logical CPUs)` cycles in
  10,000). A single thread runs 4× slower; work spread over several threads is slowed more, because the threads share
  that one slowed core.
- Linux: when `CI=true` and `sudo -n` works (as on GitHub's runners), a cgroup with `cpu.max` of a quarter of one core
  every 10 ms (a longer period above 10×, as the kernel's quota is at least 1 ms), with the duty cycle below under it:
  the same as Windows' hard cap. `--cpu-mechanism hard-cap` asks for it anywhere; `duty-cycle` uses the duty cycle
  alone, and the cgroup, when there is one, then caps memory only.
- macOS, and Linux without the cgroup: the tree is stopped (`SIGSTOP`) and continued (`SIGCONT`) in turn, running a
  quarter of every 10 ms. Every thread runs 4× slower, in parallel, so parallel work isn't slowed more. The beat sleeps
  on its worker thread's timers, not `Atomics.wait`, which on GitHub's macOS runners woke about four times late (a
  2.5 ms wait took about 12 ms, a 7.5 ms one up to 95), so the slices ran long and uneven: a 10 ms task either ran
  through a long slice at full speed or waited out the long pause after it, 5–7× in the median. The cycle
  counts from when each signal has landed, so where security software inspects signals and they land late, the cycle
  grows coarser but keeps its ratio. When a measurement is more than 5% off, the ratio is corrected and measured
  again, up to six times (the summary's `cpu.dutyRatio`; every measurement is in `cpu.calibration`); each correction
  learns from the ones before it how far the factor moves for a change in the ratio, never corrects by more than the
  plain ratio of the factor wanted to the factor measured (a factor that barely moved is taken for noise), and none
  moves it more than 2× either way. The factor reported is the last one measured. A
  tree slowed so far beyond its ratio that the correction would take the ratio below 0.6 of the profile's is losing
  most of each run to being resumed late, as on a virtual machine that wakes a continued process a millisecond or two after the signal; there
  the period doubles instead, up to 40 ms (`cpu.dutyPeriodMs`), so each run outlasts the delay. Longer runs let more of
  a short task through at full speed, which the 10 ms tasks' factor then shows. Processes that
  leave the tree's process group (a browser Playwright launches) are found by parent and signalled one by one, within
  a quarter of a second of starting. If the constraining process is killed outright (`SIGKILL`), it can't clean up:
  the tree may be left stopped, using no CPU; `kill -KILL -<pid>` ends it.
- Browser pages: `Emulation.setCPUThrottlingRate`, as DevTools' CPU throttling. `constrainPage(page, settings,
  { calibrate: true })` measures it too: the loop is timed in the page unthrottled and throttled in turn, five times,
  and the factor is the median of the five pairs (each in `cpu.factors`), so a moment when the computer runs faster or
  slower than usual isn't taken for the slowdown. A page whose processes are already in a constrained tree isn't
  throttled again, so nothing is slowed twice. Chromium slows a page in slices: on Windows it suspends the page's main
  thread for about 165 µs of every 210 (measured about 4.4×); on Linux and macOS a thread signals the main thread
  every 200 µs to busy-wait three times as long as it ran, counting at most 1 ms of running. Linux wakes that thread on
  time (4.1–4.2×). macOS often wakes it 0.3–1.5 ms late, so the pauses after a run of over 1 ms are cut short and the
  page gets more than its share; on GitHub's macOS runners the factor measured 3.5–4.1×, and dips lower for a moment
  when the wake-ups are late for long.

The factor is relative to this computer at the moment it runs: on a busy computer the baseline is slower too. On a
heavily loaded computer, and on Apple silicon, where a process can move between performance and efficiency cores, the
measurement is noisier; a run that misses the tolerance doesn't run its command rather than report a false factor.
On an idle GitHub macOS runner (an Apple M1 virtual machine) the duty cycle's signals land within about 0.1 ms and a
busy process gets 4.0–4.25× at a 10 ms period; Linux is exact. The misses seen there came from the runner's load moving
between a single baseline taken before the constraint and the readings after it (2.5× to 8× on long work, from one
first reading of over 6.7× that doubled the period); the paired timings above cancel it. Windows and Linux runners
measured 3.6–4.2× on both, run after run.

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

In CI, or on a Dev Box made for the run with `FLOW_REVIEW_CONSTRAIN_SANDBOX=1`, run the harness under
`flow-review constrain`, which constrains every process it starts and hands it the settings in
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
the command line does and returns `{ ready, done, stop, lift, restore }`; `startDelayProxy({ latencyMs, downKbps,
upKbps })` is the proxy on its own.

A harness that measures something the calibration can't reach (an app's own web view, say) can pair its timings the
same way: `await run.lift()` lets the whole tree run unconstrained (the controls the calibration lifts: the duty cycle
held with the tree running, a hard cap at no limit), answered once it has taken effect, and `await run.restore()` puts
the constraint back as calibrated, at its corrected ratio, rate or quota. They work only while the command runs, after
`ready` and before `done`, and reject otherwise. Calls run one at a time, in order; lifting a lifted run, or restoring
a constrained one, changes nothing. Every lifted interval is in the summary (`cpu.lifted`, ms from the run's start), so
no timing taken inside one is read as constrained; a run that ends lifted closes its last interval.

## Can't be mistaken for a normal run

- A banner on stderr before the command starts and after it ends, starting `CONSTRAINED COMPUTER (old-windows-laptop)`,
  with the measured factors and the caps hit; in GitHub Actions, a notice on the run too.
- `FLOW_REVIEW_CONSTRAINED` in the command's environment.
- The summary (`--summary <file>`, `flow-review schema constrained`): the profile, the settings and any overrides, the
  achieved CPU factors on long work and on 10 ms tasks, with their baseline and constrained timings, each mechanism and whether it was enforced or detected,
  peak memory, `capsHit`, the proxy's traffic, what let it run here (`sandbox`), its time limit and whether it was
  reached (`timeoutMinutes`, `timedOut`), and how the command ended. `ok` is true only when both slowdowns were within
  tolerance, no cap was hit, the run didn't time out and the command exited 0.
- `flow-review run` under the switch puts `provenance.constrained` in report.json and a line in summary.md.

## Exit codes

The command's own, or: 2 when the switch can't constrain as asked (a usage error, a host that isn't a CI runner or a
declared sandbox, or a mechanism this computer doesn't have; it never falls back to an unconstrained run); 3 when the
tree went over the memory cap; 4 when the measured CPU slowdown, on long work or on 10 ms tasks, was outside the
tolerance, and the command didn't run;
5 when the run went past `--timeout-minutes` and its tree was killed.
