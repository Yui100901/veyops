import { BadRequestException } from '@nestjs/common';
import { createHash } from 'node:crypto';

const authOrigins: Record<string, { origin: string; path: string }> = {
  'https://registry-1.docker.io': { origin: 'https://auth.docker.io', path: '/token' },
  'https://registry.gitlab.com': { origin: 'https://gitlab.com', path: '/jwt/auth' },
};
const hubAliases = new Set(['docker.io', 'index.docker.io', 'registry-1.docker.io']);
const registryVersion = 'registry/2.0';

export function registryAddress(value: string): string {
  const input = value.trim().toLowerCase();
  const match = /^([a-z0-9](?:[a-z0-9.-]*[a-z0-9])?)(?::(\d{1,5}))?$/.exec(input);
  const host = match?.[1];
  const port = match?.[2];
  if (
    !host ||
    host.length > 253 ||
    host
      .split('.')
      .some(
        (label) => !label || label.length > 63 || label.startsWith('-') || label.endsWith('-'),
      ) ||
    (port && (Number(port) < 1 || Number(port) > 65535)) ||
    URL.parse(`https://${input}`)?.hostname !== host
  ) {
    throw new BadRequestException('请输入有效的 Registry 主机名和可选端口');
  }
  return port ? `${host}:${Number(port)}` : host;
}

interface RegistryCredentials {
  username: string;
  password: string;
}
export type RegistryConnectionResult = {
  success: boolean;
  authenticated: boolean;
  message: string;
};

function result(
  success: boolean,
  authenticated: boolean,
  message: string,
): RegistryConnectionResult {
  return { success, authenticated, message };
}

function challengeParameters(header: string): { realm: string; service?: string } | undefined {
  const bearer = /(?:^|,)\s*Bearer\s+([^]*?)(?=,\s*[a-z][a-z\d-]*\s+(?!\s*=)|$)/i.exec(header);
  if (!bearer) return undefined;
  const fields = new Map<string, string>();
  const parameter = /(?:^|,)\s*([a-z][a-z\d_-]*)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^\s,]+))\s*/gi;
  for (const match of bearer[1]!.matchAll(parameter)) {
    const [, key, quoted, raw] = match;
    fields.set(key!.toLowerCase(), quoted?.replace(/\\(.)/g, '$1') ?? raw!);
  }
  const realm = fields.get('realm');
  return realm ? { realm, service: fields.get('service') } : undefined;
}

function tokenEndpoint(
  endpoint: URL,
  challenge: { realm: string; service?: string },
): URL | undefined {
  const url = URL.parse(challenge.realm);
  if (!url || url.protocol !== 'https:' || url.username || url.password || url.hash)
    return undefined;
  const known = authOrigins[endpoint.origin];
  const trusted =
    url.origin === endpoint.origin || (url.origin === known?.origin && url.pathname === known.path);
  if (!trusted) return undefined;
  if (challenge.service) url.searchParams.set('service', challenge.service);
  return url;
}

async function readToken(response: Response): Promise<string | undefined> {
  const reader = response.body?.getReader();
  if (!reader) return undefined;
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 16_384) return undefined;
      chunks.push(Buffer.from(value));
    }
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      token?: unknown;
      access_token?: unknown;
    } | null;
    const token = body?.token ?? body?.access_token;
    return typeof token === 'string' && /^[A-Za-z0-9._~+/=-]{1,8192}$/.test(token)
      ? token
      : undefined;
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

