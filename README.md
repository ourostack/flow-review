# flow-review

Deterministic review of user and agent flows. A repository declares its flows in `flows/`; flow-review runs each one across a matrix of viewports, themes and reduced motion, measures it with fixed checks, and writes JSON with a small cropped picture for every failure. Agents judge only what measurement can't decide, from packets the run prepares.

It runs locally and in CI, and every check is also a plain function another repository can use as its own conformance test.

## Run it

Node 22.18 or newer. From the product repository:

```sh
npm install --save-dev github:ourostack/flow-review#v0.3.1 && npx playwright install --only-shell chromium
npx flow-review run                  # flows/**/*.flow.{ts,json}
npx flow-review run 'flows/site/*.flow.ts' --only axe,contrast --fail-on none
```

In CI, use the action instead ([In CI](#in-ci)): it installs everything itself.

| Command | Does |
| --- | --- |
| `run [globs] --out report --shard k/n --fail-on any\|none\|<checks> --only <checks> --times <file> --workers n` | Runs flows. Exit 1 when a check named by `--fail-on` (or the flow's own `failOn`) fails (default `any`). |
| `list [globs] --shard k/n --times <file>` | Prints how shards split the units, without running. |
| `merge <report dirs> --out report --flows <glob> --coverage gated\|strict` | Combines shard reports. Exit 3 when a gated unit didn't run exactly once ([Coverage](#coverage-cancelled-shards-and-advisory-flows)). |
| `times <report dirs> --out flows/flow-review-times.json` | Records each unit's time, so the next run's shards balance by time. |
| `judge --merge <answer.json> --report report` | Validates judges' rubric answers and folds them into `report.json`. |
| `schema flow\|report\|finding\|rubric` | Prints a published JSON Schema. |
| `validate [globs]` | Loads and checks flow files. |

`FLOW_REVIEW_CHROMIUM` points at another Chromium build; `FLOW_REVIEW_CHANNEL=chrome` uses installed Chrome.

## A flow

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
- **Steps, web and cdp:** `goto`, `act: { role, name, verb: click|press|type|hover|focus, key?, text? }`, `waitFor`, `capture: { moment, region? }`, `tabTraverse`, `setTheme`, `resize`, `scroll`. Targets are found by role and accessible name first, `text` next, and a CSS `selector` last. Any step may carry `expect` (role, text, url, focus, count), `state` (`empty`, `error`, `loading`) and `route` (fixtures for that navigation only).
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
- **Matrix:** each viewport × theme × reduced-motion combination is a cell. Themes come from `prefers-color-scheme`, or from the flow's own `themeSteps` (`matrix.themeVia: "steps"`), for an app with its own toggle.
- **Fixtures:** `fixtures.route` answers matching requests from a file, `json`, `body` or `status`. Requests to other origins are aborted (`app.blockExternal: false` allows them), so runs don't depend on the network.
- **Time limits:** `timeouts: { cellMs, stepMs }`. A cell (one matrix cell, or an agent flow's one unit) may take `cellMs` (default 120000, or the flow's longest `waitFor.ms` or step `timeoutMs` and 30 s more when that is longer and no `cellMs` is set), counted once its app is up (`app.readyTimeoutMs` bounds the start). Past it, the engine stops the cell: it closes its page (a `cdp` browser is only disconnected), kills its running command, and stops its app when the app is the flow's own (`scope: "flow"`) or no longer answers its ready URL, so the next cell starts it afresh. A `timeout` finding names the step it was on, that step's target and the time, and the run goes on with the next cell, so a shard always finishes and writes its report. A step may take `stepMs` (default 60000): a `goto`, `act` or `waitFor` that hangs fails that step, naming its target in `selector`. A `waitFor` with a longer `ms` gets that `ms` and 5 s more, and an agent step's own `timeoutMs` wins. A flow's `timeouts` go over its config's.
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

## Checks

Checks run at every `capture` and at the end of the flow. Keyboard and focus run at each `tabTraverse`, or at the end when a flow has none. `states` runs after every step that declares one. Every threshold is the flow's to set, in `checks.thresholds`.

| Check | Fails when | Threshold (default) |
| --- | --- | --- |
| `axe` | axe-core finds a WCAG 2.2 A/AA or best-practice violation (contrast and target size have their own checks). Focus guards (Base UI, Floating UI, Radix, `data-focus-guard`, and `checks.focusGuards`) are left out: they are hidden and focusable on purpose. The `region` rule counts each open popup layer or portal root (menus, listboxes, dialogs, tooltips, `[popover]`, Base UI and Radix portals, and `checks.popupLayers`) as a region of its own, since they render outside the landmarks by design; other content outside a landmark still fails | `axeImpact` (`minor`) |
| `keyboard` | Tab doesn't reach an interactive element, or focus is trapped (inside an open modal, only its contents count). In a composite widget (a listbox, grid, tree, toolbar, menu, tab list, an `aria-activedescendant` container, or items at any depth inside one container that rove one `tabindex="0"`, such as a thread's first post and its nested replies), an element inside another item counts as reached when arrowing there (Home, then Down or Right) and pressing Tab reaches it; the check drives it. An open combobox may take one Tab to accept its suggestion. A control the traversal itself removes isn't missing, and one Tab skipped while it was briefly disabled counts when a second Tab cycle reaches it. A dialog is modal when it is a `showModal()` `<dialog>`, has `aria-modal="true"`, or hides the page behind it (aria-hidden or inert); a toast or other non-modal dialog doesn't scope the checks | — |
| `focusVisible` | a focused element shows no outline, ring or other visible change (computed style, then a pixel diff) | — |
| `contrast` | text falls under its ratio (axe), or an icon-only control's glyph falls under the UI ratio | `contrastText` (4.5), `contrastUi` (3) |
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
| `coverage` | merge only: a unit of an advisory flow didn't run, ran twice or timed out. Never fails a run or merge by itself | — |

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
- `findings.jsonl`: one finding a line, `{ flow, step, surface, cell, check, pass, measured, threshold, selector, label, evidence, fix, ms }`. `cell` is `{ viewport, theme, reducedMotion }`, or null on the agent side.
- `evidence/`: a crop around each failing element with a red box, PNG or WebP under 300 KB (at most 3 per check per capture, 40 per unit).
- `moments/`: each capture's picture, WebP, at most 1600 px wide, listed in `report.json`'s `captures[]`.
- `judge-packet-<rubric>.json`: per rubric the flows name, the measurements, failing checks with crops and up to 24 key moments. A judge answers with `{ judge, verdict: "approve" | "not yet", moments: [{ step, cell, crop, observation, fix }] }` and never browses; `flow-review judge --merge` rejects an answer that names a step or crop the report doesn't have.
- `summary.md`: the markdown table CI shows.

## In CI

The action (`action.yml`, `uses: ourostack/flow-review@<tag or commit>`) installs flow-review and Chromium (cached by Playwright version), runs, uploads `report/` as an artifact, writes the summary to the job, and fails per `fail-on`. Pin it to a release tag, or to the tag's commit:

```yaml
jobs:
  review:
    runs-on: ubuntu-latest
    strategy: { fail-fast: false, matrix: { shard: [1/4, 2/4, 3/4, 4/4] } }
    steps:
      - uses: actions/checkout@v4
      - uses: ourostack/flow-review@v0.3.1
        with: { flows: "flows/site/*.flow.ts", shard: "${{ matrix.shard }}", fail-on: none }
  merge:
    needs: review
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        with: { pattern: "flow-review-*-of-*", path: shards }
      - uses: ourostack/flow-review@v0.3.1
        with: { command: merge, reports: "shards/*", flows: "flows/site/*.flow.ts", fail-on: none }
```

Where a repository's Actions policy doesn't allow outside actions, copy this repository at a release tag into the repository as a local action (`uses: ./.github/actions/flow-review`) and record the tag and commit beside it.

Shards split matrix cells. With `flows/flow-review-times.json` (from `flow-review times`), they split by each cell's recorded time, longest first into the shard with least so far; without it, by count.

### Coverage, cancelled shards and advisory flows

`merge` checks that every unit of `--flows` ran exactly once. What a gap means depends on whether the unit's flow gates:

- A flow **gates** when it fails on something: its own `failOn`, else its config's, else `--fail-on`, is anything but `none`. A gated unit that is missing or ran twice fails the merge (exit 3), listed in the summary. A gated unit that timed out fails through its `timeout` finding (exit 1).
- A flow failing on `none` is **advisory**. Its units that are missing, ran twice or timed out become `coverage` findings (`{ check: "coverage", unit, measured }`), listed under a **Notice:** in the summary and as a notice annotation in CI. They don't fail the merge.
- A shard that was cancelled, or failed before writing its report, leaves a folder without `report.json`, or none at all. `merge` reads such a folder as a shard whose units are missing, and names it in the summary (`coverage.missingReports` in `report.json`).
- A unit no flow expects (`--flows` and the shards disagree) always fails.
- `--coverage strict` (the action's `coverage: strict`) goes back to failing on every missing or duplicated unit, gated or not.

So a run that gates some checks on one set of flows and only reports on others can merge everything with `--fail-on none`: a hung or cancelled advisory shard shows up as findings, not a red merge, while a merge of the gated flows with their `--fail-on` still fails on any gap.

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

`checks` has `axe`, `contrast`, `targetSize`, `overflow`, `deadSpace`, `repetition`, `designSystem`, `proofNotice`, `states`, `cls`, `jank`, `keyboard` and `focusVisible`; each takes the same options as a flow's `checks` block. `expectNoFindings` throws an error listing every failing finding with its measurement and fix. Install the package from a release tag (`npm install --save-dev github:ourostack/flow-review#v0.3.1`).

## Develop

```sh
npm ci && npx playwright install --only-shell chromium && npm test
```

The tests plant one defect per check in a fixture page and check that the check fails it and passes the clean page, and run the CLI end to end on a fixture app (`test/fixtures/`): sharding, merge, the coverage guard, time limits and judge answers.

## Not in v0 yet

Electron launch (use `cdp`), YAML flows, component-boundary contrast for form fields, a pixel-level focus-ring contrast measure, Chrome trace-based frame timing (frames come from requestAnimationFrame sampling, attributed with long-animation-frame timing), and per-step check overrides.

## Contributing and licence

See [CONTRIBUTING.md](CONTRIBUTING.md). MIT licensed; see [LICENSE](LICENSE).
