import { HttpException } from '@nestjs/common';
import type { Kysely } from 'kysely';
import type { Database } from '../../core/database/schema';
import { readReleasePolicy } from '../deployments/release-policy';
import {
  selectedServerIds,
  storedDeploymentSelection,
} from '../deployment-targets/deployment-selection';
import { resolveDeliveryTargets } from '../pipelines/delivery-targets';
import { branchCache } from '../projects/repository-metadata.service';
import { redactTaskLog } from '../tasks/task-log.service';
import { orderedFlowNodes, type GraphFlow } from './execution-graph-definition';
import { flowSelection } from './graph-run-lifecycle';
import { legacyPreset, migrationIssue, type MigrationIssue } from './graph-migration-mapping';

export interface MigrationComparisonInput {
  environmentId?: string;
  commitSha?: string;
  serverIds?: string[];
  groupIds?: string[];
  artifactId?: string;
  targetId?: string;
  value?: string;
}

type ReviewVariable = { key: string; source: string; sensitive: boolean };
type Target = { source: string; serverIds: string[]; legacyTargetId?: string; strategy?: string };
export interface MigrationSummary {
  steps: { id: string; type: string }[];
  mode?: string;
  serviceId?: string;
  environmentId?: string;
  buildLocation?: string;
  repositoryId?: string;
  branch?: string;
  commitSha?: string;
  artifactType?: string;
  artifactId?: string;
  environmentFile?: string;
  workingDirectory?: string;
  deployPath?: string;
  buildCommandSource?: 'NODE' | 'SERVICE_ENVIRONMENT';
  requireCodeReview?: boolean;
  requireReleaseApproval?: boolean;
  targetSource?: string;
  serverIds?: string[];
  targets?: { build?: Target; release?: Target };
  variables?: ReviewVariable[];
}

async function variables(
  db: Kysely<Database>,
  projectId: string,
  environmentId?: string,
  serviceId?: string,
) {
  const project = await db
    .selectFrom('project_variables')
    .select(['key', 'is_secret'])
    .where('project_id', '=', projectId)
    .execute();
  const environment = environmentId
    ? await db
        .selectFrom('environment_variables')
        .select(['key', 'is_secret'])
        .where('environment_id', '=', environmentId)
        .execute()
    : [];
  const service =
    environmentId && serviceId
      ? await db
          .selectFrom('service_environment_variables')
          .select(['key', 'is_secret'])
          .where('environment_id', '=', environmentId)
          .where('service_id', '=', serviceId)
          .execute()
      : [];
  const result = new Map<string, ReviewVariable>();
  for (const [source, list] of [
    ['PROJECT', project],
    ['ENVIRONMENT', environment],
    ['SERVICE_ENVIRONMENT', service],
  ] as const)
    for (const row of list)
      result.set(row.key, { key: row.key, source, sensitive: Boolean(row.is_secret) });
  return [...result.values()].sort((a, b) => a.key.localeCompare(b.key));
}

async function expand(db: Kysely<Database>, plan: ReturnType<typeof resolveDeliveryTargets>) {
  if (plan.legacyId) {
    const legacy = await db
      .selectFrom('deployment_targets')
      .select('strategy')
      .where('id', '=', plan.legacyId)
      .executeTakeFirst();
    if (!legacy)
      return { source: 'UNAVAILABLE_LEGACY_TARGET', serverIds: [], legacyTargetId: plan.legacyId };
    const rows = await db
      .selectFrom('deployment_target_servers as member')
      .innerJoin('servers as server', 'server.id', 'member.server_id')
      .select('member.server_id')
      .where('member.target_id', '=', plan.legacyId)
      .where('server.is_active', '=', 1)
      .orderBy('member.sort_order')
      .orderBy('member.server_id')
      .execute();
    return {
      source: rows.length ? plan.source : 'UNAVAILABLE_LEGACY_TARGET',
      legacyTargetId: plan.legacyId,
      strategy: legacy.strategy,
      serverIds: rows.map(({ server_id }) => server_id),
    };
  }
  try {
    return {
      source: plan.source,
      strategy: plan.selection?.strategy,
      serverIds: plan.selection ? await selectedServerIds(db, plan.selection) : [],
    };
  } catch (error) {
    if (!(error instanceof HttpException)) throw error;
    return { source: 'UNAVAILABLE_SELECTION', serverIds: [] };
  }
}

