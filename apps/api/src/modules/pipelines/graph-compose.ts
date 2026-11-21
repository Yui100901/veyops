import { BadRequestException } from '@nestjs/common';
import { parseComposeTemplate } from '../service-configs/compose-template-reference';

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new BadRequestException('Compose 模板须为有效的对象配置');
  return value as Record<string, unknown>;
}

export function assertGraphCompose(text: string) {
  const { compose, services } = parseComposeTemplate(text);
  if (compose.include || compose.configs || compose.secrets)
    throw new BadRequestException('图内 Compose 模板须自包含，请使用执行图变量和项目内资源');
  const volumes = new Set(Object.keys(compose.volumes ? record(compose.volumes) : {}));
  for (const group of [compose.volumes, compose.networks]) {
    if (!group) continue;
    for (const value of Object.values(record(group))) {
      if (value == null) continue;
      const resource = record(value);
      if (resource.external || resource.name || resource.driver_opts)
        throw new BadRequestException('图内 Compose 模板资源须使用发布项目自己的命名空间');
    }
  }
  for (const service of services) {
    if (
      service.container_name ||
      service.extends ||
      service.env_file ||
      service.build ||
      (service.privileged !== undefined && service.privileged !== false) ||
      (service.use_api_socket !== undefined && service.use_api_socket !== false) ||
      service.devices ||
      service.volumes_from ||
      service.network_mode ||
      service.pid ||
      service.ipc
    )
      throw new BadRequestException('Compose 模板包含发布命名空间外的资源或依赖文件');
    if (service.volumes !== undefined && !Array.isArray(service.volumes))
      throw new BadRequestException('Compose 卷须使用本发布声明的命名卷');
    for (const mount of Array.isArray(service.volumes) ? service.volumes : []) {
      if (typeof mount === 'string') {
        const [source, target] = mount.split(':');
        if (target && (!source || !volumes.has(source)))
          throw new BadRequestException('Compose 仅可挂载本发布声明的命名卷');
        continue;
      }
      const config = record(mount);
      if (
        config.type !== 'tmpfs' &&
        (config.type !== 'volume' ||
          typeof config.source !== 'string' ||
          !volumes.has(config.source))
      )
        throw new BadRequestException('Compose 仅可挂载本发布声明的命名卷');
    }
  }
}
