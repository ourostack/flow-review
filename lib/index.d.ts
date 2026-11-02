// Types for flow files. A `.flow.ts` default-exports `defineFlow({...})`; a `.flow.json` holds the same shape and is
// validated by the JSON Schema `flow-review/0` (`flow-review schema flow`).

export type CheckName =
  | "axe" | "keyboard" | "focusVisible" | "contrast" | "targetSize" | "overflow" | "deadSpace" | "repetition"
  | "cls" | "jank" | "designSystem" | "proofNotice" | "states" | "errors"
  | "duoOverlap" | "duoReducedMotion" | "duoBytes" | "celebrationCap" | "quietMode" | "unusedRoute"
  | "exit" | "jsonShape" | "fields" | "stdoutRules" | "stderrRules" | "status" | "text" | "maxMs" | "maxBytes" | "readOnly" | "listed" | "known" | "step"
  | "timeout" | "coverage";

/** A target found by role and accessible name first; `selector` (CSS) is the fallback. */
export interface Target {
  role?: string;
  name?: string | RegExp | { regex: string; flags?: string };
  text?: string;
  selector?: string;
  /** Which match when several do (default 0, the first). */
  nth?: number;
  exact?: boolean;
}

export interface RouteFixture {
  status?: number;
  /** A file path, relative to the flow file. */
  file?: string;
  body?: string;
  json?: unknown;
  contentType?: string;
  /** Abort the request instead of answering it. */
  abort?: boolean;
}

export interface Expect {
  role?: string;
  name?: string | RegExp | { regex: string; flags?: string };
  text?: string;
  url?: string;
  /** The focused element after the step. */
  focus?: Target;
  count?: { target: Target; equals?: number; min?: number; max?: number };
}

interface StepBase {
  id?: string;
  /** Declares the step reaches one of the app's states; the `states` check verifies it says something human. */
  state?: "normal" | "empty" | "error" | "loading" | "first-run" | "success";
  /** Where the state shows (default: main, else body). */
  stateRegion?: Target;
  expect?: Expect;
  /** Routes on top of the flow's fixtures: a goto's last until the next goto or the end of the flow; any other step's, for that step only. */
  route?: Record<string, string | RouteFixture>;
}

export type UiStep = StepBase & (
  | { goto: string }
  | { act: Target & { verb: "click" | "press" | "type" | "hover" | "focus"; key?: string; text?: string } }
  /**
   * Holds `key` down (on the target, focused first, when one is given), waits `ms` (default 0), takes the `during`
   * steps (a capture among them runs its checks while the key is down), then lets it go, whatever those steps did. The
   * step's own `expect` is checked once the key is up.
   */
  | { act: Target & { verb: "hold"; key: string; ms?: number; during?: UiStep[] } }
  | { waitFor: Target & { state?: "visible" | "hidden" | "attached" | "detached"; ms?: number } }
  | { capture: { moment: string; region?: Target } }
  | { tabTraverse: true | { within?: string; max?: number } }
  | { setTheme: "light" | "dark" }
  | { resize: string }
  | { scroll: { to: "top" | "bottom" } | { target: Target } }
);

export interface AgentExpect {
  /** agent-http: the status, or the statuses any of which is right (default: exit, else 200). */
  status?: number | number[];
  /** The exit code, or the codes any of which is right (default 0). */
  exit?: number | number[];
  /**
   * A JSON Schema for stdout (agent-cli) or the response body (agent-http), or paths that must be present: "a.b",
   * "a[0]", "a[-1]", "a[].b" (every element), "a[subject~^Weekly].id" (elements whose field matches), "a.length".
   */
  jsonShape?: Record<string, unknown> | string[];
  /** Paths to a literal or a matcher; a path through [] or a filter passes when any value matches. */
  fields?: Record<string, unknown | { exists?: boolean; matches?: string; re?: string; oneOf?: unknown[]; gte?: number; lte?: number; type?: string }>;
  stdoutRules?: { mustMatch?: string[]; mustNotMatch?: string[] };
  /** Regexes, or named rules: empty, oneLine, namesFix ("Fix: " or one of app.cliNames and a word), noStack. */
  stderrRules?: { mustMatch?: string[]; mustNotMatch?: string[] } | ("empty" | "oneLine" | "namesFix" | "noStack")[];
  /** Patterns stdout and stderr together must (has) or must not (not) contain. */
  text?: { has?: string[]; not?: string[] };
  maxMs?: number;
  /** stdout plus stderr, in bytes. */
  maxBytes?: number;
}

export interface Harness { path: string; method?: string; body?: unknown }

