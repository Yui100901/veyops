#!/bin/sh
set -eu

case "${VEYOPS_DEMO_ENV:-}" in
  test) port=38781; manager=npm ;;
  staging) port=38782; manager=pnpm ;;
  *) echo 'VEYOPS_DEMO_ENV must be test or staging' >&2; exit 1 ;;
esac
node_bin=${VEYOPS_NODE:-node}
release_dir=$(pwd -P)
"$node_bin" - "$port" "$manager" "${release_dir##*/}" <<'NODE'
const [port, manager, instance] = process.argv.slice(2);
const environment = process.env.VEYOPS_DEMO_ENV;
async function check() {
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`, {
        redirect: 'error', signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        const health = await response.json();
        if (health.status === 'ok' && health.language === 'typescript' &&
            health.environment === environment && health.packageManager === manager && health.instance === instance) {
          console.log(JSON.stringify(health));
          return;
        }
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  console.error(`TypeScript ${environment} health check failed at 127.0.0.1:${port}`);
  process.exitCode = 1;
}
void check();
NODE
