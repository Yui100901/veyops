import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { createHash, createHmac } from 'node:crypto';
import {
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path';
import { dataDirectory, encryptionKey } from '../../core/config';
import { ProcessRunnerService } from '../../infrastructure/build-runner/process-runner.service';
import { SshService, type SshTarget } from '../../infrastructure/ssh/ssh.service';
import { CredentialsService } from '../credentials/credentials.service';
import { relativePath, shellQuote as q } from '../pipelines/pipeline.validation';
import { checkRegistryManifest } from '../registries/registry-connection';
import { RegistriesService } from '../registries/registries.service';
import { ServersService } from '../servers/servers.service';
import {
  artifactPathDigest,
  InvalidArtifactObject,
  linuxArtifactDigest,
  type ArtifactDigest,
  type PathArtifactKind,
} from './artifact-physical-paths';

export interface ArtifactPhysical {
  kind: PathArtifactKind | 'DOCKER_IMAGE';
  location: 'SERVER_PATH' | 'BUILDER_PATH' | 'DOCKER_ENGINE' | 'REGISTRY';
  owner: 'MANAGED' | 'EXTERNAL';
  serverId?: string;
  hostKeyFingerprint?: string;
  builderId?: string;
  path?: string;
  fileName?: string;
  sha256?: string;
  sizeBytes?: number;
  imageId?: string;
  platform?: string;
  engineId?: string;
  imageReference?: string;
  registryId?: string;
  digest?: string;
  ownerToken?: string;
}
export type ArtifactVerification = {
  status: 'AVAILABLE' | 'MISSING' | 'CHANGED' | 'UNVERIFIABLE';
  reason?: string;
};
export type ArtifactRemoval = { status: 'DELETED' | 'RETAINED' | 'RETRY'; reason?: string };

interface CollectPathInput {
  workspace: string;
  relativePath: string;
  kind: PathArtifactKind;
  instanceId: string;
  signal?: AbortSignal;
}

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
const sha256 = /^[a-f0-9]{64}$/;
const imageDigest = /^sha256:[a-f0-9]{64}$/;
const imagePlatform = /^[a-z0-9]+\/[a-z0-9]+$/;
const engineIdentity = /^[A-Za-z0-9:_-]{1,180}$/;
const imageReference = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,511}$/;
export function isDockerImageReference(value: string) {
  return imageReference.test(value);
}
const managedTag =
  /^veyops-build\/[a-f0-9-]{36}(?:\/[a-f0-9-]{36})?:[a-f0-9]{40,64}-[a-f0-9-]{36}$/;
const fingerprintChanged = '服务器 SSH 指纹与登记时不同';
const reasons: Record<Exclude<ArtifactVerification['status'], 'AVAILABLE'>, string> = {
  MISSING: '已确认产物实物不存在',
  CHANGED: '产物类型、摘要或实际位置已变化',
  UNVERIFIABLE: '无法核对产物，请检查执行端连通性、凭据、权限和所需工具',
};

function outcome(status: ArtifactVerification['status'], reason?: string): ArtifactVerification {
  return { status, ...(status !== 'AVAILABLE' && { reason: reason ?? reasons[status] }) };
}

export function physicalKey(physical: ArtifactPhysical) {
  return createHash('sha256')
    .update(
      JSON.stringify([
        physical.location,
        physical.location === 'REGISTRY'
          ? [physical.registryId, physical.imageReference, physical.digest]
          : [
              physical.serverId ?? physical.builderId,
              physical.location === 'DOCKER_ENGINE'
                ? [physical.engineId, physical.imageId]
                : physical.path,
            ],
      ]),
    )
    .digest('hex');
}

function token(scope: string, instanceId: string) {
  return createHmac('sha256', encryptionKey())
    .update(JSON.stringify(['managed-artifact-v1', scope, instanceId]))
    .digest('hex');
}

function parseDigest(value: string): ArtifactDigest {
  const match = /^([a-f0-9]{64}):([0-9]+)$/.exec(value.trim());
  const sizeBytes = Number(match?.[2]);
  if (!match || !Number.isSafeInteger(sizeBytes)) throw new Error('无法读取产物校验结果');
  return { sha256: match[1]!, sizeBytes };
}

