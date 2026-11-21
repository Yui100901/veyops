import {
  Body,
  ConflictException,
  Controller,
  Delete,
  Injectable,
  NotFoundException,
  Param,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { IsIn, IsOptional, IsString, IsUUID, MaxLength } from 'class-validator';
import { randomUUID } from 'node:crypto';
import type { Kysely, Transaction } from 'kysely';
import type { Database } from '../../core/database/schema';
import { DatabaseService } from '../../core/database/database.service';
import { AuditService } from '../audit/audit.service';
import { Roles } from '../auth/auth.decorators';
import type { AuthRequest } from '../auth/auth.guard';

class DependencyDto {
  @IsUUID() dependsOnProjectId!: string;
  @IsIn(['RUNTIME', 'DEPLOYMENT']) dependencyType = 'RUNTIME';
  @IsOptional() @IsString() @MaxLength(2000) description?: string;
}

export async function requireProject(db: Kysely<Database>, id: string) {
  const project = await db
    .selectFrom('projects')
    .select('id')
    .where('id', '=', id)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (!project) throw new NotFoundException('项目不存在');
}

// Serialize graph updates across connections in both SQLite and PostgreSQL.
export async function lockProjectGraph(tx: Transaction<Database>) {
  await tx
    .insertInto('system_settings')
    .values({ key: 'projects:dependency-graph-lock', value_json: '{}', updated_at: Date.now() })
    .onConflict((conflict) =>
      conflict.column('key').doUpdateSet((eb) => ({ updated_at: eb.ref('excluded.updated_at') })),
    )
    .execute();
}

@Injectable()
export class ProjectRelationsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  dependencies(projectId: string) {
    return this.database.db
      .selectFrom('project_dependencies as dependencies')
      .innerJoin('projects as dependency', 'dependency.id', 'dependencies.depends_on_project_id')
      .select([
        'dependencies.id as id',
        'dependencies.depends_on_project_id as dependsOnProjectId',
        'dependency.name as projectName',
        'dependency.slug as projectSlug',
        'dependencies.dependency_type as dependencyType',
        'dependencies.description as description',
      ])
      .where('dependencies.project_id', '=', projectId)
      .where('dependency.deleted_at', 'is', null)
      .orderBy('dependency.name')
      .orderBy('dependencies.id')
      .execute();
  }

  dependents(projectId: string) {
    return this.database.db
      .selectFrom('project_dependencies as dependencies')
      .innerJoin('projects as dependent', 'dependent.id', 'dependencies.project_id')
      .select([
        'dependencies.id as id',
        'dependent.id as projectId',
        'dependent.name as projectName',
        'dependencies.dependency_type as dependencyType',
        'dependencies.description as description',
      ])
      .where('dependencies.depends_on_project_id', '=', projectId)
      .where('dependent.deleted_at', 'is', null)
      .orderBy('dependent.name')
      .orderBy('dependencies.id')
      .execute();
  }

  async saveDependency(
    projectId: string,
    dto: DependencyDto,
    userId: string,
    dependencyId?: string,
  ) {
    const id = dependencyId ?? randomUUID();
    await this.database.db.transaction().execute(async (tx) => {
      await lockProjectGraph(tx);
      await requireProject(tx, projectId);
      await requireProject(tx, dto.dependsOnProjectId);
      if (
        dependencyId &&
        !(await tx
          .selectFrom('project_dependencies')
          .select('id')
          .where('id', '=', id)
          .where('project_id', '=', projectId)
          .executeTakeFirst())
      )
        throw new NotFoundException('项目依赖不存在');
      const edges = await tx
        .selectFrom('project_dependencies')
        .selectAll()
        .where('id', '!=', id)
        .execute();
      const outgoing = new Map<string, string[]>();
      for (const edge of edges) {
        if (
          edge.project_id === projectId &&
          edge.depends_on_project_id === dto.dependsOnProjectId &&
          edge.dependency_type === dto.dependencyType
        )
          throw new ConflictException('项目依赖已存在');
        const targets = outgoing.get(edge.project_id) ?? [];
        targets.push(edge.depends_on_project_id);
        outgoing.set(edge.project_id, targets);
      }
      const seen = new Set<string>();
      const pending = [dto.dependsOnProjectId];
      while (pending.length) {
        const next = pending.pop()!;
        if (next === projectId) throw new ConflictException('项目依赖不能形成循环');
        if (seen.has(next)) continue;
        seen.add(next);
        for (const target of outgoing.get(next) ?? []) pending.push(target);
      }
      const values = {
        depends_on_project_id: dto.dependsOnProjectId,
        dependency_type: dto.dependencyType,
        description: dto.description ?? '',
      };
      if (!dependencyId)
        await tx
          .insertInto('project_dependencies')
          .values({ id, project_id: projectId, ...values })
          .execute();
      else await tx.updateTable('project_dependencies').set(values).where('id', '=', id).execute();
    });
    await this.audit.record(
      userId,
      dependencyId ? 'project-dependency.update' : 'project-dependency.create',
      'project',
      projectId,
      { dependencyId: id },
    );
    return (await this.dependencies(projectId)).find((dependency) => dependency.id === id);
  }

  async removeDependency(projectId: string, id: string, userId: string) {
    await this.database.db.transaction().execute(async (tx) => {
      await lockProjectGraph(tx);
      await requireProject(tx, projectId);
      const deleted = await tx
        .deleteFrom('project_dependencies')
        .where('project_id', '=', projectId)
        .where('id', '=', id)
        .returning('id')
        .executeTakeFirst();
      if (!deleted) throw new NotFoundException('项目依赖不存在');
    });
    await this.audit.record(userId, 'project-dependency.delete', 'project', projectId, { id });
    return { success: true };
  }
}

@Controller('projects/:projectId')
export class ProjectRelationsController {
  constructor(private readonly relations: ProjectRelationsService) {}
  @Roles('ADMIN', 'OPERATOR') @Post('dependencies') dependency(
    @Param('projectId') project: string,
    @Body() dto: DependencyDto,
    @Req() req: AuthRequest,
  ) {
    return this.relations.saveDependency(project, dto, req.user.id);
  }
  @Roles('ADMIN', 'OPERATOR') @Patch('dependencies/:id') updateDependency(
    @Param('projectId') project: string,
    @Param('id') id: string,
    @Body() dto: DependencyDto,
    @Req() req: AuthRequest,
  ) {
    return this.relations.saveDependency(project, dto, req.user.id, id);
  }
  @Roles('ADMIN', 'OPERATOR') @Delete('dependencies/:id') deleteDependency(
    @Param('projectId') project: string,
    @Param('id') id: string,
    @Req() req: AuthRequest,
  ) {
    return this.relations.removeDependency(project, id, req.user.id);
  }
}
