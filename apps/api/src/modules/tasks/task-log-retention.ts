import { lstatSync, realpathSync, unlinkSync } from 'node:fs';
import { join, relative } from 'node:path';
import type { Kysely } from 'kysely';
import type { Database } from '../../core/database/schema';
import { terminalTaskStatuses } from './tasks.types';

export const logRetentionBatchSize = 100;

export function missingLogFile(error: unknown) {
  return (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';
}

export interface LogRetentionResult {
  removed: number;
  missing: number;
  skipped: number;
  failed: number;
  more: boolean;
}

const taskIdFormat = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const logKeyFormat = /^logs\/(\d{4})\/(0[1-9]|1[0-2])\/[a-f0-9-]+\.log$/;

function removeOwnedLog(root: string, id: string, key: string, expectedKey: string) {
  const logParts = logKeyFormat.exec(key);
  if (!logParts || key !== expectedKey || !taskIdFormat.test(id)) return 'skipped';

  let directory = root;
  for (const part of ['logs', logParts[1]!, logParts[2]!]) {
    directory = join(directory, part);
    const entry = lstatSync(directory, { throwIfNoEntry: false });
    if (!entry) return 'missing';
    if (!entry.isDirectory() || entry.isSymbolicLink()) return 'skipped';
  }
  const path = join(directory, `${id}.log`);
  const file = lstatSync(path, { throwIfNoEntry: false });
  if (!file) return 'missing';
  if (!file.isFile() || file.isSymbolicLink() || file.nlink !== 1) return 'skipped';
  if (relative(path, realpathSync(path)) !== '') return 'skipped';
  unlinkSync(path);
  return 'removed';
}

export async function pruneTaskLogs(
  database: Kysely<Database>,
  dataDirectory: string,
  cutoff: number,
  cursor: string | undefined,
  logKey: (id: string, createdAt: number) => string,
) {
  const result: LogRetentionResult = { removed: 0, missing: 0, skipped: 0, failed: 0, more: false };
  let root: string;
  try {
    root = realpathSync(dataDirectory);
  } catch (error) {
    if (missingLogFile(error)) return { result, nextCursor: undefined };
    throw error;
  }

  let eligible = database
    .selectFrom('tasks')
    .select('id')
    .where('status', 'in', terminalTaskStatuses)
    .where('finished_at', '<', cutoff)
    .where('lease_owner', 'is', null)
    .where('log_file_key', 'is not', null);
  if (cursor) eligible = eligible.where('id', '>', cursor);
  const candidates = await eligible
    .orderBy('id')
    .limit(logRetentionBatchSize + 1)
    .execute();
  const batch = candidates.slice(0, logRetentionBatchSize);
  if (batch.length === 0) return { result, nextCursor: undefined };
  result.more = candidates.length > logRetentionBatchSize;

  return database.transaction().execute(async (tx) => {
    // Recheck eligibility while locking each row before removing a file. A concurrent
    // worker or a previous interrupted sweep can safely encounter an already missing log.
    const locked = await tx
      .updateTable('tasks')
      .set((eb) => ({ log_file_key: eb.ref('log_file_key') }))
      .where(
        'id',
        'in',
        batch.map(({ id }) => id),
      )
      .where('status', 'in', terminalTaskStatuses)
      .where('finished_at', '<', cutoff)
      .where('lease_owner', 'is', null)
      .where('log_file_key', 'is not', null)
      .returning(['id', 'created_at', 'log_file_key'])
      .execute();

    const cleared: string[] = [];
    for (const task of locked) {
      let outcome: 'removed' | 'missing' | 'skipped' | 'failed';
      try {
        outcome = removeOwnedLog(
          root,
          task.id,
          task.log_file_key!,
          logKey(task.id, task.created_at),
        );
      } catch (error) {
        outcome = missingLogFile(error) ? 'missing' : 'failed';
      }
      result[outcome]++;
      if (outcome === 'removed' || outcome === 'missing') cleared.push(task.id);
    }
    if (cleared.length)
      await tx
        .updateTable('tasks')
        .set({ log_file_key: null })
        .where('id', 'in', cleared)
        .execute();
    return { result, nextCursor: result.more ? batch.at(-1)?.id : undefined };
  });
}
