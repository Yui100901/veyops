import type { Kysely } from 'kysely';
import type { Database } from '../../core/database/schema';

export function projectAddressLinks(db: Kysely<Database>) {
  return db
    .selectFrom('project_addresses as address')
    .leftJoin('services as service', 'service.id', 'address.service_id')
    .leftJoin('environments as environment', 'environment.id', 'address.environment_id')
    .select([
      'address.project_id as projectId',
      'address.id as id',
      'address.name as name',
      'address.url as url',
      'service.name as serviceName',
      'environment.name as environmentName',
    ]);
}

export function byProject<Row extends { projectId: string }>(rows: Row[]) {
  const grouped = new Map<string, Omit<Row, 'projectId'>[]>();
  for (const { projectId, ...row } of rows) {
    const group = grouped.get(projectId);
    if (group) group.push(row);
    else grouped.set(projectId, [row]);
  }
  return grouped;
}
