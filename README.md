# flow-review

Deterministic review of user and agent flows. A repository declares its flows in `flows/`; flow-review runs each one across a matrix of browser engines, viewports, themes and reduced motion, measures it with fixed checks, and writes JSON with a small cropped picture for every failure. Agents judge only what measurement can't decide, from packets the run prepares.

It runs locally and in CI, and every check is also a plain function another repository can use as its own conformance test.

## Run it

Node 22.18 or newer. From the product repository:

```sh
npm install --save-dev github:ourostack/flow-review#v0.6.0 && npx playwright install --only-shell chromium
npx flow-review run                  # flows/**/*.flow.{ts,json}
npx flow-review run 'flows/site/*.flow.ts' --only axe,contrast --fail-on none
```

In CI, use the action instead ([In CI](#in-ci)): it installs everything itself.

| Command | Does |
| --- | --- |
| `run [globs] --out report --shard k/n --engine <engines> --fail-on any\|none\|<checks> --only <checks> --times <file> --workers n` | Runs flows on each engine ([Engines](#engines)). Exit 1 when a check named by `--fail-on` (or the flow's own `failOn`) fails (default `any`). |
| `list [globs] --shard k/n --times <file>` | Prints how shards split the units, without running. |
| `merge <report dirs> --out report --flows <glob> --engine <engines> --coverage gated\|strict` | Combines shard reports. Exit 3 when a gated unit didn't run exactly once ([Coverage](#coverage-cancelled-shards-and-advisory-flows)). |
| `times <report dirs> --out flows/flow-review-times.json` | Records each unit's time, so the next run's shards balance by time. |
| `judge --merge <answer.json> --report report` | Validates judges' rubric answers and folds them into `report.json`. |
| `schema flow\|report\|finding\|rubric` | Prints a published JSON Schema. |
| `validate [globs]` | Loads and checks flow files. |

`FLOW_REVIEW_CHROMIUM` points at another Chromium build; `FLOW_REVIEW_CHANNEL=chrome` uses installed Chrome; `FLOW_REVIEW_WEBKIT` points at another WebKit build. `--evidence-max` caps the bytes of pictures a run keeps ([Output](#output)).

**No visible browser outside CI.** Every browser flow-review launches is headless, so a run never shows a window, shows a Dock or taskbar icon, or takes focus on the machine someone is working on. A request for a visible browser (`--headed`, or `PWDEBUG` set for Playwright's inspector, which launches every browser headful) is allowed only where `CI=true`. Anywhere else the run is refused before anything starts: exit 2, with an error naming the setting. flow-review never falls back to a visible window. A `cdp` flow connects to a browser that is already running and launches none; whatever `app.start` runs is the app's own command. Your own tests can hold the same rule with `launchBrowser(chromium, options)`, which launches headless by default and throws outside CI on `headless: false`, `devtools`, `--headed`, `ignoreDefaultArgs` that drops `--headless`, or Playwright's inspector (`PWDEBUG`), or with `assertHeadless(options)`, which only checks the options.

## A flow

New to flows? [How to write a flow](docs/writing-a-flow.md) walks through a first flow and the mistakes that make runs flaky.

`flows/site/read-plan.flow.ts`:

```ts
import { defineFlow } from "@ourostack/flow-review";

export default defineFlow({
  name: "Site: read the live plan",
  surface: "web",
  app: { start: "node site/server.mjs --port 5290", url: "http://127.0.0.1:5290/" },
  matrix: { viewports: ["390x844", "1440x900", "3840x2160"], themes: ["light", "dark"], reducedMotion: [true] },
  fixtures: { route: { "**/plan.json": "fixtures/plan.json", "**/plan-meta.json": { status: 404 } } },
  steps: [
    { goto: "/" },
    { waitFor: { role: "region", name: /Live plan/ } },
    { capture: { moment: "first screen" } },
    { act: { role: "button", name: "First item", verb: "click" }, expect: { role: "dialog" } },
    { capture: { moment: "item", region: { role: "dialog" } } },
    { tabTraverse: true },
    { goto: "/", route: { "**/plan.json": { status: 500 } }, state: "error" },
  ],
  checks: { thresholds: { deadSpace: 0.3 }, designSystem: { marker: "[data-ouro], [data-ouro-control]" } },
  rubric: ["craft"],
});
```

The flow file needs nothing installed: flow-review resolves `@ourostack/flow-review` itself. A `.flow.json` holds the same object (`"schema": "flow-review/0"`), checked by `flow-review schema flow`.

- **`surface`:** `web` launches `app.start` (a shell command, from the working directory) and waits for `app.ready` (default `app.url`) to answer. `cdp` attaches to a running browser, Electron app or WebView at `app.cdpUrl`. `agent-cli` runs commands and `agent-http` sends requests.
- **Steps, web and cdp:** `goto`, `act: { role, name, verb: click|press|type|hover|focus|hold, key?, text? }`, `waitFor`, `capture: { moment, region? }`, `tabTraverse`, `setTheme`, `resize`, `scroll: { to: top|bottom } | { target } | { wheel, times?, intervalMs?, target? }` (wheel: real wheel input, [Engines](#engines)). Targets are found by role and accessible name first, `text` next, and a CSS `selector` last. Any step may carry `expect` (role, text, url, focus, count), `state` (`empty`, `error`, `loading`) and `route` (fixtures on top of the flow's own). A `goto`'s routes stay in force until the next `goto` or the end of the flow, so they answer what the page asks for just after it loads; any other step's last for that step only.
- **Holding a key:** `act: { verb: "hold", key, ms?, during?: [steps] }` presses `key` and keeps it down (on the target, focused first, when the act names one), waits `ms` (default 0), takes the `during` steps, then lets it go, whatever those steps did. A `capture` among them runs its checks on the page as it is while the key is down, and a `waitFor` there can wait for the held state to show. The hold's own `expect` is checked once the key is up, so it can say what comes back. Steps inside a hold are named after it (`compare.1-waitFor`, or `4-act.1-waitFor` for a hold without an `id`) unless they have an `id` or are a capture.

  ```ts
  { id: "compare", act: { verb: "hold", key: "\\", during: [
      { waitFor: { selector: "[data-comparing]" } },
      { capture: { moment: "held: your own style" } },
    ] }, expect: { text: "Showing the try." } },
  ```
- **Steps, agent:** `{ run: [argv] }`, `{ request: { method, path, body } }` or `{ harness: { path, body } }` (a call to a mock's control port, `app.controlUrl`). Run and request steps take `expect: { exit, status, jsonShape, fields, stdoutRules, stderrRules, text, maxMs, maxBytes }`.
  - `exit` is a code or a list of codes.
  - `jsonShape` is either a JSON Schema or a list of paths that must be present. A path can be `a.b`, `a[0]`, `a[-1]`, `a[].b` (every element), `a[subject~^Weekly].id` (the elements whose field matches) or `a.length`.
  - `fields` maps paths to a value, or to `{ re, oneOf, type, exists, gte, lte }`.
  - `stderrRules` is either `mustMatch`/`mustNotMatch` regexes or named rules: `empty`, `oneLine`, `namesFix` (`Fix: ` or one of `app.cliNames` followed by a word) and `noStack`.
  - `save: { name: path }` keeps a value for later steps' `{name}`, `fix` names the fix, and `known: "#123"` marks a known defect.
  - `app.cli` is the command every `run` follows, such as `["node", "${target}"]`. With `readOnly: true`, `app.stateProbe`'s output must stay the same.
  - A request step's `exit` is its HTTP status when `status` isn't given.
  - A flow's `known` may use another runner's check names, mapped in the config's `checkAliases` (`{ "reads-stay-reads": "readOnly", "stderr": "stderrRules" }`; a dotted name also matches by what comes before the dot).

  A product can type its agent flows with its own definitions and extra fields: `test/fixtures/ax/` runs a flow written against its own `define.ts`, unchanged, on a stand-in mock and CLI.
- **Matrix:** each engine × viewport × theme × reduced-motion combination is a cell (engines come from the run's `--engine`, less any the flow's `matrix.engines` leaves out: [Engines](#engines)). Themes come from `prefers-color-scheme`, or from the flow's own `themeSteps` (`matrix.themeVia: "steps"`), for an app with its own toggle.
- **Fixtures:** `fixtures.route` answers matching requests from a file, `json`, `body` or `status`, for the whole flow. A step's `route` adds to them: a `goto`'s until the next `goto` or the end of the flow, any other step's for that step only (a step inside a hold or the theme steps adds its own on top of the outer step's). The most specific scope answers first: the step's routes, then the `goto`'s, then the flow's, and within each the first pattern that matches. A step's route that no request matched before then is an `unusedRoute` finding, which is advisory: it never fails the run. Requests to other origins are aborted (`app.blockExternal: false` allows them), so runs don't depend on the network.
- **After a goto:** `app.readyAfterGoto` says what a `goto` waits for once the page has navigated: `"load"` (the default), `"domcontentloaded"`, `"networkidle"`, or a target such as `{ "selector": "#plan", "ms": 10000 }` (a `role` with its `name`, `text` or `selector`, and `ms`, default 15000; a longer `ms` lengthens the goto's step and cell limits to match). `networkidle` is opt-in. It waits up to 3 s and never comes while the page holds a stream open (live updates read through `fetch`, for example), so it would cost those 3 s on every goto. Whatever the choice, every goto, `waitFor`, act and capture then waits for fonts, the images on screen and running animations, plus two frames, so no layout shift is pending. A page that fills in after load (data it fetches) is caught by the flow's next `waitFor` or a declared `state`, or by a target here.
- **Time limits:** `timeouts: { cellMs, stepMs }`. A cell (one matrix cell, or an agent flow's one unit) may take `cellMs` (default 120000, or the flow's longest `waitFor.ms` or step `timeoutMs`, counting a hold's `ms` and the steps it holds the key for, and 30 s more when that is longer and no `cellMs` is set), counted once its app is up (`app.readyTimeoutMs` bounds the start). Past it, the engine stops the cell: it closes its page (a `cdp` browser is only disconnected), kills its running command, and stops its app when the app is the flow's own (`scope: "flow"`) or no longer answers its ready URL, so the next cell starts it afresh. A `timeout` finding names the step it was on, that step's target and the time, and the run goes on with the next cell, so a shard always finishes and writes its report. A step may take `stepMs` (default 60000): a `goto`, `act` or `waitFor` that hangs fails that step, naming its target in `selector`. A `waitFor` with a longer `ms` gets that `ms` and 5 s more (a hold's `ms` likewise, for pressing the key; each step it holds the key for has its own limit), and an agent step's own `timeoutMs` wins. A flow's `timeouts` go over its config's.
- **What fails it:** `failOn` (`any`, `none` or a comma list of checks) takes the place of `--fail-on` for this flow. A flow failing on `none` is advisory ([Coverage](#coverage-cancelled-shards-and-advisory-flows)).

## Placeholders and the config file

A flow without its own `app` takes its surface's `app` and `vars` from the nearest `flow-review.config.json` above it (or `--config`). Many flows then share one mock and one way to run the CLI:

```json
{
  "schema": "flow-review-config/0",
  "surfaces": {
    "agent-cli": {
      "app": {
        "start": "node scripts/mock-server.mjs ${workdir}/daemon-home",
        "ready": "stdout-json",
        "guard": ["node", "scripts/check-mock.mjs", "${start.agent}"],
        "target": "bin/inbox.mjs",
        "cli": ["node", "${target}"],
        "env": { "INBOX_URL": "${start.agent}", "INBOX_AGENT": "${flow.agent:-flow-review}", "INBOX_HOME": "${workdir}/cli-home" },
        "controlUrl": "${start.control}",
        "stateProbe": ["log", "--json"],
        "help": ["--help"]
      },
      "vars": { "home": "${workdir}/cli-home" }
    }
  }
}
```

The placeholders are:

- `${target}`: the run's target.
- `${workdir}`: a scratch folder under `report/`, removed at the end.
- `${flow.<field>:-default}`: a field of the flow.
- `${start.<field>}`: a field of the JSON line the app prints when `ready` is `"stdout-json"`, for ports it picks itself.

`{name}` in a step comes from `vars` and from earlier steps' `save`.

The config may also set `timeouts` and `failOn`, at its top level or per surface (`surfaces.web.failOn`), for every flow under it. A flow's own win, then its surface's, then the config's; without any, `--fail-on` and the default time limits apply.

Agent flows run one at a time, in file order, so flows that share one mock see each other's writes in a fixed order. `app.scope: "flow"` gives each flow a fresh app instead. `app.guard` runs once the app is up and must exit 0. `app.files` are written before it starts. With `app.help`, the `listed` check fails when a command the flow runs successfully isn't in the CLI's top-level help.

## Gate a release candidate

The same flows run against a dev server, a pull request's build or a packaged candidate. The flow says where the target goes: `${target}` in `app.start`, `app.cdpUrl`, `app.cli` or a step's argv. The run says what it is:

```sh
flow-review run 'flows/agent/**/*.flow.ts' --target dist/inbox-1.3.0/bin/inbox.mjs --target-version 1.3.0 --fail-on any
```

- `--target` (or `FLOW_REVIEW_TARGET`, or the flow's own `app.target` as a default) fills every `${target}`. A flow that uses `${target}` without one stops with exit 2.
- `report.json`'s `provenance` records the target (its path or URL, `--target-version`, a file's sha256 or a folder's package version), the engine's version, Node, the repository's commit, `--fail-on` and `retries: 0`. flow-review never retries a step or a check.
- `--fail-on any` exits 1 on any failing check, except one marked `known` (a step's `known: "#123"`, or a flow's `known: { check: "#123" }`). Those are reported, and a known defect that passes again is a failing `known` finding, so the mark gets removed.
- `--slack 2` doubles every `maxMs`, for a slow machine, and is recorded.
- The action takes `target`, `target-version` and `slack`, so a release workflow can call it after building a candidate.

## Engines

People see a product through their own browser engine, and a page smooth on one can stall on another: a list that waits on its wheel listener only where the browser can't yield to rendering is smooth in Chromium and stuck in Safari. Every flow-review run that judges what people see should run on the engines the product ships on.

`--engine` (the action's `engine`, or `FLOW_REVIEW_ENGINE`) names them, as one more matrix dimension; the default is `chromium`:

| Engine | What it is | What it stands for |
| --- | --- | --- |
| `chromium` | Playwright's Chromium (headless shell) | Chrome; Chromium-based shells |
| `webkit` | Playwright's WebKit | Safari, and WKWebView in a Mac or iOS app |
| `msedge` | the installed Microsoft Edge (Playwright's `msedge` channel) | Edge, and WebView2 in a Windows app |

```sh
npx playwright install --only-shell chromium && npx playwright install --with-deps webkit
npx flow-review run --engine chromium,webkit,msedge
```

- **Keys.** A cell's key ends `@<engine>` (`flows/a.flow.ts#390x844-light-rm@webkit`), except on Chromium, whose keys are as they were before engines, so recorded times and earlier reports still match. Every finding's `cell` names its `engine`, so findings, evidence and states are keyed by engine.
- **Reports.** `report.json`'s `engines` has each engine's units, failures, findings by check, `gaps` (below) and `notRun`; each table row's `byEngine` has that flow's results per engine, and `provenance.browsers` each browser's version. The summary puts the engines side by side when a run has more than Chromium.
- **Sharding and merging.** Shards split all cells, every engine's together; or give each job its own engine (`engine: webkit` on a Mac runner, `engine: msedge` on a Windows one) and merge them with every engine named: `merge --engine chromium,webkit,msedge`. Name them: an engine whose every shard was cancelled left no report to say it was expected.
- **Leaving an engine out.** A flow's `matrix.engines` lists the engines it may run on. A `cdp` flow attaches over the DevTools protocol, so it runs on `chromium` and `msedge` only (point `app.cdpUrl` at the WebView2 or Edge the cell names). What a run names that a flow leaves out is listed in `engines.<engine>.notRun` and the summary, never dropped quietly.
- **A few cells on an engine.** An engine that stands in for one Chromium already covers (Edge for WebView2, say) can run fewer cells: `"engines": { "msedge": { "cells": ["1280x800-light"] } }` in `flow-review.config.json` runs each flow on msedge only in the named cells (`viewport-theme`, `-rm` for reduced motion). The cells left out are in `engines.msedge.notRun` (with `cells`) and the summary; `list` and `merge` count units the same way.
- **An engine that can't launch** (Edge not installed, say) fails each of its cells with the reason; the other engines' cells still run.
- **Wheel input.** `{ scroll: { wheel: 120, times: 10, intervalMs: 50, target } }` turns the mouse wheel over the target (or the middle of the view) as a person does, on every engine, so a page's own wheel listeners run and the `jank` check judges the frames while it scrolls.

### Known-failing cells

Turning on an engine shows what already fails there. Those are bugs, not cells to skip: list each in `flows/flow-review-known-failing.json` (or `--known-failing <file>`, the action's `known-failing`), with its issue and owner, in the shape the basics gate and window tests share:

```json
{ "about": "Cells that fail on an engine today. The list only shrinks.",
  "entries": [{ "case": "flows/app/scroll.flow.ts", "legs": ["webkit"], "issue": "#1823", "owner": "Chat scrolling (lane)", "why": "dead input scrolling a long channel" }] }
```

- `case` is a flow file (every cell of that flow) or `<file>:<cell name>` (`flows/app/scroll.flow.ts:390x844-light-rm`), split at the first `.flow.<ext>:`; `legs` are engines. `enforce` (default true) false makes what comes off advisory.
- A listed cell's failing findings carry `known` (the issue) and `knownCase`, and never fail the run. Every other failure still does.
- An unsharded run without `--cells` or `--only`, and a merge, judge each listed case on each leg the run names (`knownFailing.notJudged` lists the others): one whose cells no longer fail, or that no longer runs, is a failing `known` finding, so its entry comes off in the pull request that fixes it. (A cell a cancelled shard left missing is a coverage finding instead.) Put `known` in `--fail-on` to fail on it. `report.json`'s `knownFailing` and the summary say which still fail and which come off.
- `flow-review known-failing --check <file> --base <base branch's file>` fails when the list grew: it only shrinks. Nothing is skipped and no limit loosened.

Every check runs on every engine and means the same there. Where WebKit lacks what Chromium measures with, flow-review measures another way, never more loosely, and says so: the `method` on the finding, and `engines.webkit.gaps` in the report.

| Check | WebKit lacks | flow-review on WebKit |
| --- | --- | --- |
| `cls` | the Layout Instability API (`layout-shift` entries) | After anything that can move content (a DOM change, a load, a resize, a font, a running transition or animation), each frame reads where the content in view is (every element whose box meets the view, up to 1500, and a grid of hit tests; the reading costs the main thread a little each such frame) and scores what moved as the API scores a shift: the share of the view the moved elements cover, before and after, times the furthest move over the view's longer side. An element counts as moved when it moved 3 px or more on screen and in layout, so a transform or a scroll isn't a shift; shifts within 500 ms of a key or pointer press are left out, as `hadRecentInput` does. `method: "sampled"` (Chromium: `"layout-shift"`). A shift in the same frame as a scroll isn't seen |
| `jank` (long tasks) | the Long Tasks API | A timer due every 16 ms runs late by as long as the main thread was held; the lateness, plus 16 ms (an upper bound), is the long task. `method: "timer, …"` (Chromium: `"longtask"`) |
| `jank` (slow frames) | Long Animation Frames | A slow frame can't be told apart as waiting on raster, so every frame over `frameMs` counts: stricter than Chromium, never looser. `method` says `no raster split` |
| `keyboard`, `focusVisible` | Tab to every item: WebKit, as Safari and WKWebView ship, moves Tab only between text fields and lists unless the Mac's Keyboard navigation setting is on | Traversals press Option-Tab (`Alt+Tab`), which reaches every item as Tab does in Chromium; a flow step pressing `Tab` or `Shift+Tab` is pressed with Option too |
| constrained mode | the DevTools protocol, which throttles pages' CPU and network | A constrained run on WebKit needs `flow-review constrain` around it, which slows the whole process tree; without it the run is refused (exit 2) rather than run at full speed under a constrained banner |
| `cdp` flows | the DevTools protocol | They run on `chromium` and `msedge` only, listed in `engines.webkit.notRun` |
| `duoBytes` | resource-timing sizes for some responses (one a route answered, say) | An asset fetched with no size is read again from the cache and its body counted (`method` says so), never counted as 0 bytes |
| `errors` | (Playwright puts a style sheet in the page for each WebKit screenshot, which a strict `style-src` refuses) | That one console error is left out while flow-review's own screenshot is being taken; the page's own refused styles still fail. A request the page gave up is `cancelled` in WebKit (`net::ERR_ABORTED` in Chromium) and isn't a failure on either. `states` knows WebKit's stack lines (`fn@url:line:col`) as raw errors, as it knows Chromium's |
| evidence | WebP encoding in a canvas | Crops and moments are PNG, scaled down until they fit the size cap |

`axe`, `contrast`, `targetSize`, `overflow`, `deadSpace`, `repetition`, `designSystem`, `proofNotice`, `states`, `errors` and the duo's checks are the page's own DOM, styles and pixels, and measure the same on every engine. Frame times come from `requestAnimationFrame` and input times from each event's `timeStamp`, both on `performance.now()`'s clock on every engine, so an in-page frame meter reads the same everywhere; CI runs the whole test suite on Chromium and on WebKit, and a fixture list that stalls each wheel only on WebKit, which must fail there and pass on Chromium.

## Checks

Checks run at every `capture` and at the end of the flow. Keyboard and focus run at each `tabTraverse`, or at the end when a flow has none. `states` runs after every step that declares one. Every threshold is the flow's to set, in `checks.thresholds`.

| Check | Fails when | Threshold (default) |
| --- | --- | --- |
| `axe` | axe-core finds a WCAG 2.2 A/AA or best-practice violation (contrast and target size have their own checks). Focus guards (Base UI, Floating UI, Radix, `data-focus-guard`, and `checks.focusGuards`) are left out: they are hidden and focusable on purpose. The `region` rule counts each open popup layer or portal root (menus, listboxes, dialogs, tooltips, `[popover]`, Base UI and Radix portals, and `checks.popupLayers`) as a region of its own, since they render outside the landmarks by design; other content outside a landmark still fails | `axeImpact` (`minor`) |
| `keyboard` | Tab doesn't reach an interactive element, or focus is trapped (inside an open modal, only its contents count). In a composite widget (a listbox, grid, tree, toolbar, menu, tab list, an `aria-activedescendant` container, or items at any depth inside one container that rove one `tabindex="0"`, such as a thread's first post and its nested replies), an element inside another item counts as reached when arrowing there (Home, then Down or Right) and pressing Tab reaches it; the check drives it. An open combobox may take one Tab to accept its suggestion. A control the traversal itself removes isn't missing, and one Tab skipped while it was briefly disabled counts when a second Tab cycle reaches it. A dialog is modal when it is a `showModal()` `<dialog>`, has `aria-modal="true"`, or hides the page behind it (aria-hidden or inert); a toast or other non-modal dialog doesn't scope the checks | — |
| `focusVisible` | a focused element shows no outline, ring or other visible change (computed style, then a pixel diff) | — |
| `contrast` | text falls under its ratio (axe), or an icon-only control's glyph, at the opacity it is drawn with (its own and its wrappers'), falls under the UI ratio against what it is drawn on (its nearest painted ancestor, such as a badge's disc). Both are measured on what the page rests at: once fonts are in and animations and transitions running toward an end have finished (up to 3 s; an endless one isn't waited for), and again, up to three times, when something started moving during the measurement | `contrastText` (4.5), `contrastUi` (3) |
| `targetSize` | a pointer target is under the size on a side, outside WCAG 2.5.8's inline, spacing and user-agent exceptions. A small target is measured by its real hit area: its box and line boxes plus any `::before` or `::after` stretched over an ancestor (the stretched-link pattern) or descendant reaching past it, confirmed by hit-testing: it needs a min × min square of pixels whose centres the browser's hit test gives to it (good to about a pixel, since hit testing snaps edges); the finding reports that hit area | `targetPx` (24) |
| `overflow` | the page scrolls sideways, or a box hides part of its text. An ellipsis or line clamp passes as deliberate when the words it hides are in the accessible name, a tooltip (`title`) or the dialog the control opens shows them, and it still shows the share of its words; text a nested box clips is that box's finding only. Text in a collapsed disclosure isn't cut off: inside a closed `<details>`, a `hidden` or `inert` region, an element with `aria-expanded="false"` (except a control that opens something else, such as a menu button or combobox, whose own text stays on screen), or a box a visible control with `aria-expanded="false"` names in `aria-controls` (a "See more" fold). A fold with no control to open it still counts | `overflowPx` (1), `truncationMinShown` (0.5), `allowTruncation` (false: true accepts every clamp) |
| `deadSpace` | a section's largest empty rectangle is over its share of the section (`main section[id], [data-section]`, or the open modal) | `deadSpace` (0.25) |
| `repetition` | a sentence of the length or more appears more than the count | `repetitionMinChars` (40), `repetitionMax` (2) |
| `cls` | the largest layout-shift session window is over the score | `clsMax` (0.1) |
| `jank` | a long task is over the time, or too many frames are slow while things move (steps, scrolling). A frame is slow when it takes over `frameMs` plus 1 ms (frame times come in whole vsyncs). Where the browser reports long animation frames, a slow frame they cover that shows little main-thread work (scripts, style, layout and paint under `frameMs`, nothing blocking) waited on raster and compositing, which headless Chromium does in software: it is reported as `rasterBound` and doesn't count. A share is judged once a window holds enough frames that no single frame decides it (`jankMinFrames`, default twice 1 / `slowFrameShare`); a click's few frames are its response, which the long-task measure judges | `longTaskMs` (200), `frameMs` (33), `slowFrameShare` (0.1), `jankMinFrames` (20) |
| `designSystem` | an interactive element lacks the design system's marker on itself or close ancestors | `checks.designSystem: { marker, depth: 2 }` |
| `proofNotice` | a picture inside a proof element has no notice (description, figcaption or notice element) | `checks.proofNotice: { proof: "[data-proof]", notice, minChars: 10 }` |
| `states` | a declared state shows too few words, or a raw error (a stack, `undefined`, `TypeError`, an HTTP code) | `stateMinChars` (20) |
| `errors` | the page logs an error or a request fails, except routed failures and `checks.allowErrors`. A Content-Security-Policy violation counts; the engine's own rules (hit-testing the duo's art, hiding words to sample the pixels behind them) go in a constructed style sheet, which a strict `style-src` allows, so they never cause one | — |
| `duoOverlap` | duo art gets in the way. It paints above a control or the words of a text block (hit tests at each one's centre and four inset corners, with the art made hit-testable), or takes the pointer over a control. Words over it read below their contrast on the real pixels behind them (the worst tenth). Or it appears, animates or moves in the working path (the focused element and its form, editor or dialog) during an `act`. Text that isn't painted isn't content: the screen-reader-only pattern (a clip or clip-path leaving an empty or 1 px box, or a box 1 px or less across that hides its overflow), opacity 0 and visibility hidden | `contrastText` (4.5), `contrastLarge` (3) |
| `duoReducedMotion` | under reduced motion, duo art still animates, plays or autoplays video, or shows an animated image | — |
| `duoBytes` | the duo assets a page fetched (what its art references, and `checks.duo.assets`) are over the budget | `duoBytes` (150 KB) |
| `celebrationCap` | a `[data-celebrate]` element comes into view more often than the cap in one flow | `celebrationMax` (1) |
| `quietMode` | after the flow's `checks.duo.quietSteps` and a reload, a duo or `[data-duo-quiet]` element is still shown, or a duo asset is fetched | — |
| `exit`, `status`, `jsonShape`, `fields`, `stdoutRules`, `stderrRules`, `text`, `maxMs`, `maxBytes` | the agent step's expectation isn't met | per step |
| `readOnly` | a `readOnly` flow changed what `app.stateProbe` prints | — |
| `listed` | a command the flow runs to success isn't in the CLI's top-level help (`app.help`) | — |
| `known` | a step marked `known` passes now: remove the mark | — |
| `step` | a step can't be done (its target isn't there, or it ran past `timeouts.stepMs`). It fails whatever checks `--fail-on` names | `timeouts.stepMs` (60000) |
| `timeout` | a cell ran past its time limit and was stopped. Like `step`, it fails whatever checks `--fail-on` names | `timeouts.cellMs` (120000) |
| `unusedRoute` | advisory, never fails the run: a step's `route` matched no request before its routes ended (a `goto`'s at the next `goto` or the end of the flow; another step's at the next step). The finding names the step and the pattern | — |
| `coverage` | merge only: a unit didn't run (its shard was cancelled or wrote no report), ran twice, or, in an advisory flow, timed out. A gated unit's fails the merge (exit 3); an advisory one's doesn't | — |

`checks.only` and `checks.skip` choose checks per flow; `checks.ignore` is a selector every check leaves out.

The duo's markers are `checks.duo: { art: "[data-duo]", quiet: "[data-duo-quiet]", celebrate: "[data-celebrate]", assets, quietSteps }`. Scene art that fades behind text is fine: it fails only when it paints above content, takes the pointer, makes words unreadable or moves where the person is working.

## Moments

At every capture, after every `act` and at each declared `state`, the run notes every empty, loading, error, first-run and success state on screen:

- `data-state`, `aria-busy`, progress bars and alerts;
- status lines whose words say so (loading, error, empty: never success, since a line saying "Updated" or "Saved" is often standing information);
- lists, tables and grids with nothing in them;
- declared `state`s, which name their element's kind outright.

Each one also records whether it holds its Moment: `[data-moment="<kind>"]`, or `checks.moments.marker`.

`report.json`'s `moments[]` lists each as `{ flow, step, cell, kind, selector, hasMoment }`. `flow-review moments [report] --missing --json` lists the states without one, one per flow, kind and element, each with a stable `moment-key: <flow>/<kind>/<selector-hash>` a tracker can deduplicate on. Framework-generated ids (React's, Radix's, Base UI's) are never part of a selector.

## Output

`report/`:

- `report.json` (`flow-review-report/0`): the summary (counts per check, human and agent sides), a table per flow, every unit with its time, key moments, `attachments[]` (external reports such as an Ouro AX X-ray), judges' answers and timing.
- `findings.jsonl`: one finding a line, `{ flow, step, surface, cell, check, pass, measured, threshold, selector, label, evidence, fix, method, ms }`. `cell` is `{ viewport, theme, reducedMotion, engine }`, or null on the agent side; `method` says how the engine measured a check where engines differ ([Engines](#engines)).
- `evidence/`: a crop around each failing element with a red box, PNG or WebP under 300 KB (at most 3 per check per capture, 40 per unit).
- `moments/`: the pictures of the captures a judge packet names, WebP, at most 1600 px wide. `report.json`'s `captures[]` lists every capture, with its `crop` only when it kept the picture.
- **The evidence cap.** A run (a shard) keeps pictures only for failing findings and for the key moments its judge packets name; a passing check has none, and a flow without a rubric keeps no moments. They are kept in that order, failing findings' crops first, up to `--evidence-max` bytes (default 1 MB; also `FLOW_REVIEW_EVIDENCE_MAX` or the action's `evidence-max`; `none` for no cap). `report.json`'s `evidence` records what was kept (`bytes`, `files`), what the cap dropped (`dropped: { evidence, moments, bytes }`) and how many captures no packet named (`unjudgedMoments`). A merge adds up its shards' and lists each in `shards[]`. The summary and the action warn when the cap dropped anything. This keeps shard artifacts small, so a merge downloads them quickly.
- `judge-packet-<rubric>.json`: per rubric the flows name, the measurements, failing checks with crops and up to 24 key moments. A judge answers with `{ judge, verdict: "approve" | "not yet", moments: [{ step, cell, crop, observation, fix }] }` and never browses; `flow-review judge --merge` rejects an answer that names a step or crop the report doesn't have.
- `summary.md`: the markdown table CI shows.

## In CI

To let some checks block merges and keep the rest advisory, including without admin rights on the repository, see [Gating merges](docs/gating.md).

The action (`action.yml`, `uses: ourostack/flow-review@<tag or commit>`) installs flow-review and the browsers its `engine` input names (Playwright's Chromium and WebKit, cached by Playwright version, with WebKit's system libraries on Linux; the runner's Microsoft Edge for `msedge`), runs, uploads `report/` as an artifact, writes the summary to the job, and fails per `fail-on`. Pin it to a release tag, or to the tag's commit:

```yaml
jobs:
  review:
    runs-on: ubuntu-latest
    strategy: { fail-fast: false, matrix: { shard: [1/4, 2/4, 3/4, 4/4] } }
    steps:
      - uses: actions/checkout@v4
      - uses: ourostack/flow-review@v0.6.0
        with: { flows: "flows/site/*.flow.ts", shard: "${{ matrix.shard }}", engine: "chromium,webkit", fail-on: none }
  merge:
    needs: review
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        with: { pattern: "flow-review-*-of-*", path: shards }
      - uses: ourostack/flow-review@v0.6.0
        with: { command: merge, reports: "shards/*", flows: "flows/site/*.flow.ts", engine: "chromium,webkit", fail-on: none }
```

Where a repository's Actions policy doesn't allow outside actions, copy this repository at a release tag into the repository as a local action (`uses: ./.github/actions/flow-review`) and record the tag and commit beside it.

Shards split matrix cells. With `flows/flow-review-times.json` (from `flow-review times`), they split by each cell's recorded time, longest first into the shard with least so far; without it, by count.

### Coverage, cancelled shards and advisory flows

`merge` checks that every unit of `--flows` ran exactly once. A unit that didn't is never a blank: every unit that is missing or ran twice becomes a failing `coverage` finding (`{ check: "coverage", pass: false, unit, gated, measured }`), counted in its flow's row (marked ❌, a row of its own when none of the flow's units ran) and in the summary's failures. A timed-out unit already has its failing `timeout` finding. Whether a gap fails the merge depends on whether the unit's flow gates:

- A flow **gates** when it fails on something: its own `failOn`, else its config's, else `--fail-on`, is anything but `none`. A gated unit that is missing or ran twice fails the merge (exit 3), listed in the summary and as an error annotation in CI. A gated unit that timed out fails through its `timeout` finding (exit 1).
- A flow failing on `none` is **advisory**. Its units that are missing, ran twice or timed out are failing `coverage` findings too, listed in the summary and as a warning annotation in CI, but they don't fail the merge.
- A shard that was cancelled, or failed before writing its report, leaves a folder without `report.json`, or none at all. `merge` reads such a folder as a shard whose units are missing, so each of them is a failing `coverage` finding ("its shard was cancelled or failed and wrote no report"), and names the folder in the summary (`coverage.missingReports` in `report.json`).
- A unit no flow expects (`--flows` and the shards disagree) always fails.
- `--coverage strict` (the action's `coverage: strict`) goes back to failing on every missing or duplicated unit, gated or not.

So a run that gates some checks on one set of flows and only reports on others can merge everything with `--fail-on none`: a hung or cancelled advisory shard shows up as red findings, not a red merge, while a merge of the gated flows with their `--fail-on` still fails on any gap.

## Use the checks as conformance tests

Each check is a function of a Playwright page that returns findings and never throws on a failing page, so a design system or app can hold its own bar in its own tests:

```js
import { checks, expectNoFindings } from "@ourostack/flow-review";

test("buttons meet the bar", async ({ page }) => {
  await page.goto("/stories/button");
  expectNoFindings(await checks.targetSize(page, { thresholds: { targetPx: 24 } }));
  expectNoFindings(await checks.contrast(page, { thresholds: { contrastUi: 3 } }));
  expectNoFindings(await checks.designSystem(page, { designSystem: { marker: "[data-ouro]" } }));
  expectNoFindings(await checks.keyboard(page));
});
```

`checks` has `axe`, `contrast`, `targetSize`, `overflow`, `deadSpace`, `repetition`, `designSystem`, `proofNotice`, `states`, `cls`, `jank`, `keyboard` and `focusVisible`; each takes the same options as a flow's `checks` block. `expectNoFindings` throws an error listing every failing finding with its measurement and fix. Launch the page's browser with `launchBrowser(chromium, options)` to keep it headless outside CI (see [Run it](#run-it)). Install the package from a release tag (`npm install --save-dev github:ourostack/flow-review#v0.5.0`).

## Capability parity

A flow checks how a screen behaves; a **parity spec** checks whether a product has the capabilities and interaction models a floor asks for, on the data its person really has. It compares capability, not pixels: a floor is the least a familiar product does (keep its interaction model; doing better is the point), checked through stable hooks (ARIA, `data-*` attributes), never through screenshots.

A spec (`flow-review schema parity`) lists surfaces and their capabilities. Each capability has:

- a **detector** over records the product already reads: `records` names which, `scope` the ones it could apply to, `requires` the fields it needs (when no scoped record carries them, the product doesn't read them yet, and the capability is `unread`), and `where` the ones that call for it. Conditions take a dotted `path` and `eq`, `ne`, `in`, `notIn`, `gte`, `lte`, `match`, `exists`, `minItems`, `some` (an array item), `deep` (any object underneath), `anyOf` and `not`;
- a **floor**: data floors (`data: { where, min }`, the share of detected records that must meet `where`) and hook floors (`expect: { selector, min, max, attr, textNot, visible }`: at least `min` matches, at most `max`, each with `attr` and no text exactly in `textNot`, and with `visible` at least `min` of them on screen, after optional `act` steps: `click`, `hover`, `focus`, `press`, `waitFor`, each `optional` if it may not apply), checked with a few detected records open (`samples`, default 3, the same ones every run: the first by salted hash);
- `open: { with, args }`: which of the product's openers shows a record, and the record paths it takes (`${arg}` in selectors is filled from them);
- `owner` and `intent`: who a gap goes to, and the floor in words.

```json
{
  "version": 1, "name": "chat-floor",
  "surfaces": [{ "id": "quotes", "title": "Quoted replies", "capabilities": [{
    "id": "quote-shown", "title": "A reply shows what it quotes", "owner": "team:chat",
    "intent": "A quoted reply shows the quoted author and a preview above the reply.",
    "detect": { "records": "messages", "where": [{ "path": "body", "deep": [{ "path": "type", "eq": "reply" }] }] },
    "open": { "with": "message", "args": { "chat": "chatId", "message": "id" } },
    "floor": [{ "id": "quote-hook", "expect": { "selector": "[data-message-id=\"${message}\"] [data-quote]" } }]
  }] }]
}
```

Each capability ends `pass`, `gap`, `unread` or `not-present` (nothing in the data calls for it). Run one through an adapter, a module whose `setup(helpers)` returns `{ records(name), page, open(page, opener, args), guard, close }`:

```sh
flow-review parity run spec.json --adapter adapter.mjs --out parity [--baseline baseline.json] [--write-baseline baseline.json]
flow-review parity table parity/parity.json
flow-review parity issues parity/parity.json --spec spec.json    # one JSON line per gap: key, owner, title, body
flow-review parity compare parity/parity.json --baseline baseline.json
```

or from code: `runParity({ spec, records, page, open })`, `parityTable`, `parityIssues`, `parityBaseline` and `parityCompare`.

**Read-only and private by construction.** `launchGuarded({ url, allow })` opens a headless page whose context aborts every request and web socket `allow` doesn't pass (by default, only GET and HEAD to this computer), and counts what it blocked. The report (`flow-review schema parity-report`) holds counts, capability and floor ids, reasons (`open`, `step`, `missing`, `extra`, `attr`, `text`, `hidden`, `ratio`) and salted hashes of the records it opened: never a record's text, a name, an id or a picture. `textNot` compares text inside the page. A redirect's later hops and a service worker's fetches are beyond a route's reach, so the guard counts them as `escaped` and `runParity` refuses to report when there are any (contexts must block service workers; `launchGuarded` does). Pass `salt` (the CLI takes the adapter's `salt` or `FLOW_REVIEW_PARITY_SALT`): a secret kept stable on one machine keeps the hashes stable there without letting anyone check a hash against a guessed id; without it the spec's name is used, which only keeps them stable.

**Gaps become issues.** `parityIssues` turns each gap and unread capability into an issue intent with a stable key (`parity:<spec>:<surface>/<capability>`), its owner, a title and a counts-only body ending in a `parity-key:` line, so a product's own filer finds what it filed before and files each gap once. **A baseline guards CI:** run the same spec on made-up data, keep `parityBaseline`'s statuses, and `--baseline` exits 1 when a capability that passed no longer does.

## Constrained computer

`flow-review constrain -- <command>` runs a command, and everything it starts, as on a slow old Windows laptop (the
`old-windows-laptop` profile): CPU 4× slower, memory capped at 2048 MB, Node's file system calls slowed, and the network
slowed through a local proxy. It measures the CPU slowdown it achieved before the command starts, on long work and on
10 ms tasks such as an app's clicks, and refuses to run when either is off by more than 25%, prints a banner before and after, and writes a summary (`--summary`, `flow-review
schema constrained`) with the factor, which limits were enforced or only detected, and which were hit. Windows uses a
job object, Linux in CI a cgroup, macOS a stop/continue duty cycle and a memory watch. Browser pages are slowed through
DevTools: `flow-review run --constrained old-windows-laptop`, or `constrainPage` and `constrainCdp` (WebView2 too) in
any harness, switched on by `FLOW_REVIEW_CONSTRAINED`. It is independent of the review engine. It, and the CPU
throttling of pages, runs only on a CI runner or on a disposable machine that sets `FLOW_REVIEW_CONSTRAIN_SANDBOX=1` (a
Dev Box made for the run), refusing anywhere else before it starts anything, and kills everything it started when the run ends or passes
`--timeout-minutes`. See [Constrained computer](docs/constrained-computer.md) for each resource on each platform, what
isn't slowed, and why it loads nothing but the tree it slows.

## Develop

```sh
npm ci && npx playwright install --only-shell chromium && npm test
```

The tests plant one defect per check in a fixture page and check that the check fails it and passes the clean page, on Chromium and (in CI, `FLOW_REVIEW_ENGINE=webkit`) on WebKit, and run the CLI end to end on a fixture app (`test/fixtures/`): sharding, merge, the coverage guard, time limits and judge answers. The constrained-computer tests (`npm run test:constrain`, last in `npm test`) measure speed, so they run on their own, one at a time, and only where `flow-review constrain` may run (CI, or a declared sandbox; elsewhere they are skipped); CI runs them on Windows, macOS and Linux. `test/no-load-generators.test.mjs` fails any harness here that spawns `yes`, `stress` or `stress-ng`, or loops without end.

## Not in v0 yet

Electron launch (use `cdp`), driving a native WKWebView or WebView2 app window directly (WebKit and Edge stand for them; a WebView2 is reachable as a `cdp` flow), YAML flows, component-boundary contrast for form fields, a pixel-level focus-ring contrast measure, Chrome trace-based frame timing (frames come from requestAnimationFrame sampling, attributed with long-animation-frame timing), and per-step check overrides.

## Contributing and licence

See [CONTRIBUTING.md](CONTRIBUTING.md). MIT licensed; see [LICENSE](LICENSE).
