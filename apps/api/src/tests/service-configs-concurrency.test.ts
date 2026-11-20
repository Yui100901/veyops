import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { ConflictException } from '@nestjs/common';
import { sql } from 'kysely';
import { DatabaseService } from '../core/database/database.service';
import { SystemSettingsService } from '../modules/system/system-settings.service';
import { AuditService } from '../modules/audit/audit.service';
import { CredentialsService } from '../modules/credentials/credentials.service';
import { DeploymentTargetsService } from '../modules/deployment-targets/deployment-targets.service';
import type { ServersService } from '../modules/servers/servers.service';
import { ServiceConfigsService } from '../modules/service-configs/service-configs.service';
import { createPostgresTestDatabase, postgresTestUrl } from './helpers/isolated-postgres';

function assertOneReplacement(rows: unknown[], left: unknown, right: unknown) {
  assert.equal(rows.length, 1);
  assert.ok(
    JSON.stringify(rows[0]) === JSON.stringify(left) ||
      JSON.stringify(rows[0]) === JSON.stringify(right),
    'the stored set must contain exactly one submitted replacement',
  );
}

for (const client of ['sqlite', 'postgres'] as const) {
  test(
    `service configuration upserts and whole-set replacements are atomic (${client})`,
    {
      skip: client === 'postgres' && !postgresTestUrl ? 'VEYOPS_TEST_POSTGRES_URL is unset' : false,
    },
    async (t) => {
      const previousKey = process.env.ENCRYPTION_KEY;
      process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
      t.after(() => {
        if (previousKey === undefined) delete process.env.ENCRYPTION_KEY;
        else process.env.ENCRYPTION_KEY = previousKey;
      });
      let database: DatabaseService;
      if (client === 'postgres') {
        database = await createPostgresTestDatabase(t);
      } else {
        process.env.DATABASE_CLIENT = 'sqlite';
        process.env.DATABASE_PATH = ':memory:';
        database = new DatabaseService();
        t.after(() => database.onApplicationShutdown());
        await database.onModuleInit();
      }
      const { db } = database;
      const now = Date.now();
      const timestamps = { created_at: now, updated_at: now };
      const user = randomUUID();
      const project = randomUUID();
      const service = randomUUID();
      const environment = randomUUID();
      const target = randomUUID();
      const leftRepo = randomUUID();
      const rightRepo = randomUUID();
      await db
        .insertInto('users')
        .values({
          id: user,
          username: 'fixture',
          password_hash: 'unused',
          ...timestamps,
        })
        .execute();
      await db
        .insertInto('projects')
        .values({
          id: project,
          slug: 'test',
          name: 'Fixture',
          created_by: user,
          ...timestamps,
        })
        .execute();
      await db
        .insertInto('services')
        .values({
          id: service,
          project_id: project,
          slug: 'service',
          name: 'Service',
          ...timestamps,
        })
        .execute();
      await db
        .insertInto('environments')
        .values({
          id: environment,
          project_id: project,
          slug: 'env',
          name: 'Environment',
          ...timestamps,
        })
        .execute();
      await db
        .insertInto('deployment_targets')
        .values({
          id: target,
          name: 'Target',
          ...timestamps,
        })
        .execute();
      await db
        .insertInto('repositories')
        .values(
          [leftRepo, rightRepo].map((id) => ({
            id,
            project_id: project,
            name: id,
            clone_url: 'https://example.invalid/repo.git',
            ...timestamps,
          })),
        )
        .execute();
      if (client === 'postgres') {
        // Give competing transactions time to reach their first write while inserts are pending.
        // In a regression, both DELETEs can see an empty set and then both INSERTs can commit.
        await sql`create function delay_fixture_insert() returns trigger language plpgsql
          as $$ begin perform pg_sleep(0.20); return new; end $$`.execute(db);
        await sql`create trigger delay_config before insert on service_environment_configs
          for each row execute function delay_fixture_insert()`.execute(db);
        await sql`create trigger delay_env before insert on environment_variables
          for each row execute function delay_fixture_insert()`.execute(db);
        await sql`create trigger delay_service_env before insert on service_environment_variables
          for each row execute function delay_fixture_insert()`.execute(db);
        await sql`create trigger delay_links before insert on service_repositories
          for each row execute function delay_fixture_insert()`.execute(db);
      }

      const audit = new AuditService(database);
      const settings = new SystemSettingsService(database, audit);
      const targets = new DeploymentTargetsService(database, {} as ServersService, audit, settings);
      const credentials = new CredentialsService(database, audit);
      const configs = new ServiceConfigsService(database, targets, audit, settings, credentials);
      const base = {
        targetId: target,
        buildLocation: 'TARGET' as const,
        artifactType: 'FILE',
        deployMethod: 'FILE',
        deployPath: '/srv/fixture',
        buildCommand: '',
        workingDirectory: '',
        outputPath: '',
        composeFilePath: '',
        startCommand: '',
        healthCheckCommand: '',
      };
      const [left, right] = await Promise.all([
        configs.save(service, environment, { ...base, outputPath: 'left' }, user),
        configs.save(service, environment, { ...base, outputPath: 'right' }, user),
      ]);
      assert.equal(left.id, right.id);
      assert.equal(left.outputPath, 'left');
      assert.equal(right.outputPath, 'right');

      const leftVariable = { key: 'LEFT', value: 'one' };
      const rightVariable = { key: 'RIGHT', value: 'two' };
      const scopes = [
        {
          read: () => configs.listProjectVariables(project),
          save: (expectedRevision: string, variables: typeof leftVariable[]) =>
            configs.saveProjectVariables(project, { expectedRevision, variables }, user),
        },
        ...[undefined, service].map((serviceId) => ({
          read: () => configs.listVariables(environment, serviceId),
          save: (expectedRevision: string, variables: typeof leftVariable[]) =>
            configs.saveVariables(environment, { expectedRevision, variables }, user, serviceId),
        })),
      ];
      for (const scope of scopes) {
        const { revision } = await scope.read();
        const results = await Promise.allSettled([
          scope.save(revision, [leftVariable]),
          scope.save(revision, [rightVariable]),
        ]);
        const conflicts = results.filter((result) => result.status === 'rejected');
        assert.equal(conflicts.length, 1);
        assert.ok(conflicts[0]!.reason instanceof ConflictException);
        const current = await scope.read();
        assert.notEqual(current.revision, revision);
        assertOneReplacement(
          current.variables.map(({ key, value, isSecret }) => ({
            key,
            value,
            isSecret,
          })),
          { ...leftVariable, isSecret: false },
          { ...rightVariable, isSecret: false },
        );
      }
      const leftLink = { repositoryId: leftRepo, repoPath: '.', isPrimary: true };
      const rightLink = { repositoryId: rightRepo, repoPath: '.', isPrimary: true };
      await Promise.all([
        configs.saveLinks(service, { repositories: [leftLink] }, user),
        configs.saveLinks(service, { repositories: [rightLink] }, user),
      ]);
      assertOneReplacement(await configs.links(service), leftLink, rightLink);
    },
  );
}
