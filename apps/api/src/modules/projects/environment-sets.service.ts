import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Header,
  Injectable,
  Module,
  NotFoundException,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Req,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  ArrayMaxSize,
  IsArray,
  IsInt,
  IsString,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import type { Kysely, Selectable, Transaction } from 'kysely';
import { DatabaseService } from '../../core/database/database.service';
import type { Database } from '../../core/database/schema';
import { executionVariableName } from '../../infrastructure/execution-variables';
import { AuditService } from '../audit/audit.service';
import { Roles, type CurrentUser } from '../auth/auth.decorators';
import type { AuthRequest } from '../auth/auth.guard';
import {
  CredentialsService,
  variableCredentialType,
  variableCredentialValue,
} from '../credentials/credentials.service';
import { lockProjectGraph, requireProject } from './project-relations';

const externalCredentialTypes = ['API_KEY', 'API_SECRET', 'CUSTOM_SECRET', 'USERNAME_PASSWORD'];
const credentialTypes = [variableCredentialType, ...externalCredentialTypes];
const secretMask = '••••••••••••';
type SetRow = Selectable<Database['project_environment_sets']>;
type VariableRow = Selectable<Database['project_environment_set_variables']>;

class CreateEnvironmentSetDto {
  @IsString() @MaxLength(100) name!: string;
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MaxLength(2000)
  description?: string;
  @ValidateIf((_object, value) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(100)
  variables?: unknown[];
}

class UpdateEnvironmentSetDto {
  @IsInt() @Min(1) expectedRevision!: number;
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MaxLength(100)
  name?: string;
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MaxLength(2000)
  description?: string;
  @ValidateIf((_object, value) => value !== undefined)
  @IsArray()
  @ArrayMaxSize(100)
  variables?: unknown[];
}

class ArchiveEnvironmentSetDto {
  @IsInt() @Min(1) expectedRevision!: number;
}

export interface EnvironmentSetSummary {
  id: string;
  name: string;
  revision: number;
}

/** Internal plan values. API handlers expose only the summary and separately redacted variable rows. */
export interface FrozenEnvironmentSet extends EnvironmentSetSummary {
  variables: Record<string, string>;
  secretVariables: Record<string, string>;
  secretCredentialNonces: Record<string, string>;
}

function fieldError(path: (string | number)[], message: string, code = 'INVALID_VALUE'): never {
  throw new BadRequestException({ message, details: { fieldErrors: [{ path, code, message }] } });
}

function currentRevision(current: SetRow, expectedRevision: number) {
  if (current.revision !== expectedRevision)
    throw new ConflictException({
      message: '变量集合已被其他操作更新',
      details: { currentRevision: current.revision },
    });
}

const summary = ({ id, name, revision }: EnvironmentSetSummary) => ({ id, name, revision });
const metadata = (row: SetRow) => ({
  ...summary(row),
  projectId: row.project_id,
  description: row.description,
  archivedAt: row.archived_at,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

function sets(db: Kysely<Database>, projectId: string) {
  return db
    .selectFrom('project_environment_sets as env_set')
    .innerJoin('projects as project', 'project.id', 'env_set.project_id')
    .where('env_set.project_id', '=', projectId)
    .where('project.deleted_at', 'is', null);
}

async function requireSet(db: Kysely<Database>, projectId: string, id: string) {
  const row = await sets(db, projectId)
    .where('env_set.id', '=', id)
    .where('env_set.archived_at', 'is', null)
    .selectAll('env_set')
    .executeTakeFirst();
  if (!row) throw new NotFoundException('变量集合不存在或已归档');
  return row;
}

function setWithVariables(db: Kysely<Database>, projectId: string, id: string) {
  return sets(db, projectId)
    .leftJoin(
      'project_environment_set_variables as variable',
      'env_set.id',
      'variable.environment_set_id',
    )
    .leftJoin('credentials as credential', 'credential.id', 'variable.credential_id')
    .where('env_set.id', '=', id)
    .selectAll('env_set')
    .select([
      'variable.id as variableId',
      'variable.key',
      'variable.value_text',
      'variable.is_secret',
      'variable.description as variableDescription',
      'variable.credential_id',
      'credential.type as credentialType',
      'credential.status as credentialStatus',
      'credential.nonce as credentialNonce',
    ])
    .orderBy('variable.key');
}

export async function resolveEnvironmentSet(
  db: Kysely<Database>,
  projectId: string,
  id: string,
): Promise<FrozenEnvironmentSet> {
  const rows = await setWithVariables(db, projectId, id)
    .where('env_set.archived_at', 'is', null)
    .execute();
  if (!rows.length) throw new NotFoundException('变量集合不存在或已归档');
  const variables: Record<string, string> = Object.create(null);
  const secretVariables: Record<string, string> = Object.create(null);
  const secretCredentialNonces: Record<string, string> = Object.create(null);
  for (const row of rows) {
    if (row.key === null) continue;
    if (!row.is_secret) {
      variables[row.key] = row.value_text!;
      continue;
    }
    if (
      !row.credential_id ||
      !row.credentialNonce ||
      !credentialTypes.includes(row.credentialType ?? '') ||
      row.credentialStatus !== 'ACTIVE'
    )
      throw new BadRequestException(`环境变量 ${row.key} 引用的凭据不可用`);
    secretVariables[row.key] = row.credential_id;
    secretCredentialNonces[row.key] = row.credentialNonce;
  }
  return { ...summary(rows[0]), variables, secretVariables, secretCredentialNonces };
}

@Injectable()
class EnvironmentSetsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly credentials: CredentialsService,
    private readonly audit: AuditService,
  ) {}

  async list(projectId: string) {
    await requireProject(this.database.db, projectId);
    const rows = await sets(this.database.db, projectId)
      .where('env_set.archived_at', 'is', null)
      .selectAll('env_set')
      .orderBy('env_set.name')
      .orderBy('env_set.id')
      .execute();
    return rows.map(metadata);
  }

  async get(projectId: string, id: string, db = this.database.db) {
    const rows = await setWithVariables(db, projectId, id).execute();
    if (!rows.length) throw new NotFoundException('变量集合不存在');
    return {
      ...metadata(rows[0]),
      variables: rows.flatMap((row) => {
        if (row.variableId === null || row.key === null) return [];
        return [
          {
            id: row.variableId,
            key: row.key,
            value: row.is_secret ? null : row.value_text,
            isSecret: row.is_secret === 1,
            description: row.variableDescription ?? '',
            ...(row.is_secret && {
              secretSource: row.credentialType === variableCredentialType ? 'VALUE' : 'CREDENTIAL',
            }),
          },
        ];
      }),
    };
  }

  private async lockScope(tx: Transaction<Database>, projectId: string) {
    await lockProjectGraph(tx);
    const project = await tx
      .updateTable('projects')
      .set((eb) => ({ updated_at: eb.ref('updated_at') }))
      .where('id', '=', projectId)
      .where('deleted_at', 'is', null)
      .returning('id')
      .executeTakeFirst();
    if (!project) throw new NotFoundException('项目不存在');
  }

  async save(
    projectId: string,
    dto: CreateEnvironmentSetDto | UpdateEnvironmentSetDto,
    user: CurrentUser,
    id?: string,
  ) {
    return this.database.db.transaction().execute(async (tx) => {
      await this.lockScope(tx, projectId);
      const now = Date.now();
      const setId = id ?? randomUUID();
      const name = dto.name?.trim();
      if (dto.name !== undefined && !name) fieldError(['name'], '请输入变量集合名称');
      if ('expectedRevision' in dto) {
        const current = await requireSet(tx, projectId, setId);
        currentRevision(current, dto.expectedRevision);
        await tx
          .updateTable('project_environment_sets')
          .set({
            name: name ?? current.name,
            description: dto.description ?? current.description,
            revision: current.revision + 1,
            updated_at: now,
          })
          .where('id', '=', setId)
          .execute();
      } else {
        await tx
          .insertInto('project_environment_sets')
          .values({
            id: setId,
            project_id: projectId,
            name: name!,
            description: dto.description ?? '',
            created_at: now,
            updated_at: now,
          })
          .execute();
      }
      if (dto.variables !== undefined)
        await this.writeVariables(tx, setId, dto.variables, user, now);
      const saved = await this.get(projectId, setId, tx);
      await this.audit.record(
        user.id,
        `environment_set.${id ? 'update' : 'create'}`,
        'environment_set',
        setId,
        {
          projectId,
          revision: saved.revision,
          variableCount: saved.variables.length,
        },
        tx,
      );
      return saved;
    });
  }

  private async writeVariables(
    tx: Transaction<Database>,
    environmentSetId: string,
    variables: unknown[],
    user: CurrentUser,
    now: number,
  ) {
    const existing = await tx
      .selectFrom('project_environment_set_variables')
      .selectAll()
      .where('environment_set_id', '=', environmentSetId)
      .execute();
    const previous = new Map(existing.map((row) => [row.key, row]));
    const rows: VariableRow[] = [];
    const keys = new Set<string>();
    for (const [index, input] of variables.entries()) {
      const path = ['variables', index] as const;
      if (!input || typeof input !== 'object' || Array.isArray(input))
        fieldError([...path], '变量项必须是对象');
      const { key, value, description, isSecret, keepSecret, credentialId } = input as Record<
        string,
        unknown
      >;
      if (typeof key !== 'string' || key.length > 128 || !executionVariableName.test(key))
        fieldError([...path, 'key'], '请输入有效的环境变量名');
      if (/^VEYOPS_/i.test(key)) fieldError([...path, 'key'], `${key} 由系统保留`, 'RESERVED_KEY');
      if (keys.has(key)) fieldError([...path, 'key'], `变量 ${key} 重复`, 'DUPLICATE_KEY');
      keys.add(key);
      if (isSecret !== undefined && typeof isSecret !== 'boolean')
        fieldError([...path, 'isSecret'], '敏感标记应为布尔值');
      if (
        description !== undefined &&
        (typeof description !== 'string' || description.length > 1000)
      )
        fieldError([...path, 'description'], '变量描述不能超过 1000 个字符');
      if (
        value !== undefined &&
        (typeof value !== 'string' || value.length > 65_536 || value.includes('\0'))
      )
        fieldError([...path, 'value'], '变量值不能超过 65536 个字符或包含空字符');
      if (keepSecret !== undefined && keepSecret !== true)
        fieldError([...path, 'keepSecret'], '保留操作应为 true');
      if (
        credentialId !== undefined &&
        (typeof credentialId !== 'string' || !/^[\da-f-]{36}$/i.test(credentialId))
      )
        fieldError([...path, 'credentialId'], '请选择有效的凭据');
      const old = previous.get(key);
      let reference: string | null = null;
      if (isSecret) {
        const modes =
          Number(value !== undefined) +
          Number(keepSecret !== undefined) +
          Number(credentialId !== undefined);
        if (modes !== 1 || value === secretMask)
          fieldError([...path, 'value'], '请指定敏感值、凭据或保留原值中的一种');
        if (credentialId !== undefined) {
          if (user.role !== 'ADMIN') throw new ForbiddenException('只有管理员可以绑定新凭据');
          const credential = await tx
            .selectFrom('credentials')
            .select('id')
            .where('id', '=', credentialId)
            .where('status', '=', 'ACTIVE')
            .where('type', 'in', externalCredentialTypes)
            .executeTakeFirst();
          if (!credential) fieldError([...path, 'credentialId'], '凭据不存在、已禁用或类型不支持');
          reference = credential.id;
        } else if (keepSecret) {
          if (!old?.is_secret || !old.credential_id)
            fieldError([...path, 'value'], '该键没有可以保留的敏感值');
          reference = old.credential_id;
        } else {
          reference = await this.credentials.storeVariableValue(tx, user.id, key, value as string);
        }
      } else if (value === undefined || keepSecret !== undefined || credentialId !== undefined) {
        fieldError([...path, 'value'], '请输入普通变量的值');
      }
      const valueText = isSecret ? null : (value as string);
      const nextDescription = description ?? old?.description ?? '';
      rows.push({
        id: old?.id ?? randomUUID(),
        environment_set_id: environmentSetId,
        key,
        value_text: valueText,
        credential_id: reference,
        is_secret: isSecret ? 1 : 0,
        description: nextDescription,
        created_at: old?.created_at ?? now,
        updated_at:
          old?.value_text === valueText &&
          old.credential_id === reference &&
          old.description === nextDescription
            ? old.updated_at
            : now,
      });
    }
    await tx
      .deleteFrom('project_environment_set_variables')
      .where('environment_set_id', '=', environmentSetId)
      .execute();
    if (rows.length)
      await tx.insertInto('project_environment_set_variables').values(rows).execute();
  }

  async archive(projectId: string, id: string, expectedRevision: number, userId: string) {
    return this.database.db.transaction().execute(async (tx) => {
      await this.lockScope(tx, projectId);
      const current = await requireSet(tx, projectId, id);
      currentRevision(current, expectedRevision);
      const now = Date.now();
      const revision = current.revision + 1;
      await tx
        .updateTable('project_environment_sets')
        .set({ archived_at: now, updated_at: now, revision })
        .where('id', '=', id)
        .execute();
      await this.audit.record(
        userId,
        'environment_set.archive',
        'environment_set',
        id,
        { projectId, revision },
        tx,
      );
      return { id, archivedAt: now, revision };
    });
  }

  async reveal(projectId: string, id: string, key: string, userId: string) {
    const row = await setWithVariables(this.database.db, projectId, id)
      .where('env_set.archived_at', 'is', null)
      .where('variable.key', '=', key)
      .where('variable.is_secret', '=', 1)
      .executeTakeFirst();
    if (!row?.credential_id || !row.credentialNonce) throw new NotFoundException('敏感变量不存在');
    const value = variableCredentialValue(
      await this.credentials.decrypt(row.credential_id, row.credentialNonce),
    );
    if (value === undefined) throw new BadRequestException('关联凭据没有可用的变量值');
    await this.audit.record(userId, 'environment_set.variable.reveal', 'environment_set', id, {
      projectId,
      key,
      revision: row.revision,
    });
    return { value };
  }

  async credentialOptions(projectId: string) {
    await requireProject(this.database.db, projectId);
    return this.database.db
      .selectFrom('credentials')
      .select(['id', 'name', 'type'])
      .where('status', '=', 'ACTIVE')
      .where('type', 'in', externalCredentialTypes)
      .orderBy('name')
      .orderBy('id')
      .execute();
  }
}

@Controller('projects/:projectId/environment-sets')
class EnvironmentSetsController {
  constructor(private readonly service: EnvironmentSetsService) {}