export async function checkRegistryConnection(
  address: string,
  credentials?: RegistryCredentials,
): Promise<RegistryConnectionResult> {
  const host = hubAliases.has(address) ? 'registry-1.docker.io' : address;
  const endpoint = new URL(`https://${host}/v2/`);
  const signal = AbortSignal.timeout(10_000);
  const basic = credentials
    ? `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`
    : undefined;
  const request = (url: URL, authorization?: string) =>
    fetch(url, {
      signal,
      redirect: 'manual',
      headers: authorization ? { Authorization: authorization } : undefined,
    });
  const ping = async (authorization?: string) => {
    const response = await request(endpoint, authorization);
    const outcome = {
      status: response.status,
      version: response.headers.get('docker-distribution-api-version'),
      challenge: response.headers.get('www-authenticate') ?? '',
    };
    await response.body?.cancel().catch(() => undefined);
    return outcome;
  };
  const rejected = () => result(false, false, '镜像仓库拒绝访问，请检查凭据或访问权限');
  const invalid = () => result(false, false, '服务未返回有效的 Registry V2 响应');
  const success = (authenticated: boolean) =>
    result(
      true,
      authenticated,
      authenticated
        ? '连接与认证成功'
        : credentials
          ? '连接成功，仓库允许匿名访问，本次未验证凭据'
          : '匿名连接成功',
    );

  try {
    const initial = await ping();
    if (initial.status === 200)
      return initial.version === registryVersion ? success(false) : invalid();
    if (initial.status === 403) return rejected();
    if (initial.status !== 401 || initial.version !== registryVersion) return invalid();

    const challenge = challengeParameters(initial.challenge);
    let authorization: string | undefined;
    if (challenge) {
      const tokenUrl = tokenEndpoint(endpoint, challenge);
      if (!tokenUrl) return result(false, false, '镜像仓库的认证地址不受信任，未发送凭据');
      const response = await request(tokenUrl, basic);
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        return response.status === 401 || response.status === 403 ? rejected() : invalid();
      }
      const token = await readToken(response);
      if (!token) return invalid();
      authorization = `Bearer ${token}`;
    } else if (/(?:^|,)\s*Basic(?:\s|,|$)/i.test(initial.challenge)) {
      if (!basic) return result(false, false, '镜像仓库要求认证，请关联凭据后重试');
      authorization = basic;
    } else {
      return result(false, false, '镜像仓库返回了不支持的认证方式');
    }

    const checked = await ping(authorization);
    if (checked.status === 401 || checked.status === 403) return rejected();
    return checked.status === 200 && checked.version === registryVersion
      ? success(Boolean(basic))
      : invalid();
  } catch {
    return result(
      false,
      false,
      signal.aborted ? '连接镜像仓库超时' : '无法建立 HTTPS 连接，请检查仓库地址、网络及 TLS 证书',
    );
  }
}

export async function checkRegistryManifest(
  address: string,
  repository: string,
  digest: string,
  credentials?: RegistryCredentials,
  cancellation?: AbortSignal,
): Promise<'AVAILABLE' | 'MISSING' | 'CHANGED' | 'UNVERIFIABLE'> {
  if (
    !/^[a-z0-9]+(?:[._-]+[a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-]+[a-z0-9]+)*)*$/.test(repository) ||
    !/^sha256:[a-f0-9]{64}$/.test(digest)
  )
    return 'UNVERIFIABLE';
  const host = hubAliases.has(address) ? 'registry-1.docker.io' : registryAddress(address);
  const endpoint = new URL('https://' + host + '/v2/' + repository + '/manifests/' + digest);
  const timeout = AbortSignal.timeout(15_000);
  const signal = cancellation ? AbortSignal.any([cancellation, timeout]) : timeout;
  const basic = credentials
    ? 'Basic ' + Buffer.from(credentials.username + ':' + credentials.password).toString('base64')
    : undefined;
  const request = (url: URL, authorization?: string, manifest = false) =>
    fetch(url, {
      signal,
      redirect: 'manual',
      headers: {
        ...(authorization && { Authorization: authorization }),
        ...(manifest && {
          Accept: [
            'application/vnd.oci.image.manifest.v1+json',
            'application/vnd.oci.image.index.v1+json',
            'application/vnd.docker.distribution.manifest.v2+json',
            'application/vnd.docker.distribution.manifest.list.v2+json',
          ].join(', '),
        }),
      },
    });
  try {
    let response = await request(endpoint, undefined, true);
    if (response.status === 401) {
      const header = response.headers.get('www-authenticate') ?? '';
      await response.body?.cancel().catch(() => undefined);
      const challenge = challengeParameters(header);
      let authorization: string | undefined;
      if (challenge) {
        const tokenUrl = tokenEndpoint(endpoint, challenge);
        if (!tokenUrl) return 'UNVERIFIABLE';
        tokenUrl.searchParams.set('scope', 'repository:' + repository + ':pull');
        const tokenResponse = await request(tokenUrl, basic);
        if (!tokenResponse.ok) {
          await tokenResponse.body?.cancel().catch(() => undefined);
          return 'UNVERIFIABLE';
        }
        const token = await readToken(tokenResponse);
        if (token) authorization = 'Bearer ' + token;
      } else if (/(?:^|,)\s*Basic(?:\s|,|$)/i.test(header)) {
        authorization = basic;
      }
      if (!authorization) return 'UNVERIFIABLE';
      response = await request(endpoint, authorization, true);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      return response.status === 404 &&
        response.headers.get('docker-distribution-api-version') === registryVersion
        ? 'MISSING'
        : 'UNVERIFIABLE';
    }
    const reader = response.body?.getReader();
    if (!reader) return 'UNVERIFIABLE';
    try {
      const hash = createHash('sha256');
      let size = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 4 * 1024 * 1024) return 'UNVERIFIABLE';
        hash.update(value);
      }
      return 'sha256:' + hash.digest('hex') === digest ? 'AVAILABLE' : 'CHANGED';
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  } catch {
    return 'UNVERIFIABLE';
  }
}