function containedPath(root: string, path: string) {
  const child = relative(root, path);
  return Boolean(child && !isAbsolute(child) && child !== '..' && !child.startsWith('..' + sep));
}

function remotePath(path: string) {
  return posix.isAbsolute(path) && posix.normalize(path) === path && !/[\x00-\x1f\x7f]/.test(path);
}

function hasErrno(error: unknown, ...codes: string[]) {
  return error instanceof Error && codes.includes((error as NodeJS.ErrnoException).code ?? '');
}

function ensureCollection(input: CollectPathInput) {
  if (!uuid.test(input.instanceId) || !['FILE', 'DIRECTORY'].includes(input.kind))
    throw new BadRequestException('登记实例或实物类型无效');
  return relativePath(input.relativePath);
}

const remoteArtifactRoot = String.raw`
home=$(realpath -e -- "$HOME")
root="$home/.veyops/artifacts"
if [[ -L "$home/.veyops" || -L "$root" ]]; then exit 45; fi
`;

const remoteSlotCheck = String.raw`
if [[ -L "$slot" || -L "$slot/.owner" || -L "$slot/payload" ]]; then exit 45; fi
if [[ ! -e "$root" ]]; then exit 44; fi
[[ -r "$root" && -x "$root" ]] || exit 1
if [[ ! -e "$slot" ]]; then exit 44; fi
[[ -d "$slot" && -r "$slot" && -x "$slot" ]] || exit 1
[[ "$(realpath -e -- "$slot")" == "$slot" ]] || exit 45
[[ -f "$slot/.owner" ]] || exit 45
[[ "$(cat -- "$slot/.owner")" == "$owner" ]] || exit 45
if [[ ! -e "$slot/payload" ]]; then exit 44; fi
`;

@Injectable()
export class ArtifactPhysicalService {
  constructor(
    private readonly ssh: SshService,
    private readonly servers: ServersService,
    private readonly process: ProcessRunnerService,
    private readonly credentials: CredentialsService,
    private readonly registries: RegistriesService,
  ) {}

  private async server(target: SshTarget, script: string, signal?: AbortSignal, timeout = 180) {
    let stdout = '';
    let stderr = '';
    const { exitCode } = await this.ssh.execute(
      target,
      'bash -c ' + q('set -euo pipefail\n' + script),
      {
        timeout,
        signal,
        onData: (text, stream) => {
          if (stream === 'stdout') stdout += text;
          else stderr += text;
        },
      },
    );
    return { exitCode, stdout, stderr };
  }

