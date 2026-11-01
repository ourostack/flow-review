// A static server for the fixture site: node serve.mjs <port> <dir>
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

const [port, dir] = process.argv.slice(2);
const types = { '.html': 'text/html; charset=utf-8', '.json': 'application/json', '.js': 'text/javascript', '.css': 'text/css', '.png': 'image/png' };
// A directory with a csp.txt serves every page under that Content-Security-Policy.
const csp = fs.existsSync(path.join(dir, 'csp.txt')) ? fs.readFileSync(path.join(dir, 'csp.txt'), 'utf8').trim() : null;
http.createServer((req, res) => {
  const p = new URL(req.url, 'http://x').pathname;
  const file = path.join(path.resolve(dir), p === '/' ? 'index.html' : p);
  if (!file.startsWith(path.resolve(dir)) || !fs.existsSync(file)) { res.statusCode = 404; return res.end('not found'); }
  res.setHeader('content-type', types[path.extname(file)] ?? 'application/octet-stream');
  if (csp && file.endsWith('.html')) res.setHeader('content-security-policy', csp);
  res.end(fs.readFileSync(file));
}).listen(Number(port), '127.0.0.1');
