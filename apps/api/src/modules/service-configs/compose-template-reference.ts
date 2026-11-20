import { ConflictException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Database, ServiceComposeTemplatesTable } from '../../core/database/schema';

export const maxComposeBytes = 256 * 1024;
export const managedComposePath = 'compose.yaml';

export type ComposeTemplateReference =
  | { source: 'ARCHIVE'; path?: string; checksum: string }
  | { source: 'SERVICE_ENVIRONMENT'; path: string; id: string; version: number; checksum: string };
export type ManagedComposeReference = Extract<
  ComposeTemplateReference,
  { source: 'SERVICE_ENVIRONMENT' }
>;
export interface ComposeReleaseEvidence {
  template: ComposeTemplateReference;
  imageReference: string;
  imageId: string;
}

export function composeChecksum(content: string) {
  return createHash('sha256').update(content).digest('hex');
}

export function activeComposeRevision(
  db: Kysely<Database>,
  serviceId: string,
  environmentId: string,
) {
  return db
    .selectFrom('service_compose_templates')
    .select(['id', 'version', 'checksum', 'created_by', 'created_at'])
    .where('service_id', '=', serviceId)
    .where('environment_id', '=', environmentId)
    .orderBy('version', 'desc')
    .executeTakeFirst();
}

export function managedComposeReference(
  row?: Pick<ServiceComposeTemplatesTable, 'id' | 'version' | 'checksum'>,
): ManagedComposeReference | undefined {
  if (!row?.checksum) return;
  return {
    source: 'SERVICE_ENVIRONMENT',
    path: managedComposePath,
    id: row.id,
    version: row.version,
    checksum: row.checksum,
  };
}

export async function readManagedCompose(
  db: Kysely<Database>,
  serviceId: string,
  environmentId: string,
  reference: ManagedComposeReference,
) {
  const row = await db
    .selectFrom('service_compose_templates')
    .select(['content', 'checksum', 'version'])
    .where('id', '=', reference.id)
    .where('service_id', '=', serviceId)
    .where('environment_id', '=', environmentId)
    .executeTakeFirst();
  if (
    !row?.content ||
    reference.path !== managedComposePath ||
    row.version !== reference.version ||
    row.checksum !== reference.checksum ||
    Buffer.byteLength(row.content) > maxComposeBytes ||
    composeChecksum(row.content) !== reference.checksum
  )
    throw new ConflictException('服务环境 Compose 模板版本缺失或未通过校验');
  return row.content;
}
