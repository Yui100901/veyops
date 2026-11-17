import { ConflictException } from '@nestjs/common';
import type { Selectable, Transaction } from 'kysely';
import type { ArtifactsTable, Database } from '../../core/database/schema';

const uuid = '[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}';
const archiveName = new RegExp(`^${uuid}(?:-${uuid})?\\.(?:tar|tar\\.gz)$`, 'i');

export const isLocalImage = (storageType: string) =>
  storageType === 'LOCAL_IMAGE' || storageType === 'REMOTE_IMAGE';

export function archiveKey(
  row: Pick<Selectable<ArtifactsTable>, 'archive_key' | 'storage_type' | 'storage_key'>,
) {
  if (
    row.archive_key &&
    (isLocalImage(row.storage_type) || row.storage_type === 'REGISTRY_IMAGE') &&
    archiveName.test(row.archive_key)
  )
    return row.archive_key;
  if (row.storage_type !== 'LOCAL_FILE') return null;
  // Older file rows may contain an absolute path from a different platform instance.
  const key = row.storage_key.split(/[\\/]/).at(-1) ?? '';
  return archiveName.test(key) && key.endsWith('.tar.gz') ? key : null;
}

export async function lockAvailableArtifacts(tx: Transaction<Database>, ids: readonly string[]) {
  // UPDATE acquires a write/row lock on SQLite and PostgreSQL, respectively.
  for (const id of [...new Set(ids)].sort()) {
    const locked = await tx
      .updateTable('artifacts')
      .set((eb) => ({ pinned_at: eb.ref('pinned_at') }))
      .where('id', '=', id)
      .where((eb) =>
        eb.or([eb('pruned_at', 'is', null), eb('storage_type', '=', 'REGISTRY_IMAGE')]),
      )
      .returning('id')
      .executeTakeFirst();
    if (!locked) throw new ConflictException('构建产物不存在或归档已清理');
  }
}
