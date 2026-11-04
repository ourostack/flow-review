// The agent side: run a command (agent-cli) or send a request (agent-http) and check what comes back, deterministically.
// Steps take two expectation styles: JSON Schema with { mustMatch, mustNotMatch } rules, and a path style (jsonShape as
// paths, fields as matches, named stderr rules, text and output budgets).
import { spawn } from 'node:child_process';
import path from 'node:path';
import { shapeValidator } from './schema.mjs';

/** Runs argv without a shell; resolves { code, stdout, stderr, ms, timedOut }. `signal` kills it. */
export function runCommand(argv, { cwd, env, stdin, timeoutMs = 60_000, signal } = {}) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    const child = spawn(argv[0], argv.slice(1), { cwd, env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '', timedOut = false;
    child.stdout.on('data', (d) => (stdout += d));
    child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, timeoutMs);
    const kill = () => child.kill('SIGKILL');
    if (signal?.aborted) kill();
    signal?.addEventListener('abort', kill, { once: true });
    const done = () => { clearTimeout(timer); signal?.removeEventListener('abort', kill); };
    child.on('error', (e) => { done(); resolve({ code: 127, stdout, stderr: stderr + String(e.message), ms: performance.now() - t0, timedOut }); });
    child.on('close', (code) => { done(); resolve({ code: code ?? 1, stdout, stderr, ms: performance.now() - t0, timedOut }); });
    child.stdin.on('error', () => {});
    if (stdin !== undefined) child.stdin.end(stdin);
    else child.stdin.end();
  });
}

export async function sendRequest(base, req, timeoutMs = 60_000, signal) {
  const t0 = performance.now();
  const url = new URL(req.path, base).href;
  const body = req.body === undefined ? undefined : typeof req.body === 'string' ? req.body : JSON.stringify(req.body);
  const headers = { ...(body && typeof req.body !== 'string' ? { 'content-type': 'application/json' } : {}), ...req.headers };
  try {
    const res = await fetch(url, { method: req.method ?? (body ? 'POST' : 'GET'), headers, body, signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs) });
    const text = await res.text();
    return { status: res.status, stdout: text, stderr: '', ms: performance.now() - t0 };
  } catch (e) {
    return { status: 0, stdout: '', stderr: String(e.message), ms: performance.now() - t0 };
  }
}

/**
 * Every value at a path: "a.b", "a[0]", "a[-1]" (the last), "a[].b" (every element), "a[subject~^Weekly].id" (the
 * elements whose field matches, ignoring case), "a.length". `fan` says whether the path spreads over elements.
 */
export function at(doc, p) {
  let values = [doc];
  let fan = false;
  const field = (v, k) => (Array.isArray(v) ? (k === 'length' ? v.length : /^\d+$/.test(k) ? v[+k] : undefined) : v && typeof v === 'object' ? v[k] : undefined);
  for (const part of p.split(/\.(?![^[]*\])/).filter(Boolean)) {
    const m = /^([^[]*)((?:\[[^\]]*\])*)$/.exec(part);
    if (!m) return { values: [], fan };
    const [, key, idx] = m;
    if (key) values = values.map((v) => field(v, key));
    for (const i of idx.match(/\[[^\]]*\]/g) ?? []) {
      const n = i.slice(1, -1);
      const filter = /^(\w+)~(.*)$/.exec(n);
      if (n === '') { fan = true; values = values.flatMap((v) => (Array.isArray(v) ? v : [])); }
      else if (filter) {
        fan = true;
        const re = new RegExp(filter[2], 'i');
        values = values.flatMap((v) => (Array.isArray(v) ? v.filter((x) => re.test(String(field(x, filter[1]) ?? ''))) : []));
      } else if (/^-?\d+$/.test(n)) values = values.map((v) => (Array.isArray(v) ? v.at(+n) : undefined));
      else return { values: [], fan };
    }
  }
  return { values, fan };
}

const typeOf = (v) => (Array.isArray(v) ? 'array' : v === null ? 'null' : typeof v);
const MATCHER_KEYS = ['exists', 'matches', 're', 'oneOf', 'gte', 'lte', 'type'];

/** One value against a literal (deep equal) or a matcher { exists, matches|re, oneOf, gte, lte, type }. */
export function fieldOk(value, want) {
  const matcher = want && typeof want === 'object' && !Array.isArray(want) && Object.keys(want).length && Object.keys(want).every((k) => MATCHER_KEYS.includes(k));
  if (!matcher) return JSON.stringify(value) === JSON.stringify(want);
  if ('exists' in want && (value !== undefined) !== want.exists) return false;
  if ('type' in want && typeOf(value) !== want.type) return false;
  const re = want.matches ?? want.re;
  if (re !== undefined && !(typeof value === 'string' && new RegExp(re).test(value))) return false;
  if ('oneOf' in want && !want.oneOf.some((x) => x === value)) return false;
  if ('gte' in want && !(typeof value === 'number' && value >= want.gte)) return false;
  if ('lte' in want && !(typeof value === 'number' && value <= want.lte)) return false;
  return true;
}