  async collectServerPath(
    input: CollectPathInput & { target: SshTarget },
  ): Promise<ArtifactPhysical> {
    const declared = ensureCollection(input);
    if (!remotePath(input.workspace) || !input.target.hostKeyFingerprint)
      throw new BadRequestException('目标端登记需要规范工作区和已确认 SSH 指纹');
    const ownerToken = token(input.target.id, input.instanceId);
    const receipt = await this.server(
      input.target,
      [
        'umask 077',
        remoteArtifactRoot,
        linuxArtifactDigest,
        'instance=' + q(input.instanceId),
        'owner=' + q(ownerToken),
        'kind=' + q(input.kind),
        'workspace=' + q(input.workspace),
        'declared=' + q(declared),
        String.raw`
mkdir -p -- "$root"
[[ "$(realpath -e -- "$root")" == "$root" ]]
slot="$root/$instance"
lock="$root/.lock-$instance"
[[ ! -L "$lock" ]]
exec 9>>"$lock"
flock -x 9
if [[ -e "$slot" || -L "$slot" ]]; then
  ${remoteSlotCheck}
  [[ -f "$slot/.digest" && ! -L "$slot/.digest" ]] || exit 45
  measured=$(artifact_digest "$kind" "$slot/payload")
  [[ "$(cat -- "$slot/.digest")" == "$measured" ]] || exit 45
else
  [[ -d "$workspace" && "$(realpath -e -- "$workspace")" == "$workspace" ]]
  requested="$workspace/$declared"
  if [[ ! -e "$requested" && ! -L "$requested" ]]; then exit 44; fi
  source=$(realpath -e -- "$requested")
  case "$source" in "$workspace"/*) ;; *) exit 45 ;; esac
  [[ ! -L "$requested" ]]
  original=$(artifact_digest "$kind" "$source")
  stage="$root/.staging-$instance"
  [[ ! -L "$stage" ]]
  if [[ -e "$stage" ]]; then
    [[ -d "$stage" && "$(realpath -e -- "$stage")" == "$stage" ]] || exit 45
    if [[ -f "$stage/.owner" && ! -L "$stage/.owner" && "$(cat -- "$stage/.owner")" == "$owner" ]]; then
      rm -rf -- "$stage"
    else
      rmdir -- "$stage" || exit 45
    fi
  fi
  mkdir -- "$stage"
  printf '%s' "$owner" > "$stage/.owner"
  cp -a -- "$source" "$stage/payload"
  measured=$(artifact_digest "$kind" "$stage/payload")
  [[ "$measured" == "$original" ]] || exit 45
  printf '%s' "$measured" > "$stage/.digest"
  mv -T -- "$stage" "$slot"
fi
printf '%s\n%s\n' "$slot/payload" "$measured"
`,
      ].join('\n'),
      input.signal,
    );
    if (receipt.exitCode === 44) throw new ArtifactOutputMissing();
    if (receipt.exitCode !== 0)
      throw new ConflictException('目标端产物登记失败，已保留待核对的实物');
    const [path, measured] = receipt.stdout.trimEnd().split('\n');
    if (
      !path ||
      !measured ||
      !remotePath(path) ||
      !path.endsWith('/.veyops/artifacts/' + input.instanceId + '/payload')
    )
      throw new Error('目标端登记地址无法验证');
    return {
      kind: input.kind,
      location: 'SERVER_PATH',
      owner: 'MANAGED',
      path,
      ownerToken,
      serverId: input.target.id,
      hostKeyFingerprint: input.target.hostKeyFingerprint,
      ...(input.kind === 'FILE' && { fileName: posix.basename(declared) }),
      ...parseDigest(measured),
    };
  }

  private async builderRoot(create: boolean) {
    const base = await realpath(dataDirectory);
    const root = join(base, 'artifact-objects');
    if (create)
      await mkdir(root, { mode: 0o700 }).catch((error: unknown) => {
        if (!hasErrno(error, 'EEXIST')) throw error;
      });
    if (!(await lstat(root)).isDirectory() || (await realpath(root)) !== root)
      throw new InvalidArtifactObject();
    return root;
  }

  private async readyBuilderSlot(
    slot: string,
    owner: string,
    kind: PathArtifactKind,
    signal?: AbortSignal,
  ) {
    const marker = join(slot, '.owner');
    const receipt = join(slot, '.digest');
    const identity = await lstat(slot);
    const managedFile = async (path: string) => {
      try {
        return (await lstat(path)).isFile();
      } catch (error) {
        if (hasErrno(error, 'ENOENT')) return false;
        throw error;
      }
    };
    if (
      !identity.isDirectory() ||
      (await realpath(slot)) !== slot ||
      !(await managedFile(marker)) ||
      !(await managedFile(receipt)) ||
      (await readFile(marker, 'utf8')) !== owner
    )
      throw new InvalidArtifactObject();
    const digest = await artifactPathDigest(join(slot, 'payload'), kind, signal);
    if ((await readFile(receipt, 'utf8')) !== digest.sha256 + ':' + digest.sizeBytes)
      throw new InvalidArtifactObject();
    return digest;
  }

