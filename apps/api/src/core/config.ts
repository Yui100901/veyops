import { config } from 'dotenv';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const workspaceRoot = existsSync(resolve(process.cwd(), 'apps/api'))
  ? process.cwd()
  : resolve(process.cwd(), '../..');
config({ path: join(workspaceRoot, '.env'), quiet: true });
export const dataDirectory = resolve(workspaceRoot, process.env.DATA_DIR || 'data');

export function encryptionKey(): Buffer {
  const configured = process.env.ENCRYPTION_KEY;
  if (configured) {
    if (!/^[a-f\d]{64}$/i.test(configured))
      throw new Error('ENCRYPTION_KEY must be 64 hex characters');
    return Buffer.from(configured, 'hex');
  }
  if (process.env.NODE_ENV === 'production')
    throw new Error('ENCRYPTION_KEY is required in production');
  const directory = join(dataDirectory, 'config');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'encryption.key');
  try {
    writeFileSync(path, randomBytes(32).toString('hex'), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  const hex = readFileSync(path, 'utf8').trim();
  if (!/^[a-f\d]{64}$/i.test(hex)) throw new Error('Invalid development encryption key');
  return Buffer.from(hex, 'hex');
}
