// The package API. Flow files import `defineFlow` (it only returns its argument: it exists for types and editor help);
// other repositories' tests import `checks` and `expectNoFindings` to use any check as a conformance test.
export const defineFlow = (flow) => flow;
export { CHECKS, DEFAULT_THRESHOLDS } from './constants.mjs';
export { checks, expectNoFindings, traverse } from './checks.mjs';
export { assertHeadless, headfulReasons, launchBrowser, isCI } from './browser.mjs';
export { runParity, detect, meets, valueAt, hashKey, pickSamples, guardContext, readOnlyLoopback, launchGuarded, expectHook, fill, validateParitySpec, parityTable, parityIssues, parityBaseline, parityCompare, PARITY_STATUSES } from './parity.mjs';
// Constrained computer: run anything as on a slow old laptop, and slow browser pages the same way.
export { PROFILES, DEFAULT_PROFILE, CONSTRAINED_ENV, resolveSettings, constrainedFromEnv, bannerLine } from './constrain-profile.mjs';
export { launchConstrained, runConstrainedCommand, pickMechanisms, constrainedEnv, CONSTRAINED_SCHEMA } from './constrain.mjs';
export { constrainPage, constrainContext, constrainCdp, applyCdpConstraints } from './constrain-cdp.mjs';
export { startDelayProxy } from './constrain-proxy.mjs';
export { spin, timeSpin, baseline as calibrationBaseline, factorOf } from './constrain-calibrate.mjs';
