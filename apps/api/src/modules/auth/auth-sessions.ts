import { createHash } from 'node:crypto';
import type { Transaction } from 'kysely';
import type { Database } from '../../core/database/schema';

export const sessionHash = (token: string) => createHash('sha256').update(token).digest('hex');

// Call after locking the user row. Logout only locks the session row.
export function lockActiveSession(tx: Transaction<Database>, userId: string, token: string) {
  return tx
    .updateTable('auth_sessions')
    .set((eb) => ({ revoked_at: eb.ref('revoked_at') }))
    .where('user_id', '=', userId)
    .where('token_hash', '=', sessionHash(token))
    .where('revoked_at', 'is', null)
    .where('expires_at', '>', Date.now())
    .returning('id')
    .executeTakeFirst();
}

export async function revokeUserSessions(tx: Transaction<Database>, userId: string, now: number) {
  await tx
    .updateTable('auth_sessions')
    .set({ revoked_at: now })
    .where('user_id', '=', userId)
    .where('revoked_at', 'is', null)
    .execute();
}
