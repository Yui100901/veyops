const { copyFileSync } = require('node:fs');
const { join } = require('node:path');

for (const name of ['package.json', 'package-lock.json']) {
  copyFileSync(join(__dirname, name), join(__dirname, 'dist', name));
}
for (const name of ['start.sh', 'stop.sh', 'health.sh']) {
  copyFileSync(join(__dirname, 'scripts', name), join(__dirname, 'dist', name));
}
