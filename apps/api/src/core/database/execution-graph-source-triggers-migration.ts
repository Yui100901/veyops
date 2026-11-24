import { sql, type Migration } from 'kysely';

export const executionGraphSourceTriggersMigration: Migration = {
  async up(db) {
    await sql`alter table execution_graph_triggers add column source_checked_at bigint`.execute(db);
    await sql`alter table execution_graph_triggers add column source_error text`.execute(db);
    await sql`alter table execution_graph_trigger_events add column duplicate_of text`.execute(db);
    await sql`create table execution_graph_source_observations (
      project_id text not null references projects(id),
      flow_id text not null,
      repository_id text not null references repositories(id),
      ref text not null,
      commit_sha text not null,
      sequence integer not null,
      event_id text references execution_graph_trigger_events(id),
      last_checked_at bigint not null,
      primary key (project_id, flow_id, repository_id, ref)
    )`.execute(db);
  },
  async down(db) {
    await db.schema.dropTable('execution_graph_source_observations').execute();
    await db.schema
      .alterTable('execution_graph_trigger_events')
      .dropColumn('duplicate_of')
      .execute();
    await db.schema.alterTable('execution_graph_triggers').dropColumn('source_error').execute();
    await db.schema
      .alterTable('execution_graph_triggers')
      .dropColumn('source_checked_at')
      .execute();
  },
};