  async collectBuilderPath(input: CollectPathInput): Promise<ArtifactPhysical> {
    const declared = ensureCollection(input);
    const root = await this.builderRoot(true);
    const slot = join(root, input.instanceId);
    const ownerToken = token('manager', input.instanceId);
    const path = join(slot, 'payload');
    let digest: ArtifactDigest;
    const exists = await lstat(slot).catch((error: unknown) => {
      if (hasErrno(error, 'ENOENT')) return undefined;
      throw error;
    });
    if (exists) {
      digest = await this.readyBuilderSlot(slot, ownerToken, input.kind, input.signal);
    } else {
      const workspace = await realpath(input.workspace);
      const requested = resolve(workspace, declared);
      if (!containedPath(workspace, requested)) throw new InvalidArtifactObject();
      const source = await realpath(requested).catch((error: unknown) => {
        if (hasErrno(error, 'ENOENT')) throw new ArtifactOutputMissing();
        throw error;
      });
      if (!containedPath(workspace, source) || (await lstat(requested)).isSymbolicLink())
        throw new InvalidArtifactObject();
      const expected = await artifactPathDigest(source, input.kind, input.signal);
      const stage = await mkdtemp(join(root, '.staging-' + input.instanceId + '-'));
      try {
        await writeFile(join(stage, '.owner'), ownerToken, { mode: 0o600, flag: 'wx' });
        await cp(source, join(stage, 'payload'), {
          recursive: true,
          force: false,
          errorOnExist: true,
        });
        const copied = await artifactPathDigest(join(stage, 'payload'), input.kind, input.signal);
        if (expected.sha256 !== copied.sha256 || expected.sizeBytes !== copied.sizeBytes)
          throw new InvalidArtifactObject();
        await writeFile(join(stage, '.digest'), copied.sha256 + ':' + copied.sizeBytes, {
          mode: 0o600,
          flag: 'wx',
        });
        try {
          await rename(stage, slot);
        } catch (error) {
          if (!(await lstat(slot).catch(() => undefined))?.isDirectory()) throw error;
        }
        digest = await this.readyBuilderSlot(slot, ownerToken, input.kind, input.signal);
      } finally {
        if (dirname(stage) === root) await rm(stage, { recursive: true, force: true });
      }
    }
    return {
      kind: input.kind,
      location: 'BUILDER_PATH',
      owner: 'MANAGED',
      path,
      ownerToken,
      builderId: 'manager',
      ...(input.kind === 'FILE' && { fileName: basename(declared) }),
      ...digest,
    };
  }

  private serverSlot(physical: ArtifactPhysical, target: SshTarget) {
    if (
      !physical.path ||
      !remotePath(physical.path) ||
      !physical.ownerToken ||
      !physical.hostKeyFingerprint ||
      !target.hostKeyFingerprint ||
      physical.hostKeyFingerprint !== target.hostKeyFingerprint ||
      physical.serverId !== target.id
    )
      throw new InvalidArtifactObject();
    const instance = posix.basename(posix.dirname(physical.path));
    const suffix = '/.veyops/artifacts/' + instance + '/payload';
    if (
      !uuid.test(instance) ||
      !physical.path.endsWith(suffix) ||
      physical.ownerToken !== token(target.id, instance)
    )
      throw new InvalidArtifactObject();
    return [
      remoteArtifactRoot,
      'owner=' + q(physical.ownerToken),
      'slot="$root"/' + q(instance),
      '[[ "$slot/payload" == ' + q(physical.path) + ' ]] || exit 45',
      remoteSlotCheck,
    ].join('\n');
  }

  private async builderSlot(physical: ArtifactPhysical) {
    if (physical.builderId !== 'manager' || !physical.path || !physical.ownerToken)
      throw new InvalidArtifactObject();
    const root = await this.builderRoot(false);
    const slot = dirname(physical.path);
    const instance = basename(slot);
    if (
      dirname(slot) !== root ||
      basename(physical.path) !== 'payload' ||
      !uuid.test(instance) ||
      physical.ownerToken !== token('manager', instance)
    )
      throw new InvalidArtifactObject();
    return slot;
  }

  private docker(args: string[], target?: SshTarget, builderId?: string, signal?: AbortSignal) {
    if (target) return this.server(target, 'docker ' + args.map(q).join(' '), signal, 60);
    const socket = process.env.WEBHOOK_BUILD_DOCKER_SOCKET;
    const isolated = builderId === 'manager-webhook';
    if (
      isolated &&
      (!socket || !/^\/[\w./-]+$/.test(socket) || socket.includes('..') || socket.endsWith('/'))
    )
      throw new Error('隔离 Docker 运行器无法验证');
    return this.process.run('docker', isolated ? ['--host', 'unix://' + socket, ...args] : args, {
      timeout: 60,
      signal,
      isolatedDocker: isolated,
    });
  }

  private async dockerId(target?: SshTarget, builderId?: string, signal?: AbortSignal) {
    const info = await this.docker(['info', '--format', '{{.ID}}'], target, builderId, signal);
    const id = info.stdout.trim();
    if (info.exitCode !== 0 || !engineIdentity.test(id))
      throw new Error('无法读取 Docker 引擎标识');
    return id;
  }

