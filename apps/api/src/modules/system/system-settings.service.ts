import { BadRequestException, Global, Injectable, Module, NotFoundException } from '@nestjs/common';
import {
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateIf,
} from 'class-validator';
import { DatabaseService } from '../../core/database/database.service';
import type { Kysely } from 'kysely';
import type { Database } from '../../core/database/schema';
import { AuditService } from '../audit/audit.service';

export interface SystemSettings {
  defaultBuildLocation: 'TARGET' | 'MANAGER';
  defaultMaxParallelTargets: number;
  maxConcurrentFlowsPerServer: number;
  logRetentionDays: number;
  targetWorkspaceRoot: string;
}

const settingsKey = 'system:execution-defaults';
const defaults: SystemSettings = {
  defaultBuildLocation: 'TARGET',
  defaultMaxParallelTargets: 3,
  maxConcurrentFlowsPerServer: 3,
  logRetentionDays: 0,
  targetWorkspaceRoot: '~/.veyops/workspace',
};

export class UpdateSystemSettingsDto implements Partial<SystemSettings> {
  @ValidateIf((_object, value) => value !== undefined)
  @IsIn(['TARGET', 'MANAGER'])
  defaultBuildLocation?: SystemSettings['defaultBuildLocation'];

  @ValidateIf((_object, value) => value !== undefined)
  @IsInt()
  @Min(1)
  @Max(10)
  defaultMaxParallelTargets?: number;

  @ValidateIf((_object, value) => value !== undefined)
  @IsInt()
  @Min(1)
  @Max(10)
  maxConcurrentFlowsPerServer?: number;

  @ValidateIf((_object, value) => value !== undefined)
  @IsInt()
  @Min(0)
  @Max(3650)
  logRetentionDays?: number;
  @ValidateIf((_object, value) => value !== undefined)
  @IsString()
  @MaxLength(512)
  targetWorkspaceRoot?: string;
}

export class UpdateProjectSettingsDto {
  @IsOptional() @IsIn(['TARGET', 'MANAGER']) defaultBuildLocation?:
    SystemSettings['defaultBuildLocation'] | null;
  @IsOptional() @IsInt() @Min(1) @Max(10) defaultMaxParallelTargets?: number | null;
  @IsOptional() @IsInt() @Min(0) @Max(3650) logRetentionDays?: number | null;
  @IsOptional() @IsString() @MaxLength(512) targetWorkspaceRoot?: string | null;
}

export function validateWorkspaceRoot(path: string, maxLength = 512) {
  const relative = path.startsWith('~/')
    ? path.slice(2)
    : path.startsWith('/')
      ? path.slice(1)
      : '';
  if (
    !relative ||
    path.length > maxLength ||
    /[\x00-\x1f\x7f]/u.test(path) ||
    relative.split('/').some((part) => !part || part === '.' || part === '..')
  )
    throw new BadRequestException(
      '目标端工作目录须为绝对路径或以 ~/ 开头的子目录，不可包含空路径段、. 或 ..',
    );
  return path;
}

const projectKey = (id: string) => `project:${id}:execution-defaults`;
const settingFields = Object.keys(defaults) as (keyof SystemSettings)[];

function stored(row?: { value_json: string }): Partial<SystemSettings> {
  return row ? (JSON.parse(row.value_json) as Partial<SystemSettings>) : {};
}

@Injectable()
export class SystemSettingsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  private async resolve(projectId?: string, db = this.database.db) {
    const keys = projectId ? [settingsKey, projectKey(projectId)] : [settingsKey];
    const rows = await db
      .selectFrom('system_settings')
      .select(['key', 'value_json'])
      .where('key', 'in', keys)
      .execute();
    const system = { ...defaults, ...stored(rows.find((r) => r.key === settingsKey)) };
    const overrides = stored(rows.find((r) => r.key !== settingsKey));
    return { system, overrides, effective: { ...system, ...overrides } };
  }

  async get(projectId?: string, db = this.database.db): Promise<SystemSettings> {
    return (await this.resolve(projectId, db)).effective;
  }

  async project(projectId: string) {
    await this.assertProject(projectId, this.database.db, false);
    return this.resolve(projectId);
  }

  private async assertProject(id: string, db: Kysely<Database>, activeOnly: boolean) {
    let query = db.selectFrom('projects').select('id').where('id', '=', id);
    if (activeOnly) query = query.where('deleted_at', 'is', null);
    if (!(await query.executeTakeFirst())) throw new NotFoundException('项目不存在或已归档');
  }

  async logRetentionPolicies(db: Kysely<Database> = this.database.db) {
    const rows = await db
      .selectFrom('system_settings')
      .select(['key', 'value_json'])
      .where((eb) =>
        eb.or([eb('key', '=', settingsKey), eb('key', 'like', 'project:%:execution-defaults')]),
      )
      .execute();
    const projectDays = new Map<string, number>();
    let systemDays = defaults.logRetentionDays;
    for (const row of rows) {
      const days = stored(row).logRetentionDays;
      if (days === undefined) continue;
      if (row.key === settingsKey) systemDays = days;
      else projectDays.set(row.key.split(':')[1]!, days);
    }
    return { systemDays, projectDays };
  }

  async update(input: UpdateSystemSettingsDto, userId: string) {
    await this.save(input, userId);
    return this.get();
  }

  async updateProject(projectId: string, input: UpdateProjectSettingsDto, userId: string) {
    await this.save(input, userId, projectId);
    return this.resolve(projectId);
  }

  private async save(
    input: UpdateProjectSettingsDto & { maxConcurrentFlowsPerServer?: number },
    userId: string,
    projectId?: string,
  ) {
    const key = projectId ? projectKey(projectId) : settingsKey;
    if (input.targetWorkspaceRoot != null) validateWorkspaceRoot(input.targetWorkspaceRoot);
    await this.database.db.transaction().execute(async (tx) => {
      if (projectId) await this.assertProject(projectId, tx, true);
      const fields = settingFields.filter((field) => input[field] !== undefined);
      if (!fields.length) return;
      const current = await tx
        .insertInto('system_settings')
        .values({ key, value_json: '{}', updated_at: Date.now() })
        .onConflict((c) =>
          c
            .column('key')
            .doUpdateSet((eb) => ({ value_json: eb.ref('system_settings.value_json') })),
        )
        .returning('value_json')
        .executeTakeFirstOrThrow();
      const next = { ...stored(current) };
      for (const field of fields) {
        if (input[field] === null) delete next[field];
        else Object.assign(next, { [field]: input[field] });
      }
      await tx
        .updateTable('system_settings')
        .set({ value_json: JSON.stringify(next), updated_at: Date.now() })
        .where('key', '=', key)
        .execute();
      await this.audit.record(
        userId,
        projectId ? 'project.settings.update' : 'system.settings.update',
        projectId ? 'project' : 'system-settings',
        projectId ?? key,
        Object.fromEntries(fields.map((field) => [field, input[field]])),
        tx,
      );
    });
  }
}

@Global()
@Module({ providers: [SystemSettingsService], exports: [SystemSettingsService] })
export class SystemSettingsModule {}
