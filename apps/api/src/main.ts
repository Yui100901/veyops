import { createApp } from './bootstrap';
async function main() {
  const app = await createApp();
  const host = process.env.HOST || '127.0.0.1';
  const port = Number(process.env.PORT || 3000);
  try {
    await app.listen(port, host);
  } catch (error) {
    await app.close();
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE') throw error;
    console.error(`Startup failed: ${host}:${port} is already in use. Choose another PORT.`);
    process.exitCode = 1;
    return;
  }
  console.log(`veyops API ready: http://${host}:${port}/api/v1/health`);
}
void main().catch((error: unknown) => {
  console.error(
    `Startup failed: ${error instanceof Error ? error.name : 'UnknownError'}. Check configuration and migrations.`,
  );
  process.exitCode = 1;
});
