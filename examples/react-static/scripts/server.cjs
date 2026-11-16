const { createServer } = require('node:http');
const { readFile } = require('node:fs/promises');
const { join } = require('node:path');

const port = Number(process.env.PORT ?? 8080);
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  throw new Error('PORT must be an integer between 1 and 65535');
}
const root = join(__dirname, 'public');
const instance = process.env.VEYOPS_DEMO_INSTANCE ?? 'standalone';
const mime = { html: 'text/html; charset=utf-8', js: 'text/javascript', css: 'text/css' };

const server = createServer(async (req, res) => {
  const path = req.url?.split('?')[0];
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { Allow: 'GET, HEAD' }).end();
    return;
  }
  try {
    if (path === '/healthz') {
      await readFile(join(root, 'index.html'));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(
        req.method === 'HEAD'
          ? undefined
          : JSON.stringify({ status: 'ok', framework: 'react', instance }),
      );
      return;
    }
    const file =
      path === '/'
        ? 'index.html'
        : /^\/assets\/[\w.-]+\.(?:js|css)$/.test(path ?? '')
          ? path.slice(1)
          : null;
    if (!file) {
      res.writeHead(404).end();
      return;
    }
    const content = await readFile(join(root, file));
    res.writeHead(200, {
      'Content-Type': mime[file.split('.').at(-1)],
      'Content-Length': content.length,
    });
    res.end(req.method === 'HEAD' ? undefined : content);
  } catch (error) {
    res.writeHead(error.code === 'ENOENT' ? 404 : 500).end();
  }
});
server.listen(port, '127.0.0.1');
