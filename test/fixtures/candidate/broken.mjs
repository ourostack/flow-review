#!/usr/bin/env node
// A broken candidate: today prints text and a stack trace.
const [cmd] = process.argv.slice(2);
if (cmd === '--version') console.log('candidate 1.2.4-broken');
else if (cmd === 'log') console.log('[]');
else if (cmd === 'today') { console.log('Today: Weekly sync'); console.error('TypeError: x is undefined\n    at today (/candidate/cli.mjs:4:11)'); process.exitCode = 1; }
else { console.error(`no such command: ${cmd}`); process.exitCode = 2; }