  private async image(
    reference: string,
    target?: SshTarget,
    builderId?: string,
    signal?: AbortSignal,
  ) {
    const inspected = await this.docker(
      ['image', 'inspect', '--format', '{{.Id}} {{.Os}}/{{.Architecture}}', '--', reference],
      target,
      builderId,
      signal,
    );
    if (inspected.exitCode !== 0) {
      if (/\b(?:no such image|no such object)\b/i.test(inspected.stderr)) return undefined;
      throw new Error('无法读取镜像实物');
    }
    const [imageId, platform] = inspected.stdout.trim().split(' ');
    if (!imageId || !platform || !imageDigest.test(imageId) || !imagePlatform.test(platform))
      throw new Error('Docker 未返回完整镜像标识和平台信息');
    return { imageId, platform };
  }

  async describeImage({
    target,
    reference,
    owner,
    builderId = 'manager',
    signal,
  }: {
    target?: SshTarget;
    reference: string;
    owner: ArtifactPhysical['owner'];
    builderId?: string;
    signal?: AbortSignal;
  }): Promise<ArtifactPhysical> {
    if (
      !imageReference.test(reference) ||
      (owner === 'MANAGED' && !managedTag.test(reference)) ||
      (target && !target.hostKeyFingerprint) ||
      (!target && !['manager', 'manager-webhook'].includes(builderId))
    )
      throw new BadRequestException('镜像引用或构建位置不符合登记规则');
    const engineId = await this.dockerId(target, builderId, signal);
    const image = await this.image(reference, target, builderId, signal);
    if (!image) throw new ArtifactOutputMissing();
    return {
      kind: 'DOCKER_IMAGE',
      location: 'DOCKER_ENGINE',
      owner,
      ...image,
      engineId,
      imageReference: reference,
      ...(target
        ? { serverId: target.id, hostKeyFingerprint: target.hostKeyFingerprint! }
        : { builderId }),
    };
  }

  async verify(
    physical: ArtifactPhysical,
    target?: SshTarget,
    signal?: AbortSignal,
  ): Promise<ArtifactVerification> {
    try {
      if (physical.serverId) {
        target ??= await this.servers.get(physical.serverId);
        if (
          target.id !== physical.serverId ||
          !physical.hostKeyFingerprint ||
          target.hostKeyFingerprint !== physical.hostKeyFingerprint
        )
          return outcome('CHANGED', fingerprintChanged);
      } else if (target && physical.location !== 'REGISTRY') {
        return outcome('CHANGED', '产物实物不在当前指定目标');
      }
      if (physical.location === 'REGISTRY') return this.verifyRegistry(physical, signal);
      if (physical.location === 'DOCKER_ENGINE') {
        if (
          !physical.imageId ||
          !imageDigest.test(physical.imageId) ||
          !physical.platform ||
          !imagePlatform.test(physical.platform) ||
          !physical.engineId
        )
          return outcome('CHANGED');
        if ((await this.dockerId(target, physical.builderId, signal)) !== physical.engineId)
          return outcome('CHANGED', 'Docker 引擎与登记时不同');
        const current = await this.image(physical.imageId, target, physical.builderId, signal);
        if (!current) {
          const reference = physical.imageReference;
          const replaced =
            reference && imageReference.test(reference)
              ? await this.image(reference, target, physical.builderId, signal)
              : undefined;
          return outcome(replaced ? 'CHANGED' : 'MISSING');
        }
        return outcome(
          current.imageId === physical.imageId && current.platform === physical.platform
            ? 'AVAILABLE'
            : 'CHANGED',
        );
      }
      if (physical.kind === 'DOCKER_IMAGE' || !physical.sha256 || !sha256.test(physical.sha256))
        return outcome('CHANGED');
      let measured: ArtifactDigest;
      if (physical.location === 'SERVER_PATH' && target) {
        const probe = await this.server(
          target,
          [
            this.serverSlot(physical, target),
            linuxArtifactDigest,
            'artifact_digest ' + q(physical.kind) + ' "$slot/payload"',
          ].join('\n'),
          signal,
        );
        if (probe.exitCode === 44) return outcome('MISSING');
        if (probe.exitCode === 45) return outcome('CHANGED');
        if (probe.exitCode !== 0) return outcome('UNVERIFIABLE');
        measured = parseDigest(probe.stdout);
      } else if (physical.location === 'BUILDER_PATH') {
        const slot = await this.builderSlot(physical);
        measured = await this.readyBuilderSlot(slot, physical.ownerToken!, physical.kind, signal);
      } else {
        return outcome('UNVERIFIABLE');
      }
      return outcome(
        measured.sha256 === physical.sha256 && measured.sizeBytes === physical.sizeBytes
          ? 'AVAILABLE'
          : 'CHANGED',
      );
    } catch (error) {
      if (error instanceof InvalidArtifactObject) return outcome('CHANGED');
      if (physical.location === 'BUILDER_PATH' && hasErrno(error, 'ENOENT'))
        return outcome('MISSING');
      return outcome('UNVERIFIABLE');
    }
  }

