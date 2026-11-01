// Evidence crops: the whole marked box, scaled to fit rather than cut off, under the size cap.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checks } from '../lib/index.mjs';
import { crop, closeEncoder, MAX_BYTES } from '../lib/evidence.mjs';
import { pageWith, launch, close } from './helpers.mjs';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.scratch', 'evidence-test');
after(async () => { await closeEncoder(); await close(); fs.rmSync(out, { recursive: true, force: true }); });

test('a large empty area is cropped whole, scaled to 1000 px, under 300 KB', async () => {
  const page = await pageWith('<main><section id="big" style="height:1300px"><p>One line in a big section.</p></section></main>', { width: 2000, height: 1400 });
  const [f] = (await checks.deadSpace(page)).filter((x) => !x.pass);
  assert.ok(f.offset.w > 1500 && f.offset.h > 1000, JSON.stringify(f.offset));
  const rel = await crop(page, await launch(), out, f);
  const file = path.join(out, rel);
  assert.ok(fs.statSync(file).size < MAX_BYTES);
  const size = await page.evaluate(async (src) => { const i = new Image(); i.src = src; await i.decode(); return [i.naturalWidth, i.naturalHeight]; }, `data:image/${rel.endsWith('.webp') ? 'webp' : 'png'};base64,${fs.readFileSync(file).toString('base64')}`);
  assert.ok(Math.max(...size) <= 1000 && Math.max(...size) >= 900, `scaled to fit: ${size}`);
  assert.ok(size[0] / size[1] > 1.2, `the whole wide area, not a corner: ${size}`);
  await page.context().close();
});
