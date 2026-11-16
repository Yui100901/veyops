import { Global, Injectable, Module } from '@nestjs/common';
import { IsIn, IsInt, Max, Min, ValidateIf } from 'class-validator';
import { DatabaseService } from '../../core/database/database.service';
import { AuditService } from '../audit/audit.service';

export interface SystemSettings {
  defaultBuildLocation: 'TARGET' | 'MANAGER';
  defaultMaxParallelTargets: number;
  logRetentionDays: number;
}

const settingsKey = 'system:execution-defaults';
const defaults: SystemSettings = {
  defaultBuildLocation: 'TARGET',
  defaultMaxParallelTargets: 3,
  logRetentionDays: 0,
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
  @Min(0)
  @Max(3650)
  logRetentionDays?: number;
}

function readSettings(row?: { value_json: string }): SystemSettings {
  return row
    ? { ...defaults, ...(JSON.parse(row.value_json) as Partial<SystemSettings>) }
    : { ...defaults };
}

@Injectable()
export class SystemSettingsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  async get(): Promise<SystemSettings> {
    const row = await this.database.db
      .selectFrom('system_settings')
      .select('value_json')
      .where('key', '=', settingsKey)
      .executeTakeFirst();
    return readSettings(row);
  }

  async update(input: UpdateSystemSettingsDto, userId: string): Promise<SystemSettings> {
    const { defaultBuildLocation, defaultMaxParallelTargets, logRetentionDays } = input;
    const changes = {
      ...(defaultBuildLocation !== undefined && { defaultBuildLocation }),
      ...(defaultMaxParallelTargets !== undefined && { defaultMaxParallelTargets }),
      ...(logRetentionDays !== undefined && { logRetentionDays }),
    };
    if (!Object.keys(changes).length) return this.get();

    return this.database.db.transaction().execute(async (tx) => {
      // Lock the settings row before reading it so concurrent partial changes merge.
      const current = await tx
        .insertInto('system_settings')
        .values({ key: settingsKey, value_json: '{}', updated_at: Date.now() })
        .onConflict((conflict) =>
          conflict
            .column('key')
            .doUpdateSet((eb) => ({ value_json: eb.ref('system_settings.value_json') })),
        )
        .returning('value_json')
        .executeTakeFirstOrThrow();
      const next = { ...readSettings(current), ...changes };
      await tx
        .updateTable('system_settings')
        .set({ value_json: JSON.stringify(next), updated_at: Date.now() })
        .where('key', '=', settingsKey)
        .execute();
      await this.audit.record(
        userId,
        'system.settings.update',
        'system-settings',
        settingsKey,
        changes,
        tx,
      );
      return next;
    });
  }
}

@Global()
@Module({ providers: [SystemSettingsService], exports: [SystemSettingsService] })
export class SystemSettingsModule {}
