// Keyboard patterns that are not defects: roving focus in composite widgets, a combobox that takes a Tab to accept its
// suggestion, a non-modal dialog (a toast), a control the traversal itself removes, and focus guards under axe. Each case
// failed before the engine knew the pattern; a real defect beside it still fails.
import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { checks } from '../lib/index.mjs';
import { pageWith, failing, close } from './helpers.mjs';

after(close);

// A message list as one Tab stop (roving tabindex): Tab lands on the current message, the arrow keys, Home and End move
// between messages, Tab goes into the current message's controls, and the Tab after its last control leaves the list.
// Every message's controls keep tabindex 0; the list steers Tab past the others in script.
const rovingList = (extra = '') => `<main>
  <button id="before">Before</button>
  <div role="list" aria-label="Messages" id="list">
    ${[1, 2, 3].map((n) => `<article role="listitem" data-item tabindex="${n === 3 ? 0 : -1}" aria-label="Message ${n}"><p>Message ${n}</p><button>React ${n}</button><button>Reply ${n}</button>${n === 2 ? extra : ''}</article>`).join('')}
  </div>
  <button id="after">After</button>
</main>
<script>
  const list = document.getElementById('list');
  const items = [...list.querySelectorAll('[data-item]')];
  const current = () => items.find((i) => i.tabIndex === 0);
  const go = (i) => { items.forEach((x) => (x.tabIndex = x === i ? 0 : -1)); i.focus(); };
  list.addEventListener('keydown', (e) => {
    const item = e.target.closest('[data-item]');
    const at = items.indexOf(item);
    if (e.target === item && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
      e.preventDefault();
      go(items[e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : Math.max(0, Math.min(items.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))]);
    } else if (e.key === 'Tab' && !e.shiftKey && item) {
      const own = [...item.querySelectorAll('button')];
      const i = e.target === item ? -1 : own.indexOf(e.target);
      e.preventDefault();
      (own[i + 1] ?? document.getElementById('after')).focus();
    }
  });
  document.getElementById('before').addEventListener('keydown', (e) => { if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); current().focus(); } });
</script>`;

test('keyboard: a roving list reaches every message\'s controls by arrowing to the message, then Tab', async () => {
  const page = await pageWith(rovingList());
  const f = failing(await checks.keyboard(page));
  assert.deepEqual(f, [], JSON.stringify(f));
  await page.context().close();
});

test('keyboard: inside a roving list, a control no key reaches is still not reached', async () => {
  const page = await pageWith(rovingList('<span role="button" id="dead" aria-label="Unreachable">x</span>'));
  const f = failing(await checks.keyboard(page));
  assert.equal(f.length, 1, JSON.stringify(f));
  assert.match(f[0].label, /Unreachable/);
  await page.context().close();
});

test('keyboard: a toolbar with roving tabindex and an aria-activedescendant listbox are one stop each', async () => {
  const page = await pageWith(`<main>
    <div role="toolbar" aria-label="Format" id="tb"><button tabindex="0">Bold</button><button tabindex="-1">Italic</button><button tabindex="-1">Link</button></div>
    <div role="listbox" tabindex="0" aria-label="Pick" aria-activedescendant="o1" id="lb"><div role="option" id="o1">One</div><div role="option" id="o2">Two</div></div>
    <button>Done</button>
  </main>
  <script>
    const tb = document.getElementById('tb');
    tb.addEventListener('keydown', (e) => {
      const bs = [...tb.querySelectorAll('button')];
      const i = bs.indexOf(e.target);
      const j = e.key === 'ArrowRight' ? i + 1 : e.key === 'ArrowLeft' ? i - 1 : e.key === 'Home' ? 0 : e.key === 'End' ? bs.length - 1 : null;
      if (j === null || !bs[j]) return;
      e.preventDefault();
      bs.forEach((b, k) => (b.tabIndex = k === j ? 0 : -1));
      bs[j].focus();
    });
  </script>`);
  const f = failing(await checks.keyboard(page));
  assert.deepEqual(f, [], JSON.stringify(f));
  await page.context().close();
});

