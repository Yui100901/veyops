import type { Kysely } from 'kysely';
import type { Database } from '../../core/database/schema';
import { resolvedAddress } from './service-addresses';

export function projectAddressLinks(db: Kysely<Database>) {
  return db
    .selectFrom('service_addresses as address')
    .innerJoin('services as service', 'service.id', 'address.service_id')
    .leftJoin('servers as addressServer', 'addressServer.id', 'address.binding_server_id')
    .where('service.archived_at', 'is', null)
    .select([
      'service.project_id as projectId',
      'address.id as id',
      'address.name as name',
      'address.url as url',
      'address.binding_server_id as bindingServerId',
      'address.binding_json as bindingJson',
      'addressServer.host as serverHost',
      'service.id as serviceId',
      'service.name as serviceName',
    ])
    .select((eb) => eb.val(null).as('environmentName'))
    .orderBy('service.name')
    .orderBy('service.id')
    .orderBy('address.position');
}

export function projectAddressDto({
  url,
  bindingServerId,
  bindingJson,
  serverHost,
  ...row
}: Awaited<ReturnType<ReturnType<typeof projectAddressLinks>['execute']>>[number]) {
  return { ...row, url: resolvedAddress({ url, bindingServerId, bindingJson, serverHost }).url };
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
