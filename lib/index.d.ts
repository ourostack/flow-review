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

/** Launch options a browser is started with (a subset of Playwright's). */
export interface LaunchOptions { headless?: boolean; devtools?: boolean; args?: string[]; [key: string]: unknown }
/** Whether this is CI (CI=true), where a visible browser is allowed. */
export declare function isCI(env?: Record<string, string | undefined>): boolean;
/** What in these options, or the environment (PWDEBUG), asks for a visible browser. */
export declare function headfulReasons(options?: LaunchOptions, env?: Record<string, string | undefined>): string[];
/** The options with headless on by default; throws outside CI when they, or the environment, ask for a visible browser. */
export declare function assertHeadless<T extends LaunchOptions>(options?: T, env?: Record<string, string | undefined>): T & { headless: boolean };
/** Launches a browser type (Playwright's chromium, say) headless, or headful only where CI=true. */
export declare function launchBrowser<B>(browserType: { launch(options: LaunchOptions): Promise<B> }, options?: LaunchOptions, env?: Record<string, string | undefined>): Promise<B>;
export declare function launchPersistentBrowser<C>(browserType: { launchPersistentContext(userDataDir: string, options: LaunchOptions): Promise<C> }, userDataDir: string, options?: LaunchOptions, env?: Record<string, string | undefined>): Promise<C>;

// ---- Capability parity (schema/parity-0.schema.json, schema/parity-report-0.schema.json)

/** One test on a record; every key given must hold. */
export interface ParityCondition {
  path?: string;
  exists?: boolean;
  eq?: unknown;
  ne?: unknown;
  in?: unknown[];
  notIn?: unknown[];
  gte?: number;
  lte?: number;
  match?: string;
  flags?: string;
  minItems?: number;
  some?: ParityCondition[];
  deep?: ParityCondition[];
  anyOf?: (ParityCondition | ParityCondition[])[];
  not?: ParityCondition | ParityCondition[];
}
export interface ParityStep { click?: string; hover?: string; focus?: string; press?: string; waitFor?: string; waitMs?: number; timeoutMs?: number; optional?: boolean }
export interface ParityExpect { selector: string; min?: number; max?: number; attr?: Record<string, string | true | null>; textNot?: string[]; visible?: boolean; timeoutMs?: number }
export type ParityFloor =
  | { id: string; title?: string; data: { where: ParityCondition[]; min?: number } }
  | { id: string; title?: string; act?: ParityStep[]; expect: ParityExpect };
export interface ParityCapability {
  id: string;
  title: string;
  owner?: string;
  intent?: string;
  detect: { records: string; scope?: ParityCondition[]; requires?: string[]; where?: ParityCondition[]; key?: string };
  open?: { with?: string; args?: Record<string, string> };
  samples?: number;
  floor: ParityFloor[];
}
export interface ParitySpec {
  $schema?: string;
  version: number;
  name: string;
  title?: string;
  samples?: number;
  surfaces: { id: string; title: string; owner?: string; capabilities: ParityCapability[] }[];
}
export type ParityStatus = "pass" | "gap" | "unread" | "not-present";
export interface GuardCounts { allowed: number; blocked: number; blockedByMethod: Record<string, number>; blockedRemote: number; blockedLocal: number; sockets: { allowed: number; blocked: number }; escaped: number }
export interface ParityResult {
  surface: string;
  capability: string;
  title?: string;
  owner: string | null;
  status: ParityStatus;
  scoped: number;
  detected: number;
  checked: number;
  passed: number;
  unread?: string[];
  floors: { id: string; kind: "data" | "hook"; pass: number; fail: number; ratio?: number; min?: number; reasons?: Record<string, number> }[];
  samples: string[];
  ms: number;
}
export interface ParityReport {
  schema: "flow-review-parity-report-0";
  tool: { name: string; version: string };
  spec: { name: string; version: number; sha256: string };
  target: unknown;
  startedAt: string;
  finishedAt: string;
  ms: number;
  guard: GuardCounts | null;
  only: string[] | null;
  summary: Record<ParityStatus, number>;
  results: ParityResult[];
}
export interface ParityIssue { key: string; surface: string; capability: string; status: "gap" | "unread"; owner: string | null; title: string; body: string }
export type RequestAsk = { url: string; method: string; resourceType: string };

