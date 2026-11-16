const { copyFileSync } = require('node:fs');
const { join } = require('node:path');

for (const name of ['server.cjs', 'start.sh', 'stop.sh', 'health.sh']) {
  copyFileSync(join(__dirname, 'scripts', name), join(__dirname, 'dist', name));
}
