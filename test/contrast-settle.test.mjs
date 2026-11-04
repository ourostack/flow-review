// Text contrast is measured on what the page rests at, not on a fade caught part of the way: a pane that fades in as it
// arrives (Web Animations or a CSS transition), just before or during the measurement, gives the same findings as the
// page at rest, and words that are faint at rest still fail at every timing.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { checks } from '../lib/index.mjs';
import { pageWith, failing, close } from './helpers.mjs';

after(close);

const PAGE = `<style>@keyframes spin { to { rotate: 1turn } } .spin { animation: spin 1s linear infinite; width: 12px; height: 12px; border: 2px solid #333 }</style>
<main><h1>Settling</h1>
  <div id="pane">
    <p id="words" style="color:#222">Words that fade in as they arrive.</p>
    <p id="faint" style="color:#949494">Words that are faint at rest.</p>
  </div>
  <div class="spin" aria-hidden="true"></div>
</main>
<script>
  const pane = document.getElementById('pane');
  // The pane fades in from 30%, as an entrance does: by Web Animations or by a CSS transition.
  window.fade = (how, ms) => {
    if (how === 'animate') return void pane.animate([{ opacity: 0.3 }, { opacity: 1 }], { duration: ms, easing: 'ease-out' });
    pane.style.transition = 'none';
    pane.style.opacity = '0.3';
    pane.getBoundingClientRect();
    pane.style.transition = 'opacity ' + ms + 'ms ease-out';
    pane.style.opacity = '1';
  };
  // The fade starts inside the measurement itself: at the first style the measurement reads.
  window.fadeWhenRead = (how, ms) => {
    const read = window.getComputedStyle;
    window.getComputedStyle = function (...a) {
      window.getComputedStyle = read;
      window.fade(how, ms);
      return read.apply(this, a);
    };
  };
</script>`;

const TIMINGS = {
  'at rest': async () => {},
  'a fade just started': (page) => page.evaluate(() => window.fade('animate', 400)),
  'a transition just started': (page) => page.evaluate(() => window.fade('transition', 400)),
  'a fade starts mid-measurement': (page) => page.evaluate(() => window.fadeWhenRead('animate', 400)),
  'a transition starts mid-measurement': (page) => page.evaluate(() => window.fadeWhenRead('transition', 400)),
  'a short fade starts and ends mid-measurement': (page) => page.evaluate(() => window.fadeWhenRead('animate', 20)),
};

const text = (findings) => failing(findings).filter((f) => /^text /.test(f.label)).map((f) => `${f.selector} ${f.measured}`).sort();

test('contrast: the same text findings at every capture timing, and faint words still fail', async () => {
  const seen = {};
  for (const [name, start] of Object.entries(TIMINGS)) {
    const page = await pageWith(PAGE);
    await start(page);
    const t0 = Date.now();
    seen[name] = text(await checks.contrast(page));
    assert.ok(Date.now() - t0 < 8000, `${name}: an endless animation elsewhere doesn't hold the measurement (${Date.now() - t0} ms)`);
    await page.context().close();
  }
  const rest = seen['at rest'];
  assert.equal(rest.length, 1, `at rest, only the faint words fail: ${JSON.stringify(rest)}`);
  assert.match(rest[0], /^#faint /);
  assert.deepEqual(seen, Object.fromEntries(Object.keys(TIMINGS).map((name) => [name, rest])), 'every timing gives the findings at rest');
});

test('contrast: an icon is measured at the opacity it is drawn with, its wrappers\' included', async () => {
  const icon = (op) => `<main><h1>T</h1><button aria-label="Close" style="background:#fff;border:0;width:32px;height:32px"><span style="opacity:${op}"><svg width="16" height="16" viewBox="0 0 16 16"><path d="M2 2L14 14" stroke="#333" stroke-width="2"/></svg></span></button></main>`;
  const solid = await pageWith(icon(1));
  assert.deepEqual(failing(await checks.contrast(solid)), [], 'a dark icon passes');
  await solid.context().close();
  const faded = await pageWith(icon(0.25));
  const [f, ...rest] = failing(await checks.contrast(faded));
  assert.equal(rest.length, 0);
  assert.match(f.label, /icon/);
  assert.ok(f.measured < 3, `a dark icon in a wrapper at 25% reads faint: ${f.measured}`);
  await faded.context().close();
});
