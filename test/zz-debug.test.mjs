import test, { after } from 'node:test';
import { checks } from '../lib/index.mjs';
import { pageWith, close } from './helpers.mjs';
after(close);
test('debug: transition starts mid-measurement', async () => {
  const page = await pageWith(`<main><h1>T</h1><div id="pane"><p id="words" style="color:#222">Words.</p></div></main><script>
  const pane = document.getElementById('pane');
  window.log = [];
  const L = (m) => window.log.push(Math.round(performance.now()) + ' ' + m + ' op=' + getComputedStyle(pane).opacity + ' starts=' + window.__fr.motionStarts + ' anims=' + document.getAnimations().map((a) => a.playState + '@' + Math.round(a.currentTime ?? -1) + (a.pending ? 'p' : '')).join(','));
  window.L = L;
  for (const k of ['motionMark', 'movedSinceMark', 'moving', 'watchShadows']) { const f = window.__fr[k]; window.__fr[k] = (...a) => { const r = f(...a); if (k !== 'moving' || r) L(k + '=' + r); return r; }; }
  let n = 0;
  const read = window.getComputedStyle;
  window.getComputedStyle = function (...a) { n++; if (n === 1) { window.getComputedStyle = read; pane.style.transition = 'none'; pane.style.opacity = '0.3'; pane.getBoundingClientRect(); pane.style.transition = 'opacity 400ms ease-out'; pane.style.opacity = '1'; L('faded by ' + (new Error().stack.split('\\n')[2] || '').trim().slice(0, 120)); } return read.apply(this, a); };
  document.addEventListener('transitionrun', () => L('transitionrun'), true);
  document.addEventListener('transitionend', () => L('transitionend'), true);
  </script>`);
  const t0 = Date.now();
  const f = await checks.contrast(page);
  console.log('DEBUG ms', Date.now() - t0, JSON.stringify(f.map((x) => `${x.selector} ${x.measured} ${x.pass}`)));
  console.log('DEBUG log\n' + (await page.evaluate(() => window.log.join('\n'))));
  await page.context().close();
});
