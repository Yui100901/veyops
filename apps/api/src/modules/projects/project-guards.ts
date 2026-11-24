import { NotFoundException } from '@nestjs/common';
import type { Kysely, Transaction } from 'kysely';
import type { Database } from '../../core/database/schema';

export async function requireProject(db: Kysely<Database>, id: string) {
  const project = await db
    .selectFrom('projects')
    .select('id')
    .where('id', '=', id)
    .where('deleted_at', 'is', null)
    .executeTakeFirst();
  if (!project) throw new NotFoundException('项目不存在');
}

export async function lockProjectGraph(tx: Transaction<Database>) {
  // Reuse the existing settings key so all instances serialize writes on the same row.
  await tx
    .insertInto('system_settings')
    .values({ key: 'projects:dependency-graph-lock', value_json: '{}', updated_at: Date.now() })
    .onConflict((conflict) =>
      conflict.column('key').doUpdateSet((eb) => ({ updated_at: eb.ref('excluded.updated_at') })),
    )
    .execute();
}
