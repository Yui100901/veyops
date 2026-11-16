import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const manifestPath = resolve(__dirname, '../../../../package.json');
export const appVersion = (JSON.parse(readFileSync(manifestPath, 'utf8')) as { version: string })
  .version;