export type AgentStep = {
  id?: string;
  expect?: AgentExpect;
  /** Values to keep from this step's JSON for later steps' {name} placeholders: name -> path. */
  save?: Record<string, string>;
  /** The fix reported with any failing check of this step. */
  fix?: string;
  /** A known defect (an issue): its failures are reported, never counted by --fail-on; passing again is a finding. */
  known?: string;
  /** A call to the mock's control port (app.controlUrl) while this step runs. */
  during?: { afterMs: number; harness: Harness };
} & (
  | { run: string[]; cwd?: string; env?: Record<string, string>; stdin?: string; timeoutMs?: number }
  | { request: { method?: string; path: string; body?: unknown; headers?: Record<string, string> }; timeoutMs?: number }
  | { harness: Harness }
);

export interface Thresholds {
  /** Lowest axe impact that fails: minor, moderate, serious or critical (default minor). */
  axeImpact?: "minor" | "moderate" | "serious" | "critical";
  contrastText?: number;
  contrastUi?: number;
  targetPx?: number;
  /** Largest empty rectangle's share of a section (default 0.25). */
  deadSpace?: number;
  /** Ignore sections shorter than this, in px (default 120). */
  deadSpaceMinSectionPx?: number;
  repetitionMinChars?: number;
  repetitionMax?: number;
  clsMax?: number;
  longTaskMs?: number;
  frameMs?: number;
  /** Share of frames over frameMs, during motion, that fails (default 0.1). */
  slowFrameShare?: number;
  /** Motion frames a share needs before it is judged (default twice 1 / slowFrameShare, 20 at 0.1). */
  jankMinFrames?: number;
  overflowPx?: number;
  /** Accept every ellipsis and line clamp as deliberate (default false: one passes only when the hidden words are in the accessible name and a tooltip or dialog, and it shows `truncationMinShown` of its words). */
  allowTruncation?: boolean;
  /** Share of a truncated element's words it must still show (default 0.5). */
  truncationMinShown?: number;
  stateMinChars?: number;
  /** Large text's contrast (24 px, or 18.66 px bold), over duo art (default 3). */
  contrastLarge?: number;
  /** Bytes of duo assets per page (default 153600, 150 KB). */
  duoBytes?: number;
  /** Celebrations per flow (default 1). */
  celebrationMax?: number;
}

export interface ChecksConfig {
  /** Run only these (default: all that apply to the surface). */
  only?: CheckName[];
  skip?: CheckName[];
  thresholds?: Thresholds;
  /** The design system's marker: an interactive element passes when it, or an ancestor within `depth`, matches. */
  designSystem?: { marker: string; depth?: number; ignore?: string };
  /** Proof pictures: every image inside `proof` needs a notice (its description, a figcaption, or a `notice` match). */
  proofNotice?: { proof?: string; notice?: string; minChars?: number };
  /** The duo: its art, what quiet mode hides, a celebration, its asset URLs, and the steps that turn quiet mode on. */
  duo?: { art?: string; quiet?: string; celebrate?: string; assets?: string; quietSteps?: UiStep[]; watchMs?: number };
  /** The Moment each state should hold; {kind} becomes the state's kind (default [data-moment="{kind}"]). */
  moments?: { marker?: string };
  /** Sections for deadSpace (default: `main section[id], [data-section]`, outermost only). */
  sections?: string;
  /** Selectors of focus guards beyond the known ones (Base UI, Floating UI, Radix, data-focus-guard), left out of axe. */
  focusGuards?: string[];
  /** Selectors of popup layers or portal roots beyond the known ones, whose content axe's region rule leaves out. */
  popupLayers?: string[];
  /** Elements to leave out of every check (third-party embeds, deliberate art). */
  ignore?: string;
  /** Regexes for console errors, page errors and failed requests the errors check accepts. */
  allowErrors?: string[];
}

