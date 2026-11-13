import type { Transaction } from 'kysely';
import type { Database } from '../../core/database/schema';

export class TaskLeaseUnavailableError extends Error {
  constructor() {
    super('任务已取消或 Worker 租约已失效');
  }
}

/** Lock the parent before writing execution records so lease recovery cannot overtake the write. */
export async function lockTaskLease(
  tx: Transaction<Database>,
  taskId: string,
  owner: string,
  allowCancel = false,
): Promise<boolean> {
  const row = await tx
    .updateTable('tasks')
    .set((eb) => ({ updated_at: eb.ref('updated_at') }))
    .where('id', '=', taskId)
    .where('lease_owner', '=', owner)
    .where('status', 'in', allowCancel ? ['RUNNING', 'CANCEL_REQUESTED'] : ['RUNNING'])
    .where('lease_expires_at', '>=', Date.now())
    .returning('lease_expires_at')
    .executeTakeFirst();
  return row?.lease_expires_at != null && row.lease_expires_at >= Date.now();
}
