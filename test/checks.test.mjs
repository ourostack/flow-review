// Each check passes a clean page and fails a page with one planted defect.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { checks, expectNoFindings } from '../lib/index.mjs';
import { pageWith, failing, close, ENGINE } from './helpers.mjs';

after(close);

const lines = (n) => Array.from({ length: n }, (_, i) => `<p>Paragraph ${i}: ${"plain words that wrap across the section and fill it from one side to the other ".repeat(3)}</p>`).join("");

async function both(name, clean, defect, opts = {}, pageOpts = {}) {
  const good = await pageWith(clean, pageOpts);
  const g = await checks[name](good, opts);
  assert.equal(failing(g).length, 0, `${name} passes the clean page: ${JSON.stringify(failing(g))}`);
  assert.ok(g.length > 0, `${name} reports a finding on the clean page`);
  await good.context().close();
  const bad = await pageWith(defect, pageOpts);
  const b = await checks[name](bad, opts);
  assert.ok(failing(b).length > 0, `${name} fails the planted defect: ${JSON.stringify(b)}`);
  for (const f of failing(b)) {
    assert.equal(f.check, name);
    assert.ok(f.fix || f.label, `${name} explains its failure`);
  }
  await bad.context().close();
  return failing(b);
}

test('axe', async () => {
  const [f] = await both('axe', '<main><h1>Hello</h1><p>Words.</p></main>', '<main><h1>Hello</h1><img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width="40" height="40"></main>');
  assert.match(f.measured, /image-alt/);
});

test('contrast: text and icon-only controls', async () => {
  const icon = (c) => `<button aria-label="Close" style="background:#fff;border:0;width:32px;height:32px"><svg width="16" height="16" viewBox="0 0 16 16"><path d="M2 2L14 14" stroke="${c}" stroke-width="2"/></svg></button>`;
  const text = await both('contrast', `<main><h1>T</h1><p style="color:#222">Readable words.</p>${icon('#333')}</main>`, '<main><h1>T</h1><p style="color:#aaa">Faint words.</p></main>');
  assert.ok(text[0].measured < 4.5);
  const page = await pageWith(`<main><h1>T</h1>${icon('#ddd')}</main>`);
  const ui = failing(await checks.contrast(page));
  assert.equal(ui.length, 1);
  assert.match(ui[0].label, /icon/);
  await page.context().close();
});

test('contrast: an icon on its own disc is measured against the disc, not the control behind it', async () => {
  // A dark glyph on a small white disc, inside a dark control: about 17:1 on what it is drawn on, 1.18:1 against the control.
  const badge = (disc, glyph) => `<main><h1>T</h1><div tabindex="0" role="group" aria-label="Your picture" style="position:relative;width:160px;height:90px;background:#262626"><span role="img" aria-label="Muted" style="position:absolute;left:8px;bottom:8px;width:28px;height:28px;border-radius:50%;background:${disc};display:flex;align-items:center;justify-content:center"><svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true"><path d="M2 2L14 14M14 2L2 14" stroke="${glyph}" stroke-width="2"/></svg></span></div></main>`;
  const good = await pageWith(badge('#fff', '#171717'));
  const g = await checks.contrast(good);
  assert.deepEqual(failing(g), [], 'the dark glyph reads on its white disc');
  assert.match(String(g[0].measured), /1 icons >= 3/);
  await good.context().close();
  const bad = await pageWith(badge('#fff', '#ddd'));
  const [f, ...rest] = failing(await checks.contrast(bad));
  assert.equal(rest.length, 0);
  assert.ok(f.measured < 1.5, `a faint glyph on the disc still fails: ${f.measured}`);
  await bad.context().close();
});

test('targetSize, with the inline exception', async () => {
  const small = 'style="width:12px;height:12px;padding:0;border:0;margin:0"';
  const [f] = await both('targetSize', '<main><button style="width:44px;height:44px">A</button><p>Read <a href="#x">this link</a> inside a sentence.</p></main>', `<main><button ${small}>a</button><button ${small}>b</button></main>`);
  assert.equal(f.measured, '12x12');
  assert.equal(f.threshold, 24);
});

test('overflow: sideways scroll and clipped text', async () => {
  await both('overflow', '<main><p>Short words.</p></main>', '<main><div style="width:2000px">Too wide</div></main>');
  const page = await pageWith('<main><p style="width:60px;overflow:hidden;white-space:nowrap">A long line of words cut off</p></main>');
  const [f] = failing(await checks.overflow(page));
  assert.match(f.label, /cut off/);
  assert.equal(failing(await checks.overflow(page, { thresholds: { allowTruncation: true } })).length, 1, 'plain clipping is never deliberate truncation');
  await page.context().close();
  const ell = await pageWith('<main><p style="width:60px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">A long line of words cut off</p></main>');
  assert.equal(failing(await checks.overflow(ell)).length, 1);
  assert.equal(failing(await checks.overflow(ell, { thresholds: { allowTruncation: true } })).length, 0);
  await ell.context().close();
});

test('overflow: a clamp is deliberate when what it hides is named, one hover or click away, and it says enough', async () => {
  const clamp = 'style="display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;width:150px;font:16px/20px sans-serif"';
  const title = 'Group chat list reads like the real one at every width';
  const card = (attrs, words = title) => `<main><button ${attrs} style="display:block;padding:4px;border:0;background:#fff;text-align:left"><span ${clamp}>${words}</span></button></main>`;
  const one = async (html, opts) => {
    const page = await pageWith(html);
    const f = failing(await checks.overflow(page, opts));
    await page.context().close();
    return f;
  };
  assert.deepEqual(await one(card(`aria-label="${title}. Done. Open details." title="${title}"`)), [], 'named and in a tooltip');
  assert.deepEqual(await one(card(`aria-label="${title}. Open details." aria-haspopup="dialog"`)), [], 'named, and the dialog it opens shows it');
  assert.deepEqual(await one(card('aria-haspopup="dialog"')), [], 'named by its own content');
  const unnamed = await one(card(`aria-label="Group chat. Open details." title="${title}"`));
  assert.equal(unnamed.length, 1);
  assert.match(unnamed[0].label, /not in the accessible name/);
  const noTooltip = await one(card(`aria-label="${title}"`));
  assert.match(noTooltip[0].label, /no tooltip or dialog/);
  const long = 'Group chat list reads like the real one at every single width from a phone to a wall-sized screen with room to spare';
  const meaning = await one(card(`aria-label="${long}" title="${long}"`, long));
  assert.equal(meaning.length, 1, 'a clamp that shows too little of its text hides its meaning');
  assert.match(meaning[0].label, /shows \d+ of 23 words/);
  assert.deepEqual(await one(card(`aria-label="${long}" title="${long}"`, long), { thresholds: { truncationMinShown: 0.2 } }), []);
  assert.equal((await one(card('aria-label="Other words"'), { thresholds: { allowTruncation: true } })).length, 0, 'allowTruncation accepts every clamp');
  const [badName] = await one(card(`aria-label="Other words" title="${title}"`));
  assert.match(badName.fix, /accessible name/, 'the fix names what is missing');
  const inner = await one(`<main><div title="${title}" style="width:120px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis"><a href="#x" aria-label="Open">${title}</a></div></main>`);
  assert.match(inner[0]?.label ?? '', /not in the accessible name/, 'a control inside the truncating box is checked too');
});

