# Gating merges with flow-review

**Start here (30 seconds).** Start every check as advisory: it reports, it never blocks. Promote a check to a gate one at a time, once main is at zero failures for it and it has shown it doesn't cry wolf. Keep checks that depend on the runner's speed advisory for good. Give the gate one job that a merge must pass, prove it fails by planting a defect, and if it ever blocks a correct change, send that check back to advisory the same day. You can enforce all of this without admin rights on the repository.

Words used here:

- **Advisory:** the check runs and its failures show red in the report and summary, but the job passes.
- **Gated:** a failure fails the job that merges must pass.
- **False positive:** a failing finding that, on inspection, isn't a defect.

## Patterns that worked

### 1. Report first, then gate check by check

`--fail-on` (and a flow's `failOn`) takes a list of checks, so a workflow can gate some and report the rest. A check is ready to gate when:

- main has **zero** failures for it (otherwise every pull request inherits main's red);
- **1% or fewer** of its failing findings over the trial period were false, and none in the last few days;
- the whole workflow's **95th percentile stays under your time budget** (ours is 10 minutes).

Deterministic DOM checks (`axe`, `overflow`, `contrast`, `targetSize`, `keyboard`, `focusVisible`, `states`) are the usual first set. Gate the ones main is already clean on now, and let the rest earn it.

### 2. Keep machine-dependent checks advisory

`jank` (long tasks and slow frames) and `cls` measure the runner as much as your code: on shared runners the same page's long task varies widely between runs of the same job. Report them. If you want them to gate, gate them on a pinned runner class, or as a ratchet against main's own last run, never against an absolute number on shared runners.

### 3. One job is the gate

Run the shards with the gated checks, then merge them in one job, the gate, with the same `fail-on`. Its report still lists every finding, advisory ones included, and its merge also fails when a gated cell is missing, so a cancelled shard can't turn into a silent pass.

```yaml
env:
  FLOWS: flows/site/*.flow.ts
  FAIL_ON: axe,overflow          # the one line that decides what gates
jobs:
  site:
    runs-on: ubuntu-latest
    strategy: { fail-fast: false, matrix: { shard: [1/3, 2/3, 3/3] } }
    steps:
      - uses: actions/checkout@v4
      - uses: ourostack/flow-review@v0.3.2
        with: { flows: "${{ env.FLOWS }}", shard: "${{ matrix.shard }}", fail-on: "${{ env.FAIL_ON }}" }
  gate:
    name: flow-review gate
    needs: site
    if: ${{ !cancelled() }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        with: { pattern: "flow-review-*-of-3", path: shards }
      - uses: ourostack/flow-review@v0.3.2
        with: { command: merge, reports: "shards/*", flows: "${{ env.FLOWS }}", fail-on: "${{ env.FAIL_ON }}" }
```

**A check you require must always report.** Don't put a path filter on the workflow: a required check a filter skips never reports, and merges wait for it forever. Decide what to run in a first job instead, and let the gate pass in seconds when nothing it covers changed. Fail closed: if that first job can't tell what changed, the gate fails.

### 4. Every exception has a reason and an issue

A threshold, a skip or an ignored selector in a flow is an exception. Write its reason and an issue number in a comment right above it, and remove it with the issue. Add a test to your repository that fails when an exception to a gated check has no issue number: it keeps the list honest without anyone policing it.

### 5. One false positive sends it back

When a gated check blocks a correct change: take it out of `FAIL_ON`, open an issue with the finding, fix the engine or the flow, and gate it again once main is back at zero. Don't merge over it, and don't widen the threshold to make it pass.

### 6. Prove the gate with a planted defect

Open a throwaway draft pull request that breaks what the gate checks: for example, a button whose visible label isn't in its accessible name, and an image with no `alt`. Watch every shard and the gate go red on exactly those checks while the advisory checks only report. Then close it unmerged and delete the branch. A gate you haven't seen fail isn't a gate.

### 7. Keep pull-request gates and release gates apart

The merge gate protects main. A release has its own gates, run against the built candidate (`--target`), and a site check on pull requests should never be able to stop a release. Don't call the merge gate from a release workflow.

## Enforce it without admin rights

Normally an admin marks `flow-review gate` as a required check in the branch rules. If nobody on the team can, enforce it where you can:

1. **Merge through a wrapper.** A small script reads every check run and status on the pull request's head (only the latest attempt of each), refuses while anything is red, pending or missing, and merges with `gh pr merge --squash --match-head-commit <sha>`, so a push after the read refuses instead of merging unchecked code. No `--force`. Make it the only documented way to merge, for people and agents alike.
2. **Watch main.** When the gate fails on a push to main (main includes everything merged since a pull request ran), a workflow opens an issue for the commit and comments on the pull request, mentioning its author. Put a marker in both, such as `gate-watch-commit: <sha>`, so a rerun never files twice. It needs only the workflow's own token.
3. **Ship only green.** Whatever ships, a release job or a deploy, reads the gate on the exact commit it ships and skips a commit whose gate didn't pass.
4. **Ask for the rule anyway.** A required check is still better. Until someone with admin rights adds it, a red gate blocks by convention: nobody merges over it.

A time-budget check is the one exception worth making in the wrapper: if a "budget" job fails only because runners were queued, warn and don't block, and keep every other red blocking.

## Where outside actions aren't allowed

Some organizations only run actions from their own repositories. A run that fails at startup before any step is the sign. Copy this repository at a release tag into yours as a local action (`.github/actions/flow-review/`), record the tag and commit beside it, and use `uses: ./.github/actions/flow-review`. Update it by copying the next tag, never by editing the copy. The copy still uses GitHub's own `actions/*` (setup-node, cache, upload-artifact), so those must be allowed.
