#!/usr/bin/env node
// A stand-in release candidate: a tiny CLI with the shape of a product's agent CLI.
const [cmd, ...rest] = process.argv.slice(2);
const items = [{ id: 1, title: 'Weekly sync' }, { id: 2, title: '1:1 with Pat' }];
const out = (v) => process.stdout.write(`${JSON.stringify(v)}\n`);
if (cmd === '--version') console.log('candidate 1.2.3');
else if (cmd === 'today') out({ items, sync: { state: 'ok' } });
else if (cmd === 'show') out(items.find((i) => String(i.id) === rest[0]) ?? null);
else if (cmd === 'log') out([]);
else if (cmd === 'slow') { console.error('slow is not built yet. Fix: candidate today'); process.exitCode = 1; }
else { console.error(`no such command: ${cmd}. Fix: candidate today`); process.exitCode = 2; }
