import { sql, type Migration } from 'kysely';

// Persisted v1 seed shared by the upgrade and project creation paths.
export const initialGraphDraft = JSON.stringify({
  flows: [
    {
      id: 'main',
      name: '手动执行',
      nodes: [
        { id: 'start', type: 'START', name: '开始' },
        { id: 'end', type: 'END', name: '结束' },
      ],
      edges: [{ from: 'start', to: 'end' }],
    },
  ],
});

export const executionGraphsMigration: Migration = {
  async up(db) {
    await sql`create table execution_graphs (
      id text primary key not null,
      project_id text not null unique references projects(id) on delete restrict,
      revision integer not null check (revision >= 1),
      draft_json text not null,
      published_version integer,
      created_at bigint not null,
      updated_at bigint not null,
      unique (project_id, id)
    )`.execute(db);
    await sql`create table execution_graph_versions (
      id text primary key not null,
      graph_id text not null references execution_graphs(id) on delete restrict,
      version integer not null check (version >= 1),
      source_revision integer not null,
      definition_json text not null,
      created_at bigint not null,
      created_by text not null references users(id) on delete restrict,
      unique (graph_id, version), unique (graph_id, source_revision)
    )`.execute(db);
    await sql`create table execution_flow_runs (
      id text primary key not null,
      project_id text not null,
      graph_id text not null,
      version integer not null,
      flow_id text not null,
      flow_name text not null,
      created_by text not null references users(id) on delete restrict,
      idempotency_key text not null,
      request_hash text not null,
      configuration_hash text not null,
      inputs_json text not null,
      status text not null,
      created_at bigint not null,
      finished_at bigint,
      parent_run_id text references execution_flow_runs(id) on delete restrict,
      task_id text unique references tasks(id) on delete restrict,
      foreign key (project_id, graph_id) references execution_graphs(project_id, id) on delete restrict,
      foreign key (graph_id, version) references execution_graph_versions(graph_id, version) on delete restrict,
      unique (project_id, created_by, idempotency_key)
    )`.execute(db);
    await sql`create index execution_flow_runs_project_time on execution_flow_runs(project_id, created_at, id)`.execute(
      db,
    );
    await sql`create index execution_flow_runs_active on execution_flow_runs(status, created_at, id)`.execute(
      db,
    );
    await sql`create index execution_flow_runs_parent on execution_flow_runs(parent_run_id)`.execute(db);
    await sql`create table execution_node_runs (
      id text primary key not null,
      run_id text not null references execution_flow_runs(id) on delete restrict,
      node_id text not null,
      name text not null,
      node_type text not null,
      position integer not null,
      status text not null,
      log text not null,
      started_at bigint,
      finished_at bigint,
      task_id text unique references tasks(id) on delete restrict,
      child_run_id text unique references execution_flow_runs(id) on delete restrict,
      output_json text,
      dispatch_json text,
      unique (run_id, node_id), unique (run_id, position)
    )`.execute(db);
  },
  async down(db) {
    await db.schema.dropTable('execution_node_runs').execute();
    // SQLite applies the self-referencing foreign key during DROP TABLE.
    await sql`update execution_flow_runs set parent_run_id = null where parent_run_id is not null`.execute(
      db,
    );
    for (const table of ['execution_flow_runs', 'execution_graph_versions', 'execution_graphs'])
      await db.schema.dropTable(table).execute();
  },
};
