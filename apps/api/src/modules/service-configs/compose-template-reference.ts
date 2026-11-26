import { BadRequestException, ConflictException } from '@nestjs/common';
import { CORE_SCHEMA, load, mergeTag } from 'js-yaml';
import { createHash } from 'node:crypto';
import type { Kysely } from 'kysely';
import type { Database, ServiceComposeTemplatesTable } from '../../core/database/schema';

export const maxComposeBytes = 256 * 1024;
export const managedComposePath = 'compose.yaml';

function object(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

export function parseComposeTemplate(content?: string) {
  if (!content?.trim() || Buffer.byteLength(content) > maxComposeBytes || /\0/.test(content))
    throw new BadRequestException('Compose 模板不能为空，且大小不能超过 256 KiB');
  let parsed: unknown;
  try {
    parsed = load(content, {
      schema: CORE_SCHEMA.withTags(mergeTag),
      maxDepth: 64,
      maxAliases: 100,
    });
  } catch {
    throw new BadRequestException('Compose 模板必须是单份有效的 YAML 文档');
  }
  if (!object(parsed) || !object(parsed.services) || !Object.keys(parsed.services).length)
    throw new BadRequestException('Compose 模板至少需要定义一个服务');
  const services = Object.values(parsed.services);
  if (!services.every(object))
    throw new BadRequestException('Compose 模板中每个服务都必须是键值映射');
  if (
    !services.some(
      ({ image }) =>
        typeof image === 'string' &&
        /^(?:\$VEYOPS_IMAGE|\$\{VEYOPS_IMAGE(?:(?::?[-?])[^}]*)?\})$/.test(image),
    )
  )
    throw new BadRequestException('至少一个 Compose 服务必须通过 ${VEYOPS_IMAGE} 使用发布镜像');
  return { compose: parsed, services, content };
}

export type ComposeTemplateReference =
  | { source: 'ARCHIVE'; path?: string; checksum: string }
  | {
      source: 'REPOSITORY_FILE';
      repositoryId: string;
      commitSha: string;
      path: string;
      checksum: string;
    }
  | { source: 'SERVICE_ENVIRONMENT'; path: string; id: string; version: number; checksum: string };
export type ManagedComposeReference = Extract<
  ComposeTemplateReference,
  { source: 'SERVICE_ENVIRONMENT' }
>;
export interface ComposeReleaseEvidence {
  template: ComposeTemplateReference;
  imageReference: string;
  imageId: string;
  images?: { artifactId: string; imageReference: string; imageId: string }[];
  composeProject?: string;
  dockerEngineId?: string;
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
