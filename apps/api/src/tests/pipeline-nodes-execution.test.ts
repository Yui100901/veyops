import 'reflect-metadata';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import type { ProcessRunnerService } from '../infrastructure/build-runner/process-runner.service';
import type { SshService, SshTarget } from '../infrastructure/ssh/ssh.service';
import { BuildsService, checkoutScript, type BuildSession } from '../modules/builds/builds.service';
import type { CredentialsService } from '../modules/credentials/credentials.service';
import { PipelineDefinitionDto } from '../modules/pipelines/pipeline.dto';
import type { PipelineNode, PipelineSnapshot } from '../modules/pipelines/pipeline.types';
import type { RegistriesService } from '../modules/registries/registries.service';

const run = promisify(execFile);
const gitBash = join(process.env.ProgramFiles ?? 'C:\\Program Files', 'Git', 'bin', 'bash.exe');
const shell =
  process.platform === 'win32' && existsSync(gitBash)
    ? gitBash
    : process.platform === 'linux'
      ? '/bin/sh'
      : undefined;

async function fixtureRepo(path: string, files: Record<string, string>) {
  await mkdir(path);
  const git = (...args: string[]) => run('git', ['-C', path, ...args]);
  await git('init', '-q');
  await git('config', 'user.name', 'Pipeline fixture');
  await git('config', 'user.email', 'pipeline@example.test');
  await git('config', 'core.autocrlf', 'false');
  for (const [name, value] of Object.entries(files)) await writeFile(join(path, name), value);
  await git('add', '.');
  await git('commit', '-qm', 'source');
  const old = (await git('rev-parse', 'HEAD')).stdout.trim();
  await git('commit', '--allow-empty', '-qm', 'remote progressed');
  return { url: pathToFileURL(path).href, credentialId: null, commitSha: old };
}

