// The bad page sets an inline style attribute, which a strict style-src blocks.
if (location.search.includes('bad')) document.getElementById('note').setAttribute('style', 'color: #900');
// The cover page shows art painted above words; the art takes no pointer, so only the engine's own rule makes it hit-testable.
if (location.search.includes('cover')) document.body.classList.add('covered');
