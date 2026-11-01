import { defineFlow } from '@ourostack/flow-review';

export default defineFlow({
  name: 'Fixture: open details',
  surface: 'web',
  app: { start: 'node test/fixtures/serve.mjs 5297 test/fixtures/site', url: 'http://127.0.0.1:5297/' },
  matrix: { viewports: ['390x844', '1280x800'], themes: ['light', 'dark'], reducedMotion: [true] },
  steps: [
    { id: 'open', goto: '/' },
    { waitFor: { text: 'First thing' } },
    { capture: { moment: 'list' } },
    { id: 'details', act: { role: 'button', name: 'Open details', verb: 'click' }, expect: { role: 'dialog', name: 'Details' } },
    { capture: { moment: 'dialog', region: { role: 'dialog' } } },
    { tabTraverse: true },
    { act: { verb: 'press', key: 'Escape' }, expect: { focus: { role: 'button', name: 'Open details' } } },
    { id: 'empty', goto: '/', route: { '**/data.json': { json: { items: [] } } }, state: 'empty' },
    { id: 'error', goto: '/', route: { '**/data.json': { status: 500, body: 'boom' } }, state: 'error', stateRegion: { text: 'could not load' } },
    { id: 'raw-error', goto: '/?raw', route: { '**/data.json': { status: 500, body: 'boom' } }, state: 'error' },
  ],
  checks: { designSystem: { marker: '[data-ds]' }, skip: ['jank'] },
  rubric: ['craft'],
});
