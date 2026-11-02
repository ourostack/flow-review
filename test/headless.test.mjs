// No visible browser outside CI: every launch goes through launchBrowser, which is headless by default and refuses a
// headful request (headless: false, devtools, --headed, PWDEBUG) unless CI=true.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertHeadless, launchBrowser } from '../lib/browser.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const local = { CI: '' };
const ci = { CI: 'true' };

test('headless is the default, and a headful request outside CI throws, naming what asked', () => {
  assert.equal(assertHeadless({}, local).headless, true);
  assert.equal(assertHeadless({ headless: true, args: ['--headless=new'] }, local).headless, true);
  // PWDEBUG=console only logs; it opens no inspector.
  for (const PWDEBUG of ['console', '0', 'false']) assert.equal(assertHeadless({}, { PWDEBUG }).headless, true, PWDEBUG);
  assert.equal(assertHeadless({ ignoreDefaultArgs: ['--mute-audio'] }, local).headless, true);
  assert.equal(assertHeadless({ ignoreDefaultArgs: true, args: ['--headless=new'] }, local).headless, true);
  for (const [options, env, named] of [
    [{ headless: false }, local, /headless: false/],
    [{ devtools: true }, local, /devtools: true/],
    [{ args: ['--headed'] }, local, /argument --headed/],
    [{ args: ['--auto-open-devtools-for-tabs'] }, local, /argument --auto-open-devtools-for-tabs/],
    [{ args: ['--headless=false'] }, local, /argument --headless=false/],
    [{}, { PWDEBUG: '1' }, /PWDEBUG=1/],
    [{}, { npm_config_pwdebug: 'true' }, /npm_config_pwdebug=true/],
    [{}, { npm_package_config_pwdebug: '1' }, /npm_package_config_pwdebug=1/],
    [{ ignoreDefaultArgs: true }, local, /ignoreDefaultArgs: true/],
    [{ ignoreDefaultArgs: ['--headless'] }, local, /ignoreDefaultArgs/],
    [{ headless: false }, { CI: '1' }, /headless: false/],
  ]) assert.throws(() => assertHeadless(options, env), (e) => /refusing to launch a visible browser outside CI/.test(e.message) && named.test(e.message), JSON.stringify([options, env]));
});

test('with CI=true a headful launch is allowed', async () => {
  assert.equal(assertHeadless({ headless: false }, ci).headless, false);
  assert.equal(assertHeadless({}, { ...ci, PWDEBUG: '1' }).headless, true);
  const asked = [];
  const fake = { launch: async (o) => { asked.push(o); return 'browser'; } };
  assert.equal(await launchBrowser(fake, { headless: false }, ci), 'browser');
  await assert.rejects(launchBrowser(fake, { headless: false }, local), /outside CI/);
  assert.deepEqual(asked, [{ headless: false }], 'outside CI the browser type is never asked to launch');
});

test('flow-review run --headed outside CI is refused before anything runs', () => {
  const out = path.join(root, '.scratch', 'headed');
  fs.rmSync(out, { recursive: true, force: true });
  const r = spawnSync(process.execPath, ['bin/flow-review.mjs', 'run', 'test/fixtures/routes/flows/goto-route.flow.json', '--out', out, '--headed'], { cwd: root, encoding: 'utf8', env: { ...process.env, ...local } });
  assert.equal(r.status, 2, r.stderr);
  assert.match(r.stderr, /refusing to launch a visible browser outside CI \(headless: false\)/);
  assert.equal(fs.existsSync(out), false, 'nothing ran');
});

test('every browser launch in the engine and its tests goes through launchBrowser', () => {
  const files = (dir) => fs.readdirSync(path.join(root, dir), { recursive: true }).filter((f) => /\.(mjs|js|ts)$/.test(f)).map((f) => path.join(dir, f));
  const launches = [...files('lib'), ...files('bin'), ...files('test')]
    .filter((f) => f !== path.join('lib', 'browser.mjs') && f !== path.join('test', 'headless.test.mjs'))
    .filter((f) => /\.(launch|launchPersistentContext|launchServer)\s*\(/.test(fs.readFileSync(path.join(root, f), 'utf8')));
  assert.deepEqual(launches, []);
});
