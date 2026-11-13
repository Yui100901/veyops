import { BadRequestException } from '@nestjs/common';
import type { PipelineDefinition } from './pipeline.types';

export const shellQuote = (value: string) => `'${value.replace(/'/g, `'"'"'`)}'`;
export function relativePath(value: string): string {
  if (
    !value ||
    value.startsWith('/') ||
    value.includes('\\') ||
    value.split('/').includes('..') ||
    /[\x00-\x1f]/.test(value)
  )
    throw new BadRequestException('仓库和产物路径必须为不含..的相对路径');
  return value;
}
export function safeDeployPath(value: string): string {
  if (
    !/^\/(?:opt|srv|home|tmp|var\/www)\/[a-zA-Z0-9_./-]+$/.test(value) ||
    value.split('/').includes('..') ||
    value.split('/').filter(Boolean).length < 2
  )
    throw new BadRequestException(
      '部署路径须位于 /opt、/srv、/home、/tmp 或 /var/www 的专用子目录',
    );
  return value.replace(/\/+$/, '');
}
export function validateDefinition(definition: PipelineDefinition) {
  relativePath(definition.repoPath);
  relativePath(definition.outputPath);
  relativePath(definition.dockerfilePath);
  relativePath(definition.composeFilePath);
  safeDeployPath(definition.deployPath);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9._/:@-]{0,199}$/.test(definition.buildImage))
    throw new BadRequestException('无效构建容器镜像');
  if (definition.artifactType === 'DOCKER_IMAGE') {
    if (
      !definition.registryId ||
      !definition.imageRepository ||
      !/^[a-z0-9][a-z0-9._/-]{0,249}$/.test(definition.imageRepository)
    )
      throw new BadRequestException('Docker Pipeline须配置Registry及有效镜像仓库名');
  }
}
export function validateGitUrl(url: string) {
  if (!/^https?:\/\//.test(url))
    throw new BadRequestException('Pipeline当前支持HTTP(S) Git仓库；私有仓库请使用凭据引用');
  const parsed = new URL(url);
  if (parsed.username || parsed.password || parsed.search || parsed.hash)
    throw new BadRequestException('Git URL不能内嵌凭据');
}
export function deploymentGuard(path: string, owner: string): string {
  const p = shellQuote(safeDeployPath(path));
  return `test ! -L ${p}; test "$(realpath -m ${p})" = ${p}; mkdir -p ${p}; if test -f ${p}/.veyops-managed; then test "$(cat ${p}/.veyops-managed)" = ${shellQuote(owner)}; else test -z "$(ls -A ${p})"; printf '%s' ${shellQuote(owner)} > ${p}/.veyops-managed; fi; test ! -L ${p}/releases; test ! -L ${p}/.artifacts; mkdir -p ${p}/releases ${p}/.artifacts; test ! -e ${p}/current || test -L ${p}/current`;
}