test('overflow: an absolutely placed child escapes a nested clip its containing block lies outside', async () => {
  const page = await pageWith('<main><div style="position:relative;width:200px;height:40px;overflow:hidden"><div style="overflow:hidden;width:200px;height:20px"><span style="position:absolute;white-space:nowrap">A long line of words that runs well past both boxes</span></div></div></main>');
  const f = failing(await checks.overflow(page));
  assert.equal(f.length, 1, JSON.stringify(f));
  await page.context().close();
  const t = 'A long title that the ellipsis cuts well short of its end';
  const badge = await pageWith(`<main><div style="position:relative;width:400px"><div title="${t}" style="width:120px;overflow:hidden;white-space:nowrap;text-overflow:ellipsis">${t}<span style="position:absolute;top:0;right:0">New</span></div></div></main>`);
  assert.deepEqual(failing(await checks.overflow(badge, { thresholds: { truncationMinShown: 0.2 } })), [], 'a badge placed outside the box is not cut by it');
  await badge.context().close();
  for (const cb of ['will-change:transform', 'translate:1px', 'transform:translateZ(0)']) {
    const held = await pageWith(`<main><div style="width:150px;height:40px;overflow:hidden;${cb}"><span style="position:absolute;top:0;left:0;white-space:nowrap">A long caption that runs well past the edge of its box</span></div></main>`);
    assert.equal(failing(await checks.overflow(held)).length, 1, `${cb} makes the box hold its absolute child`);
    await held.context().close();
  }
});

test('overflow: text a nested box clips is that box\'s finding, not its container\'s too', async () => {
  const page = await pageWith('<main><div style="overflow:hidden;width:160px;height:44px;border:1px solid"><span style="display:-webkit-box;-webkit-box-orient:vertical;-webkit-line-clamp:2;overflow:hidden;font:16px/20px sans-serif">A title long enough to need far more than the two lines it is given here</span></div></main>');
  const f = failing(await checks.overflow(page));
  assert.equal(f.length, 1, JSON.stringify(f));
  assert.match(f[0].selector, /span$/);
  await page.context().close();
});

