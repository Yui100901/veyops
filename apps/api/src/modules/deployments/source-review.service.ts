import {
  BadRequestException,
  Controller,
  ForbiddenException,
  Get,
  Global,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { randomUUID } from 'node:crypto';
import type { Kysely, Selectable } from 'kysely';
import { DatabaseService } from '../../core/database/database.service';
import type { Database } from '../../core/database/schema';
import { AuditService } from '../audit/audit.service';
import type { PipelineSnapshot } from '../pipelines/pipeline.types';
import { lockProjectGraph } from '../projects/project-guards';
import { redactTaskLog } from '../tasks/task-log.service';
import { serviceReleasePolicy } from './release-policy';
import {
  buildReviewSources,
  releaseArtifactSources,
  SourceReviewConflict,
} from './release-source-policy';

const decisions = ['APPROVED', 'REVOKED'] as const;
type ReviewDecision = (typeof decisions)[number];
type ReviewRow = Selectable<Database['repository_source_reviews']>;
type LegacyReviewRow = Selectable<Database['service_source_reviews']>;
export type ReviewSource = { repositoryId: string; commitSha: string };
export type SourceReviewProof = ReviewSource & {
  reviewId: string;
  reviewedBy: string;
  updatedAt: number;
};

export class SourceReviewDecisionDto {
  @IsIn(decisions) decision!: ReviewDecision;
  @IsOptional() @IsUUID() repositoryId?: string;
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

function present(row: ReviewRow | LegacyReviewRow, reviewer?: string, repositoryName?: string) {
  return {
    id: row.id,
    projectId: row.project_id,
    serviceId: row.service_id,
    environmentId: row.environment_id,
    repositoryId: 'repository_id' in row ? row.repository_id : null,
    repositoryName,
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
      .selectFrom('repository_source_reviews as review')
      .where('review.project_id', '=', projectId)
      .where('review.service_id', '=', serviceId)
      .where('review.environment_id', '=', environmentId);
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

  async list(
    projectId: string,
    serviceId: string,
    environmentId: string,
    commitSha?: string,
    repositoryId?: string,
  ) {
    const db = this.database.db;
    await this.assertScope(db, projectId, serviceId, environmentId);
    const commit = commitSha ? fullCommit(commitSha) : undefined;
    const [rows, legacy] = await Promise.all([
      this.scope(db, projectId, serviceId, environmentId)
        .innerJoin('users', 'users.id', 'review.reviewed_by')
        .innerJoin('repositories', 'repositories.id', 'review.repository_id')
        .selectAll('review')
        .select(['users.username as reviewer', 'repositories.name as repositoryName'])
        .$if(Boolean(commit), (query) => query.where('review.commit_sha', '=', commit!))
        .$if(Boolean(repositoryId), (query) =>
          query.where('review.repository_id', '=', repositoryId!),
        )
        .orderBy('review.updated_at', 'desc')
        .orderBy('review.id', 'desc')
        .limit(100)
        .execute(),
      repositoryId
        ? []
        : db
            .selectFrom('service_source_reviews as review')
            .innerJoin('users', 'users.id', 'review.reviewed_by')
            .selectAll('review')
            .select('users.username as reviewer')
            .where('review.project_id', '=', projectId)
            .where('review.service_id', '=', serviceId)
            .where('review.environment_id', '=', environmentId)
            .$if(Boolean(commit), (query) => query.where('review.commit_sha', '=', commit!))
            .orderBy('review.updated_at', 'desc')
            .orderBy('review.id', 'desc')
            .limit(100)
            .execute(),
    ]);
    return [
      ...rows.map((row) => present(row, row.reviewer, row.repositoryName)),
      ...legacy.map((row) => present(row, row.reviewer)),
    ]
      .sort((a, b) => b.updatedAt - a.updatedAt || b.id.localeCompare(a.id))
      .slice(0, 100);
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
      await lockProjectGraph(tx);
      await this.assertScope(tx, projectId, serviceId, environmentId);
      const repositories = await tx
        .selectFrom('repositories')
        .select(['id', 'name', 'archived_at'])
        .where('project_id', '=', projectId)
        .$if(Boolean(input.repositoryId), (query) => query.where('id', '=', input.repositoryId!))
        .limit(2)
        .execute();
      const repository = repositories[0];
      if (!input.repositoryId && repositories.length !== 1)
        throw new BadRequestException('请指定本次代码审核所属仓库');
      if (!repository || repository.archived_at !== null)
        throw new NotFoundException('代码审核仓库不属于当前项目或已归档');
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
        .insertInto('repository_source_reviews')
        .values({
          id: randomUUID(),
          project_id: projectId,
          service_id: serviceId,
          environment_id: environmentId,
          repository_id: repository.id,
          commit_sha: commit,
          created_at: now,
          ...update,
        })
        .onConflict((conflict) =>
          conflict
            .columns(['project_id', 'service_id', 'environment_id', 'repository_id', 'commit_sha'])
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
          repositoryId: repository.id,
          commitSha: commit,
          reason,
        },
        tx,
      );
      return present(row, reviewer.username, repository.name);
    });
  }

  async requireReviewed(
    projectId: string,
    serviceId: string,
    environmentId: string,
    sources: readonly ReviewSource[],
    { db = this.database.db, force = false }: { db?: Kysely<Database>; force?: boolean } = {},
  ) {
    if (
      !force &&
      !(await serviceReleasePolicy(db, serviceId, environmentId)).policy.requireCodeReview
    )
      return null;
    await this.assertScope(db, projectId, serviceId, environmentId);
    if (!sources.length)
      throw new SourceReviewConflict(
        '当前服务环境要求代码审核，产物缺少可核验的仓库与 Git 提交来源',
      );
    const revisions = new Map<string, ReviewSource>();
    for (const source of sources) {
      let commitSha: string;
      try {
        commitSha = fullCommit(source.commitSha);
      } catch {
        throw new SourceReviewConflict('产物源码来源缺少完整 Git 提交 SHA');
      }
      if (!source.repositoryId)
        throw new SourceReviewConflict(`提交 ${commitSha} 缺少仓库来源`, { commitSha });
      revisions.set(source.repositoryId + ':' + commitSha, {
        repositoryId: source.repositoryId,
        commitSha,
      });
    }
    const ids = [...new Set([...revisions.values()].map(({ repositoryId }) => repositoryId))];
    const repositories = await db
      .selectFrom('repositories')
      .select(['id', 'name'])
      .where('project_id', '=', projectId)
      .where('archived_at', 'is', null)
      .where('id', 'in', ids)
      .execute();
    const names = new Map(repositories.map((repository) => [repository.id, repository.name]));
    const approved: SourceReviewProof[] = [];
    for (const { repositoryId, commitSha } of [...revisions.values()].sort(
      (a, b) =>
        a.repositoryId.localeCompare(b.repositoryId) || a.commitSha.localeCompare(b.commitSha),
    )) {
      const name = names.get(repositoryId);
      if (!name)
        throw new SourceReviewConflict(`提交 ${commitSha} 的仓库不属于当前项目或已归档`, {
          commitSha,
        });
      const review = await this.scope(db, projectId, serviceId, environmentId)
        .innerJoin('users as reviewer', 'reviewer.id', 'review.reviewed_by')
        .select(['review.id', 'review.reviewed_by', 'review.updated_at'])
        .where('review.repository_id', '=', repositoryId)
        .where('review.commit_sha', '=', commitSha)
        .where('review.decision', '=', 'APPROVED')
        .where('reviewer.role', '=', 'ADMIN')
        .where('reviewer.status', '=', 'ACTIVE')
        .where('reviewer.must_change_password', '=', 0)
        .executeTakeFirst();
      if (!review)
        throw new SourceReviewConflict(
          `仓库「${name}」提交 ${commitSha} 缺少当前服务环境的有效代码审核`,
          { repositoryId, commitSha },
        );
      approved.push({
        repositoryId,
        commitSha,
        reviewId: review.id,
        reviewedBy: review.reviewed_by,
        updatedAt: review.updated_at,
      });
    }
    return approved;
  }

  async requireReleaseReviewed(
    snapshot: PipelineSnapshot,
    db: Kysely<Database> = this.database.db,
    force = false,
  ) {
    if (
      !force &&
      !snapshot.releasePolicy?.requireCodeReview &&
      !(await serviceReleasePolicy(db, snapshot.serviceId, snapshot.environmentId)).policy
        .requireCodeReview
    )
      return null;
    const sources =
      snapshot.mode === 'DEPLOY_ARTIFACT'
        ? await releaseArtifactSources(
            db,
            snapshot,
            snapshot.deploymentArtifacts?.map(({ id }) => id) ?? [],
          )
        : buildReviewSources(snapshot);
    return this.requireReviewed(
      snapshot.projectId,
      snapshot.serviceId,
      snapshot.environmentId,
      sources,
      {
        db,
        force: true,
      },
    );
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
    @Query('repositoryId', new ParseUUIDPipe({ optional: true })) repositoryId?: string,
  ) {
    return this.reviews.list(projectId, serviceId, environmentId, commitSha, repositoryId);
  }
}

@Global()
@Module({
  controllers: [SourceReviewController],
  providers: [SourceReviewService],
  exports: [SourceReviewService],
})
export class SourceReviewModule {}
