import { BadRequestException } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import type { Kysely, Selectable, Transaction } from 'kysely';
import type { Database } from '../../core/database/schema';

type ServiceRow = Selectable<Database['services']>;
type AddressBinding = {
  serverId: string;
  protocol: 'http' | 'https';
  port: number;
  host?: string;
  externalPort?: number;
  path?: string;
};
type Address = { id: string; name: string; url: string; binding?: AddressBinding };
type StoredAddress = {
  url: string;
  bindingServerId: string | null;
  bindingJson: string | null;
  serverHost: string | null;
};
type FieldError = { path: (string | number)[]; code: string; message: string };

function invalidAddresses(fieldErrors: FieldError[]): never {
  throw new BadRequestException({ message: '请检查服务访问地址', details: { fieldErrors } });
}

function serviceUrl(value: string) {
  const parsed = value.length <= 2048 && /^https?:\/\//i.test(value) ? URL.parse(value) : null;
  return parsed?.hostname && !parsed.username && !parsed.password ? parsed.href : undefined;
}

function boundUrl(binding: AddressBinding, serverHost: string) {
  const host = binding.host ?? serverHost;
  const unbracketed = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const authority = isIP(unbracketed) === 6 ? `[${unbracketed}]` : host;
  if (!authority.startsWith('[') && !/^[\p{L}\p{N}.-]+$/u.test(authority)) return;
  if (authority.startsWith('[') && isIP(unbracketed) !== 6) return;
  const url = URL.parse(
    `${binding.protocol}://${authority}:${binding.externalPort ?? binding.port}`,
  );
  if (!url) return;
  if (binding.path) url.pathname = binding.path;
  return serviceUrl(url.href);
}

