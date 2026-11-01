// The package API. Flow files import `defineFlow` (it only returns its argument: it exists for types and editor help);
// other repositories' tests import `checks` and `expectNoFindings` to use any check as a conformance test.
export const defineFlow = (flow) => flow;
export { CHECKS, DEFAULT_THRESHOLDS } from './constants.mjs';
export { checks, expectNoFindings, traverse } from './checks.mjs';