test(
  'ordered target nodes shallow-checkout pinned sources and pass scoped environment without evaluating dotenv',
  {
    skip: !shell && 'requires a POSIX shell with Git',
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'veyops-node-execution-'));
    const work = join(root, 'work').replaceAll('\\', '/');
    const logs: string[] = [];
    const optionsUsed: (string[] | undefined)[] = [];
    const ssh = {
      execute: async (_target, script, options) => {
        optionsUsed.push(options.secrets);
        try {
          const { stdout, stderr } = await run(shell!, ['-eu', '-c', script]);
          options.onData?.(stdout, 'stdout');
          options.onData?.(stderr, 'stderr');
          return { exitCode: 0 };
        } catch (error) {
          options.onData?.((error as { stderr?: string }).stderr ?? '', 'stderr');
          return { exitCode: Number((error as { code?: number }).code) || 1 };
        }
      },
      uploadContent: async (_target, content, path) => writeFile(path, content),
      download: async (_target, remotePath, localPath) => copyFile(remotePath, localPath),
    } satisfies Pick<SshService, 'execute' | 'uploadContent' | 'download'>;
    const builds = new BuildsService(
      ssh as unknown as SshService,
      {} as ProcessRunnerService,
      { decrypt: async () => ({ value: 'injected-credential' }) } as unknown as CredentialsService,
      {} as RegistriesService,
    );
    try {
      const primary = await fixtureRepo(join(root, 'primary'), {
        '.env.test':
          "DEPLOY_GROUP=dotenv-test\nLEVEL=file\nLITERAL='$(printf unsafe)'\nSECRET=stale\nVEYOPS_PROJECT_NAME=from-file\n",
      });
      const legacyWork = join(root, 'legacy').replaceAll('\\', '/');
      await mkdir(legacyWork);
      await run(shell!, ['-eu', '-c', checkoutScript(primary.url, primary.commitSha, legacyWork)]);
      const legacyGit = (...args: string[]) =>
        run('git', ['-C', join(legacyWork, 'repo'), ...args]);
      assert.equal((await legacyGit('rev-parse', 'HEAD')).stdout.trim(), primary.commitSha);
      assert.equal((await legacyGit('rev-list', '--count', 'HEAD')).stdout.trim(), '1');
      assert.equal((await legacyGit('rev-parse', '--is-shallow-repository')).stdout.trim(), 'true');
      const extra = await fixtureRepo(join(root, 'extra'), { 'support.txt': 'from-second-repo' });
      await mkdir(work);
      const repositoryId = randomUUID();
      const nodes: PipelineNode[] = [
        { id: 'root', name: 'root', type: 'CHECKOUT', repositoryId },
        {
          id: 'extra',
          name: 'extra',
          type: 'CHECKOUT',
          repositoryId: randomUUID(),
          directory: 'packages/support',
        },
        {
          id: 'env',
          name: 'env',
          type: 'ENVIRONMENT',
          envFile: '.env.test',
          variables: [
            { key: 'LEVEL', value: 'node' },
            { key: 'SECRET', credentialId: randomUUID() },
          ],
        },
        {
          id: 'dependency',
          name: 'dependency',
          type: 'INSTALL',
          directory: 'packages/support',
          command: 'test -f support.txt; test "$SECRET" = injected-credential',
        },
        {
          id: 'build',
          name: 'build',
          type: 'BUILD',
          command: `test "$LITERAL" = '$(printf unsafe)'; test "$VEYOPS_PROJECT_NAME" = 'demo project'; test "$VEYOPS_SERVICE_NAME" = service; printf '%s' "$DEPLOY_GROUP/$LEVEL" > built.txt`,
        },
        { id: 'fail', name: 'fail', type: 'TEST', command: 'exit 5' },
        { id: 'skip', name: 'skip', type: 'SHELL', command: 'touch unexpected.txt' },
        { id: 'package', name: 'package', type: 'PACKAGE' },
      ];
      const snapshot: PipelineSnapshot = {
        runId: randomUUID(),
        pipelineId: randomUUID(),
        pipelineVersionId: randomUUID(),
        projectId: randomUUID(),
        environmentId: randomUUID(),
        serviceId: randomUUID(),
        projectName: 'demo project',
        serviceName: 'service',
        commitSha: primary.commitSha,
        repository: primary,
        definition: { ...new PipelineDefinitionDto(), repositoryId, nodes },
        nodeSources: { root: primary, extra },
        variables: { DEPLOY_GROUP: 'platform' },
        secretVariables: {},
      };
      const resolved = await builds.resolveVariables(snapshot);
      assert.equal(resolved.values.VEYOPS_PROJECT_ID, snapshot.projectId);
      assert.equal(resolved.values.VEYOPS_SERVICE_ID, snapshot.serviceId);
      const session: BuildSession = {
        snapshot,
        taskId: randomUUID(),
        context: {
          signal: new AbortController().signal,
          log: (line) => logs.push(line),
          startTarget: async () => 'fixture-target',
          finishTarget: async () => undefined,
          startStep: async () => 'fixture-step',
          finishStep: async () => undefined,
        },
        variables: resolved.values,
        secrets: resolved.secrets,
      };
      const started: string[] = [];
      await assert.rejects(
        builds.remoteNodes(
          { id: randomUUID() } as SshTarget,
          work,
          session,
          async (node, action) => {
            started.push(node.id);
            return action();
          },
        ),
        { exitCode: 5 },
      );
      assert.deepEqual(started, ['root', 'extra', 'env', 'dependency', 'build', 'fail']);
      assert.equal(await readFile(join(work, 'repo', 'built.txt'), 'utf8'), 'platform/node');
      assert.equal(existsSync(join(work, 'repo', 'unexpected.txt')), false);
      for (const [path, source] of [
        ['repo', primary],
        ['repo/packages/support', extra],
      ] as const) {
        const git = (...args: string[]) => run('git', ['-C', join(work, path), ...args]);
        assert.equal((await git('rev-parse', 'HEAD')).stdout.trim(), source.commitSha);
        assert.equal((await git('rev-list', '--count', 'HEAD')).stdout.trim(), '1');
        assert.equal((await git('rev-parse', '--is-shallow-repository')).stdout.trim(), 'true');
      }
      assert.equal(Object.hasOwn(session.variables, 'SECRET'), false);
      assert.deepEqual(session.secrets, []);
      assert.ok(
        optionsUsed.some(
          (values) =>
            values?.includes('injected-credential') && values.includes('$(printf unsafe)'),
        ),
      );
      assert.ok(!logs.join('').includes('injected-credential'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
