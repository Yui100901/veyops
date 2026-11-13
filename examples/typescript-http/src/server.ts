import { createServer } from 'node:http';

const profiles = {
  test: { port: 38781, packageManager: 'npm' },
  staging: { port: 38782, packageManager: 'pnpm' },
} as const;

const environment = process.env.VEYOPS_DEMO_ENV;
if (environment !== 'test' && environment !== 'staging') {
  throw new Error('VEYOPS_DEMO_ENV must be test or staging');
}
const profile = profiles[environment];
const instance = process.env.VEYOPS_DEMO_INSTANCE;

const server = createServer({ requestTimeout: 5000 }, (request, response) => {
  if (request.url !== '/healthz') {
    response.writeHead(404).end();
    return;
  }
  if (request.method !== 'GET') {
    response.writeHead(405, { Allow: 'GET' }).end();
    return;
  }
  response.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' }).end(
    JSON.stringify({
      status: 'ok',
      language: 'typescript',
      environment,
      packageManager: profile.packageManager,
      ...(instance && { instance }),
    }) + '\n',
  );
});
server.headersTimeout = 5000;

server.listen(profile.port, '127.0.0.1', () => {
  console.log(`TypeScript ${environment} health endpoint at 127.0.0.1:${profile.port}`);
});
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