export declare const PARITY_STATUSES: readonly ParityStatus[];
export declare function valueAt(record: unknown, path: string): unknown;
export declare function meets(record: unknown, condition: ParityCondition): boolean;
export declare function hashKey(key: unknown, salt?: string): string;
export declare function detect(detector: ParityCapability["detect"], records: unknown[]): { scoped: number; found: unknown[]; unread: string[] };
export declare function pickSamples<R>(found: R[], opts?: { key?: string; n?: number; salt?: string }): { r: R; h: string }[];
export declare function readOnlyLoopback(ask: { url: string; method: string }): boolean;
export declare function guardContext(context: import("playwright").BrowserContext, opts?: { allow?: (ask: RequestAsk) => boolean }): Promise<GuardCounts>;
export declare function launchGuarded(opts?: { url?: string | null; allow?: (ask: RequestAsk) => boolean; viewport?: { width: number; height: number }; launch?: LaunchOptions; waitUntil?: "load" | "domcontentloaded" | "networkidle" | "commit"; timeoutMs?: number }): Promise<{ browser: import("playwright").Browser; context: import("playwright").BrowserContext; page: PageLike; guard: GuardCounts; close: () => Promise<void> }>;
export declare function fill(text: string, args?: Record<string, unknown>): string;
export declare function expectHook(page: PageLike, expect: ParityExpect, args?: Record<string, unknown>, waitMs?: number): Promise<string | null>;
export declare function validateParitySpec(spec: unknown): string[];
export declare function runParity(opts: {
  spec: ParitySpec;
  records: (name: string) => unknown[] | Promise<unknown[]>;
  page?: PageLike | null;
  open?: ((page: PageLike, opener: string, args: Record<string, unknown>) => Promise<void>) | null;
  samples?: number;
  salt?: string;
  guard?: GuardCounts | null;
  target?: unknown;
  waitMs?: number;
  only?: string[] | null;
  log?: (line: string) => void;
}): Promise<ParityReport>;
export declare function parityTable(report: ParityReport): string;
export declare function parityIssues(report: ParityReport, spec?: ParitySpec | null): ParityIssue[];
export declare function parityBaseline(report: ParityReport): Record<string, ParityStatus>;
export declare function parityCompare(report: ParityReport, baseline: Record<string, ParityStatus>): { regressions: { id: string; was: string; now: string }[]; improvements: { id: string; was: string; now: string }[] };

// Constrained computer.
export interface ConstrainedSettings {
  profile: string;
  /** How many times slower every CPU-bound step runs; 1 is off. */
  cpu: number;
  /** The process tree's memory cap; 0 is off. */
  memoryMB: number;
  /** Added to each fs call of a Node process, with throughput in megabytes a second; 0 is off. */
  disk: { latencyMs: number; mbPerSec: number };
  /** Round-trip latency and throughput in kilobits a second; 0 is off. */
  network: { latencyMs: number; downKbps: number; upKbps: number };
  overridden?: string[];
  /** Set inside a tree flow-review constrain launched: its processes are already CPU-throttled. */
  tree?: { cpu: CpuMechanism | null; memory: MemoryMechanism | null; achieved: number | null; burst?: number | null };
  proxy?: string | null;
}
export type CpuMechanism = "job-duty-cycle" | "job-cpu-rate" | "cgroup-cpu-max" | "duty-cycle";
export type MemoryMechanism = "job-memory" | "cgroup-memory-max" | "rss-watch";
export interface ConstrainedOverrides { cpu?: number | string; memoryMB?: number | string; disk?: { latencyMs?: number | string; mbPerSec?: number | string }; network?: { latencyMs?: number | string; downKbps?: number | string; upKbps?: number | string } }
export interface ConstrainedSummary {
  schema: "flow-review-constrained-0";
  tool: { name: string; version: string };
  profile: string;
  settings: Pick<ConstrainedSettings, "cpu" | "memoryMB" | "disk" | "network">;
  overridden: string[];
  platform: string;
  command: string[];
  startedAt: string;
  finishedAt: string;
  ms: number;
  cpu: { target: number; mechanism: CpuMechanism | null; enforcement: "enforced" | null; scope: "tree" | "thread" | null; achieved: number | null; tolerance: number; within: boolean | null; baselineMs: number | null; constrainedMs: number | null; iterations: number | null; cpus: number; rate?: number | null; quota?: string | null; burst?: { baselineMs: number; constrainedMs?: number; achieved?: number; within?: boolean }; dutyCycle?: boolean; [k: string]: unknown };
  memory: { capMB: number | null; mechanism: MemoryMechanism | null; enforcement: "enforced" | "detected" | null; peakMB: number | null; hit: boolean; [k: string]: unknown };
  disk: { latencyMs: number; mbPerSec: number; mechanism: "node-fs-preload" | null };
  network: { latencyMs: number; downKbps: number; upKbps: number; mechanism: "delay-proxy" | null; proxy: string | null; requests?: number; tunnels?: number; bytesUp?: number; bytesDown?: number };
  capsHit: "memory"[];
  exitCode: number | null;
  signal: string | null;
  error: string | null;
  /** What let it run here: GITHUB_ACTIONS=true, CI=true or FLOW_REVIEW_CONSTRAIN_SANDBOX=1. */
  sandbox?: string;
  timeoutMinutes?: number;
  /** The run went past its time limit and its whole tree was killed. */
  timedOut?: boolean;
  ok: boolean;
}
export interface CdpConstraintResult { cpu: { rate: number | null; skipped: string | null; achieved: number | null; factors?: number[]; baselineMs?: number; constrainedMs?: number; iterations?: number }; network: { latencyMs: number; downKbps: number; upKbps: number } | null }
export interface CdpOptions { cpu?: boolean; network?: boolean; calibrate?: boolean; calibrateMs?: number }

