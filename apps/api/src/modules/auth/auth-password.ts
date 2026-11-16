import { randomBytes, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
export const dummyPasswordHash = `${'0'.repeat(32)}:${'0'.repeat(128)}`;

export async function hashPassword(password: string) {
  const salt = randomBytes(16).toString('hex');
  const hash = (await scrypt(password, salt, 64)) as Buffer;
  return `${salt}:${hash.toString('hex')}`;
}

export async function matchesPassword(password: string, storedHash: string) {
  const [salt, expected] = storedHash.split(':');
  const actual = (await scrypt(password, salt || dummyPasswordHash.slice(0, 32), 64)) as Buffer;
  const expectedBytes = Buffer.from(expected || '', 'hex');
  return expectedBytes.length === actual.length && timingSafeEqual(actual, expectedBytes);
}
