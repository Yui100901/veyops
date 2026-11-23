import { ConflictException, NotFoundException } from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { Database } from '../../core/database/schema';
import { graphRepositoryUrl } from './http-clone-url';

/** Resolve only registered, active repositories in the current project. */
export async function graphRepositoryMatches(
  db: Kysely<Database>,
  projectId: string,
  urls: Iterable<string>,
) {
  const addresses = [...new Set(urls)];
  const result = new Map<string, string[]>();
  for (let offset = 0; offset < addresses.length; offset += 500) {
    const rows = await db
      .selectFrom('repositories')
      .select(['id', 'clone_url'])
      .where('project_id', '=', projectId)
      .where('archived_at', 'is', null)
      .where('clone_url', 'in', addresses.slice(offset, offset + 500))
      .execute();
    for (const row of rows) {
      const ids = result.get(row.clone_url) ?? [];
      ids.push(row.id);
      result.set(row.clone_url, ids);
    }
  }
  return result;
}

export async function resolveGraphRepositorySelector(
  db: Kysely<Database>,
  projectId: string,
  value: string,
) {
  const address = graphRepositoryUrl(value);
  if (!address) return value;
  const ids = (await graphRepositoryMatches(db, projectId, [address])).get(address) ?? [];
  if (ids.length > 1) throw new ConflictException('仓库地址匹配多个项目仓库，请按项目仓库标识选择');
  if (!ids.length) throw new NotFoundException('仓库地址未匹配当前项目的已登记仓库');
  return ids[0]!;
}
