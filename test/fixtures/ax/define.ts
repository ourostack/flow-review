// Agent flows as data, in a product repository's own types: the flow-review/0 shape (a flow is { id, surface, title,
// steps, rubric }, an agent step is { run: [argv] | request: { method, path, body }, expect: { exit, jsonShape?,
// fields?, stderrRules?, maxMs? } }) plus extensions of its own, marked below. The engine runs flows typed this way
// without its own `defineFlow`.

/** Six criteria every agent flow is judged on. */
export type Rubric = "discoverable" | "predictable" | "honest" | "forgiving" | "fast" | "beautiful";

/** A value a JSON field must have: the value itself, a pattern, one of several values, or a type. */
export type Match = string | number | boolean | null | { re: string } | { oneOf: Array<string | number | boolean | null> } | { type: "string" | "number" | "boolean" | "array" | "object" | "null" };

/**
 * One line on stderr ("oneLine"), that names what to do instead ("namesFix": a "Fix:" or a command), with no Node
 * stack trace ("noStack"); or nothing on stderr at all ("empty").
 */
export type StderrRule = "empty" | "oneLine" | "namesFix" | "noStack";

export interface Expect {
  /** The exit code, or the codes any of which is right. */
  exit: number | number[];
  /**
   * Paths that must exist in stdout's JSON: "a.b", "a[0].b", "a[-1]" (the last), "a[].b" (every element; non-empty),
   * "a[subject~^Weekly]" (the elements whose field matches, ignoring case), "a.length" (an array's length).
   */
  jsonShape?: string[];
  /** Path to the value it must have; with "[]" in the path, at least one element must match. */
  fields?: Record<string, Match>;
  stderrRules?: StderrRule[];
  /** Latency budget for this call, in milliseconds (the runner may scale it with --slack). */
  maxMs?: number;
  /** Extension: an output budget, stdout plus stderr in bytes ("fast": small outputs). */
  maxBytes?: number;
  /** Extension: patterns the text output must (has) or must not (not) contain; stdout and stderr together. */
  text?: { has?: string[]; not?: string[] };
}

interface StepBase {
  id: string;
  expect: Expect;
  /** Extension: values to keep from this step's JSON for later steps' {name} placeholders: name -> path. */
  save?: Record<string, string>;
  /** Extension: the smallest fix, reported with any failing check of this step. */
  fix?: string;
  /** Extension: a known defect on main (an issue or PR link); its failing checks are reported, not fatal in the test. */
  known?: string;
}
export interface RunStep extends StepBase {
  /** The argv after the tool's name; {name} is replaced by a saved value. */
  run: string[];
}
export interface RequestStep extends StepBase {
  request: { method: "GET" | "POST" | "PUT" | "DELETE"; path: string; body?: unknown };
}
/** Extension: the mock's control port: a made-up reply (/inject), the person's Send (/person-send). */
export interface Harness {
  path: "/inject" | "/person-send";
  body: Record<string, string>;
}
export interface HarnessStep {
  id: string;
  harness: Harness;
}
export type Step = RunStep | RequestStep | HarnessStep;

export interface Flow {
  id: string;
  surface: "agent-cli" | "agent-http";
  title: string;
  steps: Step[];
  rubric: Rubric[];
  /** Extension: where the flow comes from (a task list, an issue). */
  source?: string;
  /** Extension: the flow only reads; the runner checks the action log did not change. */
  readOnly?: boolean;
  /** Extension: the host's name for the agent (INBOX_AGENT) for this flow's calls; default "flow-review". */
  agent?: string;
  /** Extension: known defects of the flow-level checks ("discoverable.listed", "reads-stay-reads"): check -> issue. */
  known?: Record<string, string>;
}

/** One check's result, one line of report/findings.jsonl (flow-review/0). */
export interface Finding {
  flow: string;
  step: string;
  surface: Flow["surface"];
  cell: null;
  check: string;
  pass: boolean;
  measured?: unknown;
  threshold?: unknown;
  selector?: string;
  evidence?: string;
  fix?: string;
  ms: number;
  /** Extension: the rubric criterion the check serves. */
  rubric?: Rubric;
  /** Extension: the step's known defect, when it has one. */
  known?: string;
}

export function defineFlow<T extends Flow>(flow: T): T {
  return flow;
}
