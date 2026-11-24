import {
  BadRequestException,
  ConflictException,
  Controller,
  Get,
  Header,
  Injectable,
  Module,
  NotFoundException,
  Param,
  Req,
} from '@nestjs/common';
import { IsIn, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { randomUUID } from 'node:crypto';
import type { Kysely } from 'kysely';
import { DatabaseService } from '../../core/database/database.service';
import type { Database } from '../../core/database/schema';
import { AuditService } from '../audit/audit.service';
import { Roles } from '../auth/auth.decorators';
import type { AuthRequest } from '../auth/auth.guard';
import { lockProjectGraph } from '../projects/project-guards';
import {
  activeComposeRevision,
  composeChecksum,
  managedComposePath,
  managedComposeReference,
  maxComposeBytes,
  parseComposeTemplate,
  readManagedCompose,
} from './compose-template-reference';

export class SaveComposeRevisionDto {
  @IsInt() @Min(0) expectedVersion!: number;
  @IsIn(['ARCHIVE', 'SERVICE_ENVIRONMENT']) source!: 'ARCHIVE' | 'SERVICE_ENVIRONMENT';
  @IsOptional() @IsString() @MaxLength(maxComposeBytes) content?: string;
}

const metadataFields = ['id', 'version', 'checksum', 'created_by', 'created_at'] as const;
const present = (row: {
  id: string;
  version: number;
  checksum: string | null;
  created_by: string;
  created_at: number;
}) => ({
  id: row.id,
  version: row.version,
  source: row.checksum ? 'SERVICE_ENVIRONMENT' : 'ARCHIVE',
  ...(row.checksum && { path: managedComposePath, checksum: row.checksum }),
  createdBy: row.created_by,
  createdAt: row.created_at,
});

@Injectable()
export class ComposeTemplatesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  private async requireScope(db: Kysely<Database>, serviceId: string, environmentId: string) {
    const scope = await db
      .selectFrom('services')
      .innerJoin('projects', 'projects.id', 'services.project_id')
      .innerJoin('environments', 'environments.project_id', 'projects.id')
      .select('projects.id')
      .where('services.id', '=', serviceId)
      .where('environments.id', '=', environmentId)
      .where('projects.deleted_at', 'is', null)
      .where('services.archived_at', 'is', null)
      .where('environments.archived_at', 'is', null)
      .executeTakeFirst();
    if (!scope) throw new NotFoundException('服务环境不存在');
  }

  async list(serviceId: string, environmentId: string) {
    const db = this.database.db;
    await this.requireScope(db, serviceId, environmentId);
    const rows = await db
      .selectFrom('service_compose_templates')
      .select(metadataFields)
      .where('service_id', '=', serviceId)
      .where('environment_id', '=', environmentId)
      .orderBy('version', 'desc')
      .limit(100)
      .execute();
    return { revision: rows[0]?.version ?? 0, versions: rows.map(present) };
  }

  async content(serviceId: string, environmentId: string, id: string, actor: string) {
    const db = this.database.db;
    await this.requireScope(db, serviceId, environmentId);
    const row = await db
      .selectFrom('service_compose_templates')
      .select(['id', 'version', 'checksum'])
      .where('service_id', '=', serviceId)
      .where('environment_id', '=', environmentId)
      .where('id', '=', id)
      .executeTakeFirst();
    const reference = managedComposeReference(row);
    if (!reference) throw new NotFoundException('没有可读取的 Compose 模板');
    const content = await readManagedCompose(db, serviceId, environmentId, reference);
    await this.audit.record(actor, 'service-environment.compose.read', 'service', serviceId, {
      environmentId,
      version: reference.version,
    });
    return { ...reference, content };
  }

  async save(
    serviceId: string,
    environmentId: string,
    input: SaveComposeRevisionDto,
    actor: string,
  ) {
    if (input.source === 'ARCHIVE' && input.content !== undefined)
      throw new BadRequestException('使用归档时无需提供模板内容');
    const content =
      input.source === 'SERVICE_ENVIRONMENT' ? parseComposeTemplate(input.content).content : null;
    const checksum = content === null ? null : composeChecksum(content);
    const db = this.database.db;
    return db.transaction().execute(async (tx) => {
      await lockProjectGraph(tx);
      await this.requireScope(tx, serviceId, environmentId);
      const latest = await activeComposeRevision(tx, serviceId, environmentId);
      if ((latest?.version ?? 0) !== input.expectedVersion)
        throw new ConflictException('Compose 配置已更新，请重新加载版本列表后保存');
      if (latest?.checksum === checksum) return present(latest);
      const row = await tx
        .insertInto('service_compose_templates')
        .values({
          id: randomUUID(),
          service_id: serviceId,
          environment_id: environmentId,
          version: input.expectedVersion + 1,
          content,
          checksum,
          created_by: actor,
          created_at: Date.now(),
        })
        .returning(metadataFields)
        .executeTakeFirstOrThrow();
      await this.audit.record(
        actor,
        'service-environment.compose.configure',
        'service',
        serviceId,
        { environmentId, version: row.version, source: input.source, checksum },
        tx,
      );
      return present(row);
    });
  }
}

@Controller('services/:serviceId/environments/:environmentId/compose-templates')
class ComposeTemplatesController {
  constructor(private readonly templates: ComposeTemplatesService) {}

  @Get()
  list(@Param('serviceId') serviceId: string, @Param('environmentId') environmentId: string) {
    return this.templates.list(serviceId, environmentId);
  }

  @Roles('ADMIN', 'OPERATOR')
  @Header('Cache-Control', 'no-store')
  @Get(':id')
  content(
    @Param('serviceId') serviceId: string,
    @Param('environmentId') environmentId: string,
    @Param('id') id: string,
    @Req() request: AuthRequest,
  ) {
    return this.templates.content(serviceId, environmentId, id, request.user.id);
  }
}

@Module({
  providers: [ComposeTemplatesService],
  controllers: [ComposeTemplatesController],
  exports: [ComposeTemplatesService],
})
export class ComposeTemplatesModule {}