  @Get()
  list(@Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.service.list(projectId);
  }

  @Get('credential-options')
  @Roles('ADMIN')
  credentialOptions(@Param('projectId', ParseUUIDPipe) projectId: string) {
    return this.service.credentialOptions(projectId);
  }

  @Get(':id')
  get(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id', ParseUUIDPipe) id: string,
  ) {
    return this.service.get(projectId, id);
  }

  @Post()
  @Roles('ADMIN', 'OPERATOR')
  create(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Body() dto: CreateEnvironmentSetDto,
    @Req() req: AuthRequest,
  ) {
    return this.service.save(projectId, dto, req.user);
  }

  @Patch(':id')
  @Roles('ADMIN', 'OPERATOR')
  update(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateEnvironmentSetDto,
    @Req() req: AuthRequest,
  ) {
    return this.service.save(projectId, dto, req.user, id);
  }

  @Delete(':id')
  @Roles('ADMIN', 'OPERATOR')
  archive(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Body() { expectedRevision }: ArchiveEnvironmentSetDto,
    @Req() req: AuthRequest,
  ) {
    return this.service.archive(projectId, id, expectedRevision, req.user.id);
  }

  @Post(':id/variables/:key/reveal')
  @Roles('ADMIN')
  @Header('Cache-Control', 'no-store')
  reveal(
    @Param('projectId', ParseUUIDPipe) projectId: string,
    @Param('id', ParseUUIDPipe) id: string,
    @Param('key') key: string,
    @Req() req: AuthRequest,
  ) {
    return this.service.reveal(projectId, id, key, req.user.id);
  }
}

@Module({ controllers: [EnvironmentSetsController], providers: [EnvironmentSetsService] })
export class EnvironmentSetsModule {}
