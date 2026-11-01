#!/usr/bin/env node
import { main } from '../lib/cli.mjs';

try {
  process.exitCode = await main(process.argv.slice(2));
} catch (e) {
  console.error(`flow-review: ${e.message}`);
  process.exitCode = 2;
}