const short = (s, n = 300) => (s.length > n ? `${s.slice(0, n)}…` : s);
const STACK = /^\s+at .+(:\d+:\d+\)?|\(native\)|<anonymous>\)?)$/m;

/** Turns a result and an expect block into findings. `opts`: { kind: 'cli'|'http', slack, cliNames }. */
export function expectFindings(result, expect = {}, opts = {}) {
  const kind = typeof opts === 'string' ? opts : opts.kind ?? 'cli';
  const slack = opts.slack ?? 1;
  const out = [];
  const f = (check, pass, measured, threshold, fix, extra = {}) => out.push({ check, pass, measured, threshold, fix: pass ? undefined : fix, ...extra });
  if (kind === 'cli') {
    const want = [expect.exit ?? 0].flat();
    f('exit', want.includes(result.code) && !result.timedOut, result.timedOut ? 'timed out' : result.code, want.length === 1 ? want[0] : want, `Exit ${want.join(' or ')}; it exited ${result.code}. stderr: ${short(result.stderr.trim())}`);
  } else {
    // An HTTP step's exit is its status (the agent-flow style), when status isn't given.
    const want = [expect.status ?? expect.exit ?? 200].flat();
    f('status', want.includes(result.status), result.status, want.length === 1 ? want[0] : want, `Answer ${want.join(' or ')}; it answered ${result.status}. ${short(result.stdout.trim() || result.stderr.trim())}`);
  }
  let json;
  let parsed = false;
  if (expect.jsonShape || expect.fields) {
    try { json = JSON.parse(result.stdout); parsed = true; } catch { json = undefined; }
  }
  if (Array.isArray(expect.jsonShape)) {
    for (const p of expect.jsonShape) {
      const { values } = parsed ? at(json, p) : { values: [] };
      const pass = values.length > 0 && values.every((v) => v !== undefined);
      f('jsonShape', pass, pass ? 'present' : parsed ? (values.length ? 'missing' : 'empty') : 'output is not JSON', p, `The JSON should have ${p}.`, { selector: p });
    }
  } else if (expect.jsonShape) {
    const errors = parsed ? shapeValidator(expect.jsonShape)(json) : ['output is not JSON'];
    f('jsonShape', errors.length === 0, errors.length ? errors.join('; ') : 'matches', 'jsonShape', `Make the JSON match its shape: ${errors.join('; ')}`);
  }
  if (expect.fields) {
    for (const [p, want] of Object.entries(expect.fields)) {
      const { values, fan } = parsed ? at(json, p) : { values: [], fan: false };
      const pass = parsed && (fan ? values.some((v) => fieldOk(v, want)) : values.length === 1 && fieldOk(values[0], want));
      f('fields', pass, fan ? `${values.length} values` : short(JSON.stringify(values[0]) ?? 'undefined'), want, `Field ${p} should be ${JSON.stringify(want)}.`, { selector: p });
    }
  }
  const stderrRules = expect.stderrRules;
  if (Array.isArray(stderrRules)) {
    const lines = result.stderr.split('\n').filter((l) => l.trim());
    const names = (opts.cliNames ?? []).map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    const namesFix = new RegExp(`\\bFix: ${names.length ? `|\\b(?:${names.join('|')}) [a-z]` : ''}`);
    for (const rule of stderrRules) {
      const pass = rule === 'empty' ? lines.length === 0 : rule === 'oneLine' ? lines.length === 1 : rule === 'namesFix' ? namesFix.test(result.stderr) : !STACK.test(result.stderr);
      const fix = { empty: 'Say nothing on stderr here.', oneLine: 'Say it in one line on stderr.', namesFix: 'Name the fix on stderr ("Fix: ..." or the command to run).', noStack: 'Print the error, not a stack trace.' }[rule];
      f('stderrRules', pass, rule === 'oneLine' || rule === 'empty' ? `${lines.length} lines` : pass ? 'ok' : short(result.stderr.trim(), 200), rule, fix, { selector: rule });
    }
  } else if (stderrRules) rulesFindings(f, 'stderrRules', 'stderr', result.stderr, stderrRules);
  if (expect.stdoutRules) rulesFindings(f, 'stdoutRules', 'stdout', result.stdout, expect.stdoutRules);
  if (expect.text) {
    const both = `${result.stdout}\n${result.stderr}`;
    for (const has of expect.text.has ?? []) f('text', new RegExp(has, 'm').test(both), new RegExp(has, 'm').test(both) ? 'found' : 'not found', `has /${has}/`, `The output should say /${has}/.`, { selector: has });
    for (const not of expect.text.not ?? []) {
      const m = new RegExp(not, 'm').exec(both);
      f('text', !m, m ? `found "${short(m[0], 80)}"` : 'absent', `not /${not}/`, `The output should not say "${m?.[0]}".`, { selector: not });
    }
  }
  if (expect.maxMs !== undefined) f('maxMs', result.ms <= expect.maxMs * slack, Math.round(result.ms), expect.maxMs * slack, `Answer within ${expect.maxMs * slack} ms (took ${Math.round(result.ms)}).`);
  if (expect.maxBytes !== undefined) {
    const bytes = Buffer.byteLength(result.stdout) + Buffer.byteLength(result.stderr);
    f('maxBytes', bytes <= expect.maxBytes, bytes, expect.maxBytes, `Say it in at most ${expect.maxBytes} bytes (said ${bytes}).`);
  }
  return out;
}