test('keyboard: Tab that accepts an open combobox\'s suggestion is not a trap', async () => {
  const page = await pageWith(`<main>
    <label>Reply <input id="c" role="combobox" aria-expanded="true" aria-controls="sug" aria-autocomplete="list" value="@Al"></label>
    <ul role="listbox" id="sug"><li role="option" aria-selected="true">Alex Example</li></ul>
    <button>Send</button><button>Attach</button>
  </main>
  <script>
    const c = document.getElementById('c');
    c.addEventListener('keydown', (e) => {
      if (e.key === 'Tab' && c.getAttribute('aria-expanded') === 'true') {
        e.preventDefault();
        c.value = '@Alex Example ';
        c.setAttribute('aria-expanded', 'false');
        document.getElementById('sug').hidden = true;
      }
    });
    c.focus();
  </script>`);
  const f = failing(await checks.keyboard(page));
  assert.deepEqual(f, [], JSON.stringify(f));
  await page.context().close();
  // A field that keeps Tab whatever its state is still a trap.
  const stuck = await pageWith('<main><input id="c" role="combobox" aria-expanded="true" aria-label="Stuck" onkeydown="if (event.key === \'Tab\') event.preventDefault()"><button>Send</button></main>');
  assert.ok(failing(await checks.keyboard(stuck)).some((x) => x.measured === 'focus trapped'));
  await stuck.context().close();
});

test('keyboard: a non-modal dialog (a toast) neither traps focus nor scopes the checks', async () => {
  const toast = '<section role="region" aria-label="Notifications"><div role="dialog" aria-label="Sent" aria-live="polite"><p>Sent</p><button>Dismiss</button></div></section>';
  const page = await pageWith(`<main><button id="send">Send</button><button>Attach</button></main>${toast}<script>document.getElementById('send').focus()</script>`);
  const f = failing(await checks.keyboard(page));
  assert.deepEqual(f, [], JSON.stringify(f));
  assert.equal(await page.evaluate(() => window.__fr.modalRoot()), null);
  await page.context().close();
  // A dialog that hides the page behind it (Base UI's and Radix's modal pattern, without aria-modal) is still modal.
  const hidden = await pageWith('<div id="app" aria-hidden="true"><main><button>Behind</button></main></div><div role="dialog" aria-label="D"><button>In</button><button>Also in</button></div>');
  assert.equal(await hidden.evaluate(() => window.__fr.modalRoot()?.getAttribute('aria-label')), 'D');
  await hidden.context().close();
  // A <dialog> opened with show() is not modal; showModal() is.
  const shown = await pageWith('<main><button>Page</button></main><dialog id="d" aria-label="D"><button>In</button></dialog><script>document.getElementById("d").show()</script>');
  assert.equal(await shown.evaluate(() => window.__fr.modalRoot()), null);
  await shown.context().close();
});

test('keyboard: a control the traversal itself removes is not reported unreachable', async () => {
  // Reading the conversation (focusing into it) marks it read, and the header's Mark read button goes away.
  const page = await pageWith(`<main>
    <button id="convo">Conversation</button><button>Reply</button><button id="mark">Mark read</button>
  </main>
  <script>document.getElementById('convo').addEventListener('focus', () => document.getElementById('mark')?.remove())</script>`);
  const f = failing(await checks.keyboard(page));
  assert.deepEqual(f, [], JSON.stringify(f));
  await page.context().close();
});

test('axe: focus guards are left out by a config list; aria-hidden-focus still holds elsewhere', async () => {
  const guards = '<span data-base-ui-focus-guard="" aria-hidden="true" tabindex="0"></span><span data-radix-focus-guard="" aria-hidden="true" tabindex="0"></span>';
  const page = await pageWith(`<main><h1>T</h1>${guards}<button>Popup item</button>${guards}</main>`);
  const f = failing(await checks.axe(page));
  assert.deepEqual(f, [], JSON.stringify(f));
  await page.context().close();
  const real = await pageWith('<main><h1>T</h1><div aria-hidden="true"><button>Hidden but focusable</button></div></main>');
  assert.ok(failing(await checks.axe(real)).some((x) => /aria-hidden-focus/.test(x.measured)));
  await real.context().close();
  // A project's own guard marker, from config.
  const own = await pageWith('<main><h1>T</h1><span data-my-guard aria-hidden="true" tabindex="0"></span><button>Item</button></main>');
  assert.ok(failing(await checks.axe(own)).length > 0);
  assert.deepEqual(failing(await checks.axe(own, { focusGuards: ['[data-my-guard]'] })), []);
  await own.context().close();
});

test('keyboard: a control disabled for a moment while Tab passes it is reachable when Tab comes round again', async () => {
  // While a write is in flight (here: from the chat's first focus until focus moves on past the header), Mark read is
  // disabled and Tab skips it; by the next time round it is back.
  const page = await pageWith(`<main><button id="convo">Conversation</button><button>Reply</button><button id="mark">Mark read</button><button id="open">Open in Teams</button></main>
  <script>
    const mark = document.getElementById('mark');
    let once = false;
    document.getElementById('convo').addEventListener('focus', () => { if (!once) { once = true; mark.disabled = true; } });
    document.getElementById('open').addEventListener('focus', () => (mark.disabled = false));
  </script>`);
  const f = failing(await checks.keyboard(page));
  assert.deepEqual(f, [], JSON.stringify(f));
  await page.context().close();
  // One that stays out of the tab order is still reported.
  const never = await pageWith('<main><button>One</button><div role="button" aria-label="Never">x</div><button>Two</button></main>');
  assert.ok(failing(await checks.keyboard(never)).some((x) => /Never/.test(x.label)));
  await never.context().close();
});