  private async verifyRegistry(physical: ArtifactPhysical, signal?: AbortSignal) {
    if (
      physical.kind !== 'DOCKER_IMAGE' ||
      !physical.registryId ||
      !physical.imageReference ||
      !physical.digest ||
      !imageDigest.test(physical.digest)
    )
      return outcome('CHANGED');
    try {
      const registry = await this.registries.get(physical.registryId);
      const prefix = registry.registryUrl + '/';
      const suffix = '@' + physical.digest;
      if (!physical.imageReference.startsWith(prefix) || !physical.imageReference.endsWith(suffix))
        return outcome('CHANGED', '镜像仓库地址或 Digest 与登记值不一致');
      const repository = physical.imageReference.slice(prefix.length, -suffix.length);
      let login: { username: string; password: string } | undefined;
      if (registry.credentialId) {
        const { username, password } = await this.credentials.decrypt(registry.credentialId);
        if (!username || !password || username.includes(':')) return outcome('UNVERIFIABLE');
        login = { username, password };
      }
      return outcome(
        await checkRegistryManifest(
          registry.registryUrl,
          repository,
          physical.digest,
          login,
          signal,
        ),
      );
    } catch {
      return outcome('UNVERIFIABLE');
    }
  }

  async stageServerArchive(
    physical: ArtifactPhysical,
    target: SshTarget,
    archive: string,
    signal?: AbortSignal,
  ) {
    const name = physical.kind === 'FILE' ? (physical.fileName ?? 'artifact') : 'payload';
    if (
      physical.location !== 'SERVER_PATH' ||
      physical.kind === 'DOCKER_IMAGE' ||
      !remotePath(archive) ||
      !physical.sha256 ||
      !sha256.test(physical.sha256) ||
      !name ||
      name === '.' ||
      name === '..' ||
      posix.basename(name) !== name ||
      /[\x00-\x1f\x7f]/.test(name)
    )
      throw new ConflictException('无法将该产物应用到当前服务器');
    const receipt = await this.server(
      target,
      [
        'umask 077',
        this.serverSlot(physical, target),
        linuxArtifactDigest,
        'expected=' + q(physical.sha256 + ':' + physical.sizeBytes),
        'archive=' + q(archive),
        'name=' + q(name),
        'kind=' + q(physical.kind),
        String.raw`
[[ "$(artifact_digest "$kind" "$slot/payload")" == "$expected" ]] || exit 45
parent=$(dirname -- "$archive")
[[ "$(realpath -e -- "$parent")" == "$parent" && ! -e "$archive" && ! -L "$archive" ]]
stage=$(mktemp -d "$parent/.pickup-XXXXXXXX")
trap 'rm -rf -- "$stage"' EXIT
mkdir -- "$stage/files"
cp -a -- "$slot/payload" "$stage/files/$name"
[[ "$(artifact_digest "$kind" "$stage/files/$name")" == "$expected" ]] || exit 45
if [[ "$kind" == DIRECTORY ]]; then
  tar -czf "$stage/.payload.tar.gz" -C "$stage/files/$name" .
else
  tar -czf "$stage/.payload.tar.gz" -C "$stage/files" -- "$name"
fi
ln -- "$stage/.payload.tar.gz" "$archive"
printf '%s:%s\n' "$(checksum "$archive")" "$(stat -c '%s' -- "$archive")"
`,
      ].join('\n'),
      signal,
    );
    if (receipt.exitCode !== 0)
      throw new ConflictException('同机产物缺失、已变化或无法生成发布归档');
    const { sha256: checksum, sizeBytes } = parseDigest(receipt.stdout);
    return { checksum, sizeBytes };
  }

