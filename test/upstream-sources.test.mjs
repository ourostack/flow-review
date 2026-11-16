// The vendored Ouro kits are the releases' files, byte for byte: each file's sha256 is the one the lock records, every
// file under lib/ouro-ui and tools/ouro-actions is listed, and the generator's copies match the release's manifest.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const lock = JSON.parse(readFileSync(join(root, 'upstream-sources.lock.json'), 'utf8'));
const sha256 = (path) => createHash('sha256').update(readFileSync(join(root, path))).digest('hex');
const allFiles = lock.sources.flatMap((source) => source.files);

function filesUnder(dir) {
  return readdirSync(join(root, dir)).flatMap((name) => {
    const path = join(dir, name);
    return statSync(join(root, path)).isDirectory() ? filesUnder(path) : [path];
  });
}

test('the lock is schema 1, names the Ouro UI and Ouro UI core tags, and gives each file its hash', () => {
  assert.equal(lock.schemaVersion, 1);
  assert.deepEqual(lock.sources.map((s) => s.repository), ['ourostack/ouro-ui', 'ourostack/ouro-ui-core']);
  for (const source of lock.sources) assert.match(source.commit, /^[0-9a-f]{40}$/);
});

test('each vendored file matches the sha256 the lock records', () => {
  for (const file of allFiles) {
    assert.equal(sha256(file.generatedPath), file.sha256, `${file.generatedPath} differs from ${file.sourcePath}`);
  }
});

test('every file under lib/ouro-ui and tools/ouro-actions is listed in the lock, and nothing else', () => {
  const listed = allFiles.map((file) => file.generatedPath).sort();
  const present = [...filesUnder('lib/ouro-ui'), ...filesUnder('tools/ouro-actions')].sort();
  assert.deepEqual(present, listed);
});

test('the core generator is the one the core release manifest records', () => {
  const manifest = JSON.parse(readFileSync(join(root, 'tools/ouro-actions/dist-manifest.json'), 'utf8'));
  assert.equal(manifest.coreTag, 'v0.16.0');
  assert.equal(manifest.files['dist/actions/ouro-actions.mts'], sha256('tools/ouro-actions/ouro-actions.mts'));
  assert.equal(manifest.files['dist/ax/actions.claims.json'], sha256('tools/ouro-actions/actions.claims.json'));
});
