import http from 'node:http';
import {readFile} from 'node:fs/promises';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
const root = path.resolve(fileURLToPath(new URL('../', import.meta.url)));
const port = Number(process.env.PORT || 8766);
const mime = {'.html': 'text/html; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.png': 'image/png'};
http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://127.0.0.1');
    const file = path.resolve(root, '.' + decodeURIComponent(url.pathname === '/' ? '/tests/native.html' : url.pathname));
    if (!file.startsWith(root + path.sep)) throw Error('Forbidden');
    let data = await readFile(file);
    if (url.pathname === '/popup.html') data = Buffer.from(data.toString().replace('<head>', '<head><script type="module" src="/tests/browser-host.mjs"></script>'));
    res.writeHead(200, {'Content-Type': mime[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-store'});
    res.end(data);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
}).listen(port, '127.0.0.1', () => console.log(`Mini browser harness http://127.0.0.1:${port}/tests/native.html`));
