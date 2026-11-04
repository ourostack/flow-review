# Contributing

Issues and pull requests are welcome.

- Node 22.18 or newer. `npm ci && npx playwright install --only-shell chromium && npm test` runs every test locally on Chromium; CI runs the same tests on Chromium and on WebKit (`FLOW_REVIEW_ENGINE=webkit`, after `npx playwright install --with-deps webkit`), the engine-parity tests (`FLOW_REVIEW_PARITY=1`, both browsers) and the action on the fixture flows, Edge on Windows included.
- A check behaves the same on every engine ([Engines](README.md#engines)). Where an engine lacks what it measures with, measure another way that is never looser, put the `method` on the finding and add the gap to `GAPS` in `lib/engines.mjs` and the README's table; never let it pass quietly.
- A new check, or a change to what one measures, comes with a test that plants the defect in a fixture page and shows the check failing it and passing the clean page.
- No harness may load the computer it runs on: never spawn `yes`, `stress` or `stress-ng`, or loop without end. `test/no-load-generators.test.mjs` enforces it; the only CPU-burning loops allowed are the bounded calibration loops it names. The constrained-computer tests run only in CI or on a declared sandbox (`FLOW_REVIEW_CONSTRAIN_SANDBOX=1`, never on a computer someone works on), and are skipped elsewhere.
- Keep the engine product-neutral: no product's names, hosts or data in the code, tests or fixtures. Anything a product needs goes in its own `flow-review.config.json` or its flows.
- The JSON Schemas in `schema/` are the contract: a change that breaks an existing flow or report needs a new schema version.
- Pin third-party actions to a full commit, with the version in a comment.
- Releases are tags (`v<major>.<minor>.<patch>`) on a green `main`, with the version in `package.json` to match.

By contributing, you agree that your contributions are licensed under the [MIT licence](LICENSE).