  async remove(
    physical: ArtifactPhysical,
    target?: SshTarget,
    signal?: AbortSignal,
  ): Promise<ArtifactRemoval> {
    if (physical.owner !== 'MANAGED' || physical.location === 'REGISTRY')
      return { status: 'RETAINED', reason: '外部对象只解除维序引用' };
    const state = await this.verify(physical, target, signal);
    if (state.status === 'MISSING') return { status: 'DELETED' };
    if (state.status !== 'AVAILABLE') return { status: 'RETRY', reason: state.reason };
    try {
      if (physical.serverId && !target) target = await this.servers.get(physical.serverId);
      if (physical.location === 'DOCKER_ENGINE') {
        if (target && target.hostKeyFingerprint !== physical.hostKeyFingerprint)
          return { status: 'RETRY', reason: fingerprintChanged };
        if ((await this.dockerId(target, physical.builderId, signal)) !== physical.engineId)
          return { status: 'RETRY', reason: 'Docker 引擎与登记时不同' };
        const refs = await this.docker(
          [
            'image',
            'inspect',
            '--format',
            '{{json .RepoTags}}\n{{json .RepoDigests}}',
            '--',
            physical.imageId!,
          ],
          target,
          physical.builderId,
          signal,
        );
        if (refs.exitCode !== 0) return { status: 'RETRY', reason: '镜像引用无法核对' };
        const reference = physical.imageReference;
        const [tags, digests] = refs.stdout.trim().split('\n');
        if (
          !reference ||
          !managedTag.test(reference) ||
          tags !== JSON.stringify([reference]) ||
          !['[]', 'null'].includes(digests ?? '')
        )
          return { status: 'RETAINED', reason: '镜像包含共享标签或仓库引用' };
        const containers = await this.docker(
          ['container', 'ls', '-aq', '--filter', 'ancestor=' + physical.imageId],
          target,
          physical.builderId,
          signal,
        );
        if (containers.exitCode !== 0) return { status: 'RETRY', reason: '镜像使用状态无法核对' };
        if (containers.stdout.trim()) return { status: 'RETAINED', reason: '容器正在引用该镜像' };
        const deleted = await this.docker(
          ['image', 'rm', '--no-prune', '--', physical.imageId!],
          target,
          physical.builderId,
          signal,
        );
        return deleted.exitCode === 0
          ? { status: 'DELETED' }
          : { status: 'RETRY', reason: 'Docker 拒绝清理，镜像引用可能已变化' };
      }
      if (physical.location === 'SERVER_PATH' && target) {
        const candidate = await this.server(
          target,
          [
            this.serverSlot(physical, target),
            linuxArtifactDigest,
            'expected=' + q(physical.sha256 + ':' + physical.sizeBytes),
            '[[ "$(artifact_digest ' +
              q(physical.kind) +
              ' "$slot/payload")" == "$expected" ]] || exit 45',
            'rm -rf -- "$slot"',
          ].join('\n'),
          signal,
        );
        if (candidate.exitCode === 0 || candidate.exitCode === 44) return { status: 'DELETED' };
        return {
          status: 'RETRY',
          reason: candidate.exitCode === 45 ? reasons.CHANGED : reasons.UNVERIFIABLE,
        };
      }
      if (physical.location === 'BUILDER_PATH' && physical.kind !== 'DOCKER_IMAGE') {
        const slot = await this.builderSlot(physical);
        const checked = await this.readyBuilderSlot(
          slot,
          physical.ownerToken!,
          physical.kind,
          signal,
        );
        if (checked.sha256 !== physical.sha256 || checked.sizeBytes !== physical.sizeBytes)
          return { status: 'RETRY', reason: reasons.CHANGED };
        await rm(slot, { recursive: true, force: false });
        return { status: 'DELETED' };
      }
      return { status: 'RETRY', reason: reasons.UNVERIFIABLE };
    } catch {
      return { status: 'RETRY', reason: reasons.UNVERIFIABLE };
    }
  }
}

export class ArtifactOutputMissing extends Error {
  constructor() {
    super('声明的构建产物不存在');
  }
}
