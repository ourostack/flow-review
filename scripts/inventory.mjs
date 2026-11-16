// The CLI's surfaces for the Ouro AX X-ray, read from its own command registration (never written by hand):
// node scripts/inventory.mjs > inventory.json
import { cli } from '../lib/cli.mjs';

process.stdout.write(`${JSON.stringify({ cli: cli.commands.map((c) => c.name) }, null, 2)}\n`);
