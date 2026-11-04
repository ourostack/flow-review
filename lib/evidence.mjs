// Evidence crops: a small picture around an element with a red box, and key-moment pictures for judges. Pictures over
// the size cap are re-encoded as WebP (and scaled down if needed) in a blank page's canvas, so no image library is needed.
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export const MAX_BYTES = 300 * 1024;
const PAD = 16;
/** Evidence crops are scaled to fit this many px on their longer side. */
const MAX_SIDE = 1000;

// One blank page per browser (each engine's run has its own browser).
const encoders = new Map();
async function encoder(browser) {
  const open = encoders.get(browser);
  if (open && !open.isClosed()) return open;
  const page = await (await browser.newContext()).newPage();
  encoders.set(browser, page);
  return page;
}
export async function closeEncoder() {
  for (const page of encoders.values()) await page.context().close().catch(() => {});
  encoders.clear();
}

/** PNG bytes to at most maxBytes: PNG as it is when small enough, else WebP, scaled down until it fits. An engine whose
 * canvas can't encode WebP (WebKit) gives PNG, scaled down until it fits. */
export async function shrink(browser, png, { maxBytes = MAX_BYTES, maxWidth = Infinity } = {}) {
  if (png.length <= maxBytes && maxWidth === Infinity) return { bytes: png, ext: 'png' };
  const page = await encoder(browser);
  const { b64, ext } = await page.evaluate(async ({ src, maxBytes, maxWidth }) => {
    const img = new Image();
    img.src = src;
    await img.decode();
    let scale = Math.min(1, maxWidth / img.naturalWidth);
    for (let i = 0; i < 6; i++) {
      const c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(img.naturalWidth * scale));
      c.height = Math.max(1, Math.round(img.naturalHeight * scale));
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      const url = c.toDataURL('image/webp', 0.82);
      const b = url.slice(url.indexOf(',') + 1);
      if (b.length * 0.75 <= maxBytes || i === 5) return { b64: b, ext: url.startsWith('data:image/webp') ? 'webp' : 'png' };
      scale *= 0.75;
    }
  }, { src: `data:image/png;base64,${png.toString('base64')}`, maxBytes, maxWidth });
  return { bytes: Buffer.from(b64, 'base64'), ext };
}

export function save(dir, sub, { bytes, ext }) {
  const name = `${createHash('sha1').update(bytes).digest('hex').slice(0, 16)}.${ext}`;
  fs.mkdirSync(path.join(dir, sub), { recursive: true });
  const file = path.join(dir, sub, name);
  if (!fs.existsSync(file)) fs.writeFileSync(file, bytes);
  return `${sub}/${name}`;
}

/** Crops around the finding's element (or the area inside it) with a red box; returns the evidence path or undefined. */
export async function crop(page, browser, outDir, finding) {
  if (finding.ref === undefined) return undefined;
  try {
    const saved = await page.evaluate(() => [scrollX, scrollY]);
    const box = await page.evaluate(([r, o]) => window.__fr.mark(r, o), [finding.ref, finding.offset ?? null]);
    if (!box) return undefined;
    const vw = page.viewportSize();
    // An empty area needs more of its surroundings to read than an element does.
    const pad = finding.offset ? PAD * 3 : PAD;
    const x = Math.max(0, Math.floor(box.x - pad));
    const y = Math.max(0, Math.floor(box.y - pad));
    // The whole box and its surroundings as far as the screen shows them, scaled down rather than cut off.
    const w = Math.min(vw.width - x, Math.ceil(box.w + pad * 2));
    const h = Math.min(vw.height - y, Math.ceil(box.h + pad * 2));
    let png = null;
    if (w > 0 && h > 0) png = await page.screenshot({ clip: { x, y, width: w, height: h }, animations: 'disabled' });
    await page.evaluate(([sx, sy]) => { window.__fr.unmark(); scrollTo({ left: sx, top: sy, behavior: 'instant' }); }, saved);
    if (!png) return undefined;
    return save(outDir, 'evidence', await shrink(browser, png, w > MAX_SIDE || h > MAX_SIDE ? { maxWidth: Math.round(MAX_SIDE * Math.min(1, w / h)) } : {}));
  } catch {
    await page.evaluate(() => window.__fr?.unmark()).catch(() => {});
    return undefined;
  }
}

/** A key moment: the viewport, or a region, as WebP no wider than 1600 px and under the size cap. */
export async function moment(page, browser, outDir, region) {
  let png;
  if (region) png = await region.screenshot({ animations: 'disabled' });
  else png = await page.screenshot({ animations: 'disabled' });
  return save(outDir, 'moments', await shrink(browser, png, { maxWidth: 1600 }));
}

/** A whole-viewport picture of a failure, for a step that could not run. */
export async function failureShot(page, browser, outDir) {
  try {
    return save(outDir, 'evidence', await shrink(browser, await page.screenshot({ animations: 'disabled', timeout: 5000 }), { maxWidth: 1000 }));
  } catch {
    return undefined;
  }
}
