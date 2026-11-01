// A stand-in mock daemon: answers the CLI's reads with made-up data on a port it picks, plus a control port, and
// announces both as one JSON line, the way a product's own mock server can.
import http from 'node:http';

const link = (c, m) => `https://example.com/inbox/${c}/${m}`;
const data = {
  '/today': { attention: { top: [{ ref: 'ej90am#1700001800000', why: 'Pat asked you', from: 'Pat Example' }] }, nextCommands: ['inbox look ej90am'] },
  '/activity': { counts: { unseen: 2 }, items: [{ kind: 'mention' }] },
  // The stand-in's known defect: attention items have no link.
  '/attention': [{ threadTitle: 'Pat Example', why: 'asked you', messageId: '1700001800000' }],
  '/threads': [{ shortId: 'ej90am', title: 'Pat Example', kind: 'direct', link: link('ej90am', 0) }],
  '/look/ej90am#1700001800000': { messages: [{ ref: 'ej90am#1700001800000', link: link('ej90am', 1700001800000), sender: { displayName: 'Pat Example' } }] },
  '/log': [],
};
const serve = (handler) => new Promise((r) => { const s = http.createServer(handler).listen(0, '127.0.0.1', () => r(s)); });
const agent = await serve((req, res) => {
  const body = data[decodeURIComponent(new URL(req.url, 'http://x').pathname)];
  res.statusCode = body === undefined ? 404 : 200;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(body ?? { error: 'not found' }));
});
const control = await serve((req, res) => res.end('{}'));
console.log(JSON.stringify({ agent: `http://127.0.0.1:${agent.address().port}`, control: `http://127.0.0.1:${control.address().port}` }));
