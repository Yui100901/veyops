import { BadRequestException, ConflictException } from '@nestjs/common';
import { isUUID } from 'class-validator';
import { posix } from 'node:path';
import type { Selectable } from 'kysely';
import type { Database } from '../../core/database/schema';
import { isGitBranchName } from '../projects/git-ref';
import type { RepositoryMetadataService } from '../projects/repository-metadata.service';
import type { PipelineDefinition, PipelineNode, PipelineNodeSource } from './pipeline.types';
import { relativePath } from './pipeline.validation';

const shellNodes: ReadonlySet<PipelineNode['type']> = new Set([
  'INSTALL',
  'BUILD',
  'TEST',
  'SHELL',
]);

export function pipelineSourceRepositories(definition: PipelineDefinition) {
  return [
    ...new Set([
      definition.repositoryId,
      ...(definition.nodes ?? []).flatMap((node) =>
        node.type === 'CHECKOUT' && node.repositoryId ? [node.repositoryId] : [],
      ),
    ]),
  ].sort();
}

export function pipelineNodeSecrets(definition: PipelineDefinition) {
  return [
    ...new Set(
      definition.nodes?.flatMap((node) =>
        (node.variables ?? []).flatMap((variable) =>
          variable.credentialId ? [variable.credentialId] : [],
        ),
      ),
    ),
  ];
}

export async function resolvePipelineSources(
  definition: PipelineDefinition,
  repositories: Map<string, Selectable<Database['repositories']>>,
  metadata: RepositoryMetadataService,
  environmentId: string,
  requestedSha?: string,
  webhookBranch?: string,
) {
  const requests = (definition.nodes ?? [])
    .filter((node) => node.type === 'CHECKOUT')
    .map((node, index) => {
      const repositoryId = node.repositoryId ?? definition.repositoryId;
      let branch = node.environmentBranches?.[environmentId] ?? node.branch;
      const primaryWebhook = index === 0 && webhookBranch !== undefined;
      if (primaryWebhook) {
        if (branch && branch !== webhookBranch)
          throw new BadRequestException('Webhook 分支必须与主源码节点的生效分支一致');
        branch = webhookBranch;
      }
      if (!branch && repositoryId !== definition.repositoryId)
        throw new BadRequestException(`请为源码节点「${node.name}」选择此环境的分支`);
      return {
        id: node.id,
        repositoryId,
        branch,
        resolve: Boolean(branch && !primaryWebhook),
        name: node.name,
      };
    });
  const byRepo = new Map<string, Set<string>>();
  for (const request of requests) {
    if (!request.resolve || !request.branch) continue;
    const names = byRepo.get(request.repositoryId) ?? new Set<string>();
    names.add(request.branch);
    byRepo.set(request.repositoryId, names);
  }
  const heads = new Map(
    await Promise.all(
      [...byRepo].map(
        async ([id, names]) =>
          [
            id,
            await metadata.branchHeads(
              repositories.get(id)!.project_id,
              id,
              [...names],
              repositories.get(id)!,
            ),
          ] as const,
      ),
    ),
  );
  const primary = requests[0];
  const commitSha = primary?.resolve
    ? heads.get(primary.repositoryId)?.get(primary.branch!)
    : requestedSha;
  if (!commitSha)
    throw new BadRequestException(
      primary?.branch ? '主源码节点的分支不存在或无法取得提交' : '请选择完整 Git Commit SHA',
    );
  if (requestedSha && requestedSha !== commitSha)
    throw new ConflictException('主源码节点的分支提交已变化，请重新预览');
  const preview = requests.map((request) => {
    const sha = request.resolve ? heads.get(request.repositoryId)?.get(request.branch!) : commitSha;
    if (!sha) throw new BadRequestException(`源码节点「${request.name}」的分支不存在`);
    return {
      id: request.id,
      repositoryId: request.repositoryId,
      commitSha: sha,
      ...(request.branch && { branch: request.branch }),
    };
  });
  const nodeSources = Object.fromEntries(
    preview.map(({ id, repositoryId, commitSha, ...ref }) => {
      const repository = repositories.get(repositoryId)!;
      return [
        id,
        {
          url: repository.clone_url,
          credentialId: repository.credential_id,
          commitSha,
          ...ref,
        } satisfies PipelineNodeSource,
      ];
    }),
  );
  return { preview, nodeSources, commitSha };
}

