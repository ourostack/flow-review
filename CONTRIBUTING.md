# Contributing

Issues and pull requests are welcome.

- Node 22.18 or newer. `npm ci && npx playwright install --only-shell chromium && npm test` runs every test locally; CI runs the same tests and the action on the fixture flows.
- A new check, or a change to what one measures, comes with a test that plants the defect in a fixture page and shows the check failing it and passing the clean page.
- Keep the engine product-neutral: no product's names, hosts or data in the code, tests or fixtures. Anything a product needs goes in its own `flow-review.config.json` or its flows.
- The JSON Schemas in `schema/` are the contract: a change that breaks an existing flow or report needs a new schema version.
- Pin third-party actions to a full commit, with the version in a comment.
- Releases are tags (`v<major>.<minor>.<patch>`) on a green `main`, with the version in `package.json` to match.

By contributing, you agree that your contributions are licensed under the [MIT licence](LICENSE).
