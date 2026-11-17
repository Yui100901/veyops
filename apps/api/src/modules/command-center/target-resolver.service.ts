import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { Kysely } from 'kysely';
import { DatabaseService } from '../../core/database/database.service';
import type { Database } from '../../core/database/schema';
import { ExecutionOptionsDto, TargetSelectionDto } from './command.dto';
import type { SshTarget } from '../../infrastructure/ssh/ssh.service';
import type { CreateTaskInput } from '../tasks/tasks.types';

@Injectable()
export class TargetResolver {
  constructor(private readonly database: DatabaseService) {}

  private async scopedTargets(input: TargetSelectionDto, db: Kysely<Database>) {
    const projectIds = [...new Set(input.projectIds)];
    const environmentIds = [...new Set(input.environmentIds)];
    if (projectIds.length) {
      const rows = await db
        .selectFrom('projects')
        .select('id')
        .where('id', 'in', projectIds)
        .where('deleted_at', 'is', null)
        .execute();
      if (rows.length !== projectIds.length) throw new BadRequestException('部分所选项目不存在');
    }
    if (environmentIds.length) {
      const rows = await db
        .selectFrom('environments as e')
        .innerJoin('projects as p', 'p.id', 'e.project_id')
        .select('e.id')
        .where('e.id', 'in', environmentIds)
        .where('p.deleted_at', 'is', null)
        .execute();
      if (rows.length !== environmentIds.length)
        throw new BadRequestException('部分所选环境不存在');
    }
    if (!projectIds.length && !environmentIds.length) return [];
    const rows = await db
      .selectFrom('service_environment_configs as c')
      .innerJoin('environments as e', 'e.id', 'c.environment_id')
      .innerJoin('projects as p', 'p.id', 'e.project_id')
      .innerJoin('deployment_targets as d', 'd.id', 'c.target_id')
      .select('d.id')
      .where('p.deleted_at', 'is', null)
      .where((eb) =>
        eb.or([
          ...(projectIds.length ? [eb('p.id', 'in', projectIds)] : []),
          ...(environmentIds.length ? [eb('e.id', 'in', environmentIds)] : []),
        ]),
      )
      .distinct()
      .orderBy('d.id')
      .execute();
    return rows.map(({ id }) => id);
  }

  async resolve(input: TargetSelectionDto, db: Kysely<Database> = this.database.db) {
    const ids = [...(input.serverIds ?? [])];
    for (const groupId of input.groupIds ?? []) {
      const group = await db
        .selectFrom('server_groups')
        .select('id')
        .where('id', '=', groupId)
        .executeTakeFirst();
      if (!group) throw new BadRequestException('所选服务器分组不存在');
      const members = await db
        .selectFrom('server_group_members as membership')
        .innerJoin('servers as server', 'server.id', 'membership.server_id')
        .select('membership.server_id')
        .where('membership.group_id', '=', groupId)
        .where('server.is_active', '=', 1)
        .orderBy('membership.server_id')
        .execute();
      ids.push(...members.map((member) => member.server_id));
    }
    for (const targetId of new Set([
      ...(input.deploymentTargetIds ?? []),
      ...(await this.scopedTargets(input, db)),
    ])) {
      const target = await db
        .selectFrom('deployment_targets')
        .select('id')
        .where('id', '=', targetId)
        .executeTakeFirst();
      if (!target) throw new BadRequestException('所选部署目标不存在');
      const members = await db
        .selectFrom('deployment_target_servers')
        .select('server_id')
        .where('target_id', '=', targetId)
        .orderBy('sort_order')
        .execute();
      ids.push(...members.map((member) => member.server_id));
    }
    if (input.tags?.length) {
      const candidates = await db
        .selectFrom('servers')
        .select(['id', 'tags_json'])
        .where('is_active', '=', 1)
        .orderBy('id')
        .execute();
      ids.push(
        ...candidates
          .filter((server) =>
            input.tags!.every((tag) => (JSON.parse(server.tags_json) as string[]).includes(tag)),
          )
          .map((server) => server.id),
      );
    }
    const distinct = [...new Set(ids)];
    if (!distinct.length)
      throw new BadRequestException('请明确选择至少一台目标服务器；不会默认选择全部服务器');
    if (distinct.length > 100) throw new BadRequestException('单次最多操作100台服务器');
    const targets = await db
      .selectFrom('servers as s')
      .leftJoin('credentials as c', 'c.id', 's.credential_id')
      .select([
        's.id',
        's.name',
        's.host',
        's.port',
        's.username',
        's.credential_id',
        's.host_key_fingerprint',
        'c.nonce',
        'c.status as credential_status',
        'c.type as credential_type',
      ])
      .where('s.is_active', '=', 1)
      .where('s.id', 'in', distinct)
      .execute();
    if (targets.length !== distinct.length)
      throw new BadRequestException('部分目标不可用，已拒绝整个批量操作');
    for (const target of targets) {
      if (
        !target.credential_id ||
        !target.host_key_fingerprint ||
        !target.nonce ||
        target.credential_status !== 'ACTIVE' ||
        !['SSH_PASSWORD', 'SSH_KEY'].includes(target.credential_type ?? '')
      )
        throw new BadRequestException(
          `请先为服务器 ${target.name} 配置 SSH 凭据和已确认的主机指纹`,
        );
    }
    // Keep the selection order instead of relying on an IN query's unspecified ordering.
    const byId = new Map(targets.map((target) => [target.id, target]));
    return distinct.map((id): SshTarget => {
      const target = byId.get(id)!;
      return {
        id,
        name: target.name,
        host: target.host,
        port: target.port,
        username: target.username,
        credentialId: target.credential_id,
        hostKeyFingerprint: target.host_key_fingerprint,
        credentialNonce: target.nonce!,
      };
    });
  }

  private hash(targets: SshTarget[]) {
    return createHash('sha256').update(JSON.stringify(targets)).digest('hex');
  }

  async preview(input: TargetSelectionDto, db: Kysely<Database> = this.database.db) {
    const targets = await this.resolve(input, db);
    return {
      count: targets.length,
      targets: targets.map(({ id, name, host }) => ({ id, name, host })),
      targetHash: this.hash(targets),
    };
  }

  async executionScope(input: TargetSelectionDto): Promise<CreateTaskInput['scope']> {
    if (
      input.serverIds?.length ||
      input.groupIds?.length ||
      input.tags?.length ||
      input.deploymentTargetIds?.length
    )
      return undefined;
    const environments = [...new Set(input.environmentIds)];
    const projects = [...new Set(input.projectIds)];
    if (environments.length === 1 && !projects.length) {
      const environment = await this.database.db
        .selectFrom('environments')
        .select('project_id')
        .where('id', '=', environments[0]!)
        .executeTakeFirst();
      if (!environment) throw new ConflictException('所选环境已变化，请重新预览确认');
      return { projectId: environment.project_id, environmentId: environments[0] };
    }
    if (!environments.length && projects.length === 1) return { projectId: projects[0] };
    return undefined;
  }

  async resolveForExecution(input: ExecutionOptionsDto, db: Kysely<Database> = this.database.db) {
    if (
      !input.expectedTargetHash &&
      (input.groupIds?.length ||
        input.tags?.length ||
        input.deploymentTargetIds?.length ||
        input.projectIds?.length ||
        input.environmentIds?.length)
    )
      throw new BadRequestException('请先预览并确认批量目标');
    const targets = await this.resolve(input, db);
    if (input.expectedTargetHash && this.hash(targets) !== input.expectedTargetHash)
      throw new ConflictException('目标或 SSH 配置已变化，请重新预览确认');
    return targets;
  }
}
