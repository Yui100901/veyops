import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Selectable, Transaction } from 'kysely';
import { DatabaseService } from '../../core/database/database.service';
import type { CommandTemplatesTable, Database } from '../../core/database/schema';
import { AuditService } from '../audit/audit.service';
import { CommandCenterService } from './command-center.service';
import type { RunCommandTemplateDto, SaveCommandTemplateDto } from './command-template.dto';
import {
  CommandParameterDto,
  parameterEnvironment,
  validateParameterDefinitions,
} from './command-parameters';

function fields(input: SaveCommandTemplateDto) {
  return {
    name: input.name,
    description: input.description ?? '',
    command_text: input.command,
    variables_schema_json: JSON.stringify(validateParameterDefinitions(input.parameters ?? [])),
    timeout_seconds: input.timeout ?? 300,
  };
}

function presentFields(row: ReturnType<typeof fields>) {
  const stored = JSON.parse(row.variables_schema_json) as unknown;
  return {
    name: row.name,
    description: row.description,
    command: row.command_text,
    timeout: row.timeout_seconds,
    parameters: (Array.isArray(stored) ? stored : []) as CommandParameterDto[],
  };
}

function present(row: Selectable<CommandTemplatesTable>) {
  return {
    ...presentFields(row),
    id: row.id,
    currentVersion: row.current_version,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
  };
}

@Injectable()
export class CommandTemplatesService {
  constructor(
    private readonly database: DatabaseService,
    private readonly commands: CommandCenterService,
    private readonly audit: AuditService,
  ) {}

  private async template(id: string) {
    const row = await this.database.db
      .selectFrom('command_templates')
      .selectAll()
      .where('id', '=', id)
      .executeTakeFirst();
    if (!row) throw new NotFoundException('命令模板不存在');
    return row;
  }

  async list() {
    const rows = await this.database.db
      .selectFrom('command_templates')
      .selectAll()
      .where('enabled', '=', 1)
      .orderBy('created_at', 'desc')
      .execute();
    return rows.map(present);
  }

  private async saveVersion(
    tx: Transaction<Database>,
    row: Selectable<CommandTemplatesTable>,
    userId: string,
    now: number,
  ) {
    await tx
      .insertInto('command_template_versions')
      .values({
        id: randomUUID(),
        template_id: row.id,
        version: row.current_version,
        name: row.name,
        description: row.description,
        command_text: row.command_text,
        variables_schema_json: row.variables_schema_json,
        timeout_seconds: row.timeout_seconds,
        created_by: userId,
        created_at: now,
      })
      .execute();
  }

  async create(input: SaveCommandTemplateDto, userId: string) {
    const id = randomUUID();
    const now = Date.now();
    const values = fields(input);
    const row = await this.database.db.transaction().execute(async (tx) => {
      const created = await tx
        .insertInto('command_templates')
        .values({ ...values, id, created_by: userId, created_at: now })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.saveVersion(tx, created, userId, now);
      return created;
    });
    await this.audit.record(userId, 'command_template.create', 'command_template', id);
    return present(row);
  }

  async update(id: string, input: SaveCommandTemplateDto, userId: string) {
    const values = fields(input);
    const row = await this.database.db.transaction().execute(async (tx) => {
      const updated = await tx
        .updateTable('command_templates')
        .set((eb) => ({ ...values, current_version: eb('current_version', '+', 1) }))
        .where('id', '=', id)
        .where('enabled', '=', 1)
        .returningAll()
        .executeTakeFirst();
      if (!updated) throw new NotFoundException('命令模板不存在');
      await this.saveVersion(tx, updated, userId, Date.now());
      return updated;
    });
    await this.audit.record(userId, 'command_template.update', 'command_template', id);
    return present(row);
  }

  async remove(id: string, userId: string) {
    const row = await this.database.db
      .updateTable('command_templates')
      .set({ enabled: 0 })
      .where('id', '=', id)
      .where('enabled', '=', 1)
      .returning('id')
      .executeTakeFirst();
    if (!row) throw new NotFoundException('命令模板不存在');
    await this.audit.record(userId, 'command_template.archive', 'command_template', id);
    return { id };
  }

  async versions(id: string) {
    await this.template(id);
    const rows = await this.database.db
      .selectFrom('command_template_versions')
      .selectAll()
      .where('template_id', '=', id)
      .orderBy('version', 'desc')
      .execute();
    return rows.map((row) => ({
      ...presentFields(row),
      id: row.id,
      version: row.version,
      createdAt: row.created_at,
    }));
  }

  async prepareRun(id: string, input: RunCommandTemplateDto) {
    const template = await this.template(id);
    if (!template.enabled) throw new BadRequestException('命令模板已禁用');
    const version = await this.database.db
      .selectFrom('command_template_versions')
      .selectAll()
      .where('template_id', '=', id)
      .where('version', '=', input.version ?? template.current_version)
      .executeTakeFirst();
    if (!version) throw new NotFoundException('命令模板版本不存在');
    const definition = presentFields(version);
    const execution = await this.commands.prepareExecution(
      {
        ...input,
        name: `${version.name} · v${version.version}`,
        timeout: input.timeout ?? definition.timeout,
        command:
          parameterEnvironment(definition.parameters, input.parameters ?? {}) + definition.command,
      },
      { id, version: version.version },
    );
    return {
      input: execution,
      beforeInsert: async (tx: Transaction<Database>) => {
        const active = await tx
          .updateTable('command_templates')
          .set((eb) => ({ enabled: eb.ref('enabled') }))
          .where('id', '=', id)
          .where('enabled', '=', 1)
          .returning('id')
          .executeTakeFirst();
        if (!active) throw new BadRequestException('命令模板已禁用');
      },
    };
  }

  async run(id: string, input: RunCommandTemplateDto, userId: string) {
    const execution = await this.prepareRun(id, input);
    return this.commands.submitPrepared(execution.input, userId, execution.beforeInsert);
  }
}
