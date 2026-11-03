// No harness here may load the computer it runs on: nothing spawns `yes`, `stress` or `stress-ng`, and nothing spins
// without end. The scan covers the engine, its CLI, its tests and fixtures, the workflows, the action and the npm
// scripts. The only CPU-burning loops allowed are the calibration loops listed in ALLOWED, each bounded by its
// iteration count; the test checks they are still there and still bounded, so the list can't go stale.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SELF = path.join('test', 'no-load-generators.test.mjs');

const GENERATOR = '(?:yes|stress|stress-ng)(?:\\.exe)?';
const RULES = {
  // spawn('yes'), execFile('/usr/bin/stress-ng', ...), exec('yes > /dev/null'), spawn('sh', ['-c', 'stress --cpu 8'])
  spawn: new RegExp(`\\b(?:spawn|spawnSync|execFile|execFileSync|fork)\\s*\\(\\s*['"\`](?:[^'"\`\\s]*[/\\\\])?${GENERATOR}['"\`]`),
  shellString: new RegExp(`(?:\\b(?:exec|execSync)\\s*\\(\\s*|['"](?:-c|/c|-Command)['"]\\s*,\\s*)['"\`](?:[^'"\`]*?[\\s;&|(])?${GENERATOR}(?=[\\s;&|)>'"\`])`),
  // A shell line, in a workflow's run, a script or an npm script.
  shellLine: new RegExp(`(?:^|[\\s;&|(\`$])${GENERATOR}(?=$|[\\s;&|)>])`),
  // for (;;), while (true), while (1), while (!0), do { } while (true), and the shell's while true / while :
  unboundedJs: /\bfor\s*\(\s*;\s*;\s*\)|\bwhile\s*\(\s*(?:true|1|!0|!false)\s*\)/,
  unboundedShell: /\bwhile\s+(?:true|:|\[\s*1\s*\])\s*(?:;|$)|\bwhile\s*\(\s*\$true\s*\)|\bfor\s*\(\s*;\s*;\s*\)/i,
  // A function that burns CPU by name: spin, burn, busy..., hog..., stress...
  burner: /(?:\bfunction\s+|\b(?:const|let|var)\s+|\.)(spin|burn\w*|busy\w*|hog\w*|stress\w*)\s*(?:\(|=|\?\?=)|(__\w*[Ss]pin)\s*\?\?=/,
};

// The calibration loops: a fixed number of iterations, timed. Each entry must be found, and bounded by its argument.
const ALLOWED = [
  { file: path.join('lib', 'constrain-calibrate.mjs'), match: 'export function spin(iterations)', bounded: /export function spin\(iterations\) \{\s*let x = 1;\s*for \(let i = 0; i < iterations; i\+\+\)/ },
  { file: path.join('lib', 'constrain-cdp.mjs'), match: "const spin = (globalThis.__flowReviewSpin ??= (n) =>", bounded: /__flowReviewSpin \?\?= \(n\) => \{ let x = 1; for \(let i = 0; i < n; i\+\+\)/ },
  // The type of the first, exported: a declaration, no loop.
  { file: path.join('lib', 'index.d.ts'), match: 'export declare function spin(iterations: number): number;', bounded: /export declare function spin\(iterations: number\): number;/ },
];

const SOURCE = /\.(?:mjs|cjs|js|ts|ps1|sh|yml|yaml)$/;
function files() {
  const out = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = path.join(dir, e.name);
      if (e.isDirectory()) { if (!['node_modules', '.scratch', '.git'].includes(e.name)) walk(rel); } else if (SOURCE.test(e.name)) out.push(rel);
    }
  };
  for (const dir of ['lib', 'bin', 'test', path.join('.github', 'workflows')]) if (fs.existsSync(path.join(root, dir))) walk(dir);
  for (const f of ['action.yml', 'action.yaml']) if (fs.existsSync(path.join(root, f))) out.push(f);
  return out.filter((f) => f !== SELF);
}

// A line's code without its comment: whole comment lines, and a trailing `// ` comment (a URL's // has no space before).
const code = (line, kind) => {
  const t = line.trim();
  if (kind === 'js') return /^(\/\/|\/\*|\*)/.test(t) ? '' : line.replace(/\s\/\/\s.*$/, '');
  return t.startsWith('#') ? '' : line.replace(/\s#\s.*$/, '');
};

/** Every place in `text` (a file named `file`, read as `kind`) that loads the computer, as `file:line: why`. */
function scan(file, text, kind = /\.(?:mjs|cjs|js|ts)$/.test(file) ? 'js' : /\.ya?ml$/.test(file) ? 'yaml' : 'shell') {
  const found = [];
  const lines = text.split('\n');
  let runIndent = -1;
  lines.forEach((raw, i) => {
    const line = code(raw, kind);
    const at = `${file}:${i + 1}`;
    if (!line.trim()) return;
    if (kind === 'js') {
      if (RULES.spawn.test(line) || RULES.shellString.test(line)) found.push(`${at}: starts a load generator (yes, stress or stress-ng)`);
      if (RULES.unboundedJs.test(line)) found.push(`${at}: an unbounded loop`);
      const b = line.match(RULES.burner);
      if (b && !ALLOWED.some((a) => a.file === file && line.includes(a.match))) found.push(`${at}: a CPU-burning function (${b[1] ?? b[2]}) not in the allowed calibration loops`);
      return;
    }
    let shell = line;
    if (kind === 'yaml') {
      // Only a step's run is a shell: `run: cmd`, or the lines of a `run: |` block.
      const indent = raw.search(/\S/);
      if (runIndent >= 0 && indent > runIndent) shell = line;
      else {
        runIndent = -1;
        const m = line.match(/^(\s*)(?:-\s+)?run:\s*(.*)$/);
        if (!m) return;
        if (/^[|>][-+]?\s*$/.test(m[2])) { runIndent = m[1].length; return; }
        shell = m[2];
      }
    }
    if (RULES.shellLine.test(shell)) found.push(`${at}: runs a load generator (yes, stress or stress-ng)`);
    if (RULES.unboundedShell.test(shell)) found.push(`${at}: an unbounded loop`);
  });
  return found;
}

test('the scan finds load generators and endless loops, and lets the calibration loops be', () => {
  const planted = {
    'a.mjs': ["spawn('yes', [], { stdio: 'ignore' });", "execFile('/usr/bin/stress-ng', ['--cpu', '8']);", "exec('yes > /dev/null &');", "spawn('sh', ['-c', 'stress --cpu 4']);", "spawnSync('stress.exe');", 'for (;;) x++;', 'while (true) {}', 'while(1) step();', 'function spin(n) { for (let i = 0; i < n; i++); }', 'const burnCpu = () => {};', 'const busyWait = (ms) => {};'],
    'w.yml': ['steps:', '  - run: yes > /dev/null &', '  - run: |', '      sudo apt-get install -y stress-ng', '      while true; do :; done', '  - name: fine', '    with:', '      answer: yes'],
    's.sh': ['stress --cpu 2 &', 'while :; do :; done'],
    'p.ps1': ['while ($true) { }'],
  };
  const hits = Object.entries(planted).flatMap(([f, lines]) => scan(f, lines.join('\n')));
  const at = (f) => hits.filter((h) => h.startsWith(`${f}:`)).map((h) => Number(h.split(':')[1]));
  assert.deepEqual([...new Set(at('a.mjs'))], [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], hits.join('\n'));
  assert.deepEqual([...new Set(at('w.yml'))], [2, 4, 5], 'a run line, and a run block, but not a value that happens to be yes');
  assert.deepEqual([...new Set(at('s.sh'))], [1, 2]);
  assert.deepEqual(at('p.ps1'), [1]);
  assert.equal(scan('package.json scripts.load', 'yes > /dev/null & npm test', 'shell').length, 1, 'an npm script');

  const fine = [
    "// spawn('yes') in a comment, and while (true) too",
    "const answer = 'yes';",
    "const label = 'Say yes to continue';",
    'for (let i = 0; i < iterations; i++) x++;',
    'while (Atomics.load(s, 0) === 0) sleep(10);',
    "const [busy] = failing(findings);",
    "const r = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)']);",
    "export function timeSpin(iterations, samples = 3) {",
  ];
  assert.deepEqual(scan('b.mjs', fine.join('\n')), []);
  assert.deepEqual(scan(ALLOWED[0].file, 'export function spin(iterations) {'), [], 'an allowed calibration loop');
  assert.equal(scan('lib/other.mjs', 'export function spin(iterations) {').length, 1, 'allowed only where it is listed');
});

test('nothing in this repository spawns yes, stress or stress-ng, or spins without end', () => {
  const all = files();
  assert.ok(all.some((f) => f.startsWith(path.join('.github', 'workflows'))) && all.includes(path.join('lib', 'constrain.mjs')) && all.includes(path.join('test', 'fixtures', 'constrain', 'tree.mjs')), 'the scan covers the workflows, the engine and the fixtures');
  const found = all.flatMap((f) => scan(f, fs.readFileSync(path.join(root, f), 'utf8')));
  const { scripts = {} } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  for (const [name, line] of Object.entries(scripts)) found.push(...scan(`package.json scripts.${name}`, line, 'shell'));
  assert.deepEqual(found, [], `a harness here would load the computer it runs on:\n${found.join('\n')}`);
});

test('the calibration loops allowed to burn CPU are where the list says, and bounded by their iteration count', () => {
  for (const a of ALLOWED) {
    const text = fs.readFileSync(path.join(root, a.file), 'utf8');
    assert.ok(text.includes(a.match), `${a.file} still defines ${a.match}`);
    assert.match(text, a.bounded, `${a.file}'s loop is bounded by its argument`);
  }
});
