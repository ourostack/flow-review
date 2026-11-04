// The published JSON Schemas and their validators.
import { readFileSync } from 'node:fs';
import Ajv from 'ajv';

const read = (name) => JSON.parse(readFileSync(new URL(`../schema/${name}`, import.meta.url), 'utf8'));

export const SCHEMAS = {
  flow: read('flow-review-0.schema.json'),
  report: read('flow-review-report-0.schema.json'),
  finding: read('finding-0.schema.json'),
  rubric: read('rubric-0.schema.json'),
  config: read('flow-review-config-0.schema.json'),
  parity: read('parity-0.schema.json'),
  'parity-report': read('parity-report-0.schema.json'),
  constrained: read('constrained-0.schema.json'),
};

const ajv = new Ajv({ allErrors: true, strict: false });
const compiled = Object.fromEntries(Object.entries(SCHEMAS).map(([k, s]) => [k, ajv.compile(s)]));

/** Validates `value` against a named schema; returns a list of readable errors (empty when valid). */
export function validate(kind, value) {
  const fn = compiled[kind];
  if (!fn) throw new Error(`no schema named ${kind}`);
  if (fn(value)) return [];
  return formatErrors(fn.errors);
}

export function formatErrors(errors) {
  // anyOf/oneOf produce one error per branch; keep the most specific (deepest) ones so the message points at the field.
  const list = (errors ?? []).filter((e) => !['anyOf', 'oneOf', 'allOf', 'if'].includes(e.keyword));
  const deepest = Math.max(0, ...list.map((e) => e.instancePath.split('/').length));
  const pick = list.filter((e) => e.instancePath.split('/').length >= deepest - 1);
  const out = [...new Set((pick.length ? pick : errors ?? []).map((e) => `${e.instancePath || '/'} ${e.message}${e.params?.additionalProperty ? ` (${e.params.additionalProperty})` : ''}${e.params?.allowedValues ? ` (${e.params.allowedValues.join(', ')})` : ''}`))];
  return out.slice(0, 12);
}

/** A validator for an arbitrary JSON Schema (an agent step's jsonShape). */
export function shapeValidator(schema) {
  const fn = new Ajv({ allErrors: true, strict: false }).compile(schema);
  return (value) => (fn(value) ? [] : formatErrors(fn.errors));
}
