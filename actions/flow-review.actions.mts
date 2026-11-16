// flow-review's agent-facing commands, declared once. `ouro-actions.mts generate` writes their CLI definitions into
// actions/generated/commands.json; lib/cli.mjs builds the commands from it with defineCommand, and keeps each command's
// positional words (the flows, the report folders) in the same place they always were.
// Not yet moved, so still dispatched by lib/cli.mjs alone: moments (its --json flag is one the kit reserves), schema,
// parity and constrain.
import { defineAction, defineActions, field } from "../tools/ouro-actions/ouro-actions.mts";

const report = field.string({ label: "Report folder", description: "The folder the run wrote its report.json to." });

export const run = defineAction({
  id: "run_flows",
  cli: "run",
  consent: "write",
  label: "Run flows",
  description: "Run the product's flows across its matrix and write the report.",
  agent: "Run the declared flows across the matrix and write report/report.json with its findings, evidence and summary. Exit 1 when a check named by failOn fails.",
  input: {
    out: field.string({ label: "Output folder", description: "Where the report is written (default report).", optional: true }),
    shard: field.string({ label: "Shard", description: "k/n: run one shard of the units.", optional: true }),
    failOn: field.string({ label: "Fail on", description: "any, none, or a comma list of checks that fail the run (default any).", optional: true }),
    only: field.string({ label: "Only", description: "A comma list of checks to run (default all).", optional: true }),
    times: field.string({ label: "Times file", description: "The per-unit times that balance the shards.", optional: true }),
    workers: field.string({ label: "Workers", description: "Matrix cells run side by side in one browser.", optional: true }),
    cells: field.string({ label: "Cells", description: "A comma list of cell key texts to keep, for a quick local run.", optional: true }),
    engine: field.string({ label: "Engine", description: "Browser engines every web flow runs on: chromium, webkit, msedge.", optional: true }),
    target: field.string({ label: "Target", description: "What the flows run against, recorded in report.json's provenance.", optional: true }),
    targetVersion: field.string({ label: "Target version", description: "The target's version, recorded in provenance.", optional: true }),
    slack: field.number({ label: "Slack", description: "Scales every maxMs budget (default 1).", optional: true, min: 0 }),
    config: field.string({ label: "Config", description: "The flow-review.config.json to use.", optional: true }),
    headed: field.boolean({ label: "Headed", description: "Show the browser; refused outside CI.", optional: true }),
    evidenceMax: field.string({ label: "Evidence cap", description: "The most evidence to keep: bytes, KB, MB or none.", optional: true }),
    constrained: field.string({ label: "Constrained profile", description: "Slow every page through DevTools, or off.", optional: true }),
    knownFailing: field.string({ label: "Known failing list", description: "The list of cells that fail today, each with its issue.", optional: true }),
  },
  output: { report },
});

export const list = defineAction({
  id: "list_units",
  cli: "list",
  consent: "read",
  label: "List units",
  description: "Print the units and how the shards split them, without running anything.",
  agent: "Print every unit the flows expand to and how shards split them. Runs nothing.",
  input: {
    shard: field.string({ label: "Shard", description: "k/n, to count one shard.", optional: true }),
    times: field.string({ label: "Times file", description: "The per-unit times that balance the shards.", optional: true }),
    engine: field.string({ label: "Engine", description: "Browser engines to list.", optional: true }),
    config: field.string({ label: "Config", description: "The flow-review.config.json to use.", optional: true }),
  },
  output: { units: field.string({ label: "Units", description: "The listed shards and their units." }) },
});

export const merge = defineAction({
  id: "merge_reports",
  cli: "merge",
  consent: "write",
  label: "Merge reports",
  description: "Combine shard reports into one report.",
  agent: "Combine shard report folders into one report.json, checking that each expected unit ran exactly once. Exit 3 when a failing unit is missing or ran twice.",
  input: {
    out: field.string({ label: "Output folder", description: "Where the merged report is written (default report).", optional: true }),
    flows: field.string({ label: "Flows", description: "A glob of the flows whose units are expected.", optional: true }),
    engine: field.string({ label: "Engine", description: "The engines the merge expects.", optional: true }),
    failOn: field.string({ label: "Fail on", description: "any, none, or a comma list of checks.", optional: true }),
    coverage: field.string({ label: "Coverage", description: "gated (default) or strict.", optional: true }),
    config: field.string({ label: "Config", description: "The flow-review.config.json to use.", optional: true }),
    knownFailing: field.string({ label: "Known failing list", description: "The list of cells that fail today.", optional: true }),
  },
  output: { report },
});

export const times = defineAction({
  id: "record_times",
  cli: "times",
  consent: "write",
  label: "Record times",
  description: "Record each unit's time from reports, to balance the next run's shards.",
  agent: "Write each unit's measured time from the report folders to the times file, which the next run uses to balance shards.",
  input: {
    out: field.string({ label: "Times file", description: "Where the times are written (default flows/flow-review-times.json).", optional: true }),
  },
  output: { file: field.string({ label: "Times file", description: "The file written." }) },
});

export const summary = defineAction({
  id: "print_summary",
  cli: "summary",
  consent: "read",
  label: "Print summary",
  description: "Print the markdown summary of a report.",
  agent: "Print the markdown summary of report/report.json.",
  input: {},
  output: { summary: field.string({ label: "Summary", description: "The markdown summary." }) },
});

export const judge = defineAction({
  id: "judge_merge",
  cli: "judge",
  consent: "write",
  label: "Fold in judges",
  description: "Fold judges' rubric answers into the report.",
  agent: "Validate the judges' rubric answer files and fold them into report.json. Exit 2 when one is invalid.",
  input: {
    merge: field.boolean({ label: "Merge", description: "Fold the rubric answer files named after it into the report.", optional: true }),
    report: field.string({ label: "Report folder", description: "The report folder to update (default report).", optional: true }),
  },
  output: { report },
});

export const knownFailing = defineAction({
  id: "check_known_failing",
  cli: "known-failing",
  consent: "read",
  label: "Check known failing",
  description: "Check that a known-failing list is valid and has not grown.",
  agent: "Check a known-failing list is valid. With base, exit 1 when it grew against the base list: the list only shrinks.",
  input: {
    check: field.string({ label: "List", description: "The known-failing list to check.", optional: true }),
    base: field.string({ label: "Base list", description: "The base branch's list to compare against.", optional: true }),
    count: field.boolean({ label: "Count", description: "Print how many entries the list has.", optional: true }),
  },
  output: { entries: field.integer({ label: "Entries", description: "How many entries the list has.", min: 0 }) },
});

export const validate = defineAction({
  id: "validate_flows",
  cli: "validate",
  consent: "read",
  label: "Validate flows",
  description: "Load and validate flows without running them.",
  agent: "Load and validate the flows named by the globs, printing one ok line per flow. Runs nothing.",
  input: {
    config: field.string({ label: "Config", description: "The flow-review.config.json to use.", optional: true }),
  },
  output: { flows: field.integer({ label: "Flows", description: "How many flows loaded.", min: 0 }) },
});

export default defineActions("flow-review", [run, list, merge, times, summary, judge, knownFailing, validate], { tool: "flow-review" });