export function validatePipelineNodes(definition: PipelineDefinition) {
  const nodes = definition.nodes;
  if (!nodes) return;
  const primary = nodes[0];
  if (
    primary?.type !== 'CHECKOUT' ||
    (primary.directory ?? '.') !== '.' ||
    (primary.repositoryId && primary.repositoryId !== definition.repositoryId)
  )
    throw new BadRequestException('第一个节点必须将主仓库检出到根目录');
  if (new Set(nodes.map((node) => node.id)).size !== nodes.length)
    throw new BadRequestException('流水线节点 ID 必须唯一');
  const packageIndex = nodes.findIndex((node) => node.type === 'PACKAGE');
  const hasDeploy = nodes[nodes.length - 1]?.type === 'DEPLOY';
  if (
    packageIndex !== nodes.length - (hasDeploy ? 2 : 1) ||
    nodes.some((node, i) => node.type === 'DEPLOY' && i !== nodes.length - 1)
  )
    throw new BadRequestException('流水线以一个打包节点结束，发布节点如启用须排在打包之后');
  const checkoutDirectories: string[] = [];
  let reachedBuildNodes = false;
  for (const [i, node] of nodes.entries()) {
    const isCheckout = node.type === 'CHECKOUT';
    if (isCheckout && reachedBuildNodes)
      throw new BadRequestException('请将所有源码节点放在环境和命令节点之前');
    if (!isCheckout) reachedBuildNodes = true;
    if (!node.name.trim()) throw new BadRequestException('请输入节点名称');
    if (!isCheckout && (node.repositoryId || node.branch || node.environmentBranches))
      throw new BadRequestException('仓库和分支只能设置在源码节点上');
    if (node.type !== 'ENVIRONMENT' && (node.variables || node.envFile))
      throw new BadRequestException('环境变量和环境文件只能设置在环境节点上');
    if (!shellNodes.has(node.type) && (node.command || node.timeout))
      throw new BadRequestException('此节点不支持自定义命令或命令超时');
    if (node.directory && ['PACKAGE', 'DEPLOY'].includes(node.type))
      throw new BadRequestException('打包和发布目录使用流水线的产物及发布配置');
    for (const value of [node.directory, node.envFile]) {
      if (!value) continue;
      relativePath(value);
      if (
        value.split('/').some((part) => part.toLowerCase() === '.git') ||
        (value !== '.' && (posix.normalize(value) !== value || value.endsWith('/')))
      )
        throw new BadRequestException('节点路径必须为规范的工作区相对路径');
    }
    if (shellNodes.has(node.type) && !node.command?.trim())
      throw new BadRequestException(`请为节点「${node.name}」填写执行命令`);
    if (node.envFile && !/^\.env(?:\.[A-Za-z0-9_-]+)*$/.test(posix.basename(node.envFile)))
      throw new BadRequestException('环境文件名须为 .env 或 .env.<名称>');
    if (node.variables) {
      const keys = new Set<string>();
      for (const variable of node.variables) {
        if (keys.has(variable.key) || /^VEYOPS_/i.test(variable.key))
          throw new BadRequestException('节点变量名不能重复或使用平台保留变量');
        if (
          (typeof variable.value === 'string') === Boolean(variable.credentialId) ||
          variable.value?.includes('\0')
        )
          throw new BadRequestException('每个节点变量必须提供普通值或有效的凭据引用');
        keys.add(variable.key);
      }
    }
    if (!isCheckout) continue;
    if (node.branch && !isGitBranchName(node.branch)) throw new BadRequestException('源码分支无效');
    for (const [environmentId, branch] of Object.entries(node.environmentBranches ?? {})) {
      if (!isUUID(environmentId) || typeof branch !== 'string' || !isGitBranchName(branch))
        throw new BadRequestException('环境分支配置无效');
    }
    if (i === 0) continue;
    const dir = node.directory;
    if (
      !dir ||
      dir === '.' ||
      checkoutDirectories.some(
        (other) => dir === other || dir.startsWith(other + '/') || other.startsWith(dir + '/'),
      )
    )
      throw new BadRequestException('额外源码节点须使用独立且不重叠的子目录');
    checkoutDirectories.push(dir);
  }
}
