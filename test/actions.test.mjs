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

// The generator stamps its version on each file and `check` ignores the stamp, so an update that regenerates the
// files changes it: the test holds that a generator wrote them, not which release.
test('the generated files match their declarations, and name the generator that wrote them', () => {
  const check = spawnSync(process.execPath, ['tools/ouro-actions/ouro-actions.mts', 'check', 'actions/flow-review.actions.mts', 'actions/generated'], { cwd: root, encoding: 'utf8' });
  assert.equal(check.status, 0, check.stdout + check.stderr);
  assert.match(JSON.parse(readFileSync(join(generated, 'actions.json'), 'utf8')).generator, /^ouro-actions \d+\.\d+\.\d+$/);
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

test('help --json lists every declared command, its effect, and the exit codes the CLI gives', () => {
  const out = spawnSync(process.execPath, ['bin/flow-review.mjs', 'help', '--json'], { cwd: root, encoding: 'utf8' });
  assert.equal(out.status, 0, out.stderr);
  const help = JSON.parse(out.stdout);
  assert.deepEqual(help.commands.map((c) => c.name), declared.map((c) => c.name));
  assert.ok(help.commands.every((c) => c.effect === 'private'));
  assert.deepEqual(help.exitCodes.map((e) => e.code), [0, 1, 2, 3]);
});
