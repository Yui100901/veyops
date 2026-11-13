const { mkdirSync, writeFileSync } = require('node:fs');
mkdirSync('dist', { recursive: true });
writeFileSync('dist/index.html', '<!doctype html><meta charset="utf-8"><title>veyops delivery check</title><h1>veyops pipeline deployed</h1>\n');
