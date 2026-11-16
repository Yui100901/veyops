const { createServer } = require('node:http');
const port = Number(process.env.PORT);
if (![38853, 38854].includes(port)) throw new Error('Missing fixture port');
const server = createServer((req, res) => {
  if (req.url !== '/healthz') return res.writeHead(404).end();
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify({ status: 'ok', framework: 'docker' }));
});
server.listen(port, '127.0.0.1');
process.on('SIGTERM', () => server.close());
