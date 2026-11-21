import { BadRequestException } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { randomUUID } from 'node:crypto';
import type { Kysely, Selectable, Transaction } from 'kysely';
import type { Database } from '../../core/database/schema';

type ServiceRow = Selectable<Database['services']>;
type Address = { id: string; name: string; url: string };
type FieldError = { path: (string | number)[]; code: string; message: string };

function invalidAddresses(fieldErrors: FieldError[]): never {
  throw new BadRequestException({ message: '请检查服务访问地址', details: { fieldErrors } });
}

function serviceDetails(db: Kysely<Database>, projectId: string, serviceId?: string) {
  return db
    .selectFrom('services as service')
    .leftJoin('service_addresses as address', 'address.service_id', 'service.id')
    .selectAll('service')
    .select(['address.id as addressId', 'address.name as addressName', 'address.url as addressUrl'])
    .where('service.project_id', '=', projectId)
    .where('service.archived_at', 'is', null)
    .$if(serviceId !== undefined, (query) => query.where('service.id', '=', serviceId!))
    .orderBy('service.created_at')
    .orderBy('service.id')
    .orderBy('address.position')
    .execute();
}

export function serviceDto(row: ServiceRow, addresses: Address[]) {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    slug: row.slug,
    serviceType: row.service_type,
    description: row.description,
    revision: row.revision,
    addresses,
  };
}

export async function projectServices(db: Kysely<Database>, projectId: string, serviceId?: string) {
  const rows = await serviceDetails(db, projectId, serviceId);
  const services = new Map<string, ReturnType<typeof serviceDto>>();
  for (const row of rows) {
    const service = services.get(row.id) ?? serviceDto(row, []);
    if (row.addressId !== null && row.addressName !== null && row.addressUrl !== null) {
      service.addresses.push({ id: row.addressId, name: row.addressName, url: row.addressUrl });
    }
    services.set(row.id, service);
  }
  return [...services.values()];
}

export async function saveServiceAddresses(
  tx: Transaction<Database>,
  serviceId: string,
  input: unknown,
) {
  const existing = await tx
    .selectFrom('service_addresses')
    .select(['id', 'name', 'url'])
    .where('service_id', '=', serviceId)
    .orderBy('position')
    .execute();
  if (input === undefined) return { addresses: existing, removedIds: [] };
  if (!Array.isArray(input) || input.length > 100) {
    invalidAddresses([
      { path: ['addresses'], code: 'ADDRESS_LIST', message: '最多可保存 100 条访问地址' },
    ]);
  }

  const ownedIds = new Set(existing.map(({ id }) => id));
  const seenIds = new Set<string>();
  const fieldErrors: FieldError[] = [];
  const addresses: Address[] = [];
  input.forEach((entry: unknown, index: number) => {
    const path = ['addresses', index];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      fieldErrors.push({ path, code: 'ADDRESS_ROW', message: '请输入访问地址' });
      return;
    }
    const { id: rawId, name: rawName, url: rawUrl } = entry as Record<string, unknown>;
    const id = typeof rawId === 'string' ? rawId.toLowerCase() : undefined;
    if (rawId !== undefined && (!id || !isUUID(id) || !ownedIds.has(id) || seenIds.has(id))) {
      fieldErrors.push({
        path: [...path, 'id'],
        code: 'ADDRESS_ID',
        message: '访问地址已重复或不属于该服务',
      });
    }
    if (id) seenIds.add(id);
    const name = typeof rawName === 'string' ? rawName.trim() : '';
    if (!name || name.length > 100) {
      fieldErrors.push({
        path: [...path, 'name'],
        code: 'ADDRESS_NAME',
        message: '请输入 1 至 100 字符的地址名称',
      });
    }
    const url = typeof rawUrl === 'string' ? rawUrl.trim() : '';
    const parsed = url.length <= 2048 && /^https?:\/\//i.test(url) ? URL.parse(url) : null;
    if (!parsed?.hostname || parsed.username || parsed.password) {
      fieldErrors.push({
        path: [...path, 'url'],
        code: 'ADDRESS_URL',
        message: '请输入不含凭据的完整 HTTP(S) 地址',
      });
      return;
    }
    addresses.push({ id: id ?? randomUUID(), name, url: parsed.href });
  });
  if (fieldErrors.length) invalidAddresses(fieldErrors);

  const removedIds = existing.filter(({ id }) => !seenIds.has(id)).map(({ id }) => id);
  if (removedIds.length) {
    await tx.deleteFrom('service_addresses')
      .where('service_id', '=', serviceId)
      .where('id', 'in', removedIds)
      .execute();
  }

  // Move retained rows outside both ordinal ranges before reordering under the uniqueness constraint.
  if (seenIds.size) {
    await tx.updateTable('service_addresses')
      .set((eb) => ({ position: eb('position', '+', existing.length + addresses.length) }))
      .where('service_id', '=', serviceId)
      .execute();
  }
  for (const [position, { id, ...fields }] of addresses.entries()) {
    if (ownedIds.has(id)) {
      await tx.updateTable('service_addresses')
        .set({ ...fields, position })
        .where('service_id', '=', serviceId)
        .where('id', '=', id)
        .execute();
    } else {
      await tx.insertInto('service_addresses')
        .values({ id, service_id: serviceId, ...fields, position })
        .execute();
    }
  }
  return { addresses, removedIds };
}
