// The actions are declared once and generated: the committed generated files match the declarations, and the CLI
// takes exactly the flags each declared command declares.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const generated = join(root, 'actions', 'generated');
const declared = JSON.parse(readFileSync(join(generated, 'commands.json'), 'utf8')).commands;

test('the generated files match their declarations, from the pinned generator', () => {
  const check = spawnSync(process.execPath, ['tools/ouro-actions/ouro-actions.mts', 'check', 'actions/flow-review.actions.mts', 'actions/generated'], { cwd: root, encoding: 'utf8' });
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.equal(JSON.parse(readFileSync(join(generated, 'actions.json'), 'utf8')).generator, 'ouro-actions 0.16.0');
});

test('each declared command is registered by the CLI, and rejects a flag it does not declare', () => {
  assert.ok(declared.length > 0);
  for (const def of declared) {
    const out = spawnSync(process.execPath, ['bin/flow-review.mjs', def.name, '--not-a-declared-flag'], { cwd: root, encoding: 'utf8' });
    assert.equal(out.status, 2, `${def.name}: ${out.stderr}`);
    assert.match(out.stderr, /Unknown option/, def.name);
    assert.ok(!/unknown command/.test(out.stderr), `${def.name} is not registered`);
  }
});
