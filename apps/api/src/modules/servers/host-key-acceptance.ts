import { BadRequestException, ConflictException } from '@nestjs/common';
import { createHash, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import type { Kysely, Transaction } from 'kysely';
import type { Database } from '../../core/database/schema';

interface Endpoint {
  host: string;
  port: number;
}

interface ServerKey extends Endpoint {
  id: string;
  hostKeyFingerprint: string;
}

interface HostKeyOffer extends Endpoint {
  userId: string;
  fingerprint: string;
  expiresAt: number;
  previous?: ServerKey;
}

export const hostKeyAcceptanceToken = /^[A-Za-z0-9_-]{43}$/;
export const hostKeyFingerprint = /^(?:SHA256:[A-Za-z0-9+/]{43}=?|[a-fA-F0-9]{64})$/;
const acceptanceLifetime = 5 * 60_000;
const acceptancePrefix = 'ssh.host-key-acceptance:';

export function normalizeSshHost(host: string) {
  if (!host.includes(':')) return host.toLowerCase();
  if (isIP(host) !== 6) throw new BadRequestException('SSH 主机地址格式无效');
  return new URL(`http://[${host}]/`).hostname.slice(1, -1);
}

export function sameHostKey(left: string, right: string) {
  const digest = (value: string) =>
    value.startsWith('SHA256:')
      ? Buffer.from(value.slice(7), 'base64').toString('hex')
      : value.toLowerCase();
  return digest(left) === digest(right);
}

function settingsKey(token: string) {
  return acceptancePrefix + createHash('sha256').update(token).digest('hex');
}

export async function offerHostKey(
  db: Kysely<Database>,
  input: Endpoint & { userId: string; fingerprint: string },
  previous?: ServerKey,
) {
  const token = randomBytes(32).toString('base64url');
  const now = Date.now();
  const value: HostKeyOffer = {
    ...input,
    expiresAt: now + acceptanceLifetime,
    ...(previous && {
      previous: {
        id: previous.id,
        host: previous.host,
        port: previous.port,
        hostKeyFingerprint: previous.hostKeyFingerprint,
      },
    }),
  };
  await db.transaction().execute(async (tx) => {
    await tx
      .deleteFrom('system_settings')
      .where('key', 'like', `${acceptancePrefix}%`)
      .where('updated_at', '<=', now - acceptanceLifetime)
      .execute();
    await tx
      .insertInto('system_settings')
      .values({ key: settingsKey(token), value_json: JSON.stringify(value), updated_at: now })
      .execute();
  });
  return { acceptanceToken: token, expiresAt: value.expiresAt };
}

export async function acceptHostKey(
  tx: Transaction<Database>,
  token: string,
  input: Endpoint & { userId: string },
  previous?: ServerKey,
) {
  // The caller persists the trusted key in this transaction. A rollback leaves the offer available.
  const row = await tx
    .deleteFrom('system_settings')
    .where('key', '=', settingsKey(token))
    .returning('value_json')
    .executeTakeFirst();
  const offer = row ? (JSON.parse(row.value_json) as HostKeyOffer) : undefined;
  if (
    !offer ||
    offer.expiresAt <= Date.now() ||
    offer.userId !== input.userId ||
    offer.host !== input.host ||
    offer.port !== input.port ||
    offer.previous?.id !== previous?.id ||
    offer.previous?.host !== previous?.host ||
    offer.previous?.port !== previous?.port ||
    offer.previous?.hostKeyFingerprint !== previous?.hostKeyFingerprint
  ) {
    throw new ConflictException('SSH 指纹确认已失效，请重新探测并确认');
  }
  return offer.fingerprint;
}
