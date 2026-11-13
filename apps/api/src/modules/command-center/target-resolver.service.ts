import { BadRequestException, Injectable } from '@nestjs/common';
import { DatabaseService } from '../../core/database/database.service';
import { ServersService } from '../servers/servers.service';
import { TargetSelectionDto } from './command.dto';

@Injectable()
export class TargetResolver {
  constructor(
    private readonly database: DatabaseService,
    private readonly servers: ServersService,
  ) {}
  async resolve(input: TargetSelectionDto) {
    const ids = [...(input.serverIds ?? [])];
    for (const groupId of input.groupIds ?? []) {
      const group = await this.database.db
        .selectFrom('server_groups')
        .select('id')
        .where('id', '=', groupId)
        .executeTakeFirst();
      if (!group) throw new BadRequestException('所选服务器分组不存在');
      const members = await this.database.db
        .selectFrom('server_group_members')
        .select('server_id')
        .where('group_id', '=', groupId)
        .execute();
      ids.push(...members.map((member) => member.server_id));
    }
    for (const targetId of input.deploymentTargetIds ?? []) {
      const target = await this.database.db
        .selectFrom('deployment_targets')
        .select('id')
        .where('id', '=', targetId)
        .executeTakeFirst();
      if (!target) throw new BadRequestException('所选部署目标不存在');
      const members = await this.database.db
        .selectFrom('deployment_target_servers')
        .select('server_id')
        .where('target_id', '=', targetId)
        .orderBy('sort_order')
        .execute();
      ids.push(...members.map((member) => member.server_id));
    }
    if (input.tags?.length) {
      const candidates = await this.database.db
        .selectFrom('servers')
        .select(['id', 'tags_json'])
        .where('is_active', '=', 1)
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
    const targets = await this.servers.snapshot(distinct);
    if (targets.length !== distinct.length)
      throw new BadRequestException('部分目标不可用，已拒绝整个批量操作');
    for (const target of targets) {
      if (!target.credentialId || !target.hostKeyFingerprint)
        throw new BadRequestException(
          `请先为服务器 ${target.name} 配置 SSH 凭据和已确认的主机指纹`,
        );
    }
    // Keep the selection order instead of relying on an IN query's unspecified ordering.
    return distinct.map((id) => targets.find((target) => target.id === id)!);
  }
}
