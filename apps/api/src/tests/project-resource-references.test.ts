import 'reflect-metadata';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { DatabaseService } from '../core/database/database.service';
import type { GraphDefinition } from '../modules/execution-graphs/execution-graph-definition';
import {
  graphResourceReferences,
  projectResourceInventory,
  projectResourceReferences,
  runResourceReferences,
} from '../modules/projects/project-resource-references';
import { createPostgresTestDatabase, postgresTestUrl } from './helpers/isolated-postgres';

const at = { created_at: 1000, updated_at: 1000 };

test('graph reference context uses the bound input default and leaves ambiguous scopes unset', () => {
  const fallback = randomUUID();
  const selected = randomUUID();
  const service = randomUUID();
  const explicitService = randomUUID();
  const host = randomUUID();
  const definition: GraphDefinition = {
    flows: [
      {
        id: 'flow',
        name: 'Flow',
        edges: [],
        nodes: [
          {
            id: 'start',
            type: 'START',
            name: 'Start',
            inputs: [
              { id: 'a', name: 'A', type: 'ENVIRONMENT', defaultValue: fallback },
              { id: 'b', name: 'B', type: 'ENVIRONMENT', defaultValue: selected },
              { id: 'dynamic', name: 'Selected when running', type: 'ENVIRONMENT' },
              { id: 'svc', name: 'Service', type: 'SERVICE', defaultValue: service },
            ],
          },
          ...['unbound', 'specific', 'dynamic'].map((id) => ({
            id,
            type: 'SHELL' as const,
            name: id,
            shell: { serverId: host },
          })),
          { id: 'end', type: 'END', name: 'End' },
        ],
        inputBindings: {
          specific: {
            environment: { kind: 'INPUT', fieldId: 'b' },
            service: { kind: 'VALUE', value: explicitService },
          },
          dynamic: {
            environment: {
              kind: 'FIRST_AVAILABLE',
              sources: [
                { kind: 'INPUT', fieldId: 'dynamic' },
                { kind: 'VALUE', value: fallback },
              ],
            },
          },
        },
      },
    ],
  };
  const rows = graphResourceReferences(definition, {
    sourceId: 'version',
    state: 'RUNNABLE',
    version: 1,
  });
  const scopes = rows
    .filter(({ resourceType }) => resourceType === 'SERVER')
    .map(({ nodeId, environmentId, serviceId }) => [nodeId, environmentId, serviceId]);
  assert.deepEqual(scopes, [
    ['unbound', undefined, service],
    ['specific', selected, explicitService],
    ['dynamic', undefined, service],
  ]);
});

test('artifact-only execution retains source provenance without a live checkout dependency', () => {
  const repositoryId = randomUUID();
  const artifactId = randomUUID();
  const scope = { sourceId: 'run', version: 1, flowId: 'flow' };
  const snapshot = {
    inputs: {},
    deliveries: {
      'flow:deploy': {
        artifactIds: [artifactId],
        profile: { definition: { repositoryId } },
        sourceSnapshot: [{ repositoryId }],
      },
    },
  };
  const pending = runResourceReferences(undefined, { ...scope, state: 'PENDING' }, snapshot);
  assert.deepEqual(
    pending.map((row) => [row.resourceType, row.resourceId]),
    [['ARTIFACT', artifactId]],
  );
  const history = runResourceReferences(undefined, { ...scope, state: 'HISTORY' }, snapshot);
  assert.ok(
    history.some((row) => row.resourceType === 'REPOSITORY' && row.resourceId === repositoryId),
  );
});

test('typed graph references cover fixed values, defaults and unpaired drafts without reading script data', () => {
  const host = randomUUID();
  const otherHost = randomUUID();
  const group = randomUUID();
  const artifact = randomUUID();
  const definition: GraphDefinition = {
    flows: [
      {
        id: 'flow',
        name: 'Flow',
        edges: [],
        nodes: [
          {
            id: 'start',
            name: 'Start',
            type: 'START',
            inputs: [
              {
                id: 'targets',
                name: 'Targets',
                type: 'TARGETS',
                defaultValue: { groupIds: [group] },
              },
            ],
          },
          {
            id: 'check',
            name: 'Check',
            type: 'SHELL',
            shell: { serverId: host, command: otherHost },
          },
          {
            id: 'end',
            name: 'End',
            type: 'END',
            outputs: [{ id: 'artifact', name: 'Artifact', type: 'ARTIFACT', required: false }],
          },
        ],
        inputBindings: {
          check: {
            targets: {
              kind: 'FIRST_AVAILABLE',
              sources: [
                { kind: 'VALUE', value: { serverIds: [host] } },
                { kind: 'INPUT', fieldId: 'targets' },
              ],
            },
          },
        },
        outputBindings: { artifact: { kind: 'VALUE', value: { id: artifact } } },
      },
    ],
    canvas: {
      nodes: [{ id: 'future', name: 'Future', type: 'CHECK', shell: { serverId: otherHost } }],
      edges: [],
      endpoints: [],
      templates: [],
    },
  };
  const runnable = graphResourceReferences(definition, {
    sourceId: 'version',
    state: 'RUNNABLE',
    version: 2,
  });
  assert.ok(
    runnable.some((r) => r.resourceId === group && r.fieldId === 'targets' && r.nodeId === 'start'),
  );
  assert.ok(
    runnable.some((r) => r.resourceId === host && r.fieldId === 'targets' && r.nodeId === 'check'),
  );
  assert.ok(runnable.some((r) => r.resourceId === artifact && r.nodeId === 'end'));
  assert.ok(!runnable.some((r) => r.resourceId === otherHost));
  assert.ok(
    graphResourceReferences(definition, { sourceId: 'graph', state: 'DRAFT' }).some(
      (r) => r.resourceId === otherHost && r.nodeId === 'future',
    ),
  );
});

