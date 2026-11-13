const http = require('node:http');
const { readFileSync } = require('node:fs');
http.createServer((_req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  res.end(readFileSync('/app/dist/index.html'));
}).listen(8080, '0.0.0.0');
