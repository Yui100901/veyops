import { sql, type Migration } from 'kysely';

export const executionGraphTriggersMigration: Migration = {
  async up(db) {
    await db.schema.alterTable('execution_flow_runs').addColumn('trigger_type', 'text').execute();
    await sql`create table execution_graph_triggers (
      id text primary key not null,
      project_id text not null references execution_graphs(project_id) on delete restrict,
      flow_id text not null,
      version integer not null check (version > 0),
      name text not null,
      kind text not null check (kind in ('CRON', 'WEBHOOK', 'API', 'UPSTREAM')),
      config_json text not null,
      enabled integer not null check (enabled in (0, 1)),
      next_at bigint,
      created_by text not null references users(id) on delete restrict,
      created_at bigint not null,
      updated_at bigint not null
    )`.execute(db);
    await sql`create index execution_graph_triggers_project on execution_graph_triggers(project_id, created_at, id)`.execute(
      db,
    );
    await sql`create index execution_graph_triggers_due on execution_graph_triggers(enabled, next_at)`.execute(
      db,
    );
    await sql`create table execution_graph_trigger_events (
      id text primary key not null,
      trigger_id text not null references execution_graph_triggers(id) on delete restrict,
      event_key text not null,
      request_hash text not null,
      input_value text,
      status text not null,
      run_id text references execution_flow_runs(id) on delete restrict,
      error text,
      created_at bigint not null,
      finished_at bigint,
      unique (trigger_id, event_key)
    )`.execute(db);
    await sql`create index execution_graph_trigger_events_pending on execution_graph_trigger_events(status, created_at)`.execute(
      db,
    );
  },
  async down(db) {
    await db.schema.dropTable('execution_graph_trigger_events').execute();
    await db.schema.dropTable('execution_graph_triggers').execute();
    await db.schema.alterTable('execution_flow_runs').dropColumn('trigger_type').execute();
  },
};
