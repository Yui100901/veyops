#!/bin/sh
set -eu

node_bin=${VEYOPS_NODE:-node}
release_dir=$(pwd -P)
"$node_bin" - "${PORT:-8080}" "${release_dir##*/}" <<'NODE'
const [port, instance] = process.argv.slice(2);
const origin = 'http://127.0.0.1:' + port;

async function check() {
  for (let attempt = 0; attempt < 15; attempt++) {
    try {
      const response = await fetch(origin + '/healthz', {
        redirect: 'error', signal: AbortSignal.timeout(1000),
      });
      if (response.ok) {
        const health = await response.json();
        if (health.status === 'ok' && health.framework === 'react' && health.instance === instance) {
          const html = await fetch(origin, { signal: AbortSignal.timeout(1000) }).then((res) => res.text());
          const asset = /src="\.?(\/assets\/[\w.-]+\.js)"/.exec(html)?.[1];
          if (!asset) throw new Error('Vite entry asset missing');
          const bundle = await fetch(origin + asset, { signal: AbortSignal.timeout(1000) }).then((res) => res.text());
          if (!bundle.includes('VeyOps React 发布成功')) throw new Error('React marker missing');
          console.log(JSON.stringify(health));
          return;
        }
      }
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  console.error('react health check failed at ' + origin);
  process.exitCode = 1;
}
void check();
NODE
