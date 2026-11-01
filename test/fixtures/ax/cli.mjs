#!/usr/bin/env node
// A stand-in candidate CLI: reads INBOX_URL, prints JSON for --json reads. Its help leaves out "attention" (a known
// defect the flow marks).
const [cmd, ...rest] = process.argv.slice(2);
if (cmd === '--help') {
  console.log('inbox: the stand-in.\n\nOnly you see these\n  today           Start here.\n  activity        What happened.\n  threads         Your threads.\n  look            One thread.\n  log             What agents did.');
} else {
  const path = cmd === 'look' ? `/look/${encodeURIComponent(rest[0])}` : `/${cmd}`;
  const res = await fetch(`${process.env.INBOX_URL}${path}`);
  if (!res.ok) { console.error(`inbox: ${cmd}: not found. Fix: inbox today`); process.exitCode = 2; }
  else process.stdout.write(`${JSON.stringify(await res.json())}\n`);
}