for (const client of ['sqlite', 'postgres'] as const) {
  test(
    `reference inventory isolates projects, preserves distinct sources and freezes historical member IDs (${client})`,
    {
      skip: client === 'postgres' && !postgresTestUrl ? 'VEYOPS_TEST_POSTGRES_URL is unset' : false,
    },
    async (t) => {
      let database: DatabaseService;
      if (client === 'postgres') database = await createPostgresTestDatabase(t);
      else {
        process.env.DATABASE_CLIENT = 'sqlite';
        process.env.DATABASE_PATH = ':memory:';
        database = new DatabaseService();
        t.after(() => database.onApplicationShutdown());
        await database.onModuleInit();
      }
      const db = database.db;
      const user = randomUUID(),
        project = randomUUID(),
        otherProject = randomUUID();
      const service = randomUUID(),
        otherService = randomUUID(),
        environment = randomUUID(),
        otherEnvironment = randomUUID();
      const host = randomUUID(),
        historyOnly = randomUUID(),
        versionHost = randomUUID(),
        group = randomUUID(),
        target = randomUUID();
      const directConfig = randomUUID(),
        legacyConfig = randomUUID(),
        graph = randomUUID(),
        oldVersion = randomUUID(),
        activeVersion = randomUUID(),
        trigger = randomUUID(),
        run = randomUUID();
      await db
        .insertInto('users')
        .values({ id: user, username: 'ref-fixture', password_hash: 'unused', ...at })
        .execute();
      await db
        .insertInto('projects')
        .values([
          { id: project, slug: 'inventory', name: 'Inventory', created_by: user, ...at },
          { id: otherProject, slug: 'other', name: 'Other', created_by: user, ...at },
        ])
        .execute();
      await db
        .insertInto('environments')
        .values([
          { id: environment, project_id: project, slug: 'test', name: 'Test', ...at },
          {
            id: otherEnvironment,
            project_id: otherProject,
            slug: 'test',
            name: 'Other Test',
            ...at,
          },
        ])
        .execute();
      await db
        .insertInto('services')
        .values([
          { id: service, project_id: project, slug: 'svc', name: 'Service', ...at },
          { id: otherService, project_id: otherProject, slug: 'svc', name: 'Other Service', ...at },
        ])
        .execute();
      await db
        .insertInto('servers')
        .values([
          { id: host, name: 'Shared', host: '192.0.2.1', username: 'test', ...at },
          {
            id: historyOnly,
            name: 'Previously selected',
            host: '192.0.2.2',
            username: 'test',
            ...at,
          },
          { id: versionHost, name: 'Pinned', host: '192.0.2.3', username: 'test', ...at },
        ])
        .execute();
      await db
        .insertInto('server_groups')
        .values({ id: group, name: 'Shared group', created_at: at.created_at })
        .execute();
      await db
        .insertInto('server_group_members')
        .values({ group_id: group, server_id: host, created_at: at.created_at })
        .execute();
      await db
        .insertInto('deployment_targets')
        .values({ id: target, name: 'Other legacy target', ...at })
        .execute();
      await db
        .insertInto('deployment_target_servers')
        .values({ target_id: target, server_id: host })
        .execute();
      await db
        .insertInto('service_environment_configs')
        .values([
          {
            id: directConfig,
            service_id: service,
            environment_id: environment,
            target_selection_json: JSON.stringify({ serverIds: [host], groupIds: [group] }),
            ...at,
          },
          {
            id: legacyConfig,
            service_id: otherService,
            environment_id: otherEnvironment,
            target_id: target,
            ...at,
          },
        ])
        .execute();
      const definition = (fixedHost?: string): GraphDefinition => ({
        flows: [
          {
            id: 'start',
            name: 'Start',
            serviceId: service,
            edges: [
              { from: 'start', to: 'check' },
              { from: 'check', to: 'end' },
            ],
            nodes: [
              {
                id: 'start',
                name: 'Start',
                type: 'START',
                inputs: [
                  { id: 'selected', name: 'Selected targets', type: 'TARGETS', required: false },
                ],
              },
              { id: 'check', name: 'Check', type: 'CHECK', shell: { serverId: fixedHost } },
              { id: 'end', name: 'End', type: 'END' },
            ],
          },
        ],
      });
      await db
        .insertInto('execution_graphs')
        .values({
          id: graph,
          project_id: project,
          revision: 3,
          published_version: 2,
          draft_json: JSON.stringify(definition(host)),
          ...at,
        })
        .execute();
      await db
        .insertInto('execution_graph_versions')
        .values([
          {
            id: oldVersion,
            graph_id: graph,
            version: 1,
            source_revision: 1,
            definition_json: JSON.stringify(definition(versionHost)),
            created_by: user,
            created_at: at.created_at,
          },
          {
            id: activeVersion,
            graph_id: graph,
            version: 2,
            source_revision: 2,
            definition_json: JSON.stringify(definition(host)),
            created_by: user,
            created_at: at.created_at,
          },
        ])
        .execute();
      await db
        .insertInto('execution_graph_triggers')
        .values({
          id: trigger,
          project_id: project,
          flow_id: 'start',
          version: 1,
          name: 'Bound trigger',
          kind: 'API',
          config_json: JSON.stringify({
            parameterMappings: { selected: { source: 'VALUE', value: { groupIds: [group] } } },
          }),
          enabled: 1,
          created_by: user,
          ...at,
        })
        .execute();
      await db
        .insertInto('execution_flow_runs')
        .values({
          id: run,
          graph_id: graph,
          project_id: project,
          version: 1,
          flow_id: 'start',
          flow_name: 'Start',
          created_by: user,
          idempotency_key: 'resource-inventory',
          request_hash: 'request',
          configuration_hash: 'config',
          status: 'SUCCESS',
          created_at: at.created_at,
          inputs_json: JSON.stringify({
            inputs: { groupIds: [group] },
            deliveries: { 'start:check': { nodeId: 'check', serverIds: [historyOnly] } },
          }),
        })
        .execute();

      const inventory = await projectResourceInventory(db, project);
      assert.deepEqual(
        new Set(inventory.servers.map((row) => row.id)),
        new Set([host, versionHost]),
      );
      const direct = inventory.servers
        .find((row) => row.id === host)!
        .references.filter((row) => row.sourceId === directConfig);
      assert.deepEqual(
        direct.map((row) => row.viaGroupId),
        [undefined, group],
      );
      assert.ok(
        inventory.references.some(
          (row) =>
            row.resourceId === versionHost &&
            row.sourceId === oldVersion &&
            row.state === 'RUNNABLE',
        ),
      );
      assert.ok(
        inventory.references.some(
          (row) => row.resourceId === group && row.triggerId === trigger && row.version === 1,
        ),
      );
      const frozen = inventory.references.filter(
        (row) => row.sourceId === run && row.resourceType === 'SERVER',
      );
      assert.deepEqual(
        frozen.map((row) => [row.resourceId, row.state]),
        [[historyOnly, 'HISTORY']],
      );
      assert.ok(!inventory.references.some((row) => row.sourceId === legacyConfig));
      const other = await projectResourceInventory(db, otherProject);
      assert.deepEqual(
        other.servers.map((row) => row.id),
        [host],
      );
      assert.equal(other.servers[0]!.references[0]!.viaTargetId, target);
      assert.equal(other.servers[0]!.references[0]!.viaTargetName, 'Other legacy target');
      assert.ok(!other.references.some((row) => row.sourceId === directConfig));

      await db
        .updateTable('execution_graph_triggers')
        .set({ enabled: 0 })
        .where('id', '=', trigger)
        .execute();
      await db
        .updateTable('execution_graph_versions')
        .set({ retired_at: 1100 })
        .where('id', '=', oldVersion)
        .execute();
      await db
        .updateTable('execution_flow_runs')
        .set({ status: 'WAITING' })
        .where('id', '=', run)
        .execute();
      const pending = await projectResourceReferences(db, project, {
        resourceType: 'SERVER',
        resourceId: versionHost,
        states: ['RUNNABLE', 'PENDING'],
      });
      assert.deepEqual(
        pending.map((row) => [row.sourceId, row.state]),
        [[run, 'PENDING']],
      );
      const afterRetirement = await projectResourceInventory(db, project);
      assert.deepEqual(
        afterRetirement.servers.map((row) => row.id),
        [host],
      );
      assert.ok(
        afterRetirement.references.some(
          (row) => row.resourceId === historyOnly && row.state === 'PENDING',
        ),
      );
      const historical = await projectResourceReferences(db, project, {
        resourceType: 'SERVER',
        resourceId: versionHost,
        states: ['HISTORY'],
      });
      assert.deepEqual(
        historical.map((row) => [row.sourceId, row.state]),
        [[oldVersion, 'HISTORY']],
      );
    },
  );
}
