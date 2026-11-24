import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

test('a work directory snapshot is filtered, immutable and usable by relative subpath', async () => {
  const root = await mkdtemp(join(tmpdir(), 'veyops-work-directory-'));
  process.env.DATA_DIR = root;
  process.env.ENCRYPTION_KEY = randomBytes(32).toString('hex');
  const { ArtifactPhysicalService } =
    await import('../modules/artifacts/artifact-physical.service.js');
  const { ProcessRunnerService } =
    await import('../infrastructure/build-runner/process-runner.service.js');
  const runner = new ProcessRunnerService();
  const service = new ArtifactPhysicalService(null!, null!, runner, null!, null!);
  try {
    const workspace = join(root, 'repo');
    const project = join(workspace, 'apps', 'api');
    for (const name of ['dist', 'reports', '.git', '.veyops', 'private']) {
      await mkdir(join(project, name), { recursive: true });
      await writeFile(join(project, name, 'fixture.txt'), name === 'dist' ? 'v1' : name);
    }
    await writeFile(join(project, '.env.test'), 'secret-fixture');
    await writeFile(join(workspace, 'README.md'), 'repository root');
    const collect = {
      workspace,
      workingDirectory: 'apps/api/',
      relativePath: '.',
      kind: 'DIRECTORY',
      collection: 'WORK_DIRECTORY',
      excludePaths: ['./private/'],
      instanceId: randomUUID(),
    } as const;
    const first = await service.collectBuilderPath(collect);
    assert.equal(first.collection, 'WORK_DIRECTORY');
    assert.equal((await service.verify(first)).status, 'AVAILABLE');
    await assert.rejects(service.verifyPathSelection(first), /填写 \. 使用整个目录/);
    await assert.rejects(service.verifyPathSelection(first, '../dist'), /相对路径/);
    for (const name of ['.git', '.veyops', '.env.test', 'private', 'never-built']) {
      await assert.rejects(service.verifyPathSelection(first, name), /找不到已选子路径/);
    }
    await writeFile(join(project, 'dist', 'fixture.txt'), 'v2');
    assert.deepEqual(await service.collectBuilderPath(collect), first);
    const next = await service.collectBuilderPath({ ...collect, instanceId: randomUUID() });
    assert.notEqual(next.sha256, first.sha256);
    const rootSnapshot = await service.collectBuilderPath({
      ...collect,
      workingDirectory: '.',
      instanceId: randomUUID(),
    });
    await service.verifyPathSelection(rootSnapshot, 'README.md');
    await assert.rejects(service.verifyPathSelection(first, 'README.md'), /找不到已选子路径/);

    const archive = join(root, 'picked.tar.gz');
    await service.stageBuilderArchive(first, archive, './dist/');
    const contents = await runner.run('tar', ['-xOf', archive, './fixture.txt'], { timeout: 15 });
    assert.equal(contents.exitCode, 0);
    assert.equal(contents.stdout, 'v1');
    await service.stageBuilderArchive(first, archive, 'reports/fixture.txt');
    const report = await runner.run('tar', ['-xOf', archive, './fixture.txt'], { timeout: 15 });
    assert.equal(report.stdout, 'reports');
    await assert.rejects(
      service.stageBuilderArchive({ ...first, sha256: '0'.repeat(64) }, archive, 'dist'),
      /已变化/,
    );
    await mkdir(join(root, 'outside'));
    await symlink(join(root, 'outside'), join(workspace, 'link'), 'junction');
    await assert.rejects(
      service.collectBuilderPath({
        ...collect,
        workingDirectory: 'link',
        instanceId: randomUUID(),
      }),
    );
    await assert.rejects(
      service.collectBuilderPath({
        ...collect,
        workingDirectory: 'not-there',
        instanceId: randomUUID(),
      }),
      /构建产物不存在/,
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
});
