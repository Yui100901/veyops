import 'reflect-metadata';
import assert from 'node:assert/strict';
import { execFile, spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { promisify } from 'node:util';
import test from 'node:test';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { GraphCanvas } from '../modules/execution-graphs/execution-graph-definition';

const exec = promisify(execFile);

test(
  'SQLite default FLOW_V2 builds a real Git commit and activates verified file content',
  { timeout: 60_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'veyops-simplified-run-'));
    const worktree = join(directory, 'source');
    const password = randomBytes(16).toString('hex');
    Object.assign(process.env, {
      DATABASE_CLIENT: 'sqlite',
      DATABASE_PATH: join(directory, 'test.db'),
      DATA_DIR: directory,
      ENCRYPTION_KEY: randomBytes(32).toString('hex'),
      ADMIN_PASSWORD: password,
      WORKER_ENABLED: 'false',
    });
    const git = createServer(async (req, res) => {
      try {
        const url = new URL(req.url!, 'http://localhost');
        assert.match(url.pathname, /^\/fixture\.git\/(info\/refs|git-upload-pack)$/);
        const requestBody: Buffer[] = [];
        for await (const data of req) requestBody.push(data as Buffer);
        const body = Buffer.concat(requestBody);
        const processGit = spawn('git', ['http-backend'], {
          env: {
            ...process.env,
            GIT_PROJECT_ROOT: directory,
            GIT_HTTP_EXPORT_ALL: '1',
            GIT_PROTOCOL: req.headers['git-protocol']?.toString() ?? '',
            PATH_INFO: url.pathname,
            REQUEST_METHOD: req.method,
            QUERY_STRING: url.search.slice(1),
            CONTENT_TYPE: req.headers['content-type'] ?? '',
            CONTENT_LENGTH: String(body.length),
          },
          windowsHide: true,
        });
        const responseBody: Buffer[] = [];
        processGit.stdout.on('data', (data: Buffer) => responseBody.push(data));
        processGit.stdin.on('error', () => {});
        processGit.stdin.end(body);
        await new Promise<void>((resolve, reject) => {
          processGit.on('error', reject);
          processGit.on('close', (code) =>
            code === 0 ? resolve() : reject(new Error('git http-backend failed')),
          );
        });
        const output = Buffer.concat(responseBody);
        const boundary = output.indexOf('\r\n\r\n');
        assert.ok(boundary >= 0, 'git http-backend returned CGI headers');
        for (const header of output.toString('utf8', 0, boundary).split('\r\n')) {
          const colon = header.indexOf(':');
          const name = header.slice(0, colon);
          const value = header.slice(colon + 1).trim();
          if (name === 'Status') res.statusCode = Number(value.slice(0, 3));
          else res.setHeader(name, value);
        }
        res.end(output.subarray(boundary + 4));
      } catch (error) {
        res.writeHead(500).end(String(error));
      }
    });
    let app: NestExpressApplication | undefined;
    try {
      await exec('git', ['init', '--initial-branch=main', worktree]);
      await writeFile(join(worktree, 'input.txt'), 'content from the confirmed Git commit\n');
      await writeFile(join(worktree, 'private.vars'), 'FLOW_PRIVATE=fixture-private-value\n');
      await writeFile(join(worktree, '.gitattributes'), '*.txt text eol=lf\n');
      await exec('git', ['-C', worktree, 'add', 'input.txt', 'private.vars', '.gitattributes']);
      await exec('git', [
        '-C',
        worktree,
        '-c',
        'user.name=Fixture',
        '-c',
        'user.email=fixture@example.test',
        'commit',
        '-m',
        'Fixture',
      ]);
      const sha = (await exec('git', ['-C', worktree, 'rev-parse', 'HEAD'])).stdout.trim();
      await exec('git', ['clone', '--bare', worktree, join(directory, 'fixture.git')]);
      await new Promise<void>((resolve, reject) => {
        git.once('error', reject);
        git.listen(0, '127.0.0.1', resolve);
      });
      const address = git.address();
      assert.ok(address && typeof address !== 'string');
      const cloneUrl = `http://127.0.0.1:${address.port}/fixture.git`;

      const { AppModule } = await import('../app.module.js');
      const { configureApp } = await import('../bootstrap.js');
      const { BuildsService } = await import('../modules/builds/builds.service.js');
      const { SshService } = await import('../infrastructure/ssh/ssh.service.js');
      const { TaskWorkerService } = await import('../modules/tasks/task-worker.service.js');
      const releases = new Map<string, string>();
      const deployedContent: string[] = [];
      let probeCount = 0;
      app = (
        await Test.createTestingModule({ imports: [AppModule] })
          .overrideProvider(SshService)
          .useValue({
            execute: async (
              _target: unknown,
              command: string,
              options?: {
                onData?: (text: string, stream: 'stdout') => void;
              },
            ) => {
              const activate = /ln -s '([^']+)' '[^']+'; mv -Tf -- '[^']+' '([^']+)'/.exec(command);
              if (activate) releases.set(activate[2]!, activate[1]!);
              if (command.includes('fixture-health-probe')) probeCount++;
              const readlink = /^readlink -- '([^']+)'$/.exec(command);
              if (readlink) {
                const target = releases.get(readlink[1]!);
                if (target) options?.onData?.(target + '\n', 'stdout');
                return { exitCode: target ? 0 : 1 };
              }
              return { exitCode: 0 };
            },
            upload: async (_target: unknown, archive: string) => {
              const { stdout } = await exec('tar', ['-xOzf', archive, './built.txt']);
              deployedContent.push(stdout);
            },
          })
          .compile()
      ).createNestApplication<NestExpressApplication>({ logger: false });
      configureApp(app);
      await app.init();

      // Run the declared script in the real checkout while replacing the Docker boundary.
      const shell =
        process.platform === 'win32'
          ? join(
              (await exec('git', ['--exec-path'])).stdout.trim(),
              '..',
              '..',
              '..',
              'usr',
              'bin',
              'sh.exe',
            )
          : '/bin/sh';
      const builds = app.get(BuildsService);
      builds.managerFlowCommand = async (
        { context },
        workspace,
        command,
        subdirectory,
        variables,
      ) => {
        const env = { ...process.env, ...variables };
        const pathKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';
        env[pathKey] = dirname(shell) + delimiter + (env[pathKey] ?? '');
        const result = await exec(shell, ['-eu', '-c', command], {
          cwd: join(workspace, subdirectory),
          env,
        });
        if (result.stdout) context.log(result.stdout);
        if (result.stderr) context.log(result.stderr);
        return { ...result, exitCode: 0 };
      };

      const root = '/api/v1';
      const api = request.agent(app.getHttpServer());
      await api
        .post(root + '/auth/login')
        .send({ username: 'root', password })
        .expect(201);
      const create = async (path: string, body: object) => {
        const response = await api.post(path).send(body);
        assert.equal(response.status, 201, JSON.stringify(response.body));
        return response.body.data;
      };
      const project = await create(root + '/projects', { name: 'Fixture', slug: 'fixture' });
      const projectPath = root + '/projects/' + project.id;
      const graphPath = projectPath + '/execution-graph';
      const repo = await create(projectPath + '/repositories', { name: 'Fixture', cloneUrl });
      const service = await create(projectPath + '/services', { name: 'Fixture', slug: 'fixture' });
      const credential = await create(root + '/credentials', {
        name: 'Fixture SSH',
        type: 'SSH_PASSWORD',
        secret: { password: 'fixture' },
      });
      const server = await create(root + '/servers', {
        name: 'Fixture SSH',
        host: '127.0.0.1',
        port: 22,
        username: 'fixture',
        credentialId: credential.id,
        hostKeyFingerprint: 'a'.repeat(64),
      });

      const graph = (await api.get(graphPath).expect(200)).body.data;
      const canvas: GraphCanvas = graph.draft.canvas;
      assert.equal(canvas.model, 'FLOW_V2');
      const start = canvas.nodes[0]!;
      start.start = {
        ...start.start,
        sources: [
          { id: 'repo', repositoryId: repo.id, ref: { kind: 'BRANCH', value: 'main' } },
          {
            id: 'alternate',
            repositoryId: repo.id,
            ref: { kind: 'BRANCH', value: 'main' },
            parentDirectory: 'alternate',
          },
        ],
        execution: { location: 'MANAGER' },
        release: {
          serviceId: service.id,
          targets: { serverIds: [server.id] },
          deployPath: '/srv/fixture-flow',
          contentPath: 'fixture/dist',
        },
        variables: [{ key: 'FIXTURE_VALUE', value: 'configured' }],
        dotenv: { sourceId: 'alternate', path: 'private.vars' },
      };
      canvas.nodes[2]!.build = {
        repoPath: 'fixture',
        buildCommand:
          'test -n "$FLOW_PRIVATE"; mkdir dist; cat input.txt > dist/built.txt; printf "%s\\n" "$FIXTURE_VALUE" >> dist/built.txt; echo built-fixture',
      };
      const publish = async (definition: GraphCanvas) => {
        const { revision } = (await api.get(graphPath).expect(200)).body.data;
        const saved = await api
          .put(graphPath + '/draft')
          .send({ expectedRevision: revision, definition: { canvas: definition } })
          .expect(200);
        return (
          await create(graphPath + '/publish', {
            expectedRevision: saved.body.data.revision,
          })
        ).publishedVersion as number;
      };
      const flow = graphPath + '/flows/' + start.id;
      const version = await publish(canvas);
      const preview = await create(flow + '/preview', { version });
      assert.ok(JSON.stringify(preview).includes(sha), 'preview pins the actual Git SHA');
      const worker = app.get(TaskWorkerService);
      const waitRun = async (id: string, expected: string) => {
        const deadline = Date.now() + 25_000;
        while (Date.now() < deadline) {
          await worker.tick();
          const run = (await api.get(graphPath + '/runs/' + id).expect(200)).body.data as {
            id: string;
            status: string;
            artifactIds: string[];
            nodes: { nodeId: string; status: string; output?: unknown }[];
          };
          if (run.status === expected) return run;
          if (['SUCCESS', 'FAILED', 'NEEDS_ATTENTION', 'CANCELLED'].includes(run.status)) {
            const failed = run.nodes.find(({ status }) =>
              ['FAILED', 'NEEDS_ATTENTION'].includes(status),
            );
            const logs =
              failed &&
              (await api.get(graphPath + `/runs/${run.id}/nodes/${failed.nodeId}/logs`).expect(200))
                .body.data;
            assert.fail(JSON.stringify({ status: run.status, nodes: run.nodes, logs }));
          }
          await delay(100);
        }
        assert.fail('Execution flow did not reach ' + expected);
      };
      const runVersion = async (
        version: number,
        configurationHash: string,
        expected = 'SUCCESS',
      ) => {
        const { id } = await create(flow + '/run', {
          version,
          expectedConfigurationHash: configurationHash,
          idempotencyKey: randomUUID(),
        });
        return waitRun(id, expected);
      };
      const run = await runVersion(version, preview.configurationHash);
      assert.equal(run.nodes.filter(({ status }) => status === 'SUCCESS').length, 5);
      assert.ok(
        JSON.stringify(
          run.nodes.find(({ nodeId }) => nodeId === canvas.nodes[1]!.id)?.output,
        ).includes(sha),
      );
      assert.deepEqual(deployedContent, ['content from the confirmed Git commit\nconfigured\n']);
      assert.ok(releases.has('/srv/fixture-flow/current'));
      const log = await api
        .get(graphPath + `/runs/${run.id}/nodes/${canvas.nodes[2]!.id}/logs`)
        .expect(200);
      assert.ok(JSON.stringify(log.body.data).includes('built-fixture'));
      const artifacts = (
        await api
          .get(root + '/artifacts')
          .query({ projectId: project.id })
          .expect(200)
      ).body.data;
      assert.equal(artifacts.length, 1);
      assert.equal(artifacts[0].graphRunId, run.id);
      const snapshotPath = artifacts[0].physical.path as string;
      const entries = await exec('tar', ['-tzf', artifacts[0].storageKey]);
      assert.ok(snapshotPath && entries.stdout.includes('alternate/fixture/input.txt'));
      assert.ok(!entries.stdout.includes('private.vars'));

      const current = releases.get('/srv/fixture-flow/current');
      const failing = structuredClone(canvas);
      failing.nodes[2]!.build!.buildCommand = 'exit 23';
      const failingVersion = await publish(failing);
      const failingPreview = await create(flow + '/preview', { version: failingVersion });
      const failed = await runVersion(failingVersion, failingPreview.configurationHash, 'FAILED');
      assert.equal(
        failed.nodes.find(({ nodeId }) => nodeId === canvas.nodes[3]!.id)?.status,
        'SKIPPED',
      );
      assert.deepEqual(failed.artifactIds, []);
      assert.equal(releases.get('/srv/fixture-flow/current'), current);

      const replay = structuredClone(canvas);
      const releaseStart = replay.nodes[0]!;
      releaseStart.start!.sources = [];
      delete releaseStart.start!.dotenv;
      releaseStart.start!.release!.artifactId = artifacts[0].id;
      const deploy = replay.nodes[3]!;
      const end = replay.nodes[4]!;
      end.finish = { requireRelease: 'ACTIVATED' };
      replay.nodes = [releaseStart, deploy, end];
      replay.edges = [
        { from: releaseStart.id, to: deploy.id },
        { from: deploy.id, to: end.id },
      ];
      const replayVersion = await publish(replay);
      const replayPreview = await create(flow + '/preview', { version: replayVersion });
      const replayed = await runVersion(replayVersion, replayPreview.configurationHash);
      assert.deepEqual(replayed.artifactIds, [artifacts[0].id]);
      assert.deepEqual(
        deployedContent,
        Array<string>(2).fill('content from the confirmed Git commit\nconfigured\n'),
      );
      assert.notEqual(releases.get('/srv/fixture-flow/current'), current);

      const approvalTemplate: GraphCanvas = (
        await create(graphPath + '/draft/templates/expand', {
          templateId: 'CD_DEPLOY',
        })
      ).canvas;
      const approvalStart = approvalTemplate.nodes.find(({ type }) => type === 'START')!;
      approvalStart.start = { ...releaseStart.start };
      const approval = approvalTemplate.nodes.find(({ operation }) => operation === 'APPROVAL')!;
      const health = approvalTemplate.nodes.find(({ operation }) => operation === 'HEALTH_CHECK')!;
      health.healthCheck!.command = 'echo fixture-health-probe';
      const approvalVersion = await publish(approvalTemplate);
      const approvalFlow = graphPath + '/flows/' + approvalStart.id;
      const approvalPreview = await create(approvalFlow + '/preview', { version: approvalVersion });
      const approvalRun = await create(approvalFlow + '/run', {
        version: approvalVersion,
        expectedConfigurationHash: approvalPreview.configurationHash,
        idempotencyKey: randomUUID(),
      });
      const approvalPath = graphPath + '/runs/' + approvalRun.id;
      const waiting = (await api.get(approvalPath).expect(200)).body.data;
      const gate = waiting.nodes.find(({ nodeId }: { nodeId: string }) => nodeId === approval.id);
      assert.equal(gate.status, 'WAITING', JSON.stringify(waiting));
      assert.equal(deployedContent.length, 2);
      assert.ok(gate.output.scopeHash);
      await create(approvalPath + '/nodes/' + approval.id + '/decision', {
        decision: 'APPROVE',
        expectedScopeHash: gate.output.scopeHash,
      });
      const healthy = await waitRun(approvalRun.id, 'SUCCESS');
      assert.equal(healthy.nodes.find(({ nodeId }) => nodeId === health.id)?.status, 'SUCCESS');
      assert.equal(deployedContent.length, 3);
      assert.equal(probeCount, 1);
      assert.equal(
        await readFile(join(worktree, 'input.txt'), 'utf8'),
        'content from the confirmed Git commit\n',
      );
    } finally {
      await app?.close();
      if (git.listening) await new Promise<void>((resolve) => git.close(() => resolve()));
      await rm(directory, { recursive: true, force: true });
    }
  },
);