function rulesFindings(f, check, stream, text, rules) {
  for (const re of rules.mustMatch ?? []) {
    const ok = new RegExp(re, 'm').test(text);
    f(check, ok, ok ? 'matched' : 'no match', `must match /${re}/`, `${stream} should match /${re}/.`, { selector: re });
  }
  for (const re of rules.mustNotMatch ?? []) {
    const m = new RegExp(re, 'm').exec(text);
    f(check, !m, m ? `matched "${short(m[0])}"` : 'no match', `must not match /${re}/`, `${stream} should not say "${m?.[0]}".`, { selector: re });
  }
}

const fill = (s, vars) => s.replace(/\{(\w+)\}/g, (all, k) => (k in vars ? String(vars[k]) : all));

async function harness(flow, h, signal) {
  const base = flow.app?.controlUrl;
  if (!base) throw new Error('a harness step needs app.controlUrl');
  const r = await fetch(new URL(h.path, base), { method: h.method ?? 'POST', headers: { 'content-type': 'application/json' }, body: h.body === undefined ? undefined : JSON.stringify(h.body), signal });
  if (!r.ok) throw new Error(`harness ${h.path} answered ${r.status}: ${short(await r.text())}`);
}

const cliArgv = (flow, argv) => [...(flow.app?.cli ?? []), ...argv];

/**
 * Runs an agent flow's steps in order and returns its findings (without flow, cell or surface). Saved values fill
 * later steps' {name} placeholders; a step's `known` defect is carried on its findings; a readOnly flow's
 * app.stateProbe must print the same before and after.
 */
// Another runner's names for the checks, as a flow's `known` may use them: the config's `checkAliases` (old name ->
// check). A name with a dot is looked up whole, then by what comes before the dot (stderr.oneLine -> stderr).
const canonical = (check, aliases = {}) => aliases[check] ?? aliases[check.split('.')[0]] ?? check;

/** The command words of a CLI's top-level help: indented words followed by two or more spaces. */
export const helpWords = (text) => new Set(text.split('\n').map((l) => /^ {1,4}([a-z][\w-]*)\s{2,}/.exec(l)?.[1]).filter(Boolean));

/**
 * `signal` stops the flow (its running command is killed and the step it was on dropped); `onStep` hears each step's
 * name as it starts. A step without its own timeoutMs gets timeouts.stepMs.
 */