test('deadSpace', async () => {
  const [f] = await both('deadSpace', `<main><section id="full">${lines(30)}</section></main>`, '<main><section id="empty" style="height:500px"><p>One line.</p></section></main>');
  assert.ok(f.measured > 0.25);
  assert.match(f.label, /#empty/);
});

test('repetition', async () => {
  const s = 'This exact sentence is long enough to count as repeated text.';
  await both('repetition', `<main><p>${s}</p><p>${s}</p></main>`, `<main><p>${s}</p><p>${s}</p><p>${s}</p></main>`);
});

test('designSystem: the marker is config', async () => {
  const opts = { designSystem: { marker: '[data-ds]' } };
  await both('designSystem', '<main><button data-ds>A</button><span data-ds><a href="#">B</a></span></main>', '<main><button data-ds>A</button><button>Hand-built</button></main>', opts);
  const page = await pageWith('<main><button>A</button></main>');
  assert.deepEqual(await checks.designSystem(page, {}), [], 'no marker, nothing to check');
  await page.context().close();
});

test('proofNotice', async () => {
  const img = '<img alt="The header" width="40" height="40" src="data:image/gif;base64,R0lGODlhAQABAAAAACw=">';
  await both('proofNotice', `<main><div data-proof><figure>${img}<figcaption>Notice the header no longer wraps.</figcaption></figure></div></main>`, `<main><div data-proof>${img}</div></main>`);
});

test('states: human words, not a raw error', async () => {
  await both('states', '<main><p>Nothing here yet. Add your first item to see it.</p></main>', '<main><p>TypeError: Cannot read properties of undefined</p></main>', { state: 'error' });
});

test('cls', async () => {
  const late = '<main><p id="t">Top</p><p>Below</p><script>setTimeout(() => { const d = document.createElement("div"); d.style.height = "300px"; d.textContent = "late"; document.querySelector("main").prepend(d); }, 200)</script></main>';
  const good = await pageWith('<main><p>Still</p><p>Below</p></main>');
  await good.waitForTimeout(400);
  assert.equal(failing(await checks.cls(good)).length, 0);
  await good.context().close();
  const bad = await pageWith(late);
  await bad.waitForTimeout(600);
  const all = await checks.cls(bad);
  const [f] = failing(all);
  assert.ok(f?.measured > 0.1, JSON.stringify(all));
  await bad.context().close();
});

test('jank: long tasks and slow frames in motion', async () => {
  const good = await pageWith('<main><p>Calm</p></main>');
  await good.waitForTimeout(200);
  assert.equal(failing(await checks.jank(good)).length, 0);
  await good.context().close();
  const bad = await pageWith('<main><p>Busy</p><script>setTimeout(() => { const t = performance.now(); while (performance.now() - t < 320); }, 50)</script></main>');
  await bad.waitForTimeout(600);
  const [f] = failing(await checks.jank(bad));
  assert.ok(f.measured >= 300, JSON.stringify(f));
  await bad.context().close();
});

// WebKit has no long-animation-frame timing, so every slow frame counts there (README, Engines).
test('jank: slow frames count when the page made them slow, not when they waited on raster', { skip: ENGINE === 'webkit' && 'WebKit has no long animation frames: every slow frame counts' }, async () => {
  const page = await pageWith('<main><p>Moving</p></main>');
  const supported = await page.evaluate(() => window.__fr.loafSupported);
  assert.ok(supported, 'Chromium reports long animation frames');
  // A motion window with ten frames, four of them 100 ms: first with no timing, then with an idle main thread, then busy.
  const win = await page.evaluate(() => {
    const fr = window.__fr;
    const t0 = performance.now() + 10_000;
    fr.frames.push(...Array.from({ length: 10 }, (_, i) => [t0 + i * 100, i % 3 === 0 ? 100 : 17]));
    return [t0 - 1, t0 + 1000];
  });
  const idle0 = failing(await checks.jank(page, { windows: [win], thresholds: { jankMinFrames: 5 } }));
  assert.equal(idle0.length, 1, 'slow frames without long-animation-frame evidence count');
  await page.evaluate(([a]) => {
    for (let i = 0; i < 10; i += 3) window.__fr.loafs.push({ t: a + i * 100 - 95, end: a + i * 100, work: 1, block: 0 });
  }, win);
  const idle = failing(await checks.jank(page, { windows: [win], thresholds: { jankMinFrames: 5 } }));
  assert.equal(idle.length, 0, JSON.stringify(idle));
  const label = (await checks.jank(page, { windows: [win], thresholds: { jankMinFrames: 5 } })).find((f) => f.pass);
  assert.match(JSON.stringify(label.measured), /"rasterBound":4/);
  await page.evaluate(([a]) => {
    for (let i = 0; i < 10; i += 3) window.__fr.loafs.push({ t: a + i * 100 - 90, end: a + i * 100 - 5, work: 80, block: 30 });
  }, win);
  const [busy] = failing(await checks.jank(page, { windows: [win], thresholds: { jankMinFrames: 5 } }));
  assert.equal(busy.measured, 0.4, JSON.stringify(busy));
  await page.context().close();
  // Frames of 33 to 50 ms have no long-animation-frame timing: the page's 40 ms of work a frame still counts.
  const steady = await pageWith('<main><p>Busy</p><script>const loop = () => { const t = performance.now(); while (performance.now() - t < 40); requestAnimationFrame(loop); }; requestAnimationFrame(loop);</script></main>');
  const from = await steady.evaluate(() => performance.now());
  await steady.waitForTimeout(1200);
  const to = await steady.evaluate(() => performance.now());
  const [f] = failing(await checks.jank(steady, { windows: [[from, to]] }));
  assert.ok(f?.measured > 0.1, JSON.stringify(f));
  await steady.context().close();
  // A frame of exactly two vsyncs isn't over 33 ms.
  const vsync = await pageWith('<main><p>Even</p></main>');
  const w2 = await vsync.evaluate(() => {
    const t0 = performance.now() + 10_000;
    window.__fr.frames.push(...Array.from({ length: 10 }, (_, i) => [t0 + i * 20, i % 2 ? 33.3 : 16.7]));
    return [t0 - 1, t0 + 1000];
  });
  assert.equal(failing(await checks.jank(vsync, { windows: [w2] })).length, 0);
  // A frame's own timing, not its idle neighbour's, decides: a 40 ms frame after a raster-bound one still counts.
  const w3 = await vsync.evaluate(() => {
    const t0 = performance.now() + 20_000;
    window.__fr.frames.push([t0 + 100, 100], [t0 + 140, 40], ...Array.from({ length: 4 }, (_, i) => [t0 + 157 + i * 17, 17]));
    window.__fr.loafs.push({ t: t0 + 5, end: t0 + 102, work: 1, block: 0 });
    return [t0 + 1, t0 + 300];
  });
  const m = (await checks.jank(vsync, { windows: [w3], thresholds: { jankMinFrames: 5 } })).find((f) => f.measured?.frames || f.label?.includes('motion frames'));
  assert.match(JSON.stringify(m), /"slowFrames":1,"rasterBound":1|1 of 6 motion frames/, JSON.stringify(m));
  // By default a share needs 20 frames: one slow frame in a click's six is its response, not jank.
  const few = await checks.jank(vsync, { windows: [w3] });
  assert.equal(failing(few).length, 0, JSON.stringify(few));
  assert.match(JSON.stringify(few), /"tooFewToJudge":20/);
  assert.equal(failing(await checks.jank(vsync, { windows: [w3], thresholds: { slowFrameShare: 0 } })).length, 1, 'a share of 0 still judges, from 5 frames');
  await vsync.context().close();
});

test('keyboard: unreachable controls and traps', async () => {
  const [f] = await both('keyboard', '<main><button>One</button><a href="#a">Two</a><input aria-label="Three"></main>', '<main><button>One</button><div role="button" onclick="1">Not focusable</div></main>');
  assert.match(f.measured, /not reached/);
  const page = await pageWith('<main><button>Before</button><button onkeydown="if (event.key === \'Tab\') event.preventDefault()">Trap</button><button>After</button></main>');
  const fs = failing(await checks.keyboard(page));
  assert.ok(fs.some((x) => x.measured === 'focus trapped'), JSON.stringify(fs));
  await page.context().close();
});

test('focusVisible', async () => {
  const [f] = await both('focusVisible', '<main><button>One</button><button>Two</button></main>', '<style>*:focus { outline: none }</style><main><button style="border:0;background:#eee">One</button><button style="border:0;background:#eee">Two</button></main>');
  assert.match(f.measured, /no visible change/);
});

test('expectNoFindings throws with every failure listed, and passes clean findings', async () => {
  assert.doesNotThrow(() => expectNoFindings([{ check: 'axe', pass: true }]));
  assert.throws(() => expectNoFindings([{ check: 'targetSize', pass: false, label: 'button "x"', measured: '12x12', threshold: 24, fix: 'Grow it.' }]), /targetSize: button "x".*12x12.*Grow it/s);
});

test('keyboard: Tab escaping an open dialog, and focus left outside it', async () => {
  const page = await pageWith('<main><button id="b">Behind</button><div role="dialog" aria-modal="true" aria-label="D"><button>In</button><button>Also in</button></div></main>');
  await page.focus('#b');
  const f = failing(await checks.keyboard(page));
  assert.ok(f.some((x) => /outside the open dialog/.test(x.measured)), JSON.stringify(f));
  assert.ok(f.some((x) => x.measured === 'Tab leaves the open dialog'), JSON.stringify(f));
  await page.context().close();
  const ok = await pageWith('<main><button>Behind</button><dialog id="d"><button>In</button><button>Also in</button></dialog><script>document.getElementById("d").showModal()</script></main>');
  assert.deepEqual(failing(await checks.keyboard(ok)), [], 'a modal <dialog> keeps Tab inside');
  await ok.context().close();
});

test("keyboard: a focus trap's guards are not stops, and a working trap passes", async () => {
  const page = await pageWith(`<main><button>Behind</button>
    <span data-base-ui-focus-guard tabindex="0" aria-hidden="true" id="g1"></span>
    <div role="dialog" aria-modal="true" aria-label="D" id="d"><button id="first">In</button><button id="last">Also in</button></div>
    <span data-base-ui-focus-guard tabindex="0" aria-hidden="true" id="g2"></span>
    <script>
      g1.addEventListener('focus', () => requestAnimationFrame(() => last.focus()));
      g2.addEventListener('focus', () => requestAnimationFrame(() => first.focus()));
      first.focus();
    </script></main>`);
  assert.deepEqual(failing(await checks.keyboard(page)), []);
  await page.context().close();
});

test('focusVisible: a shadow the control always has is not a focus ring', async () => {
  const page = await pageWith('<style>button { box-shadow: 0 1px 3px #0004; border: 0; background: #eee; outline: none !important }</style><main><button>One</button><button>Two</button></main>');
  assert.equal(failing(await checks.focusVisible(page)).length, 2);
  await page.context().close();
});

test('keyboard: within starts at the region, whatever comes before it', async () => {
  const many = Array.from({ length: 40 }, (_, i) => `<button>Nav ${i}</button>`).join('');
  const page = await pageWith(`<header>${many}</header><main><p>Words.</p></main><footer id="f"><a href="#a">A</a><a href="#b">B</a><a href="#c">C</a></footer>`);
  assert.deepEqual(failing(await checks.keyboard(page, { within: '#f' })), []);
  await page.context().close();
});

test('focusVisible within a region: the region taking focus first is not the children\'s ring', async () => {
  const page = await pageWith('<style>#f a { outline: none !important; text-decoration: none; color: #333 }</style><main><p>Words.</p></main><footer id="f"><a href="#a">A</a><a href="#b">B</a></footer>');
  await page.keyboard.press('Shift');
  assert.equal(failing(await checks.focusVisible(page, { within: '#f' })).length, 2);
  await page.context().close();
});

test('states: empty, loading, error and success states are found, each with or without its Moment', async () => {
  const { ensure } = await import('../lib/checks.mjs');
  const page = await pageWith(`<main><section id="list"><h2>Items</h2><ul></ul></section>
    <p role="status">Saved.</p>
    <div data-state="loading" aria-busy="true">Loading the plan</div>
    <div role="alert"><span data-moment="error">(duo)</span> Couldn't load the plan.</div>
    <nav><ul></ul></nav></main>`);
  await ensure(page);
  const states = await page.evaluate(() => window.__fr.states({ declared: [{ kind: 'first-run', region: '#list' }] }));
  const by = Object.fromEntries(states.map((s) => [`${s.kind} ${s.selector}`, s.hasMoment]));
  assert.equal(by['empty #list'], false, 'an empty list, in its section');
  assert.equal(by['first-run #list'], false, 'a declared state');
  assert.ok(!states.some((s) => s.kind === 'success'), 'a status line saying Saved is not a success state by its words');
  assert.ok(states.some((s) => s.kind === 'loading' && !s.hasMoment));
  assert.ok(states.some((s) => s.kind === 'error' && s.hasMoment), JSON.stringify(states));
  assert.equal(states.filter((s) => s.kind === 'empty').length, 1, 'an empty nav list is not a state');
  await page.context().close();
});

const DUO = (art, body = '') => `<style>main { position: relative; font: 16px system-ui; } .art { position: absolute; inset: 0 auto auto 0; width: 300px; height: 200px; background: #eee; } ${art}</style><main><button style="position:relative;margin:20px;width:120px;height:40px">Send</button><p style="position:relative;margin:20px">${body || 'Words a person reads over the scene.'}</p><div class="art" data-duo aria-hidden="true"></div></main>`;

test('duoOverlap: art painting above content and taking the pointer fails; a scene below content passes', async () => {
  const good = await pageWith(DUO('.art { z-index: -1; pointer-events: none } main { z-index: 0 } p { color: #222 }'));
  assert.deepEqual(failing(await checks.duoOverlap(good)), []);
  await good.context().close();
  const bad = await pageWith(DUO('.art { z-index: 5 }'));
  const f = failing(await checks.duoOverlap(bad));
  assert.ok(f.some((x) => /button "Send" under duo art/.test(x.label)), JSON.stringify(f));
  assert.ok(f.some((x) => /takes the pointer/.test(x.label) && /pointer-events: auto/.test(x.measured)));
  assert.ok(f.some((x) => /^text/.test(x.label)), 'text under the art too');
  await bad.context().close();
  const ghost = await pageWith(DUO('.art { z-index: 5; pointer-events: none; opacity: .5 }'));
  const g = failing(await checks.duoOverlap(ghost));
  assert.ok(g.some((x) => /under duo art/.test(x.label)), 'art with pointer-events: none still paints above');
  assert.ok(!g.some((x) => /takes the pointer/.test(x.label)));
  await ghost.context().close();
});

test('duoOverlap: text over the art is measured on the real pixels behind it', async () => {
  const faint = await pageWith(DUO('.art { z-index: -1; pointer-events: none; background: linear-gradient(#f4f4f4, #e8e8e8) } main { z-index: 0 } p { color: #b0b0b0 }'));
  const [f] = failing(await checks.duoOverlap(faint));
  assert.ok(f && f.measured < 4.5 && f.threshold === 4.5, JSON.stringify(f));
  await faint.context().close();
});

test('duoReducedMotion: duo art that animates under reduced motion fails; a still pose passes', async () => {
  const anim = '@keyframes bob { to { transform: translateY(4px) } } .art { z-index: -1; animation: bob 1s infinite alternate }';
  const bad = await pageWith(DUO(anim));
  assert.equal(failing(await checks.duoReducedMotion(bad)).length, 1);
  await bad.context().close();
  const good = await pageWith(DUO(`${anim} @media (prefers-reduced-motion: reduce) { .art { animation: none } }`));
  assert.deepEqual(failing(await checks.duoReducedMotion(good)), []);
  await good.context().close();
});

test('duoBytes: the duo assets a page fetched, against the budget', async () => {
  const { launch } = await import('./helpers.mjs');
  const { PAGE_SCRIPT } = await import('../lib/checks.mjs');
  const b = await launch();
  const at = async (size) => {
    const ctx = await b.newContext();
    await ctx.addInitScript(PAGE_SCRIPT);
    await ctx.route('http://duo.test/**', (r) => (r.request().url().endsWith('.webp')
      ? r.fulfill({ status: 200, contentType: 'image/webp', body: Buffer.alloc(size, 1) })
      : r.fulfill({ status: 200, contentType: 'text/html', body: '<!doctype html><html lang="en"><title>d</title><main><img data-duo alt="" src="/duo/rider.webp" width="10" height="10"></main>' })));
    const page = await ctx.newPage();
    await page.goto('http://duo.test/');
    await page.waitForLoadState('networkidle');
    const [f] = await checks.duoBytes(page);
    await ctx.close();
    return f;
  };
  const small = await at(20_000);
  assert.equal(small.pass, true, JSON.stringify(small));
  assert.ok(small.measured >= 20_000, `measured ${small.measured}`);
  const big = await at(200_000);
  assert.equal(big.pass, false);
  assert.match(big.fix, /rider\.webp/);
});

test('states: a control\'s own spinner is not a loading state; a busy region still is', async () => {
  const { ensure } = await import('../lib/checks.mjs');
  const page = await pageWith(`<main><section id="chat"><button aria-busy="true">Sending</button><a href="#j" aria-busy="true">Joining</a>
    <div role="menu"><div role="menuitem" aria-busy="true">Adding</div></div><span role="switch" aria-busy="true">On</span>
    <button><span aria-busy="true">Approving</span></button></section>
    <section id="plan" aria-busy="true"><p>Fetching the plan</p></section></main>`);
  await ensure(page);
  const states = await page.evaluate(() => window.__fr.states());
  assert.deepEqual(states.filter((s) => s.kind === 'loading').map((s) => s.selector), ['#plan'], JSON.stringify(states));
  await page.context().close();
});

test('states: a declared state whose region is not on screen is not attributed to main; with no region it is', async () => {
  const { ensure } = await import('../lib/checks.mjs');
  const page = await pageWith('<main><p>Words.</p><section id="list"><ul><li>One</li></ul></section></main>');
  await ensure(page);
  const unmet = await page.evaluate(() => window.__fr.states({ declared: [{ kind: 'loading', regionRef: null }, { kind: 'empty', region: '#gone' }] }));
  assert.ok(!unmet.some((s) => s.kind === 'loading' || s.kind === 'empty'), `a declared state with a missing region is not reported on main: ${JSON.stringify(unmet)}`);
  const none = await page.evaluate(() => window.__fr.states({ declared: [{ kind: 'empty' }] }));
  assert.deepEqual(none.filter((s) => s.kind === 'empty').map((s) => [s.selector.endsWith('main'), s.how]), [[true, 'declared']], 'a declared state with no region falls back to main');
  await page.context().close();
});

test('states: an empty list in an overlay layer is not an empty state; framework ids are not anchors', async () => {
  const { ensure } = await import('../lib/checks.mjs');
  const page = await pageWith('<main><p>Words.</p><div style="position:fixed;bottom:0"><ol role="list" aria-label="Notifications"></ol></div><div id="«r1»"><p role="status" data-state="success">Saved.</p></div><p id="decl" role="status">The plan isn\'t available right now.</p></main>');
  await ensure(page);
  const states = await page.evaluate(() => window.__fr.states({ declared: [{ kind: 'empty', region: '#decl' }] }));
  assert.deepEqual(states.filter((s) => s.selector === '#decl').map((s) => s.kind), ['empty'], 'declared empty, not also error by its words');
  assert.ok(!states.some((s) => s.kind === 'empty' && s.selector !== '#decl'), JSON.stringify(states));
  assert.ok(states.some((s) => s.kind === 'success' && !s.selector.includes('«')), JSON.stringify(states));
  await page.context().close();
});

test('a hidden tick, a scrollable region and a short Tab budget are not page defects', async () => {
  const page = await pageWith('<main><h1>T</h1><button role="checkbox" aria-checked="false" aria-label="Agree" style="width:24px;height:24px;background:#fff"><svg width="16" height="16"><path d="M2 8l4 4 8-8" stroke="transparent" stroke-width="2" fill="none"/></svg></button><div role="region" aria-label="Props" tabindex="0" style="height:40px;overflow:auto"><p>Long</p><p>table</p></div></main>');
  assert.deepEqual(failing(await checks.contrast(page)), []);
  assert.deepEqual(failing(await checks.designSystem(page, { designSystem: { marker: '[data-ouro]' } })).map((f) => f.label), ['checkbox "Agree"'], 'the region is not a control');
  await page.context().close();
  const many = await pageWith(`<main>${Array.from({ length: 30 }, (_, i) => `<button>B${i}</button>`).join('')}</main>`);
  const f = failing(await checks.keyboard(many, { max: 10 }));
  assert.equal(f.length, 1);
  assert.match(f[0].measured, /budget of 10 presses ran out/);
  await many.context().close();
});

test('targetSize: a stretched link is measured by its hit area, not its line box', async () => {
  const rows = (stretch) => `<main><style>.q{position:relative;display:flex;flex-direction:column;width:200px;height:56px;font:12px/16px sans-serif}${stretch ? '.q a::after{content:"";position:absolute;inset:0}' : ''}</style>
    <div class="q" style="justify-content:flex-end"><span>Quoted words from Pat</span><a href="#a">Pat Example</a></div>
    <div class="q"><a href="#b">Alex Example</a><span>Quoted words from Alex</span></div></main>`;
  const ok = await pageWith(rows(true));
  assert.deepEqual(failing(await checks.targetSize(ok)), [], 'a link whose ::after covers its 200x56 row passes');
  assert.match(await ok.evaluate(() => JSON.stringify(window.__fr.hitBox(window.__fr.ref(document.querySelector('a'))))), /"width":(199|200),"height":(55|56),"square":true/);
  const without = await pageWith(rows(false));
  const plain = failing(await checks.targetSize(without));
  assert.equal(plain.length, 2, 'without the stretch, the same links are 16 px lines next to each other');
  await without.context().close();
  await ok.context().close();
  // Two bare inline links on neighbouring lines: each 16 px line, too close to space out.
  const bare = await pageWith('<main><p style="font:12px/16px sans-serif;margin:0"><a href="#a">Pat Example</a></p><p style="font:12px/16px sans-serif;margin:0"><a href="#b">Alex Example</a></p></main>');
  const f = failing(await checks.targetSize(bare));
  assert.equal(f.length, 2, JSON.stringify(f));
  assert.ok(+f[0].measured.split("x")[1] < 24, f[0].measured);
  await bare.context().close();
  // A stretch that something else covers doesn't count where it is covered.
  const covered = await pageWith(rows(true).replace('</main>', '<div style="position:absolute;left:0;top:0;width:200px;height:120px;background:#fff"></div></main>').replace('.q{position:relative;', '.q{position:relative;z-index:0;'));
  assert.ok(failing(await checks.targetSize(covered)).length > 0, 'a stretched area under an overlay is not a hit area');
  await covered.context().close();
});

test('targetSize: a stretch counts only where it can be hit, and checking it scrolls nothing', async () => {
  // 300 px cards whose links stretch over them, each covered but for its link's 16 px line: the hit area is 300x16. The
  // first card's link is its last line and the second's its first, so the two strips touch.
  const cover = '<div style="position:relative;z-index:1;height:284px;background:#fff">Covering words</div>';
  const link = (n) => `<a href="#${n}" class="s" style="display:block">Open ${n}</a>`;
  const card = (inner) => `<div style="position:relative;width:300px;height:300px;font:12px/16px sans-serif">${inner}</div>`;
  for (const h of [300, 1500, 3000]) {
    const covered = cover.replace('height:284px', `height:${h - 16}px`);
    const card2 = (inner) => card(inner).replace('height:300px', `height:${h}px`);
    const page = await pageWith(`<main><style>.s::after{content:"";position:absolute;inset:0}</style>${card2(covered + link(1))}${card2(link(2) + covered)}</main>`, { width: 800, height: 600 });
    const box = JSON.parse(await page.evaluate(() => JSON.stringify(window.__fr.hitBox(window.__fr.ref(document.querySelector('.s'))))));
    assert.equal(box.square, false, `${h} px card: ${JSON.stringify(box)}`);
    assert.ok(box.height <= 17 && box.width >= 299, `${h} px card's hit area is its 16 px strip: ${JSON.stringify(box)}`);
    const f = failing(await checks.targetSize(page));
    assert.equal(f.length, 2, `${h} px card: ${JSON.stringify(f)}`);
    assert.match(f[0].label, /hit area/);
    await page.context().close();
  }
  // Two adjacent 700x300 cards with one opening each: a 21 px strip fails, a 27 px square passes.
  const opening = (w, h) => `<div style="position:absolute;inset:0;z-index:1;background:#fff;clip-path:polygon(evenodd,0 0,100% 0,100% 100%,0 100%,0 0,300px 100px,300px ${100 + h}px,${300 + w}px ${100 + h}px,${300 + w}px 100px,300px 100px)"></div>`;
  const holed = (w, h) => `<main><style>.s::after{content:"";position:absolute;inset:0}</style>${[1, 2].map((n) => `<div style="position:relative;width:700px;height:300px;font:12px/16px sans-serif"><a href="#${n}" class="s" style="display:block">Open ${n}</a>${opening(w, h)}</div>`).join('')}</main>`;
  for (const [w, h, ok] of [[27, 27, true], [24, 24, true], [300, 21, false], [23, 300, false]]) {
    const p = await pageWith(holed(w, h), { width: 800, height: 700 });
    const square = await p.evaluate(() => window.__fr.hitBox(window.__fr.ref(document.querySelectorAll('.s')[1]))?.square);
    assert.equal(square, ok, `a ${w}x${h} opening`);
    await p.context().close();
  }
  // Wider cards and every offset: a 24 px opening passes wherever the grid falls.
  const hole = (x, y, w, h) => `<div style="position:absolute;inset:0;z-index:1;background:#fff;clip-path:polygon(evenodd,0 0,100% 0,100% 100%,0 100%,0 0,${x}px ${y}px,${x}px ${y + h}px,${x + w}px ${y + h}px,${x + w}px ${y}px,${x}px ${y}px)"></div>`;
  const cardWith = (width, cover) => `<main><style>.s::after{content:"";position:absolute;inset:0}</style><div style="position:relative;width:${width}px;height:300px;font:12px/16px sans-serif"><a href="#x" class="s" style="display:block">Open</a>${cover}</div></main>`;
  for (const [width, x] of [[1000, 302], [1000, 304], [1000, 311], [1100, 307]]) {
    const p = await pageWith(cardWith(width, hole(x, 100, 24, 24)), { width: width + 100, height: 700 });
    assert.equal(await p.evaluate(() => window.__fr.hitBox(window.__fr.ref(document.querySelector('.s')))?.square), true, `a 24 px opening at ${x} on a ${width} px card`);
    await p.context().close();
  }
  // Thin strips above don't crowd out the one real square below them.
  const strips = [0, 1, 2, 3, 4, 5].map((k) => `<div style="position:absolute;inset:0;z-index:${2 + k};pointer-events:none"></div>`).join('');
  const many = (x0) => [0, 1, 2, 3, 4, 5].map((k) => [x0 + k * 60, 20, 22, 200]);
  const cover2 = `<div style="position:absolute;inset:0;z-index:1;background:#fff;clip-path:polygon(evenodd,0 0,100% 0,100% 100%,0 100%,0 0,${many(20).map(([x, y, w, h]) => `${x}px ${y}px,${x}px ${y + h}px,${x + w}px ${y + h}px,${x + w}px ${y}px,${x}px ${y}px,0 0`).join(',')},400px 240px,400px 280px,440px 280px,440px 240px,400px 240px)"></div>`;
  const crowded = await pageWith(cardWith(700, cover2 + strips), { width: 800, height: 700 });
  assert.equal(await crowded.evaluate(() => window.__fr.hitBox(window.__fr.ref(document.querySelector('.s')))?.square), true, 'a 40 px opening below six 22 px strips');
  await crowded.context().close();
  // A screen wider than 120 x 24 px.
  const wide = await pageWith(cardWith(3100, hole(995, 100, 24, 24)), { width: 3200, height: 700 });
  assert.equal(await wide.evaluate(() => window.__fr.hitBox(window.__fr.ref(document.querySelector('.s')))?.square), true, 'a 24 px opening on a 3,100 px card');
  await wide.context().close();
  // A big card whose stretch is all clickable passes, however coarse the first grid.
  const open = await pageWith(`<main><style>.s::after{content:"";position:absolute;inset:0}</style>${card(link(1)).replace('height:300px', 'height:1500px')}${card(link(2)).replace('height:300px', 'height:1500px')}</main>`);
  assert.deepEqual(failing(await checks.targetSize(open)), []);
  await open.context().close();
  // A stretched link deep in a scroller: the check puts the scroller back.
  const rows = '<div style="position:relative;height:40px"><a href="#a" class="s" style="font:12px/16px sans-serif">A</a></div><div style="position:relative;height:40px"><a href="#b" class="s" style="font:12px/16px sans-serif">B</a></div>';
  for (const behavior of ['auto', 'smooth']) {
    const scroller = await pageWith(`<main><style>.s::after{content:"";position:absolute;inset:0}</style><div id="sc" style="height:150px;overflow:auto;scroll-behavior:${behavior}"><div style="height:600px"></div>${rows}</div></main>`);
    await checks.targetSize(scroller);
    assert.equal(await scroller.evaluate(() => document.getElementById('sc').scrollTop), 0, `a ${behavior} scroller is put back`);
    await scroller.context().close();
  }
});

test('targetSize: a hit area under the minimum fails and one at it passes, at any sub-pixel offset; thin rows above a real square cost little', async () => {
  const box = (x, w, h) => `<main><style>.s::after{content:"";position:absolute;left:${x}px;top:${x}px;width:${w}px;height:${h}px}</style><div style="position:relative;width:400px;height:400px;font:12px/16px sans-serif"><a href="#x" class="s" style="display:block">Open</a></div></main>`;
  // To the pixel: areas a pixel or more under the minimum fail at any offset, 24 px areas pass at any offset.
  for (const [x, w, h, ok] of [[10, 22, 22, false], [10.45, 22, 300, false], [10.7, 22.5, 22.5, false], [10, 24, 24, true], [10.3, 24, 24, true], [10.5, 24, 24, true], [10.99, 24, 24, true]]) {
    const p = await pageWith(box(x, w, h));
    assert.equal(await p.evaluate(() => window.__fr.hitBox(window.__fr.ref(document.querySelector('.s')))?.square), ok, `${w}x${h} at ${x}`);
    await p.context().close();
  }
  // A card of 40 px paragraphs over a stretched link, open between them in 16 px rows, and open at the bottom.
  const paras = Array.from({ length: 6 }, () => '<p style="position:relative;z-index:1;height:40px;margin:0 0 16px;background:#fff">Words</p>').join('');
  const p = await pageWith(`<main><style>.s::after{content:"";position:absolute;inset:0}</style><div style="position:relative;width:600px;padding-bottom:48px;font:12px/16px sans-serif"><h3 style="margin:0;font:inherit"><a href="#x" class="s">Open</a></h3>${paras}</div></main>`, { width: 800, height: 900 });
  assert.equal(await p.evaluate(() => window.__fr.hitBox(window.__fr.ref(document.querySelector('.s')))?.square), true, 'the open bottom of the card is found');
  await p.context().close();
});

test('targetSize: an inline link around a 40 px icon is measured by the icon it holds', async () => {
  const icon = (n) => `<p style="margin:0;font:7px/7px sans-serif"><a href="#${n}" aria-label="Open ${n}"><span style="display:inline-block;width:40px;height:40px;background:#ccc"></span></a></p>`;
  const page = await pageWith(`<main>${icon(1)}${icon(2)}</main>`);
  const hb = JSON.parse(await page.evaluate(() => JSON.stringify(window.__fr.hitBox(window.__fr.ref(document.querySelector('a'))))));
  assert.ok(hb?.square && Math.abs(hb.width - 40) <= 1 && Math.abs(hb.height - 40) <= 1, JSON.stringify(hb));
  assert.deepEqual(failing(await checks.targetSize(page)), []);
  await page.context().close();
});

test('targetSize: stretched rows deep in a scroller, or slotted into a shadow scroller, are measured in view and put back', async () => {
  // Links on neighbouring rows touch (the first at its row's foot, the next at its top), so spacing can't excuse them.
  const rows = Array.from({ length: 6 }, (_, k) => `<div class="q" style="position:relative;display:flex;flex-direction:column;justify-content:${k % 2 ? 'flex-start' : 'flex-end'};width:200px;height:56px;font:12px/16px sans-serif">${k % 2 ? `<a href="#${k}">Name ${k}</a><span>Quoted ${k}</span>` : `<span>Quoted ${k}</span><a href="#${k}">Name ${k}</a>`}</div>`).join('');
  const css = '<style>.q a::after{content:"";position:absolute;inset:0}</style>';
  const page = await pageWith(`<main>${css}<div id="sc" style="height:150px;overflow:auto">${rows}</div></main>`);
  assert.deepEqual(failing(await checks.targetSize(page)), []);
  assert.equal(await page.evaluate(() => document.getElementById('sc').scrollTop), 0);
  await page.context().close();
  const shadow = await pageWith(`<main>${css}<x-panel id="host">${rows}</x-panel></main><script>
    customElements.define('x-panel', class extends HTMLElement { constructor() { super(); this.attachShadow({ mode: 'open' }).innerHTML = '<div id="sc" style="height:150px;overflow:auto"><slot></slot></div>'; } });
  </script>`);
  await checks.targetSize(shadow);
  assert.equal(await shadow.evaluate(() => document.getElementById('host').shadowRoot.getElementById('sc').scrollTop), 0, 'a shadow scroller is put back');
  await shadow.context().close();
});

test('duoOverlap: text that isn\'t painted (screen-reader-only, opacity 0, visibility hidden) is not content under the art', async () => {
  const srOnly = 'position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0';
  const page = await pageWith(`<style>main { position: relative; font: 16px system-ui; } .art { position: absolute; left: 200px; top: 0; width: 400px; height: 200px; background: #eee; z-index: 5; pointer-events: none }</style>
    <main>
      <p style="position:relative;margin:20px;width:170px">Read <a href="#d">the docs<span style="${srOnly}"> (opens in a new tab), which a screen reader says</span></a></p>
      <p style="position:absolute;left:220px;top:40px;margin:0;clip-path:inset(50%)">Clipped away entirely by clip-path</p>
      <p style="position:absolute;left:220px;top:80px;margin:0;opacity:0">Faded out to nothing</p>
      <p style="position:absolute;left:220px;top:120px;margin:0;visibility:hidden">Hidden but holding its place</p>
      <div class="art" data-duo aria-hidden="true"></div>
    </main>`);
  const f = failing(await checks.duoOverlap(page));
  assert.deepEqual(f, [], JSON.stringify(f));
  await page.context().close();
  // The same words, painted, under the same art, still fail.
  const shown = await pageWith(`<style>main { position: relative; font: 16px system-ui; } .art { position: absolute; left: 200px; top: 0; width: 400px; height: 200px; background: #eee; z-index: 5; pointer-events: none }</style>
    <main><p style="position:absolute;left:220px;top:80px;margin:0">Painted words under the art</p><div class="art" data-duo aria-hidden="true"></div></main>`);
  assert.ok(failing(await checks.duoOverlap(shown)).some((x) => /under duo art/.test(x.label)));
  await shown.context().close();
  const under = (wrap) => `<style>main { position: relative; font: 16px system-ui; } .art { position: absolute; left: 200px; top: 0; width: 400px; height: 200px; background: #eee; z-index: 5; pointer-events: none }</style>
    <main>${wrap('<p style="position:absolute;left:220px;top:80px;margin:0">Painted words under the art</p>')}<div class="art" data-duo aria-hidden="true"></div></main>`;
  // Faded out at one capture and shown at the next: the next one sees it.
  const fading = await pageWith(under((p) => `<div id="w" style="opacity:0">${p}</div>`));
  assert.deepEqual(failing(await checks.duoOverlap(fading)), []);
  await fading.evaluate(() => (document.getElementById('w').style.opacity = '1'));
  assert.ok(failing(await checks.duoOverlap(fading)).some((x) => /under duo art/.test(x.label)), 'a later capture sees it shown');
  await fading.context().close();
  // An absolutely placed paragraph escapes a collapsed overflow-hidden wrapper that isn't its containing block.
  const escaped = await pageWith(under((p) => `<div style="overflow:hidden">${p}</div>`));
  assert.ok(failing(await checks.duoOverlap(escaped)).some((x) => /under duo art/.test(x.label)));
  await escaped.context().close();
});

test('overflow: text in a collapsed disclosure is not cut off; a fold with no control to open it still is', async () => {
  const long = '<p>Line one of a long message</p><p>Line two</p><p>Line three</p><p>Line four</p><p>Line five</p><figure><figcaption>bash</figcaption></figure>';
  const fold = (control) => `<main><div id="m" style="max-height:60px;overflow:hidden;font:16px/20px sans-serif">${long}</div>${control}</main>`;
  const one = async (html) => { const p = await pageWith(html); const f = failing(await checks.overflow(p)); await p.context().close(); return f; };
  assert.deepEqual(await one(fold('<button aria-expanded="false" aria-controls="m">See more</button>')), [], 'a See more that controls the fold');
  assert.deepEqual(await one(`<main><div aria-expanded="false"><div style="max-height:60px;overflow:hidden;font:16px/20px sans-serif">${long}</div></div></main>`), [], 'a collapsed region');
  assert.deepEqual(await one(`<main><details><summary>More</summary><div style="max-height:60px;overflow:hidden">${long}</div></details></main>`), [], 'a closed details');
  assert.deepEqual(await one(`<main><div inert><div style="max-height:60px;overflow:hidden;font:16px/20px sans-serif">${long}</div></div></main>`), [], 'an inert region');
  assert.equal((await one(fold(''))).length, 1, 'with nothing to open it, the fold hides words');
  assert.equal((await one(fold('<button aria-expanded="true" aria-controls="m">See less</button>'))).length, 1, 'an expanded control that still clips is not a fold');
  assert.equal((await one('<main><button aria-expanded="false" aria-haspopup="listbox" role="combobox" style="width:60px;overflow:hidden;white-space:nowrap;font:16px sans-serif">A long chosen value that is cut</button></main>')).length, 1, 'a collapsed combobox still shows its own text');
  assert.equal((await one('<main><button aria-expanded="false" aria-haspopup="menu" style="width:60px;overflow:hidden;white-space:nowrap;font:16px sans-serif">A long menu button label</button></main>')).length, 1, 'a menu button still shows its own text');
  assert.deepEqual(await one(`<main><button aria-expanded="false" style="display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;width:200px;font:16px/20px sans-serif;text-align:start">${'A long post that the button opens in place when pressed. '.repeat(6)}</button></main>`), [], 'a clamped button that expands its own text');
});

test('axe: region leaves out open popup layers and portal roots, and still holds for page content', async () => {
  const menu = '<div data-base-ui-portal=""><div role="menu" aria-label="Riders"><div role="group" aria-labelledby="g1"><div id="g1">Your agent</div><div role="menuitem" tabindex="-1">Reading your Teams</div></div></div></div>';
  const page = await pageWith(`<main><h1>T</h1><p>Page words.</p></main>${menu}<div popover="manual" id="pop">A popover's words</div><script>document.getElementById('pop').showPopover()</script>`);
  const f = failing(await checks.axe(page)).filter((x) => /region/.test(x.measured));
  assert.deepEqual(f, [], JSON.stringify(f));
  await page.context().close();
  const stray = await pageWith('<main><h1>T</h1></main><p>Words outside every landmark.</p>');
  assert.ok(failing(await checks.axe(stray)).some((x) => /^region/.test(x.measured)), 'page content outside landmarks still fails');
  await stray.context().close();
  const own = await pageWith('<main><h1>T</h1></main><div data-my-layer><p>Layer words</p></div>');
  assert.ok(failing(await checks.axe(own)).some((x) => /^region/.test(x.measured)));
  assert.ok(!failing(await checks.axe(own, { popupLayers: ['[data-my-layer]'] })).some((x) => /^region/.test(x.measured)), 'a configured layer');
  await own.context().close();
});
