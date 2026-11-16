// The vendored Ouro AX kit is the release's files, byte for byte: each file's sha256 is the one the lock records, and
// no file sits in lib/ouro-ui that the lock does not list.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const lock = JSON.parse(readFileSync(join(root, 'upstream-sources.lock.json'), 'utf8'));
const sha256 = (path) => createHash('sha256').update(readFileSync(join(root, path))).digest('hex');

function filesUnder(dir) {
  return readdirSync(join(root, dir)).flatMap((name) => {
    const path = join(dir, name);
    return statSync(join(root, path)).isDirectory() ? filesUnder(path) : [path];
  });
}

test('the lock is schema 1 and names one source, the Ouro UI tag', () => {
  assert.equal(lock.schemaVersion, 1);
  assert.equal(lock.sources.length, 1);
  assert.equal(lock.sources[0].repository, 'ourostack/ouro-ui');
  assert.match(lock.sources[0].commit, /^[0-9a-f]{40}$/);
});

test('each vendored file matches the sha256 the lock records', () => {
  for (const file of lock.sources[0].files) {
    assert.equal(sha256(file.generatedPath), file.sha256, `${file.generatedPath} differs from ${file.sourcePath}`);
  }
});

test('every file under lib/ouro-ui is listed in the lock, and nothing else', () => {
  const listed = lock.sources[0].files.map((file) => file.generatedPath).sort();
  const present = filesUnder('lib/ouro-ui').sort();
  assert.deepEqual(present, listed);
});
