import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  ForbiddenException,
  Get,
  Global,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Put,
  Query,
  Req,
} from '@nestjs/common';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';
import { randomUUID } from 'node:crypto';
import type { Kysely, Selectable } from 'kysely';
import { DatabaseService } from '../../core/database/database.service';
import type { Database } from '../../core/database/schema';
import { AuditService } from '../audit/audit.service';
import { Roles } from '../auth/auth.decorators';
import type { AuthRequest } from '../auth/auth.guard';
import { redactTaskLog } from '../tasks/task-log.service';
import { serviceReleasePolicy } from './release-policy';

const decisions = ['APPROVED', 'REVOKED'] as const;
type ReviewDecision = (typeof decisions)[number];
type ReviewRow = Selectable<Database['service_source_reviews']>;

export class SourceReviewDecisionDto {
  @IsIn(decisions) decision!: ReviewDecision;
  @IsOptional() @IsString() @MaxLength(1000) reason?: string;
}

function fullCommit(value: string) {
  if (
    typeof value !== 'string' ||
    !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(value) ||
    /^0+$/.test(value)
  )
    throw new BadRequestException('请提供实际 Git 提交的完整 SHA');
  return value.toLowerCase();
}

function present(row: ReviewRow, reviewer?: string) {
  return {
    id: row.id,
    projectId: row.project_id,
    serviceId: row.service_id,
    environmentId: row.environment_id,
    commitSha: row.commit_sha,
    decision: row.decision,
    reason: row.reason,
    reviewedBy: row.reviewed_by,
    reviewer,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

@Injectable()
export class SourceReviewService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  private scope(db: Kysely<Database>, projectId: string, serviceId: string, environmentId: string) {
    return db
      .selectFrom('service_source_reviews')
      .where('service_source_reviews.project_id', '=', projectId)
      .where('service_source_reviews.service_id', '=', serviceId)
      .where('service_source_reviews.environment_id', '=', environmentId);
  }

  private async assertScope(
    db: Kysely<Database>,
    projectId: string,
    serviceId: string,
    environmentId: string,
  ) {
    const exists = await db
      .selectFrom('services')
      .innerJoin('projects', 'projects.id', 'services.project_id')
      .innerJoin('environments', 'environments.project_id', 'projects.id')
      .select('services.id')
      .where('projects.id', '=', projectId)
      .where('projects.deleted_at', 'is', null)
      .where('services.id', '=', serviceId)
      .where('services.archived_at', 'is', null)
      .where('environments.id', '=', environmentId)
      .where('environments.archived_at', 'is', null)
      .executeTakeFirst();
    if (!exists) throw new NotFoundException('当前项目没有该服务和环境组合');
  }

  async list(projectId: string, serviceId: string, environmentId: string, commitSha?: string) {
    const db = this.database.db;
    await this.assertScope(db, projectId, serviceId, environmentId);
    const scope = this.scope(db, projectId, serviceId, environmentId);
    const query = commitSha ? scope.where('commit_sha', '=', fullCommit(commitSha)) : scope;
    const rows = await query
      .innerJoin('users', 'users.id', 'service_source_reviews.reviewed_by')
      .selectAll('service_source_reviews')
      .select('users.username as reviewer')
      .orderBy('service_source_reviews.updated_at', 'desc')
      .orderBy('service_source_reviews.id', 'desc')
      .limit(100)
      .execute();
    return rows.map((row) => present(row, row.reviewer));
  }

  async recordDecision(
    projectId: string,
    serviceId: string,
    environmentId: string,
    commitSha: string,
    input: SourceReviewDecisionDto,
    userId: string,
  ) {
    const commit = fullCommit(commitSha);
    const reason = input.reason?.trim() || null;
    if (reason && redactTaskLog(reason) !== reason)
      throw new BadRequestException('代码审核说明不能包含明文凭据');
    return this.database.db.transaction().execute(async (tx) => {
      await this.assertScope(tx, projectId, serviceId, environmentId);
      const reviewer = await tx
        .updateTable('users')
        .set((eb) => ({ updated_at: eb.ref('updated_at') }))
        .where('id', '=', userId)
        .where('role', '=', 'ADMIN')
        .where('status', '=', 'ACTIVE')
        .where('must_change_password', '=', 0)
        .returning('username')
        .executeTakeFirst();
      if (!reviewer) throw new ForbiddenException('仅管理员可以记录或撤销代码审核');
      const now = Date.now();
      const update = {
        decision: input.decision,
        reason,
        reviewed_by: userId,
        updated_at: now,
      };
      const row = await tx
        .insertInto('service_source_reviews')
        .values({
          id: randomUUID(),
          project_id: projectId,
          service_id: serviceId,
          environment_id: environmentId,
          commit_sha: commit,
          created_at: now,
          ...update,
        })
        .onConflict((conflict) =>
          conflict
            .columns(['project_id', 'service_id', 'environment_id', 'commit_sha'])
            .doUpdateSet(update),
        )
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit.record(
        userId,
        'source-review.' + input.decision.toLowerCase(),
        'source-review',
        row.id,
        {
          projectId,
          serviceId,
          environmentId,
          commitSha: commit,
          reason,
        },
        tx,
      );
      return present(row, reviewer.username);
    });
  }

  async requireReviewed(
    projectId: string,
    serviceId: string,
    environmentId: string,
    commitSha: string,
    { db = this.database.db, force = false }: { db?: Kysely<Database>; force?: boolean } = {},
  ) {
    if (
      !force &&
      !(await serviceReleasePolicy(db, serviceId, environmentId)).policy.requireCodeReview
    )
      return null;
    let commit: string;
    try {
      commit = fullCommit(commitSha);
    } catch {
      throw new ConflictException('当前服务环境要求代码审核，产物必须关联实际 Git 提交');
    }
    const row = await this.scope(db, projectId, serviceId, environmentId)
      .selectAll('service_source_reviews')
      .where('commit_sha', '=', commit)
      .where('decision', '=', 'APPROVED')
      .executeTakeFirst();
    if (!row) throw new ConflictException(`提交 ${commit} 尚未通过当前服务环境的代码审核`);
    return present(row);
  }
}

@Controller('projects/:projectId/services/:serviceId/environments/:environmentId/source-reviews')
class SourceReviewController {
  constructor(private readonly reviews: SourceReviewService) {}

  @Get()
  list(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('serviceId', ParseUUIDPipe) serviceId: string,
    @Param('environmentId', ParseUUIDPipe) environmentId: string,
    @Query('commitSha') commitSha?: string,
  ) {
    return this.reviews.list(projectId, serviceId, environmentId, commitSha);
  }

  @Put(':commitSha')
  @Roles('ADMIN')
  decide(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('serviceId', ParseUUIDPipe) serviceId: string,
    @Param('environmentId', ParseUUIDPipe) environmentId: string,
    @Param('commitSha') commitSha: string,
    @Body() input: SourceReviewDecisionDto,
    @Req() req: AuthRequest,
  ) {
    return this.reviews.recordDecision(
      projectId,
      serviceId,
      environmentId,
      commitSha,
      input,
      req.user.id,
    );
  }
}

@Global()
@Module({
  controllers: [SourceReviewController],
  providers: [SourceReviewService],
  exports: [SourceReviewService],
})
export class SourceReviewModule {}