test('keyboard: driving a roving list leaves its current item where it was; controls the drive removes are not missing', async () => {
  const page = await pageWith(rovingList());
  const before = await page.evaluate(() => [...document.querySelectorAll('[data-item]')].findIndex((i) => i.tabIndex === 0));
  assert.deepEqual(failing(await checks.keyboard(page)), []);
  assert.equal(await page.evaluate(() => [...document.querySelectorAll('[data-item]')].findIndex((i) => i.tabIndex === 0)), before);
  await page.context().close();
  // Arriving on a message marks it read, and its Mark read button goes.
  const read = await pageWith(rovingList().replace(/<button>Reply (\d)<\/button>/g, '<button>Reply $1</button><button class="mr">Mark read $1</button>').replace('</script>', "items.forEach((i) => i.addEventListener('focus', () => i.querySelector('.mr')?.remove()));</script>"));
  const f = failing(await checks.keyboard(read));
  assert.deepEqual(f, [], JSON.stringify(f));
  await read.context().close();
});

test('keyboard: in a modal dialog, the roving drive leaves focus inside it', async () => {
  const html = rovingList()
    .replace('<main>', '<div id="app" inert><button>Behind</button></div><div role="dialog" aria-modal="true" aria-label="Thread">')
    .replace('</main>', '</div>')
    .replace("document.getElementById('before').addEventListener", "document.getElementById('after').addEventListener('keydown', (e) => { if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); document.getElementById('before').focus(); } });\n  document.getElementById('before').addEventListener");
  const page = await pageWith(html + "<script>document.getElementById('before').focus()</script>");
  assert.deepEqual(failing(await checks.keyboard(page)), []);
  assert.deepEqual(failing(await checks.keyboard(page)), [], 'a second check still finds focus inside the dialog');
  await page.context().close();
});

for (const stop of [0, 3]) test(`keyboard: roving follows the arrow keys across containers (a thread's posts and its nested replies; stop on item ${stop})`, async () => {
  // The first post holds the one tabindex="0"; the replies sit in a nested container. Down moves through all of them in
  // order, whatever container each is in; Tab goes into the current one's controls.
  const page = await pageWith(`<main>
    <button id="before">Before</button>
    <div role="list" aria-label="Thread" id="list">
      <article data-item tabindex="-1" aria-label="First post"><p>First post</p><button>React to the first post</button></article>
      <article data-item tabindex="-1" aria-label="Second post"><p>Second post</p><button>React to the second post</button></article>
      <article data-item tabindex="-1" aria-label="Third post"><p>Third post</p><button>React to the third post</button></article>
      <div data-thread-replies>
        <article data-item tabindex="-1" aria-label="Reply 1"><p>Reply 1</p><button>Like, 2</button></article>
        <article data-item tabindex="-1" aria-label="Reply 2"><p>Reply 2</p><button>Shipit, 1</button></article>
      </div>
    </div>
    <button id="after">After</button>
  </main>
  <script>
    const items = [...document.querySelectorAll('[data-item]')];
    const go = (i) => { items.forEach((x) => (x.tabIndex = x === i ? 0 : -1)); i.focus(); };
    items[${stop}].tabIndex = 0;
    document.getElementById('before').addEventListener('keydown', (e) => { if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); items.find((i) => i.tabIndex === 0).focus(); } });
    document.getElementById('list').addEventListener('keydown', (e) => {
      const item = e.target.closest('[data-item]');
      const at = items.indexOf(item);
      if (e.target === item && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) {
        e.preventDefault();
        go(items[e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : Math.max(0, Math.min(items.length - 1, at + (e.key === 'ArrowDown' ? 1 : -1)))]);
      } else if (e.key === 'Tab' && !e.shiftKey && item) {
        const own = [...item.querySelectorAll('button')];
        const i = e.target === item ? -1 : own.indexOf(e.target);
        e.preventDefault();
        (own[i + 1] ?? document.getElementById('after')).focus();
      }
    });
  </script>`);
  const f = failing(await checks.keyboard(page));
  assert.deepEqual(f, [], JSON.stringify(f));
  assert.equal(await page.evaluate(() => document.querySelector('[data-item][tabindex="0"]').getAttribute('aria-label')), ['First post', 'Second post', 'Third post', 'Reply 1'][stop], 'left as found');
  await page.context().close();
});
