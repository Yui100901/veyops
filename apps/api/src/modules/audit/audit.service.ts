import { Global, Injectable, Module, Controller, Get } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../../core/database/database.service';
@Injectable()
export class AuditService {
  constructor(private readonly database: DatabaseService) {}
  async record(
    userId: string | null,
    action: string,
    resourceType: string,
    resourceId: string | null,
    detail: Record<string, unknown> = {},
  ) {
    await this.database.db
      .insertInto('audit_logs')
      .values({
        id: randomUUID(),
        actor_type: userId ? 'USER' : 'SYSTEM',
        user_id: userId,
        action,
        resource_type: resourceType,
        resource_id: resourceId,
        request_id: null,
        details_json: JSON.stringify(detail),
        created_at: Date.now(),
      })
      .execute();
  }
  async list() {
    const rows = await this.database.db
      .selectFrom('audit_logs')
      .selectAll()
      .orderBy('created_at', 'desc')
      .limit(200)
      .execute();
    return rows.map((r) => ({
      id: r.id,
      actorId: r.user_id,
      actorType: r.actor_type,
      action: r.action,
      resourceType: r.resource_type,
      resourceId: r.resource_id,
      detail: JSON.parse(r.details_json),
      createdAt: r.created_at,
    }));
  }
}
@Controller('audit')
class AuditController {
  constructor(private readonly audit: AuditService) {}
  @Get() list() {
    return this.audit.list();
  }
}
@Global()
@Module({ controllers: [AuditController], providers: [AuditService], exports: [AuditService] })
export class AuditModule {}
