import { createApp } from './bootstrap';
async function main() {
  const app = await createApp();
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 3000);
  await app.listen(port, host);
  console.log(`veyops API ready: http://${host}:${port}/api/v1/health`);
}
void main().catch((error: unknown) => {
  console.error(
    `Startup failed: ${error instanceof Error ? error.name : 'UnknownError'}. Check configuration and migrations.`,
  );
  process.exitCode = 1;
});