export async function runAgentFlow(flow, cwd, { slack = 1, enabled = () => true, signal, onStep = () => {} } = {}) {
  const out = [];
  const stepMs = flow.timeouts?.stepMs;
  const vars = { ...flow.vars };
  const env = flow.app?.env ?? {};
  const probe = async () => (await runCommand(cliArgv(flow, flow.app.stateProbe), { cwd: path.resolve(cwd, flow.app?.cwd ?? '.'), env })).stdout;
  const before = flow.readOnly && flow.app?.stateProbe ? await probe() : null;
  // Every command the flow runs to success is in the CLI's own help, so an agent reading it alone finds them.
  if (flow.surface === 'agent-cli' && flow.app?.help && enabled('listed')) {
    const t0 = performance.now();
    const help = await runCommand(cliArgv(flow, flow.app.help), { cwd: path.resolve(cwd, flow.app?.cwd ?? '.'), env });
    const listed = helpWords(help.stdout);
    const used = [...new Set(flow.steps.filter((s) => s.run && [s.expect?.exit ?? 0].flat().includes(0) && /^[a-z]/.test(s.run[0] ?? '') && s.run[0] !== 'help').map((s) => s.run[0]))];
    const missing = used.filter((w) => !listed.has(w));
    out.push({ step: flow.app.help.join(' '), check: 'listed', pass: missing.length === 0, measured: missing.length ? missing : `${used.length} commands listed`, threshold: 'every command in the top-level help', fix: missing.length ? `List ${missing.join(', ')} in the top-level help.` : undefined, ms: Math.round(performance.now() - t0) });
  }
  for (const [i, s] of flow.steps.entries()) {
    if (signal?.aborted) break;
    const name = s.id ?? `${i + 1}-${s.run ? 'run' : s.request ? 'request' : 'harness'}`;
    onStep(name, s.run ? s.run.join(' ') : s.request ? `${s.request.method ?? 'GET'} ${s.request.path}` : s.harness?.path);
    const t0 = performance.now();
    try {
      if (s.harness) {
        await harness(flow, s.harness, signal);
        out.push({ step: name, check: 'step', pass: true, measured: 'harness', threshold: 'step runs', ms: Math.round(performance.now() - t0) });
        continue;
      }
      // Settled into a value at once, so a failing harness call can't go unhandled while the step runs.
      const during = s.during ? new Promise((r) => setTimeout(r, s.during.afterMs)).then(() => harness(flow, s.during.harness, signal)).then(() => null, (e) => e) : null;
      let result;
      let findings;
      if (s.run) {
        const argv = cliArgv(flow, s.run.map((a) => fill(a, vars)));
        result = await runCommand(argv, { cwd: path.resolve(cwd, s.cwd ?? flow.app?.cwd ?? '.'), env: { ...env, ...s.env }, stdin: s.stdin, timeoutMs: s.timeoutMs ?? stepMs, signal });
        findings = expectFindings(result, s.expect, { kind: 'cli', slack, cliNames: flow.app?.cliNames });
      } else {
        if (!flow.app?.url) throw new Error('an agent-http flow needs app.url');
        const fillAll = (v) => (typeof v === 'string' ? fill(v, vars) : Array.isArray(v) ? v.map(fillAll) : v && typeof v === 'object' ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fillAll(x)])) : v);
        const req = { ...s.request, path: fill(s.request.path, vars), body: fillAll(s.request.body) };
        result = await sendRequest(flow.app.url, req, s.timeoutMs ?? stepMs, signal);
        findings = expectFindings(result, s.expect, { kind: 'http', slack });
      }
      const duringError = await during;
      if (signal?.aborted) break;
      if (duringError) throw duringError;
      const ms = Math.round(result.ms);
      const mine = findings.filter((x) => enabled(x.check)).map((x) => ({ step: name, ...x, ...(s.fix && !x.pass ? { fix: s.fix } : {}), ...(s.known ? { known: s.known } : {}), ms }));
      out.push(...mine);
      if (s.known && mine.every((x) => x.pass)) out.push({ step: name, check: 'known', pass: false, measured: `${s.known} no longer fails`, threshold: 'a known defect still fails', fix: `Remove the step's known mark (${s.known}): it passes now.`, ms });
      if (s.save) {
        let doc;
        try { doc = JSON.parse(result.stdout); } catch { doc = undefined; }
        // A value that isn't there leaves its placeholder as it is, and the steps that use it fail on their own.
        for (const [k, p] of Object.entries(s.save)) {
          const v = doc === undefined ? undefined : at(doc, p).values[0];
          if (v !== undefined && v !== null) vars[k] = String(v);
        }
      }
    } catch (e) {
      if (signal?.aborted) break;
      out.push({ step: name, check: 'step', pass: false, measured: String(e.message).split('\n')[0].slice(0, 300), threshold: 'step runs', ...(s.known ? { known: s.known } : {}), ms: Math.round(performance.now() - t0) });
      break;
    }
  }
  if (before !== null && !signal?.aborted) {
    const after = await probe();
    out.push({ step: '*', check: 'readOnly', pass: after === before, measured: after === before ? 'unchanged' : 'changed', threshold: 'reads change nothing', fix: after === before ? undefined : `A read changed state (${flow.app.stateProbe.join(' ')} differs before and after).`, ms: 0 });
  }
  // Flow-level known defects: check -> issue.
  const known = Object.fromEntries(Object.entries(flow.known ?? {}).map(([k, v]) => [canonical(k, flow.checkAliases), v]));
  for (const x of out) if (!x.known && known[x.check]) x.known = known[x.check];
  return out;
}