function parseBinding(value: unknown): AddressBinding | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return;
  const { serverId, protocol, port, host, externalPort, path } = value as Record<string, unknown>;
  const validPort = (value: unknown): value is number =>
    typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 65535;
  if (
    typeof serverId !== 'string' ||
    !isUUID(serverId) ||
    (protocol !== 'http' && protocol !== 'https') ||
    !validPort(port) ||
    (externalPort !== undefined && !validPort(externalPort)) ||
    (host !== undefined && (typeof host !== 'string' || host.length > 253)) ||
    (path !== undefined &&
      (typeof path !== 'string' ||
        path.length > 1024 ||
        (path !== '' && (!path.startsWith('/') || /[?#\\\u0000-\u001f]/.test(path)))))
  )
    return;
  return {
    serverId: serverId.toLowerCase(),
    protocol,
    port,
    ...(typeof host === 'string' && host.trim() && { host: host.trim() }),
    ...(externalPort !== undefined && { externalPort }),
    ...(path && { path }),
  };
}

export function resolvedAddress({ url, bindingServerId, bindingJson, serverHost }: StoredAddress) {
  if (!bindingServerId || !bindingJson) return { url };
  const binding = parseBinding({ ...JSON.parse(bindingJson), serverId: bindingServerId });
  if (!binding) return { url };
  return { url: boundUrl(binding, serverHost ?? '') ?? url, binding };
}

function serviceDetails(db: Kysely<Database>, projectId: string, serviceId?: string) {
  return db
    .selectFrom('services as service')
    .leftJoin('service_addresses as address', 'address.service_id', 'service.id')
    .leftJoin('servers as addressServer', 'addressServer.id', 'address.binding_server_id')
    .selectAll('service')
    .select([
      'address.id as addressId',
      'address.name as addressName',
      'address.url as addressUrl',
      'address.binding_server_id as bindingServerId',
      'address.binding_json as bindingJson',
      'addressServer.host as serverHost',
    ])
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
      service.addresses.push({
        id: row.addressId,
        name: row.addressName,
        ...resolvedAddress({ ...row, url: row.addressUrl }),
      });
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
    .selectFrom('service_addresses as address')
    .leftJoin('servers as addressServer', 'addressServer.id', 'address.binding_server_id')
    .select([
      'address.id',
      'address.name',
      'address.url',
      'address.binding_server_id as bindingServerId',
      'address.binding_json as bindingJson',
      'addressServer.host as serverHost',
    ])
    .where('address.service_id', '=', serviceId)
    .orderBy('address.position')
    .execute();
  if (input === undefined)
    return {
      addresses: existing.map(({ id, name, ...row }) => ({ id, name, ...resolvedAddress(row) })),
      removedIds: [],
    };
  if (!Array.isArray(input) || input.length > 100) {
    invalidAddresses([
      { path: ['addresses'], code: 'ADDRESS_LIST', message: '最多可保存 100 条访问地址' },
    ]);
  }

  const owned = new Map(existing.map((row) => [row.id, row]));
  const serverIds = [
    ...new Set(
      input.flatMap((row) => {
        const binding = parseBinding(row?.binding);
        return binding ? [binding.serverId] : [];
      }),
    ),
  ];
  const servers = new Map(
    serverIds.length
      ? (
          await tx
            .selectFrom('servers')
            .select(['id', 'host', 'is_active'])
            .where('id', 'in', serverIds)
            .execute()
        ).map((server) => [server.id, server])
      : [],
  );
  const seenIds = new Set<string>();
  const fieldErrors: FieldError[] = [];
  const addresses: Address[] = [];
  input.forEach((entry: unknown, index: number) => {
    const path = ['addresses', index];
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      fieldErrors.push({ path, code: 'ADDRESS_ROW', message: '请输入访问地址' });
      return;
    }
    const {
      id: rawId,
      name: rawName,
      url: rawUrl,
      binding: rawBinding,
    } = entry as Record<string, unknown>;
    const id = typeof rawId === 'string' ? rawId.toLowerCase() : undefined;
    if (rawId !== undefined && (!id || !isUUID(id) || !owned.has(id) || seenIds.has(id))) {
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
    if (rawBinding !== undefined) {
      const binding = parseBinding(rawBinding);
      const server = binding && servers.get(binding.serverId);
      const retained = Boolean(id && owned.get(id)?.bindingServerId === binding?.serverId);
      const url =
        binding && server && (server.is_active || retained) && boundUrl(binding, server.host);
      if (!url || !binding) {
        fieldErrors.push({
          path: [...path, 'binding'],
          code: 'ADDRESS_BINDING',
          message: '请选择有效服务器，检查协议、端口、访问主机和路径',
        });
        return;
      }
      addresses.push({ id: id ?? randomUUID(), name, url, binding });
      return;
    }
    const url = serviceUrl(typeof rawUrl === 'string' ? rawUrl.trim() : '');
    if (!url) {
      fieldErrors.push({
        path: [...path, 'url'],
        code: 'ADDRESS_URL',
        message: '请输入不含凭据的完整 HTTP(S) 地址',
      });
      return;
    }
    addresses.push({ id: id ?? randomUUID(), name, url });
  });
  if (fieldErrors.length) invalidAddresses(fieldErrors);

  const removedIds = existing.filter(({ id }) => !seenIds.has(id)).map(({ id }) => id);
  if (removedIds.length) {
    await tx
      .deleteFrom('service_addresses')
      .where('service_id', '=', serviceId)
      .where('id', 'in', removedIds)
      .execute();
  }

  // Move retained rows outside both ordinal ranges before reordering under the uniqueness constraint.
  if (seenIds.size) {
    await tx
      .updateTable('service_addresses')
      .set((eb) => ({ position: eb('position', '+', existing.length + addresses.length) }))
      .where('service_id', '=', serviceId)
      .execute();
  }
  for (const [position, { id, name, url, binding }] of addresses.entries()) {
    const fields = {
      name,
      url,
      binding_server_id: binding?.serverId ?? null,
      binding_json: binding ? JSON.stringify(binding) : null,
    };
    if (owned.has(id)) {
      await tx
        .updateTable('service_addresses')
        .set({ ...fields, position })
        .where('service_id', '=', serviceId)
        .where('id', '=', id)
        .execute();
    } else {
      await tx
        .insertInto('service_addresses')
        .values({ id, service_id: serviceId, ...fields, position })
        .execute();
    }
  }
  return { addresses, removedIds };
}
