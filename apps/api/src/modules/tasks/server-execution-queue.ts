import { sql, type Kysely, type Transaction } from 'kysely';
import type { Database } from '../../core/database/schema';
import { activeFlowStatuses, graphTaskKeyPrefix } from '../execution-graphs/graph-run-lifecycle';

export const operationTaskTypes = ['COMMAND', 'OPERATION_PLAN'] as const;

export function isQueuedOperation(type: string, idempotencyKey: string | null | undefined) {
  return (
    (type === 'COMMAND' || type === 'OPERATION_PLAN') &&
    !idempotencyKey?.startsWith(graphTaskKeyPrefix)
  );
}

function operations(db: Kysely<Database>) {
  return db
    .selectFrom('task_targets as target')
    .innerJoin('tasks as parent', 'parent.id', 'target.task_id')
    .where('parent.task_type', 'in', operationTaskTypes)
    .where((eb) =>
      eb.or([
        eb('parent.idempotency_key', 'is', null),
        eb('parent.idempotency_key', 'not like', graphTaskKeyPrefix + '%'),
      ]),
    );
}

function waiting(db: Kysely<Database>, now: number) {
  return db
    .selectFrom('execution_flow_runs')
    .select([
      'id',
      'id as ownerId',
      'execution_server_id as serverId',
      'created_at as queuedAt',
      sql<'FLOW' | 'OPERATION'>`'FLOW'`.as('kind'),
    ])
    .where('execution_server_id', 'is not', null)
    .where('status', '=', 'QUEUED')
    .where('execution_admitted_at', 'is', null)
    .unionAll(
      operations(db)
        .select([
          'target.id',
          'parent.id as ownerId',
          'target.server_id as serverId',
          sql<number>`coalesce(${sql.ref('target.execution_queued_at')}, ${sql.ref('parent.created_at')})`.as(
            'queuedAt',
          ),
          sql<'FLOW' | 'OPERATION'>`'OPERATION'`.as('kind'),
        ])
        .where('target.server_id', 'is not', null)
        .where('target.status', '=', 'PENDING')
        .where('parent.status', 'in', ['PENDING', 'RUNNING'])
        .where('parent.available_at', '<=', now),
    );
}

function occupying(db: Kysely<Database>) {
  return db
    .selectFrom('execution_flow_runs')
    .select('execution_server_id as serverId')
    .where('execution_admitted_at', 'is not', null)
    .where('status', 'in', activeFlowStatuses)
    .unionAll(
      operations(db)
        .select('target.server_id as serverId')
        .where('target.status', '=', 'RUNNING')
        .where('parent.status', 'in', ['RUNNING', 'CANCEL_REQUESTED']),
    );
}

/** The same database row serializes submission and admission on all workers. */
async function lockServerQueue(tx: Transaction<Database>, serverId: string) {
  await tx
    .updateTable('servers')
    .set((eb) => ({ id: eb.ref('id') }))
    .where('id', '=', serverId)
    .execute();
}

export async function nextServerWorkOrder(tx: Transaction<Database>, serverId: string) {
  await lockServerQueue(tx, serverId);
  const flow = await tx
    .selectFrom('execution_flow_runs')
    .select('created_at as queuedAt')
    .where('execution_server_id', '=', serverId)
    .orderBy('created_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  const target = await tx
    .selectFrom('task_targets')
    .select('execution_queued_at as queuedAt')
    .where('server_id', '=', serverId)
    .where('execution_queued_at', 'is not', null)
    .orderBy('execution_queued_at', 'desc')
    .limit(1)
    .executeTakeFirst();
  return Math.max(Date.now(), Number(flow?.queuedAt ?? 0) + 1, Number(target?.queuedAt ?? 0) + 1);
}

/** Advisory check for claiming parents. The target rechecks capacity inside its lease transaction. */
export function readyOperationTasks(db: Kysely<Database>, limit: number, now: number) {
  const queue = waiting(db, now);
  return db
    .selectFrom(queue.as('entry'))
    .select('entry.ownerId')
    .where('entry.kind', '=', 'OPERATION')
    .where((eb) =>
      eb.not(
        eb.exists(
          eb
            .selectFrom(queue.as('prior'))
            .select('prior.id')
            .whereRef('prior.serverId', '=', 'entry.serverId')
            .where((prior) =>
              prior.or([
                prior('prior.queuedAt', '<', prior.ref('entry.queuedAt')),
                prior.and([
                  prior('prior.queuedAt', '=', prior.ref('entry.queuedAt')),
                  prior('prior.id', '<', prior.ref('entry.id')),
                ]),
              ]),
            ),
        ),
      ),
    )
    .where((eb) =>
      eb(
        eb
          .selectFrom(occupying(db).as('active'))
          .select((active) => active.fn.countAll<number>().as('total'))
          .whereRef('active.serverId', '=', 'entry.serverId'),
        '<',
        limit,
      ),
    );
}

export async function canAdmitServerWork(
  tx: Transaction<Database>,
  serverId: string,
  kind: 'FLOW' | 'OPERATION',
  id: string,
  limit: number,
) {
  await lockServerQueue(tx, serverId);
  const head = await tx
    .selectFrom(waiting(tx, Date.now()).as('entry'))
    .select(['entry.id', 'entry.kind'])
    .where('entry.serverId', '=', serverId)
    .orderBy('entry.queuedAt')
    .orderBy('entry.id')
    .limit(1)
    .executeTakeFirst();
  if (head?.id !== id || head.kind !== kind) return false;
  const { total } = await tx
    .selectFrom(occupying(tx).as('active'))
    .select((eb) => eb.fn.countAll<number>().as('total'))
    .where('active.serverId', '=', serverId)
    .executeTakeFirstOrThrow();
  return Number(total) < limit;
}