export interface Flow {
  /** The flow's name; without one, `<id> <title>`. */
  name?: string;
  id?: string;
  title?: string;
  source?: string;
  surface: "web" | "cdp" | "agent-cli" | "agent-http";
  /** The flow only reads: app.stateProbe prints the same before and after. */
  readOnly?: boolean;
  /** Recorded only. */
  agent?: string;
  /** Known defects of flow-level checks: check -> issue. */
  known?: Record<string, string>;
  /** Values for {name} placeholders in steps (saves add to them). */
  vars?: Record<string, string>;
  app?: {
    /** The default for ${target} when neither --target nor FLOW_REVIEW_TARGET is given. */
    target?: string;
    /** agent-cli: the command every run step's argv follows, such as ["node", "${target}"]. */
    cli?: string[];
    /** Command names a stderr line may give as the fix (namesFix). */
    cliNames?: string[];
    /** A mock's control port, for harness steps. */
    controlUrl?: string;
    /** agent-cli: argv (after cli) whose output a readOnly flow must leave unchanged. */
    stateProbe?: string[];
    /** Shell command that starts the app, run from the working directory. */
    start?: string;
    cwd?: string;
    env?: Record<string, string>;
    /** Base URL for goto paths (web) and requests (agent-http). */
    url?: string;
    /** A URL that answers once the app is up (default: url), or "stdout-json": up when it prints a JSON object line, whose fields become ${start.<field>}. */
    ready?: string;
    /** argv run once the app is up; it must exit 0 (a check that it is a mock). */
    guard?: string[];
    /** Files written (relative to the working directory) before the app starts. */
    files?: Record<string, { text?: string; base64?: string }>;
    /** agent-cli: argv (after cli) that prints the top-level help, for the listed check. */
    help?: string[];
    /** run (default): one app for every flow that starts it the same way; flow: a fresh one per flow. */
    scope?: "run" | "flow";
    readyTimeoutMs?: number;
    /** cdp: the browser's CDP endpoint. */
    cdpUrl?: string;
    /** Abort requests to other origins (default true). */
    blockExternal?: boolean;
    /** What a goto waits for after navigating: "load" (default), "domcontentloaded", "networkidle" (opt-in, up to 3 s) or a target. */
    readyAfterGoto?: "load" | "domcontentloaded" | "networkidle" | { role?: string; name?: string | { regex: string; flags?: string }; text?: string; selector?: string; exact?: boolean; ms?: number };
  };
  matrix?: {
    viewports?: string[];
    themes?: ("light" | "dark")[];
    reducedMotion?: boolean[];
    /** How a cell's theme is set: prefers-color-scheme emulation (default) or the flow's themeSteps. */
    themeVia?: "emulate" | "steps";
  };
  themeSteps?: { light?: UiStep[]; dark?: UiStep[] };
  fixtures?: { route?: Record<string, string | RouteFixture> };
  steps: (UiStep | AgentStep)[];
  checks?: ChecksConfig;
  /** Judge rubrics this flow's moments go to. */
  rubric?: string[];
  attachments?: { kind: string; path: string; [key: string]: unknown }[];
  /** Time limits, over the config's (the surface's, then its own). */
  timeouts?: Timeouts;
  /**
   * What fails the run for this flow, in place of --fail-on: "any", "none" or a comma list of checks. A flow failing on
   * "none" is advisory: when merge finds its units missing, run twice or timed out, they are coverage findings.
   */
  failOn?: string;
}

export interface Timeouts {
  /** The most one matrix cell (or agent unit) may take once its app is up (default 120000, or the flow's longest waitFor.ms or step timeoutMs and 30 s more). Past it the cell is stopped and becomes a timeout finding; the run goes on. */
  cellMs?: number;
  /** The most one step may take (default 60000): a hung goto, act or waitFor fails that step. A waitFor's longer ms, and an agent step's own timeoutMs, win. */
  stepMs?: number;
}

export interface Finding {
  flow?: string;
  step?: string;
  surface?: Flow["surface"];
  cell?: { viewport: string; theme: "light" | "dark"; reducedMotion: boolean } | null;
  check: CheckName;
  pass: boolean;
  measured?: unknown;
  threshold?: unknown;
  selector?: string;
  label?: string;
  evidence?: string;
  fix?: string;
  ms?: number;
  /** An advisory finding (unusedRoute): reported, never counted by --fail-on. */
  advisory?: boolean;
}

/** Options every check takes: the flow's `checks` config shape. */
export type CheckOptions = ChecksConfig & { include?: string; within?: string; max?: number; since?: number; windows?: [number, number][]; state?: string; region?: string };
type PageLike = import("playwright").Page;
export declare const checks: { [K in "axe" | "contrast" | "targetSize" | "overflow" | "deadSpace" | "repetition" | "designSystem" | "proofNotice" | "states" | "cls" | "jank" | "keyboard" | "focusVisible" | "duoOverlap" | "duoReducedMotion" | "duoBytes"]: (page: PageLike, opts?: CheckOptions) => Promise<Finding[]> };
/** Throws, listing every failing finding, when any finding failed. */
export declare function expectNoFindings(findings: Finding[], message?: string): void;
export declare function traverse(page: PageLike, opts?: CheckOptions): Promise<Finding[]>;
export declare const DEFAULT_THRESHOLDS: Required<Thresholds>;

export declare function defineFlow<const F extends Flow>(flow: F): F;
export declare const CHECKS: { ui: CheckName[]; agent: CheckName[] };
