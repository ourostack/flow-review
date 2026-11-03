// The gate: the first process in a constrained tree. `flow-review constrain` starts it, measures the calibration loop
// here before and after putting this process under the constraint, and only then has it start the command, so the
// command and everything it starts are constrained from their first instruction.
import { spawn } from 'node:child_process';
import { baseline, timeSpin } from './constrain-calibrate.mjs';

let child = null;
let base = null;
const send = (m) => process.send?.(m);

process.on('message', (m) => {
  if (m.type === 'calibrate') {
    base = baseline(m.targetMs ?? 150);
    send({ type: 'baseline', iterations: base.iterations, ms: base.ms });
  } else if (m.type === 'measure') {
    send({ type: 'measured', ms: timeSpin(base.iterations, m.samples ?? 3) });
  } else if (m.type === 'run') {
    let done = false;
    const finish = (msg) => { if (!done) { done = true; process.send(msg, () => process.disconnect()); } };
    try {
      child = spawn(m.command, m.args, { cwd: m.cwd, env: m.env, stdio: 'inherit', shell: m.shell, windowsHide: true });
    } catch (e) {
      finish({ type: 'exit', code: 127, signal: null, error: e.message });
      return;
    }
    child.on('error', (e) => finish({ type: 'exit', code: 127, signal: null, error: e.message }));
    child.on('spawn', () => send({ type: 'started', pid: child.pid }));
    child.on('exit', (code, signal) => finish({ type: 'exit', code, signal }));
  } else if (m.type === 'signal') {
    try { child?.kill(m.name); } catch { /* already gone */ }
  } else if (m.type === 'abort') {
    process.disconnect?.();
  }
});

// The parent going away ends the command too: a constrained tree never outlives the run that constrains it.
process.on('disconnect', () => {
  if (child && child.exitCode === null && child.signalCode === null) {
    try { child.kill('SIGKILL'); } catch { /* already gone */ }
  }
  setTimeout(() => process.exit(0), 50).unref();
});

send({ type: 'hello', pid: process.pid });