export async function migrationComparisons(
  db: Kysely<Database>,
  projectId: string,
  old: GraphFlow[],
  next: GraphFlow[],
  input: MigrationComparisonInput,
) {
  const issues: MigrationIssue[] = [];
  const environment = input.environmentId
    ? await db
        .selectFrom('environments')
        .select(['id', 'repository_env_file', 'default_target_selection_json'])
        .where('id', '=', input.environmentId)
        .where('project_id', '=', projectId)
        .where('archived_at', 'is', null)
        .executeTakeFirst()
    : undefined;
  if (input.environmentId && !environment)
    issues.push(
      migrationIssue('UNAVAILABLE_ENVIRONMENT', '比较环境不可用或不属于当前项目。', true),
    );
  const settings = await db
    .selectFrom('system_settings')
    .select(['key', 'value_json'])
    .where('key', 'in', ['system:execution-defaults', `project:${projectId}:execution-defaults`])
    .orderBy('key', 'desc')
    .execute();
  const defaults = Object.assign(
    { defaultBuildLocation: 'TARGET', defaultMaxParallelTargets: 3 },
    ...settings.map(({ value_json }) => JSON.parse(value_json)),
  ) as { defaultBuildLocation: string; defaultMaxParallelTargets: number };
  const artifact = input.artifactId
    ? await db
        .selectFrom('artifacts as artifact')
        .leftJoin('pipeline_runs as build', 'build.id', 'artifact.pipeline_run_id')
        .select([
          'artifact.id',
          'artifact.service_id',
          'artifact.artifact_type',
          'artifact.source_commit',
          'build.environment_id',
        ])
        .where('artifact.id', '=', input.artifactId)
        .where('artifact.project_id', '=', projectId)
        .where('artifact.pruned_at', 'is', null)
        .where('artifact.archive_deleted_at', 'is', null)
        .executeTakeFirst()
    : undefined;
  if (
    input.artifactId &&
    (!artifact || (environment && artifact.environment_id !== environment.id))
  )
    issues.push(
      migrationIssue('UNAVAILABLE_ARTIFACT', '比较用制品不可用或不属于当前项目环境。', true),
    );

  async function projectPlan(flow: GraphFlow, isLegacy: boolean): Promise<MigrationSummary> {
    // Branch decisions use a single sample for both versions. Unresolved choices
    // remain visible as an issue, rather than assuming a live trigger's inputs.
    let chosen;
    try {
      const selection = flowSelection(flow, { commitSha: input.commitSha, value: input.value });
      chosen = orderedFlowNodes(flow).filter(({ id }) => selection.selected.has(id));
    } catch (error) {
      if (!(error instanceof HttpException)) throw error;
      issues.push(
        migrationIssue(
          'PATH_UNRESOLVED',
          '无法判定示例路径，请人工核对旧连线与条件。',
          true,
          flow.id,
        ),
      );
      return { steps: flow.nodes.map(({ id, type }) => ({ id, type })) };
    }
    const summary: MigrationSummary = { steps: chosen.map(({ id, type }) => ({ id, type })) };
    const preset = legacyPreset(flow);
    const buildNode = chosen.find(({ type }) => type === 'BUILD');
    const deploy = chosen.find(({ type }) => type === 'DEPLOY_ARTIFACT');
    if (!buildNode && !deploy) return summary;
    const serviceId = flow.serviceId ?? preset?.serviceId;
    const configure = serviceId
      ? await db
          .selectFrom('services')
          .select('id')
          .where('id', '=', serviceId)
          .where('project_id', '=', projectId)
          .where('archived_at', 'is', null)
          .executeTakeFirst()
      : undefined;
    if (!configure)
      issues.push(
        migrationIssue(
          'UNAVAILABLE_SERVICE',
          '交付服务已不可用，请先在草稿中修正。',
          true,
          flow.id,
        ),
      );
    const config =
      environment && configure
        ? await db
            .selectFrom('service_environment_configs')
            .select([
              'target_id',
              'target_selection_json',
              'build_location',
              'artifact_type',
              'execution_mode',
              'build_command',
              'build_output_path',
              'working_directory',
              'deploy_path',
              'release_policy_json',
            ])
            .where('environment_id', '=', environment.id)
            .where('service_id', '=', configure.id)
            .executeTakeFirst()
        : undefined;
    const build = buildNode && (isLegacy ? (preset?.build ?? buildNode.build) : buildNode.build);
    const deploySettings = deploy && (isLegacy ? (preset?.deploy ?? deploy.deploy) : deploy.deploy);
    if (
      build &&
      config &&
      ((build.buildCommand &&
        config.build_command &&
        build.buildCommand !== config.build_command) ||
        (build.repoPath &&
          config.working_directory &&
          build.repoPath !== config.working_directory) ||
        (build.outputPath &&
          config.build_output_path &&
          build.outputPath !== config.build_output_path) ||
        (build.buildLocation &&
          config.build_location &&
          build.buildLocation !== config.build_location) ||
        (build.artifactType && config.artifact_type && build.artifactType !== config.artifact_type))
    )
      issues.push(
        migrationIssue(
          'DUPLICATE_BUILD_FIELDS',
          '旧构建字段与服务环境重复且值不同，需按预览核对命令、工作目录、执行位置及产物。',
          false,
          flow.id,
        ),
      );
    if (deploy && config?.execution_mode === 'BUILD_ONLY')
      issues.push(
        migrationIssue(
          'LEGACY_BUILD_ONLY',
          '服务环境保存了旧的仅构建模式，但该路径有发布节点，请明确发布策略。',
          false,
          flow.id,
        ),
      );
    if (
      deploySettings?.deployPath &&
      config?.deploy_path &&
      deploySettings.deployPath !== config.deploy_path
    )
      issues.push(
        migrationIssue(
          'DEPLOY_PATH_CONFLICT',
          '旧节点发布路径与服务环境配置不同，当前两者冲突时发布可能被拒绝。',
          false,
          flow.id,
        ),
      );
    const compatible =
      artifact && artifact.service_id === serviceId && artifact.environment_id === environment?.id;
    const repository = build?.repositoryId
      ? await db
          .selectFrom('repositories')
          .select([
            'id',
            'default_branch',
            'branch_cache_json',
            'branch_checked_at',
            'branch_error',
          ])
          .where('id', '=', build.repositoryId)
          .where('project_id', '=', projectId)
          .where('archived_at', 'is', null)
          .executeTakeFirst()
      : undefined;
    if (build?.repositoryId && !repository)
      issues.push(
        migrationIssue(
          'UNAVAILABLE_REPOSITORY',
          '构建仓库已不可用，请先在草稿中修正。',
          true,
          flow.id,
        ),
      );
    const cache = repository ? branchCache(repository) : undefined;
    const branch =
      build && !build.commitSha && !input.commitSha
        ? build.branch || cache?.defaultBranch || undefined
        : undefined;
    const commitSha = build
      ? build.commitSha ||
        input.commitSha ||
        cache?.branches.find(({ name }) => name === branch)?.sha
      : compatible
        ? (artifact.source_commit ?? undefined)
        : undefined;
    const buildLocation = buildNode
      ? build?.buildLocation || config?.build_location || defaults.defaultBuildLocation
      : undefined;
    const explicit = {
      targetId: input.targetId,
      serverIds: input.serverIds?.length ? input.serverIds : undefined,
      groupIds: input.groupIds?.length ? input.groupIds : undefined,
    };
    const choices = {
      service: storedDeploymentSelection(config?.target_selection_json),
      environment: isLegacy
        ? undefined
        : storedDeploymentSelection(environment?.default_target_selection_json),
      legacyTargetId: config?.target_id,
      parallel: defaults.defaultMaxParallelTargets,
    };
    const buildTargets = buildNode
      ? await expand(
          db,
          isLegacy &&
            buildLocation === 'TARGET' &&
            !input.targetId &&
            !input.serverIds?.length &&
            !input.groupIds?.length
            ? resolveDeliveryTargets('RELEASE', {}, choices)
            : resolveDeliveryTargets(
                buildLocation === 'MANAGER' ? 'MANAGER_BUILD' : 'TARGET_BUILD',
                explicit,
                choices,
              ),
        )
      : undefined;
    const releaseTargets = deploy
      ? await expand(db, resolveDeliveryTargets('RELEASE', explicit, choices))
      : undefined;
    const protection = deploy ? readReleasePolicy(config?.release_policy_json) : undefined;
    return {
      ...summary,
      mode: buildNode && deploy ? 'BUILD_DEPLOY' : buildNode ? 'BUILD' : 'DEPLOY',
      serviceId,
      environmentId: environment?.id,
      buildLocation,
      repositoryId: repository?.id,
      branch,
      commitSha,
      artifactId: !buildNode && compatible ? artifact.id : undefined,
      environmentFile: environment?.repository_env_file ?? undefined,
      workingDirectory: buildNode ? build?.repoPath || config?.working_directory || '.' : undefined,
      deployPath: deploySettings?.deployPath || config?.deploy_path || undefined,
      buildCommandSource: buildNode
        ? build?.buildCommand
          ? 'NODE'
          : config?.build_command
            ? 'SERVICE_ENVIRONMENT'
            : undefined
        : undefined,
      requireCodeReview: protection?.requireCodeReview,
      requireReleaseApproval: protection?.requireApproval,
      artifactType:
        build?.artifactType ??
        (compatible ? artifact.artifact_type : undefined) ??
        config?.artifact_type ??
        undefined,
      targetSource: (releaseTargets ?? buildTargets)?.source,
      serverIds: (releaseTargets ?? buildTargets)?.serverIds,
      targets: { build: buildTargets, release: releaseTargets },
      variables: await variables(db, projectId, environment?.id, configure?.id),
    };
  }

  const comparison = [];
  for (const original of old) {
    const migrated = next.find(({ id }) => id === original.id);
    const before = await projectPlan(original, true);
    const after = migrated ? await projectPlan(migrated, false) : undefined;
    const differences = (
      [
        'steps',
        'mode',
        'serviceId',
        'environmentId',
        'buildLocation',
        'repositoryId',
        'branch',
        'commitSha',
        'artifactType',
        'artifactId',
        'environmentFile',
        'workingDirectory',
        'deployPath',
        'buildCommandSource',
        'requireCodeReview',
        'requireReleaseApproval',
        'targets',
        'variables',
      ] as const
    ).filter((field) => JSON.stringify(before[field]) !== JSON.stringify(after?.[field]));
    if (before.mode && !environment)
      issues.push(
        migrationIssue(
          'SELECT_ENVIRONMENT',
          '请选择服务环境，核对发布目标和变量来源。',
          false,
          original.id,
        ),
      );
    if (before.branch && !input.commitSha)
      issues.push(
        migrationIssue(
          'CACHED_BRANCH',
          '分支对照仅使用已同步 SHA。验收时请用同一固定提交执行新旧方案。',
          false,
          original.id,
        ),
      );
    if (before.mode === 'DEPLOY' && !before.artifactId)
      issues.push(
        migrationIssue(
          'ARTIFACT_UNPINNED',
          '独立部署默认选择最新兼容产物，可指定历史制品进行对照。',
          false,
          original.id,
        ),
      );
    if (before.targets && differences.includes('targets'))
      issues.push(
        migrationIssue(
          'TARGET_CHANGED',
          '新旧目标来源或成员不同。目标端构建需要显式选择构建服务器。',
          false,
          original.id,
        ),
      );
    if (
      original.nodes.some(
        ({ type }) => type === 'CONDITION' || type === 'SWITCH' || type === 'FLOW_CALL',
      )
    )
      issues.push(
        migrationIssue(
          'DYNAMIC_PATH',
          '此流包含条件或子流。对照只列当前样本路径，其他路径需要复核。',
          false,
          original.id,
        ),
      );
    comparison.push({
      flowId: original.id,
      name: redactTaskLog(original.name),
      before,
      after,
      differences,
    });
  }
  return { comparison, issues };
}