export declare const PROFILES: Readonly<Record<string, Readonly<Omit<ConstrainedSettings, "profile" | "overridden" | "tree" | "proxy">>>>;
export declare const DEFAULT_PROFILE: string;
export declare const CONSTRAINED_ENV: "FLOW_REVIEW_CONSTRAINED";
export declare const CONSTRAINED_SCHEMA: "flow-review-constrained-0";
export declare function resolveSettings(profile?: string, overrides?: ConstrainedOverrides): ConstrainedSettings;
export declare function constrainedFromEnv(env?: Record<string, string | undefined>): ConstrainedSettings | null;
export declare function bannerLine(settings: ConstrainedSettings, extra?: { cpu?: { achieved?: number | null; mechanism?: string | null } | null; memory?: { enforcement?: string | null } | null }): string;
export declare function pickMechanisms(settings: ConstrainedSettings, opts?: { cpuMechanism?: "auto" | "duty-cycle" | "hard-cap"; platform?: string; env?: Record<string, string | undefined>; cgroup?: () => boolean }): { cpu: CpuMechanism | null; memory: MemoryMechanism | null };
export declare const SANDBOX_ENV: "FLOW_REVIEW_CONSTRAIN_SANDBOX";
/** What makes this host one flow-review constrain may run on (a CI runner, or a declared disposable sandbox), or null. */
export declare function sandboxedHost(env?: Record<string, string | undefined>): string | null;
/** Throws, naming how to allow it, unless this host is a CI runner or a declared disposable sandbox. */
export declare function assertSandboxedHost(env?: Record<string, string | undefined>, options?: { what?: "constrain" | "page-cpu" }): string;
export declare function constrainedEnv(env: Record<string, string | undefined>, info: ConstrainedSettings, proxyUrl?: string | null): Record<string, string>;
export interface ConstrainedRun {
  /** Resolves once the slowdown is measured and the command has started. */
  ready: Promise<{ env: Record<string, string>; cpu: ConstrainedSummary["cpu"]; mechanisms: { cpu: CpuMechanism | null; memory: MemoryMechanism | null }; proxy: string | null }>;
  /** Resolves when the command and everything it left running have ended. */
  done: Promise<ConstrainedSummary>;
  stop(signal?: string): void;
}
export interface ConstrainOptions { settings?: ConstrainedSettings; profile?: string; overrides?: ConstrainedOverrides; tolerance?: number; cpuMechanism?: "auto" | "duty-cycle" | "hard-cap"; periodMs?: number; calibrateMs?: number; cwd?: string; env?: Record<string, string | undefined>; summary?: string | null; log?: ((line: string) => void) | null; timeoutMinutes?: number }
export declare function launchConstrained(command: string, args?: string[], options?: ConstrainOptions): ConstrainedRun;
export declare function runConstrainedCommand(command: string, args?: string[], options?: ConstrainOptions): Promise<ConstrainedSummary>;
export declare function constrainPage(page: import("playwright").Page, settings?: ConstrainedSettings | null, options?: CdpOptions): Promise<CdpConstraintResult | null>;
export declare function constrainContext(context: import("playwright").BrowserContext, settings?: ConstrainedSettings | null, options?: CdpOptions): Promise<{ applied: CdpConstraintResult[]; failed: { url: string; error: string }[] } | null>;
export declare function constrainCdp(endpoint: string, settings?: ConstrainedSettings | null, options?: CdpOptions): Promise<{ applied: (CdpConstraintResult & { targetId: string; url: string })[]; failed: { targetId: string; url: string; error: string }[]; close(): Promise<void> } | null>;
export declare function applyCdpConstraints(send: (method: string, params?: object) => Promise<any>, settings: ConstrainedSettings, options?: CdpOptions): Promise<CdpConstraintResult>;
export declare function startDelayProxy(opts?: { latencyMs?: number; downKbps?: number; upKbps?: number; port?: number; host?: string }): Promise<{ url: string; port: number; stats(): { requests: number; tunnels: number; failed: number; bytesUp: number; bytesDown: number }; close(): Promise<void> }>;
export declare function spin(iterations: number): number;
export declare function timeSpin(iterations: number, samples?: number): number;
export declare function calibrationBaseline(targetMs?: number, samples?: number): { iterations: number; ms: number };
export declare function factorOf(ms: number, baseMs: number): number;
